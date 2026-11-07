"""MinimalTube server - its own copy of yt-dlp.

pip installs it into the app folder (`--target`: no sudo, no system package in the way), so the
app can update it the same way on every OS; a system-wide yt-dlp is only the fallback. Every
install goes into a folder of its own and yt-dlp.json names the one to use, so an update never
touches the copy that's running (Windows can't replace files in use): the server picks the new
one up when it next starts, before anything imports yt-dlp.
"""
from __future__ import annotations  # `str | None` annotations on Python 3.9

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from .config import APP_DIR
from .system import replace_file

POINTER = APP_DIR / "yt-dlp.json"
PYPI_URL = "https://pypi.org/pypi/yt-dlp/json"
_install_lock = threading.Lock()


def _current_dir() -> Path | None:
    try:
        path = APP_DIR / json.loads(POINTER.read_text(encoding="utf-8"))["dir"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return path if (path / "yt_dlp").is_dir() else None


def use_own_copy():
    """Put MinimalTube's own yt-dlp first on sys.path (if there is one) and delete the copies
    it replaced. Call it before anything imports yt_dlp; without an own copy, `import yt_dlp`
    finds the system-wide one.
    """
    current = _current_dir()
    for old in APP_DIR.glob("yt-dlp-*"):
        if old != current:
            shutil.rmtree(old, ignore_errors=True)
    if current:
        sys.path.insert(0, str(current))


def running_own_copy() -> bool:
    """Whether the yt-dlp this process imported is MinimalTube's own copy (else: system-wide)."""
    import yt_dlp  # imported here: this module is loaded before sys.path is set up for it

    return Path(yt_dlp.__file__).resolve().is_relative_to(APP_DIR.resolve())


def up_to_date(running: str) -> bool:
    """Whether PyPI has no newer yt-dlp than `running` (a version such as "2026.10.26").

    Returns False when PyPI can't be asked, so the caller goes ahead and lets pip decide.
    """
    try:
        with urllib.request.urlopen(PYPI_URL, timeout=10) as resp:
            latest = json.loads(resp.read().decode("utf-8"))["info"]["version"]
    except (OSError, ValueError, KeyError, TypeError):
        return False

    # PyPI drops the leading zeros of yt-dlp's dates ("2026.01.05" is "2026.1.5" there)
    def key(version):
        return tuple(int(n) for n in re.findall(r"\d+", version))

    return key(latest) <= key(running)


def _last_line(text: str) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return lines[-1] if lines else ""


def install_latest() -> str:
    """Install the newest yt-dlp, with its usual extras ("yt-dlp[default]"), as MinimalTube's
    own copy. The running process keeps the yt-dlp it started with; the new copy is used from
    the server's next start (and the one it replaces is deleted then).

    Returns:
        str: The version that was installed.

    Raises:
        RuntimeError: pip is missing, already busy with an update, or failed, or the new copy
            doesn't import. The message says which; the copy in use is left as it was.
    """
    if importlib.util.find_spec("pip") is None:
        raise RuntimeError("pip isn't installed for this Python (run the installer again; "
                           "or Arch: python-pip, Debian/Ubuntu: python3-pip)")
    if not _install_lock.acquire(blocking=False):
        raise RuntimeError("an update is already running")
    target = APP_DIR / f"yt-dlp-{time.time_ns()}"
    done = False
    try:
        pip = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--upgrade", "--no-input",
             "--disable-pip-version-check", "--target", str(target), "yt-dlp[default]"],
            capture_output=True, text=True, timeout=600)
        if pip.returncode:
            raise RuntimeError(_last_line(pip.stderr) or _last_line(pip.stdout) or "pip failed")
        check = subprocess.run(
            [sys.executable, "-I", "-B", "-c",
             "import sys; sys.path.insert(0, sys.argv[1]); import yt_dlp; print(yt_dlp.version.__version__)",
             str(target)],
            capture_output=True, text=True, timeout=120)
        version = check.stdout.strip()
        if check.returncode or not version:
            raise RuntimeError(f"the new copy doesn't start: {_last_line(check.stderr) or 'no version'}")
        tmp = POINTER.with_suffix(".tmp")
        tmp.write_text(json.dumps({"dir": target.name, "version": version}), encoding="utf-8")
        replace_file(tmp, POINTER)
        done = True
        return version
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuntimeError(f"pip didn't finish: {e}") from e
    finally:
        if not done:
            shutil.rmtree(target, ignore_errors=True)
        _install_lock.release()
