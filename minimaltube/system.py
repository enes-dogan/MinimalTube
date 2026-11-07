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

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

WINDOWS = sys.platform == "win32"
MACOS = sys.platform == "darwin"


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


def own_python() -> Path:
    """MinimalTube's own Python, where the installer puts one (it may not exist)."""
    root = app_dir() / "python"
    return root / "python.exe" if WINDOWS else root / "bin" / "python3"


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
    """How to run the installer on this OS, for messages."""
    return "install.cmd" if WINDOWS else "./install.sh"
