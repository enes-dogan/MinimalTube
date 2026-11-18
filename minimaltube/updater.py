"""MinimalTube server - updates from GitHub (Settings -> Updates).

The server asks GitHub for the latest release of github.com/enes-dogan/MinimalTube (when it
starts and a day has passed, and from the Settings button), downloads the release's source zip,
checks every file against GitHub's list of the release tag's files (their git hashes) and works
out which files here differ. Installing replaces only those and deletes the ones the release
dropped. Files no release has (the user's own) are never touched, nothing outside the project
folder is, and a git checkout is never updated.

Old code downloads and checks; new code installs itself. The server starts the release's own copy
of this file, from the checked download, as a process of its own (`updater.py apply`). It stops
the server only when server files change, keeps a copy of every file it replaces or deletes,
swaps the files one by one, starts the server again and waits for it to answer with the new
version; when any step fails it puts everything back. The native host runs `updater.py recover`
before it starts a server, so an install that was cut off (a crash, a shutdown) is finished or
undone first.

What one version writes and another reads, so it must stay readable from version to version: the
apply plan (PLAN_FORMAT), the journal (JOURNAL_FORMAT), this file's command line and its own path
in a release (minimaltube/updater.py).

In APP_DIR/updates:
    state.json       the last check: the latest release, when, what went wrong
    staged/<v>/      a downloaded and checked release: files/ and plan.json
    apply.json       what the installing process is to do (written by the server)
    journal.json     how far it got (the server starts it; then only the installing process)
    installed.json   the installed release's files with their git hashes
    apply-backup/    the files the running install replaces or deletes
    rollback/        the same, kept after the last update (Settings -> Roll back)
    runner/          the copy of this code a rollback runs from
    update.log       what the installing process printed
"""
from __future__ import annotations  # `str | None` annotations on Python 3.9

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import ssl
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path

if __name__ == "__main__" and not __package__:
    # Started as a script (the installing process, from a checked download): import this file
    # again as part of its package, which can then import the package's other modules.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from minimaltube.updater import main

    raise SystemExit(main(sys.argv[1:]))

from .jsonfile import read_json, write_json_atomic  # noqa: E402
from .system import (  # noqa: E402
    PROJECT_DIR,
    WINDOWS,
    app_dir,
    app_version,
    cache_dir,
    data_dir,
    installer_hint,
    pid_alive,
    port_is_free,
    replace_file,
    spawn_detached,
    uses_own_python,
)

REPO = "enes-dogan/MinimalTube"
RELEASES_PAGE = f"https://github.com/{REPO}/releases"
# Tests point this at a fake GitHub on this computer; nothing else is accepted.
_TEST_API = os.environ.get("MINIMALTUBE_UPDATE_API", "")
API = (_TEST_API.rstrip("/") if re.fullmatch(r"http://(127\.0\.0\.1|localhost):\d{2,5}/?", _TEST_API)
       else "https://api.github.com")

UPDATES_DIR = app_dir() / "updates"
STATE = UPDATES_DIR / "state.json"
STAGED_DIR = UPDATES_DIR / "staged"
APPLY_PLAN = UPDATES_DIR / "apply.json"
JOURNAL = UPDATES_DIR / "journal.json"
INSTALLED = UPDATES_DIR / "installed.json"
APPLY_BACKUP = UPDATES_DIR / "apply-backup"
ROLLBACK_DIR = UPDATES_DIR / "rollback"
RUNNER_DIR = UPDATES_DIR / "runner"
UPDATE_LOG = UPDATES_DIR / "update.log"

PLAN_FORMAT = 1
JOURNAL_FORMAT = 1
# journal phases while an install or rollback runs; it ends "done" or "failed"
ACTIVE = ("waiting", "backup", "swapping", "swapped", "finishing", "starting", "undoing")

CHECK_EVERY = 24 * 3600  # a check a day
RETRY_EVERY = 3600       # an hour after one that failed
MANUAL_GAP = 60          # the Settings button asks GitHub at most once a minute
LOOP_START = 60          # the first check waits until the server's start is over
LOOP_EVERY = 3600
NOTES_MAX = 20000
ZIP_MAX_BYTES = 50 * 1024 ** 2
FILES_MAX_BYTES = 200 * 1024 ** 2
FILES_MAX_COUNT = 5000
# what a release must have, or it can't be MinimalTube (or couldn't install the next one)
REQUIRED = ("server.py", "minimaltube_host.py", "requirements.txt", "minimaltube/__init__.py",
            "minimaltube/system.py", "minimaltube/jsonfile.py", "minimaltube/updater.py",
            "extension/manifest.json", "extension/background.js", "installer/install.py")
RUNNER_FILES = ("__init__.py", "system.py", "jsonfile.py", "updater.py")


class UpdateError(Exception):
    """What stops a check, download or install, in words Settings can show.

    Args:
        message (str): What went wrong.
        kind (str): "offline", "rate-limit", "not-found", "http", "blocked" or "invalid" (GitHub's
            answer or the release can't be used).
        retry_at (float | None): For "rate-limit": when GitHub takes requests again.
    """

    def __init__(self, message: str, kind: str = "invalid", retry_at: float | None = None):
        super().__init__(message)
        self.kind, self.retry_at = kind, retry_at


# ---------------------------------------------------------------- versions and hashes
def version_key(text) -> tuple | None:
    """A version ("1.3.0", or a tag "v1.3.0") as numbers that compare the right way (1.10 after
    1.9), padded to four; None for anything else ("1.3.0-beta" is not a release here)."""
    text = str(text or "").strip()
    if not re.fullmatch(r"v?\d{1,5}(\.\d{1,5}){0,3}", text):
        return None
    parts = [int(n) for n in text.lstrip("v").split(".")]
    return tuple(parts + [0] * (4 - len(parts)))


def is_newer(version, than) -> bool:
    """Whether `version` comes after `than` (False when either isn't a version)."""
    a, b = version_key(version), version_key(than)
    return bool(a and b and a > b)


def git_blob_sha(data: bytes) -> str:
    """The hash git (and GitHub's API) gives a file with this content: SHA-1 of "blob <size>\\0"
    followed by the bytes."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _file_sha(path: Path) -> str | None:
    try:
        return None if path.is_symlink() else git_blob_sha(path.read_bytes())
    except OSError:
        return None


# ---------------------------------------------------------------- GitHub
def _ca_bundles() -> list:
    # A Python that can't see the system's certificates (one with its own OpenSSL, on macOS
    # often): certifi's, which MinimalTube's own yt-dlp brings, or pip's copy of it.
    found = []
    for name in ("certifi", "pip._vendor.certifi"):
        try:
            found.append(__import__(name, fromlist=["where"]).where())
        except Exception:
            pass
    return found


def _fetch(url: str, accept: str = "application/vnd.github+json", limit: int = 1 << 20,
           timeout: float = 30) -> bytes:
    req = urllib.request.Request(url, headers={
        "User-Agent": "MinimalTube-updater", "Accept": accept, "X-GitHub-Api-Version": "2022-11-28"})
    context, bundles = None, None
    while True:
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=context) as resp:
                data = resp.read(limit + 1)
            break
        except urllib.error.HTTPError as e:
            raise _http_error(e) from e
        except (urllib.error.URLError, OSError) as e:
            if "CERTIFICATE_VERIFY_FAILED" in str(e):
                bundles = _ca_bundles() if bundles is None else bundles
                if bundles:
                    try:
                        context = ssl.create_default_context(cafile=bundles.pop(0))
                    except (OSError, ssl.SSLError):
                        pass
                    continue
            raise UpdateError("GitHub can't be reached (no internet?)", "offline") from e
    if len(data) > limit:
        raise UpdateError("GitHub's answer is larger than an update can be")
    return data


def _http_error(e: urllib.error.HTTPError) -> UpdateError:
    headers = e.headers or {}
    if e.code == 429 or (e.code == 403 and headers.get("X-RateLimit-Remaining") == "0"):
        reset = str(headers.get("X-RateLimit-Reset") or "")
        retry_at = float(reset) if reset.isdigit() else time.time() + RETRY_EVERY
        return UpdateError("GitHub asks this network to wait before it asks again", "rate-limit", retry_at)
    if e.code == 404:
        return UpdateError("not found on GitHub", "not-found")
    return UpdateError(f"GitHub answered {e.code}", "http")


def _api(path: str) -> str:
    return f"{API}/repos/{REPO}/{path}"


def _ref(tag: str) -> str:
    return urllib.parse.quote(tag, safe="")


def _json(data: bytes):
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise UpdateError("GitHub's answer couldn't be read") from e


def latest_release() -> dict | None:
    """GitHub's latest release (drafts and pre-releases don't count).

    Returns:
        dict | None: {"version", "tag", "name", "notes" (the release text, Markdown), "url" (its
        page), "published"}; None while the repository has no release.

    Raises:
        UpdateError: GitHub can't be reached, refused, or its latest tag isn't a version.
    """
    try:
        data = _json(_fetch(_api("releases/latest")))
    except UpdateError as e:
        if e.kind == "not-found":
            return None
        raise
    if not isinstance(data, dict):
        raise UpdateError("GitHub's answer couldn't be read")
    tag = str(data.get("tag_name") or "")
    if not version_key(tag):
        raise UpdateError(f"the latest release's tag ({tag[:40]}) isn't a version number")
    url = data.get("html_url")
    return {
        "version": tag.lstrip("v"),
        "tag": tag,
        "name": str(data.get("name") or "")[:200],
        "notes": str(data.get("body") or "")[:NOTES_MAX],
        "url": url if isinstance(url, str) and url.startswith(f"https://github.com/{REPO}/") else RELEASES_PAGE,
        "published": str(data.get("published_at") or "")[:40],
    }


def release_tree(ref: str) -> dict:
    """Every file of a tag (or branch) with its git hash and mode, as GitHub lists them.

    Returns:
        dict[str, tuple[str, str]]: "path/in/repo" -> (blob SHA-1, mode such as "100644").

    Raises:
        UpdateError: GitHub can't be reached or has no such ref ("not-found"), or listed the
            files only in part.
    """
    data = _json(_fetch(_api(f"git/trees/{_ref(ref)}?recursive=1"), limit=16 << 20))
    if not isinstance(data, dict) or data.get("truncated") or not isinstance(data.get("tree"), list):
        raise UpdateError("GitHub listed the release's files only in part")
    return {e["path"]: (e["sha"], str(e.get("mode") or ""))
            for e in data["tree"]
            if isinstance(e, dict) and e.get("type") == "blob"
            and isinstance(e.get("path"), str) and isinstance(e.get("sha"), str)}


# ---------------------------------------------------------------- unpacking and checking a release
_BAD_CHARS = re.compile(r'[<>:"|?*\\\x00-\x1f]')
_RESERVED = re.compile(r"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", re.I)


def _check_part(part: str) -> None:
    # names every OS can hold, that stay where they're put
    if part in ("", ".", "..") or _BAD_CHARS.search(part) or part.endswith((".", " ")) or _RESERVED.match(part):
        raise UpdateError(f"the release holds a file name that can't be installed: {part[:60]!r}")


def _make_executable(path: Path) -> None:
    if not WINDOWS:
        mode = path.stat().st_mode
        path.chmod(mode | (mode & 0o444) >> 2)


def unpack_release(data: bytes, tree: dict, out: Path) -> tuple:
    """Unpack a GitHub source zip into `out`, checking every file against the tag's file list.

    A zip that isn't laid out like GitHub's (one top folder), holds a link, a name that would
    leave `out` or that Windows can't hold, a top-level "_" name in extension/ (Chromium won't
    load the folder), a file GitHub doesn't list or one whose hash differs is refused whole.

    Args:
        data (bytes): The zip.
        tree (dict): release_tree() of the same tag.
        out (Path): An empty folder to unpack into.

    Returns:
        tuple[dict[str, str], set[str]]: The files ("path" -> git hash) and the executable ones.

    Raises:
        UpdateError: The zip is damaged or breaks one of the rules above.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise UpdateError("the download isn't a zip file") from e
    files, execs, seen, top, total = {}, set(), set(), None, 0
    with zf:
        for info in zf.infolist():
            parts = info.filename.split("/")
            top = parts[0] if top is None else top
            if not top or parts[0] != top or info.filename.startswith("/"):
                raise UpdateError("the zip isn't laid out like a GitHub source zip")
            rel_parts = [p for p in parts[1:]]
            if info.is_dir() and rel_parts and rel_parts[-1] == "":
                rel_parts.pop()
            if not rel_parts:
                continue
            for part in rel_parts:
                _check_part(part)
            if info.is_dir():
                continue
            rel = "/".join(rel_parts)
            if stat.S_ISLNK(info.external_attr >> 16):
                raise UpdateError(f"the release holds a link ({rel}), which an update never installs")
            if rel_parts[0] == "extension" and len(rel_parts) >= 2 and rel_parts[1].startswith("_"):
                raise UpdateError(f"the release holds {rel}: Chromium won't load an extension folder with a name starting with _")
            if rel.casefold() in seen:
                raise UpdateError(f"the release holds {rel} twice")
            seen.add(rel.casefold())
            total += info.file_size
            if total > FILES_MAX_BYTES or len(seen) > FILES_MAX_COUNT:
                raise UpdateError("the release is larger than an update can be")
            try:
                content = zf.read(info)
            except Exception as e:
                raise UpdateError(f"the zip is damaged ({rel})") from e
            sha, mode = tree.get(rel, (None, ""))
            if sha is None:
                raise UpdateError(f"{rel} isn't in GitHub's list of the release's files")
            if mode == "120000":
                raise UpdateError(f"the release holds a link ({rel}), which an update never installs")
            if git_blob_sha(content) != sha:
                raise UpdateError(f"{rel} doesn't match GitHub's copy of the release (damaged download?)")
            dest = out.joinpath(*rel_parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)
            if mode == "100755":
                execs.add(rel)
                _make_executable(dest)
            files[rel] = sha
    if not files:
        raise UpdateError("the release's zip is empty")
    return files, execs


def _manifest(root: Path) -> dict:
    try:
        data = json.loads((root / "extension" / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def check_release(root: Path, version: str, project: Path = PROJECT_DIR) -> None:
    """Check an unpacked release before anything of it is installed: the files MinimalTube can't
    run (or update again) without are there, its manifest parses, says the tag's version and has
    the same key (the same extension: the browser keeps its storage), and every Python file
    compiles. Compiling writes no bytecode.

    Raises:
        UpdateError: Says what's wrong.
    """
    for rel in REQUIRED:
        if not (root / rel).is_file():
            raise UpdateError(f"the release has no {rel}")
    manifest = _manifest(root)
    if not manifest:
        raise UpdateError("the release's manifest.json can't be read: the browser couldn't load it")
    if version_key(manifest.get("version")) != version_key(version):
        raise UpdateError(f"the release's manifest says version {str(manifest.get('version'))[:20]}, its tag {version}")
    key = _manifest(project).get("key")
    if not key or manifest.get("key") != key:
        raise UpdateError("the release's manifest has another key: the browser would take it for another extension")
    for py in sorted(root.rglob("*.py")):
        try:
            compile(py.read_bytes(), str(py), "exec", dont_inherit=True)
        except (SyntaxError, ValueError) as e:
            raise UpdateError(f"{py.relative_to(root).as_posix()} has an error: {e}") from e


# ---------------------------------------------------------------- what an update changes
def file_group(rel: str) -> str:
    """Which part of MinimalTube a file belongs to: "player" (the extension), "server",
    "installer" or "other" (the READMEs and such)."""
    if rel.startswith("extension/"):
        return "player"
    if rel in ("server.py", "minimaltube_host.py", "requirements.txt") or (rel.startswith("minimaltube/") and rel.endswith(".py")):
        return "server"
    if rel.startswith(("installer/", "install-")):
        return "installer"
    return "other"


def _restarts_server(rel: str) -> bool:
    return rel in ("server.py", "requirements.txt") or (rel.startswith("minimaltube/") and rel.endswith(".py"))


def _is_file(path: Path) -> bool:
    return path.is_symlink() or path.is_file()


def plan_changes(plan: dict, project: Path = PROJECT_DIR) -> dict:
    """What installing a staged release changes here, from the files on disk now.

    A file is replaced (or added) when its content differs from the release's, and deleted when
    the installed release had it and the new one doesn't. Same content: left alone, not even
    rewritten. A file that differs from the installed release's copy too was edited by hand: it's
    replaced all the same, and its copy is kept in the rollback folder.

    Args:
        plan (dict): A staged release's plan.json.
        project (Path): The folder to compare with.

    Returns:
        dict: {"put": [paths], "delete": [paths], "edited": [paths], "groups": {"player": n, ...},
        "count": n, "restart": the server must restart, "requirements": requirements.txt
        changes, "installer": something under installer/ changes}.
    """
    files, old = plan["files"], plan.get("old") or {}
    tree = set(plan.get("tree") or files)
    put, delete, edited = [], [], []
    for rel, sha in files.items():
        local = project.joinpath(*rel.split("/"))
        have = _file_sha(local) if _is_file(local) else None
        if have == sha:
            continue
        put.append(rel)
        if have and rel in old and have != old[rel]:
            edited.append(rel)
    for rel, sha in old.items():
        local = project.joinpath(*rel.split("/"))
        if rel not in tree and _is_file(local):
            delete.append(rel)
            if _file_sha(local) != sha:
                edited.append(rel)
    groups = {}
    for rel in put + delete:
        groups[file_group(rel)] = groups.get(file_group(rel), 0) + 1
    return {
        "put": sorted(put), "delete": sorted(delete), "edited": sorted(edited), "groups": groups,
        "count": len(put) + len(delete),
        "restart": any(_restarts_server(rel) for rel in put + delete),
        "requirements": "requirements.txt" in put,
        "installer": any(rel.startswith("installer/") for rel in put),
    }


def installed_files(version: str) -> dict | None:
    """The installed release's files with their git hashes: installed.json, which every update
    writes; before the first update (installed from a zip) GitHub's list for the version's tag.

    Returns:
        dict[str, str] | None: "path" -> git hash, or None when GitHub has no such tag either
        (an update then deletes nothing and can't tell edited files).
    """
    known = read_json(INSTALLED, {})
    if known.get("version") == version and isinstance(known.get("files"), dict):
        return known["files"]
    for tag in (f"v{version}", version):
        try:
            return {rel: sha for rel, (sha, _mode) in release_tree(tag).items()}
        except UpdateError as e:
            if e.kind != "not-found":
                raise
    return None


# ---------------------------------------------------------------- what the server keeps
_lock = threading.Lock()        # downloads and starting an install
_state_lock = threading.Lock()  # state.json and settings.json
_job = {"phase": "idle"}        # the download: idle, downloading, verifying, ready, error
_writable_seen = {"at": 0.0, "ok": True}


def _state() -> dict:
    return read_json(STATE, {})


def _save_state(**changes) -> None:
    with _state_lock:
        state = _state()
        state.update(changes)
        UPDATES_DIR.mkdir(parents=True, exist_ok=True)
        write_json_atomic(STATE, state, "update")


def _settings_path() -> Path:
    return data_dir() / "settings.json"


def auto_enabled() -> bool:
    """Whether Settings' "Install updates automatically" is on (off unless switched on)."""
    return read_json(_settings_path(), {}).get("auto_update") is True


def set_auto(on: bool) -> None:
    """Switch automatic updates on or off (kept in the data folder's settings.json).

    Raises:
        OSError: settings.json couldn't be written.
    """
    with _state_lock:
        settings = read_json(_settings_path(), {})
        settings["auto_update"] = bool(on)
        if not write_json_atomic(_settings_path(), settings, "settings"):
            raise OSError("couldn't save the setting")


def _writable(project: Path) -> bool:
    # a file written and deleted in each folder an update writes to; asked again every 5 minutes
    if time.time() - _writable_seen["at"] < 300:
        return _writable_seen["ok"]
    ok = True
    for folder in (project, project / "extension", project / "minimaltube", project / "installer"):
        if not folder.is_dir():
            continue
        probe = folder / f".minimaltube-write-test-{os.getpid()}"
        try:
            probe.write_bytes(b"")
        except OSError:
            ok = False
            break
        finally:
            try:
                probe.unlink()
            except OSError:
                pass
    _writable_seen.update(at=time.time(), ok=ok)
    return ok


def blocked_reason(project: Path = PROJECT_DIR) -> dict | None:
    """Why this copy of MinimalTube can't update itself, if it can't.

    Returns:
        dict | None: {"reason": "git" | "version" | "readonly", "text": what Settings says}.
    """
    if (project / ".git").exists():
        return {"reason": "git", "text": "This copy of MinimalTube is a git checkout: update it with git pull."}
    if not app_version(project):
        return {"reason": "version", "text": "MinimalTube's manifest.json has no version, so it can't tell what to update."}
    if not _writable(project):
        return {"reason": "readonly", "text": (
            f"MinimalTube can't change the files in its folder ({project}), so it can't update itself "
            "there. Move the folder somewhere of your own (your user folder, say), choose its extension "
            "folder again on chrome://extensions (Load unpacked) and run the installer once.")}
    return None


def _journal() -> dict:
    return read_json(JOURNAL, {})


def _write_journal(data: dict) -> None:
    UPDATES_DIR.mkdir(parents=True, exist_ok=True)
    write_json_atomic(JOURNAL, data, "update")


def _is_running(journal: dict) -> bool:
    # an install whose process hasn't written its id yet counts for half a minute
    if journal.get("phase") not in ACTIVE:
        return False
    pid = journal.get("pid")
    if not pid:
        return time.time() - (journal.get("started") or 0) < 30
    return pid_alive(pid)


def _journal_summary(journal: dict) -> dict | None:
    phase = journal.get("phase")
    if not phase:
        return None
    if phase in ACTIVE and not _is_running(journal):
        phase = "interrupted"  # the native host finishes or undoes it before the next start
    return {key: journal.get(key) for key in (
        "id", "kind", "version", "from", "error", "undone", "started", "finished")} | {
        "phase": phase, "notes": journal.get("notes") or [], "edited": journal.get("edited") or [],
        "backup": str(ROLLBACK_DIR) if journal.get("edited") else None}


def _staged_plan(latest: dict | None) -> dict | None:
    if not latest:
        return None
    plan = read_json(STAGED_DIR / str(latest.get("version")) / "plan.json", {})
    if (plan.get("format") != PLAN_FORMAT or plan.get("version") != latest.get("version")
            or plan.get("from") != app_version() or not isinstance(plan.get("files"), dict)):
        return None
    return plan


def _clean_staged(keep: str | None = None) -> None:
    # downloads nothing will install any more (and halves of ones that broke off)
    if not STAGED_DIR.is_dir() or _is_running(_journal()):
        return
    installed, latest = app_version(), (_state().get("latest") or {}).get("version")
    for folder in STAGED_DIR.iterdir():
        name = folder.name
        if name != keep and (name.endswith(".part") or name != latest or not is_newer(name, installed)):
            shutil.rmtree(folder, ignore_errors=True)


def status() -> dict:
    """Everything Settings shows about updates.

    Returns:
        dict: {"version": installed, "latest": latest_release() as last seen or None,
        "available": a newer release exists, "checked" / "tried": when GitHub was last asked
        (successfully / at all), "error", "error_kind", "retry_at", "blocked": blocked_reason(),
        "auto": auto_enabled(), "download": {"phase", "version", "error"} while one runs or
        failed, "staged": {"version", "changes": plan_changes()} once downloaded and checked,
        "install": the last install or rollback ({"id", "kind", "phase", "version", "from",
        "error", "undone", "notes", "edited", "backup", ...}), "rollback": {"version"} while the
        last update can be undone, "releases": the releases page}.
    """
    installed = app_version()
    state = _state()
    latest = state.get("latest") if isinstance(state.get("latest"), dict) else None
    available = bool(latest and is_newer(latest.get("version"), installed))
    plan = _staged_plan(latest) if available else None
    staged = None
    if plan:
        try:
            staged = {"version": plan["version"], "changes": plan_changes(plan)}
        except (OSError, KeyError, TypeError):
            staged = None
    job = dict(_job)
    if job.get("phase") == "ready" and not staged:
        job = {"phase": "idle"}
    record = read_json(ROLLBACK_DIR / "backup.json", {})
    return {
        "version": installed,
        "latest": latest,
        "available": available,
        "checked": state.get("checked"),
        "tried": state.get("tried"),
        "error": state.get("error"),
        "error_kind": state.get("error_kind"),
        "retry_at": state.get("retry_at"),
        "skipped": state.get("skipped"),
        "blocked": blocked_reason(),
        "auto": auto_enabled(),
        "download": None if job.get("phase") == "idle" else job,
        "staged": staged,
        "install": _journal_summary(_journal()),
        "rollback": ({"version": record["from"]} if record.get("to") == installed and record.get("from")
                     and record.get("kind") == "install" else None),
        "releases": RELEASES_PAGE,
    }


def check(manual: bool = False) -> None:
    """Ask GitHub for its latest release and keep the answer (or what went wrong) in state.json.

    Args:
        manual (bool): From the Settings button: asks even when the last check is recent, but not
            twice within a minute, and never while GitHub asked to wait (rate limit).
    """
    now = time.time()
    state = _state()
    if now < (state.get("retry_at") or 0) or (manual and now - (state.get("tried") or 0) < MANUAL_GAP):
        return
    _save_state(tried=now)
    try:
        latest = latest_release()
    except UpdateError as e:
        _save_state(error=str(e), error_kind=e.kind, retry_at=e.retry_at)
        return
    _save_state(checked=now, latest=latest, error=None, error_kind=None, retry_at=None)
    _clean_staged()


def _check_due(state: dict, now: float) -> bool:
    return (now >= (state.get("retry_at") or 0) and now - (state.get("checked") or 0) >= CHECK_EVERY
            and now - (state.get("tried") or 0) >= RETRY_EVERY)


def check_loop() -> None:
    """The server's background thread: a check whenever one is due (a day after the last one, an
    hour after one that failed), and with automatic updates on, the download of a newer release,
    which the player installs the next time it opens."""
    time.sleep(LOOP_START)
    while True:
        try:
            if _check_due(_state(), time.time()):
                check()
            _clean_staged()
            info = status()
            latest = info["latest"] or {}
            if (info["auto"] and info["available"] and not info["blocked"] and not info["staged"]
                    and latest.get("version") != info["skipped"] and not _is_running(_journal())):
                start_download()
        except Exception as e:  # the loop must outlive anything one round runs into
            print(f"[update] {e}")
        time.sleep(LOOP_EVERY)


def _set_job(phase: str, version: str, error: str | None = None) -> None:
    _job.clear()
    _job.update(phase=phase, version=version, error=error, at=time.time())


def start_download() -> None:
    """Download and check the latest release in the background (status()["download"] follows
    it), unless that's under way already.

    Raises:
        UpdateError: There's nothing newer to download, or this copy can't update itself.
    """
    with _lock:
        if _job.get("phase") in ("downloading", "verifying"):
            return
        latest = _state().get("latest") or {}
        if not is_newer(latest.get("version"), app_version()):
            raise UpdateError("There's no newer release to download.")
        reason = blocked_reason()
        if reason:
            raise UpdateError(reason["text"], "blocked")
        _set_job("downloading", latest["version"])
    threading.Thread(target=_download_job, args=(latest,), daemon=True).start()


def _download_job(latest: dict) -> None:
    try:
        stage_release(latest)
        _set_job("ready", latest["version"])
    except UpdateError as e:
        _set_job("error", latest["version"], str(e))
    except Exception as e:
        _set_job("error", latest["version"], f"unexpected: {e}")
        print(f"[update] download failed: {e!r}")


def stage_release(latest: dict, project: Path = PROJECT_DIR) -> dict:
    """Download a release's source zip, check it (unpack_release, check_release) and keep it in
    staged/<version>/ with its plan.json: the release's files and hashes, and the installed
    release's (installed_files), which plan_changes() compares with.

    Args:
        latest (dict): latest_release()'s answer.
        project (Path): The folder the release is for.

    Returns:
        dict: The plan.

    Raises:
        UpdateError: The download or a check failed; nothing is kept then.
    """
    tag, version = latest["tag"], latest["version"]
    tree = release_tree(tag)
    data = _fetch(_api(f"zipball/{_ref(tag)}"), accept="*/*", limit=ZIP_MAX_BYTES, timeout=120)
    if _job.get("version") == version:
        _set_job("verifying", version)
    part = STAGED_DIR / f"{version}.part"
    shutil.rmtree(part, ignore_errors=True)
    try:
        files, execs = unpack_release(data, tree, part / "files")
        check_release(part / "files", version, project)
        installed = app_version(project)
        plan = {"format": PLAN_FORMAT, "version": version, "tag": tag, "from": installed,
                "files": files, "exec": sorted(execs), "tree": sorted(tree),
                "old": installed_files(installed), "checked": time.time()}
        if not write_json_atomic(part / "plan.json", plan, "update"):
            raise UpdateError("couldn't keep the download in MinimalTube's folder")
        final = STAGED_DIR / version
        shutil.rmtree(final, ignore_errors=True)
        os.replace(part, final)
    except BaseException:
        shutil.rmtree(part, ignore_errors=True)
        raise
    _clean_staged(keep=version)
    return plan


# ---------------------------------------------------------------- starting an install or rollback
def _refuse_if_busy() -> None:
    if _is_running(_journal()):
        raise UpdateError("An update is being installed right now.")
    if _job.get("phase") in ("downloading", "verifying"):
        raise UpdateError("The update is still downloading.")


def _launch(plan: dict) -> None:
    UPDATES_DIR.mkdir(parents=True, exist_ok=True)
    if not write_json_atomic(APPLY_PLAN, plan, "update"):
        raise UpdateError("couldn't write the update's plan in MinimalTube's folder")
    journal = {"format": JOURNAL_FORMAT, "id": plan["id"], "kind": plan["kind"], "phase": "waiting",
               "pid": None, "version": plan["version"], "from": plan["from"], "project": plan["project"],
               "runner": plan["runner"], "plan": str(APPLY_PLAN), "restart": plan["restart"],
               "started": time.time(), "updated": time.time()}
    _write_journal(journal)
    try:  # a long log is cut back first
        if UPDATE_LOG.stat().st_size > 1 << 20:
            UPDATE_LOG.unlink()
    except OSError:
        pass
    try:
        with open(UPDATE_LOG, "ab") as log:
            spawn_detached([sys.executable, "-X", "utf8", "-u", "-I", "-B", plan["runner"], "apply",
                            "--plan", str(APPLY_PLAN)], cwd=UPDATES_DIR, stdout=log, stderr=log)
    except OSError as e:
        _write_journal(journal | {"phase": "failed", "error": f"couldn't start the installer: {e}",
                                  "undone": False, "finished": time.time()})
        raise UpdateError(f"couldn't start the installer: {e}") from e


def start_install(server_cmd: list, port: int) -> dict:
    """Install the staged release: starts its own updater.py (`apply`) as a process of its own.
    When server files change, the caller then stops this server (the new process waits for that).

    Args:
        server_cmd (list[str]): The command line that starts this server again (system.own_command()).
        port (int): The port it listens on.

    Returns:
        dict: {"id": the journal's id for this install, "version", "restart": the server must stop}.

    Raises:
        UpdateError: Nothing is downloaded, this copy can't update itself, or something else
            is under way.
    """
    with _lock:
        _refuse_if_busy()
        installed = app_version()
        latest = _state().get("latest") or {}
        plan = _staged_plan(latest) if is_newer(latest.get("version"), installed) else None
        if not plan:
            raise UpdateError("Download the update first.")
        reason = blocked_reason()
        if reason:
            raise UpdateError(reason["text"], "blocked")
        changes = plan_changes(plan)
        files = STAGED_DIR / plan["version"] / "files"
        apply = {
            "format": PLAN_FORMAT, "kind": "install", "id": uuid.uuid4().hex, "project": str(PROJECT_DIR),
            "version": plan["version"], "from": installed,
            "put": {rel: str(files.joinpath(*rel.split("/"))) for rel in changes["put"]},
            "delete": changes["delete"], "exec": plan["exec"], "edited": changes["edited"],
            "installed": {"version": plan["version"], "files": plan["files"]},
            "restart": changes["restart"], "requirements": changes["requirements"],
            "installer": changes["installer"], "server_pid": os.getpid(), "server_cmd": list(server_cmd),
            "port": int(port), "runner": str(files / "minimaltube" / "updater.py"),
        }
        _launch(apply)
        return {"id": apply["id"], "version": apply["version"], "restart": apply["restart"]}


def _copy_runner(project: Path) -> str:
    # a rollback replaces this very code: it runs from a copy outside the project folder
    shutil.rmtree(RUNNER_DIR, ignore_errors=True)
    package = RUNNER_DIR / "minimaltube"
    package.mkdir(parents=True)
    for name in RUNNER_FILES:
        shutil.copyfile(project / "minimaltube" / name, package / name)
    return str(package / "updater.py")


def start_rollback(server_cmd: list, port: int) -> dict:
    """Put back the version the last update replaced, from the rollback folder (the files that
    update replaced or deleted; the ones it added are deleted). Started like start_install().

    Returns:
        dict: {"id", "version": the version going back to, "restart"}.

    Raises:
        UpdateError: There's nothing to go back to, or something else is under way.
    """
    with _lock:
        _refuse_if_busy()
        installed = app_version()
        record = read_json(ROLLBACK_DIR / "backup.json", {})
        if record.get("kind") != "install" or record.get("to") != installed or not record.get("from"):
            raise UpdateError("There's no earlier version to go back to.")
        reason = blocked_reason()
        if reason:
            raise UpdateError(reason["text"], "blocked")
        files = ROLLBACK_DIR / "files"
        put = {rel: str(files.joinpath(*rel.split("/"))) for rel in record.get("replaced", []) + record.get("deleted", [])}
        if not all(Path(src).is_file() for src in put.values()):
            raise UpdateError("The copy of the earlier version is incomplete.")
        before = read_json(ROLLBACK_DIR / "installed.json", {})
        apply = {
            "format": PLAN_FORMAT, "kind": "rollback", "id": uuid.uuid4().hex, "project": str(PROJECT_DIR),
            "version": record["from"], "from": installed, "put": put, "delete": list(record.get("added", [])),
            "exec": [], "edited": [], "installed": before if before.get("files") else None,
            "restart": any(_restarts_server(rel) for rel in [*put, *record.get("added", [])]),
            "requirements": False, "installer": any(rel.startswith("installer/") for rel in put),
            "server_pid": os.getpid(), "server_cmd": list(server_cmd), "port": int(port),
            "runner": _copy_runner(PROJECT_DIR),
        }
        _launch(apply)
        _save_state(skipped=installed)  # automatic updates don't bring it straight back
        return {"id": apply["id"], "version": apply["version"], "restart": apply["restart"]}


# ---------------------------------------------------------------- the installing process
class _Journal:
    """journal.json, kept up to date by the installing process (the server wrote its start)."""

    def __init__(self, plan: dict):
        self.data = _journal()
        if self.data.get("id") != plan.get("id"):
            self.data = {"format": JOURNAL_FORMAT, "id": plan.get("id"), "kind": plan.get("kind"),
                         "version": plan.get("version"), "from": plan.get("from"),
                         "project": plan.get("project"), "runner": plan.get("runner"),
                         "plan": str(APPLY_PLAN), "restart": plan.get("restart"), "started": time.time()}

    def set(self, **changes) -> None:
        self.data.update(changes, updated=time.time())
        _write_journal(self.data)


def _target(project: Path, rel: str) -> Path:
    # where a file of the release goes: inside the project folder, even through links in it
    parts = rel.split("/")
    for part in parts:
        _check_part(part)
    path = project.joinpath(*parts)
    folder = path.parent
    while not folder.exists():
        folder = folder.parent
    if not folder.resolve().is_relative_to(project.resolve()):
        raise UpdateError(f"{rel} would end up outside MinimalTube's folder")
    return path


def _retry(action, tries: int = 30) -> None:
    # Windows: a file something reads right now can't be replaced or deleted for a moment
    for attempt in range(tries):
        try:
            action()
            return
        except PermissionError:
            if not WINDOWS or attempt == tries - 1:
                raise
            time.sleep(0.1 * min(attempt + 1, 10))


def _put_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f"{dst.name}.mt-update")
    try:
        shutil.copyfile(src, tmp)
        shutil.copymode(src, tmp)
        _retry(lambda: replace_file(tmp, dst, tries=1))
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _remove(path: Path, project: Path) -> None:
    if _is_file(path):
        _retry(path.unlink)
    folder = path.parent  # folders the update emptied go too
    try:
        while folder != project and folder.is_relative_to(project) and not any(folder.iterdir()):
            folder.rmdir()
            folder = folder.parent
    except OSError:
        pass


def _wait_server_stopped(plan: dict) -> None:
    pid, port = plan.get("server_pid") or 0, plan.get("port") or 0
    deadline = time.time() + 45
    while pid and pid_alive(pid):
        if time.time() > deadline:
            raise UpdateError("the server didn't stop, so nothing was changed")
        time.sleep(0.2)
    deadline = time.time() + 15
    while port and not port_is_free("127.0.0.1", port) and time.time() < deadline:
        time.sleep(0.25)


def _backup(plan: dict, journal: _Journal) -> None:
    journal.set(phase="backup")
    project = Path(plan["project"])
    shutil.rmtree(APPLY_BACKUP, ignore_errors=True)
    files = APPLY_BACKUP / "files"
    files.mkdir(parents=True)
    record = {"id": plan["id"], "kind": plan["kind"], "from": plan["from"], "to": plan["version"],
              "at": time.time(), "replaced": [], "added": [], "deleted": []}
    for rel in sorted(plan["put"]):
        dst = _target(project, rel)
        if dst.is_dir() and not dst.is_symlink():
            raise UpdateError(f"{rel} is a folder here, where the release has a file")
        if _is_file(dst):
            copy = files.joinpath(*rel.split("/"))
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dst, copy, follow_symlinks=False)
            record["replaced"].append(rel)
        else:
            record["added"].append(rel)
    for rel in sorted(plan["delete"]):
        dst = _target(project, rel)
        if _is_file(dst):
            copy = files.joinpath(*rel.split("/"))
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dst, copy, follow_symlinks=False)
            record["deleted"].append(rel)
    if INSTALLED.is_file():
        shutil.copy2(INSTALLED, APPLY_BACKUP / "installed.json")
    data = APPLY_BACKUP / "data"  # the user's playlists and the rest, should a new version spoil them
    data.mkdir()
    for f in data_dir().glob("*.json"):
        shutil.copy2(f, data / f.name)
    # written last: an install that broke off before this changed nothing yet
    if not write_json_atomic(APPLY_BACKUP / "backup.json", record, "update"):
        raise UpdateError("couldn't keep a copy of the files the update replaces")


def _swap(plan: dict) -> None:
    project = Path(plan["project"])
    # sorted: minimaltube/ (what the native host imports) comes before minimaltube_host.py, and
    # server.py last
    for rel in sorted(plan["put"]):
        _put_file(Path(plan["put"][rel]), _target(project, rel))
    for rel in sorted(plan["delete"]):
        _remove(_target(project, rel), project)
    for rel in plan.get("exec") or []:
        path = _target(project, rel)
        if path.is_file() and not path.is_symlink():
            _make_executable(path)


def _write_installed(plan: dict) -> None:
    if plan.get("installed"):
        write_json_atomic(INSTALLED, plan["installed"], "update")
    else:
        INSTALLED.unlink(missing_ok=True)


def _undo(plan: dict) -> bool:
    record = read_json(APPLY_BACKUP / "backup.json", {})
    if record.get("id") != plan.get("id"):
        return False  # the copies weren't complete, so nothing had been changed
    project = Path(plan["project"])
    files = APPLY_BACKUP / "files"
    for rel in record.get("replaced", []) + record.get("deleted", []):
        _put_file(files.joinpath(*rel.split("/")), _target(project, rel))
    for rel in record.get("added", []):
        _remove(_target(project, rel), project)
    before = APPLY_BACKUP / "installed.json"
    if before.is_file():
        shutil.copy2(before, INSTALLED)
    else:
        INSTALLED.unlink(missing_ok=True)
    return True


def _keep_backup(plan: dict) -> None:
    # an install's copies become the rollback folder; after a rollback there's nothing to keep
    shutil.rmtree(ROLLBACK_DIR, ignore_errors=True)
    if plan["kind"] == "install" and APPLY_BACKUP.is_dir():
        os.replace(APPLY_BACKUP, ROLLBACK_DIR)
    else:
        shutil.rmtree(APPLY_BACKUP, ignore_errors=True)


def _run_logged(cmd: list, timeout: int) -> int:
    print(f"[update] running: {' '.join(str(c) for c in cmd)}", flush=True)
    try:
        return subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr,
                              timeout=timeout).returncode
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"[update] {e}", flush=True)
        return 1


def _after_swap(plan: dict) -> list:
    # what the changed files need: the server's packages, the installer's generated files
    notes = []
    project = Path(plan["project"])
    if plan.get("requirements"):
        if uses_own_python():
            reqs = []
            for line in (project / "requirements.txt").read_text(encoding="utf-8").splitlines():
                req = line.split("#", 1)[0].strip()
                if req and not req.lower().startswith("yt-dlp"):  # yt-dlp: the own copy (Settings)
                    reqs.append(req)
            if reqs and _run_logged([sys.executable, "-m", "pip", "install", "--upgrade", "--no-input",
                                     "--disable-pip-version-check", "--quiet", *reqs], 900):
                notes.append(f"The server's Python packages didn't update. Run the installer again ({installer_hint()}).")
        else:
            notes.append("The server needs other Python packages now (requirements.txt): install them "
                         f"with your package manager, or run the installer again ({installer_hint()}).")
    if plan.get("installer"):
        if _run_logged([sys.executable, "-X", "utf8", "-B", str(project / "installer" / "install.py"),
                        "--from-update"], 900):
            notes.append(f"The installer ran into a problem (update.log in MinimalTube's folder). Run it again: {installer_hint()}.")
    return notes


def _health(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
            data = json.loads(resp.read())
        return data if isinstance(data, dict) and data.get("app") == "minimaltube" else None
    except Exception:
        return None


def _start_server(plan: dict) -> subprocess.Popen:
    cmd = list(plan["server_cmd"])
    if "--wait-for-port" not in cmd:
        cmd.append("--wait-for-port")
    logs = cache_dir()
    logs.mkdir(parents=True, exist_ok=True)
    print(f"[update] starting the server: {' '.join(cmd)}", flush=True)
    with open(logs / "server.log", "ab") as log:
        return spawn_detached(cmd, cwd=plan["project"], stdout=log, stderr=log)


def _wait_healthy(port: int, version: str, proc: subprocess.Popen, seconds: int = 120) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if proc.poll() is not None:
            raise UpdateError("the server stopped right after starting (see server.log)")
        info = _health(port)
        if info and info.get("version") == version:
            return
        time.sleep(0.5)
    raise UpdateError("the server didn't answer in time (see server.log)")


def _stop(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()


def _start_old_server(plan: dict) -> None:
    if _health(plan["port"]):
        return  # it never stopped (the install broke off before that)
    try:
        _wait_healthy(plan["port"], plan["from"], _start_server(plan), 60)
    except (UpdateError, OSError) as e:
        print(f"[update] the server didn't come back: {e}", flush=True)


def apply_plan(plan_path: Path) -> int:
    """Run an install or rollback (`updater.py apply --plan apply.json`), in the process the server
    started for it; see the module's docstring.

    Returns:
        int: 0 when it's done, 1 when it failed (and what it had changed was put back).
    """
    plan = read_json(Path(plan_path), {})
    if plan.get("format") != PLAN_FORMAT:
        print(f"[update] {plan_path}: not a plan this updater can follow", flush=True)
        return 1
    journal = _Journal(plan)
    print(f"[update] {time.strftime('%Y-%m-%d %H:%M:%S')} {plan['kind']} {plan['from']} -> "
          f"{plan['version']} in {plan['project']}", flush=True)
    server = None
    try:
        journal.set(pid=os.getpid(), phase="waiting")
        if plan.get("restart"):
            _wait_server_stopped(plan)
        _backup(plan, journal)
        journal.set(phase="swapping")
        _swap(plan)
        journal.set(phase="swapped")
        _write_installed(plan)
        journal.set(phase="finishing")
        notes = _after_swap(plan)
        if plan.get("restart"):
            journal.set(phase="starting")
            server = _start_server(plan)
            _wait_healthy(plan["port"], plan["version"], server)
    except BaseException as e:  # Ctrl+C and SystemExit too: never leave half an update behind
        error = str(e) or e.__class__.__name__
        print(f"[update] failed: {error}", flush=True)
        journal.set(phase="undoing", error=error)
        _stop(server)
        try:
            undone = _undo(plan)
        except Exception as undo_error:
            print(f"[update] couldn't put everything back: {undo_error}", flush=True)
            undone = False
        if plan.get("restart"):
            _start_old_server(plan)
        journal.set(phase="failed", undone=undone, finished=time.time())
        return 1
    journal.set(phase="done", notes=notes, edited=plan.get("edited") or [], finished=time.time())
    try:
        _keep_backup(plan)
    except OSError as e:
        print(f"[update] couldn't keep the copies for a rollback: {e}", flush=True)
    print("[update] done", flush=True)
    return 0


def recover() -> int:
    """Finish or undo an install or rollback that was cut off (`updater.py recover`, run by the
    native host before it starts a server). Files all in place: it's finished; otherwise what it
    had changed is put back.

    Returns:
        int: 0, or 2 while the install is still running (the host waits for it then).
    """
    journal = _journal()
    if journal.get("phase") not in ACTIVE:
        return 0
    if _is_running(journal):
        return 2
    plan = read_json(Path(journal.get("plan") or APPLY_PLAN), {})
    if plan.get("id") != journal.get("id"):
        _write_journal(journal | {"phase": "failed", "error": "The update was cut off.", "undone": False,
                                  "finished": time.time()})
        return 0
    entry = _Journal(plan)
    if journal["phase"] in ("swapped", "finishing", "starting"):
        _write_installed(plan)
        entry.set(phase="done", finished=time.time(), edited=plan.get("edited") or [], notes=[
            f"The update was cut off after its files were in place and was finished later. If something "
            f"is missing, run the installer again ({installer_hint()})."])
        try:
            _keep_backup(plan)
        except OSError:
            pass
    else:
        undone = _undo(plan)
        entry.set(phase="failed", error="The update was cut off; what it had changed was put back.",
                  undone=undone, finished=time.time())
    return 0


def main(argv: list) -> int:
    """`updater.py apply --plan <apply.json>` or `updater.py recover`; see the module's docstring."""
    parser = argparse.ArgumentParser(prog="updater.py", description="MinimalTube's updater")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("apply", help="install or roll back as the plan says").add_argument("--plan", required=True)
    commands.add_parser("recover", help="finish or undo an install that was cut off")
    args = parser.parse_args(argv)
    UPDATES_DIR.mkdir(parents=True, exist_ok=True)
    return apply_plan(Path(args.plan)) if args.command == "apply" else recover()
