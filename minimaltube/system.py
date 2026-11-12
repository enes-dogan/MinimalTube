"""MinimalTube - what differs between Linux, macOS and Windows, in one place.

Nothing here runs on import (no folders are made), so the native host and the installer use it
as well as the server.

Where things are kept:

             cache (downloads)              data (playlists, subscriptions)   app (own Python, yt-dlp, tools)
  Linux      ~/.cache/minimaltube           ~/.local/share/minimaltube        same as data
  macOS      ~/Library/Caches/MinimalTube   ~/Library/Application Support/MinimalTube   same as data
  Windows    %LOCALAPPDATA%/MinimalTube/Cache   %APPDATA%/MinimalTube        %LOCALAPPDATA%/MinimalTube
"""
from __future__ import annotations  # `str | None` annotations on Python 3.9

import base64
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

WINDOWS = sys.platform == "win32"
MACOS = sys.platform == "darwin"

# The server listens on SERVER_PORT, or on the next free one of SERVER_PORTS when another program
# has that (the extension looks for it on the same ports: js/common.js).
SERVER_PORT = 7860
SERVER_PORTS = 10


def _local_appdata() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")


def cache_dir() -> Path:
    """Downloads, thumbnails and the server log: what may be thrown away."""
    if WINDOWS:
        return _local_appdata() / "MinimalTube" / "Cache"
    if MACOS:
        return Path.home() / "Library" / "Caches" / "MinimalTube"
    return Path.home() / ".cache" / "minimaltube"


def data_dir() -> Path:
    """What the user made (playlists, subscriptions, the Downloads order), kept apart from the
    cache, which cache cleaners empty."""
    if WINDOWS:
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "MinimalTube"
    if MACOS:
        return Path.home() / "Library" / "Application Support" / "MinimalTube"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "minimaltube"


def app_dir() -> Path:
    """What MinimalTube installed for itself: its own Python (python/), its yt-dlp copies and the
    tools the installer fetched (bin/). On Windows that stays out of the roaming profile."""
    return _local_appdata() / "MinimalTube" if WINDOWS else data_dir()


def bin_dir() -> Path:
    """ffmpeg, ffprobe and deno, when the installer had to fetch them (none on the system)."""
    return app_dir() / "bin"


def extension_id(manifest) -> str | None:
    """The id Chromium gives the extension a manifest.json belongs to.

    It follows from the manifest's "key": the SHA-256 of that public key, its first 32 hex digits
    written with the letters a-p, so it is the same on every machine.

    Args:
        manifest (str | Path): The extension's manifest.json.

    Returns:
        str | None: The 32-letter id, or None when the file can't be read or has no "key" (the
        browser then picks an id of its own).
    """
    try:
        key = json.loads(Path(manifest).read_text(encoding="utf-8"))["key"]
        digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return digest.translate(str.maketrans("0123456789abcdef", "abcdefghijklmnop"))


def port_is_free(host: str, port: int) -> bool:
    """Whether nothing listens on host:port right now (it can be bound)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def use_own_tools() -> None:
    """Put bin_dir() first on PATH, then the places a browser started from a desktop launcher
    often leaves out (Homebrew on macOS, ~/.local/bin, Flatpak on Linux). ffmpeg, ffprobe and
    deno are found through PATH, by the server and by yt-dlp."""
    home = Path.home()
    if WINDOWS:
        extra = []
    elif MACOS:
        extra = [Path("/opt/homebrew/bin"), Path("/usr/local/bin"), Path("/opt/local/bin"),
                 home / ".deno" / "bin", Path("/usr/bin"), Path("/bin")]
    else:
        extra = [home / ".local" / "bin", home / "bin", Path("/usr/local/bin"), Path("/usr/bin"),
                 Path("/bin"), Path("/snap/bin"), Path("/var/lib/flatpak/exports/bin"),
                 home / ".local/share/flatpak/exports/bin", home / ".deno" / "bin"]
    current = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    first = str(bin_dir())
    rest = [p for p in current if p != first]
    rest += [str(d) for d in extra if str(d) not in rest]
    os.environ["PATH"] = os.pathsep.join([first, *rest])


def replace_file(src, dst, tries: int = 10) -> None:
    """os.replace(src, dst), riding out Windows' file locks.

    On Windows a file another thread has open (a reader of that JSON, a range request for that
    video) can't be replaced for a moment and raises PermissionError; this tries again for up to
    about 3 s. Elsewhere it is plain os.replace.

    Args:
        src, dst (str | Path): As for os.replace.
        tries (int): Attempts before the PermissionError is let through.
    """
    for attempt in range(tries):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if not WINDOWS or attempt == tries - 1:
                raise
            time.sleep(0.05 * (attempt + 1))


def spawn_detached(cmd: list, cwd=None, stdout=None, stderr=None) -> subprocess.Popen:
    """Start a process that outlives this one (the server, from the native host or a restart).

    POSIX: it gets a session of its own. Windows: a process group of its own, out of the
    browser's job object when the job allows it (else the browser could take it down with the
    native host), and a console that never shows: the ffmpeg and deno it runs share that console
    instead of each opening a window of their own.

    Args:
        cmd (list[str]): The command line.
        cwd (str | Path | None): Its working folder.
        stdout, stderr: Where its output goes (a file, or None to inherit ours). The native host
            must never pass None: its stdout is the channel to the browser.

    Returns:
        subprocess.Popen: The started process.
    """
    kwargs = dict(cwd=None if cwd is None else str(cwd), stdin=subprocess.DEVNULL,
                  stdout=stdout, stderr=stderr)
    if not WINDOWS:
        return subprocess.Popen(cmd, start_new_session=True, **kwargs)
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        return subprocess.Popen(cmd, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kwargs)
    except OSError:  # this job doesn't allow breaking away: stay in it
        return subprocess.Popen(cmd, creationflags=flags, **kwargs)


def run_again(windows_arg: str | None = None) -> None:
    """Run this program again in place of the running one (the server, after an update). Never
    returns.

    POSIX replaces the process: same PID, same terminal or log. Windows has no real exec, so a new
    process starts with the same command line into the same log, and this one ends.

    Args:
        windows_arg (str | None): Added to the new process's command line on Windows: the flag
            that tells it to wait until this one has let go of what it holds (the port).
    """
    sys.stdout.flush()
    sys.stderr.flush()
    argv = list(getattr(sys, "orig_argv", None) or [sys.executable, "-u", *sys.argv])
    if not WINDOWS:
        os.execv(sys.executable, argv)
    if windows_arg and windows_arg not in argv:
        argv.append(windows_arg)
    spawn_detached(argv, cwd=os.getcwd(), stdout=sys.stdout, stderr=sys.stderr)
    os._exit(0)


def open_folder(path) -> None:
    """Show a folder in the system's file manager.

    Raises:
        RuntimeError: No file manager could be found (Linux without xdg-open).
    """
    if WINDOWS:
        os.startfile(str(path))  # Explorer
        return
    quiet = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                 stderr=subprocess.DEVNULL, start_new_session=True)
    if MACOS:
        subprocess.Popen(["open", str(path)], **quiet)  # Finder
        return
    for fm in ("dolphin", "nautilus", "nemo", "thunar", "pcmanfm"):
        if shutil.which(fm):
            subprocess.Popen([fm, str(path)], **quiet)
            return
    if not shutil.which("xdg-open"):
        raise RuntimeError("no file manager found (tried dolphin, nautilus, nemo, thunar, pcmanfm, xdg-open)")
    subprocess.Popen(["xdg-open", str(path)], **quiet)


def installer_hint() -> str:
    """The installer to run on this OS, for messages (the extension names the same ones)."""
    if WINDOWS:
        return "install.cmd"
    return "install.command" if MACOS else "./install.sh"
