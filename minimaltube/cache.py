"""MinimalTube server - keeping the cache folder in bounds.

Downloads older than CACHE_MAX_AGE_DAYS go, the oldest go first when together they take more than
the size cap (set in Settings, kept in DATA_DIR/settings.json), and thumbnails nothing has shown
for CACHE_MAX_AGE_DAYS go too. A sweep runs when the server starts, every few hours after that,
and (the size cap only) after each download.
"""
import time
from pathlib import Path

from .config import (
    CACHE_DIR,
    CACHE_MAINTENANCE_INTERVAL_SECONDS,
    CACHE_MAX_AGE_DAYS,
    CACHE_MAX_BYTES,
    DATA_DIR,
    VIDEO_ID_RE,
)
from .jsonfile import read_json, write_json_atomic
from .media import THUMB_NAMES, cached_path, remove_video_files

CACHE_LIMIT_GB_MIN, CACHE_LIMIT_GB_MAX = 16, 1024


def cache_files():
    return list(CACHE_DIR.glob("*.mp4"))

def remove_download(f: Path):
    """The sweep removes a download with every file kept for it, as deleting it in the app does:
    the feed doesn't read them, and playing the video again fetches them anew."""
    if VIDEO_ID_RE.match(f.stem):
        remove_video_files(f.stem)
    else:
        f.unlink()

def cleanup_old_files():
    cutoff = time.time() - CACHE_MAX_AGE_DAYS * 86400
    for f in cache_files():
        try:
            if f.stat().st_mtime < cutoff:
                remove_download(f)
                print(f"[cache] removed (older than {CACHE_MAX_AGE_DAYS}d): {f.name}")
        except OSError:  # gone already, or in use (Windows won't delete it): the next sweep
            pass

def _settings_path() -> Path:
    return DATA_DIR / "settings.json"

def cache_limit_gb() -> int:
    """The downloads' size cap in GB: the one set in Settings, else CACHE_MAX_BYTES."""
    gb = read_json(_settings_path(), {}).get("cache_max_gb")
    if isinstance(gb, int) and not isinstance(gb, bool) and CACHE_LIMIT_GB_MIN <= gb <= CACHE_LIMIT_GB_MAX:
        return gb
    return CACHE_MAX_BYTES // 1024 ** 3

def downloads_bytes() -> int:
    total = 0
    for f in cache_files():
        try:
            total += f.stat().st_size
        except OSError:
            pass
    return total

def set_cache_limit_gb(gb: int):
    """Save a new size cap (the caller checked it: an int in range, not below downloads_bytes()).

    Raises:
        OSError: settings.json couldn't be written.
    """
    settings = read_json(_settings_path(), {})
    settings["cache_max_gb"] = gb
    if not write_json_atomic(_settings_path(), settings, "settings"):
        raise OSError("couldn't save the size cap")

def enforce_cache_size_limit():
    files = []
    for f in cache_files():
        try:
            st = f.stat()
        except OSError:  # deleted since it was listed (in the app, or by the other sweep)
            continue
        files.append((st.st_mtime, st.st_size, f))
    files.sort(key=lambda entry: entry[0])
    total = sum(size for _mtime, size, _f in files)
    limit_gb = cache_limit_gb()
    for _mtime, size, f in files:
        if total <= limit_gb * 1024 ** 3:
            break
        try:
            remove_download(f)
        except OSError:  # gone already, or in use (Windows won't delete it): the next sweep
            continue
        total -= size
        print(f"[cache] removed (size cap {limit_gb}GB): {f.name}")

def cleanup_unused_thumbnails():
    """Thumbnails of videos that aren't downloaded go once nothing has shown them for
    CACHE_MAX_AGE_DAYS (a download's thumbnail goes with the download)."""
    cutoff = time.time() - CACHE_MAX_AGE_DAYS * 86400
    removed = 0
    for f in [*CACHE_DIR.glob("*.jpg"), *CACHE_DIR.glob("*.webp")]:
        vid = f.name.split(".", 1)[0]  # <id>.jpg and the large <id>.hq.webp / .hq.jpg
        try:
            if (VIDEO_ID_RE.match(vid) and f.name in [n.format(id=vid) for n in THUMB_NAMES]
                    and not cached_path(vid).exists() and f.stat().st_mtime < cutoff):
                f.unlink()
                removed += 1
        except OSError:  # gone already, or in use (Windows won't delete it): the next sweep
            pass
    if removed:
        print(f"[cache] removed {removed} thumbnails not shown for {CACHE_MAX_AGE_DAYS}d")

def run_cache_maintenance():
    # each step on its own: one that fails must neither skip the others nor end the loop below
    for step in (cleanup_old_files, enforce_cache_size_limit, cleanup_unused_thumbnails):
        try:
            step()
        except Exception as e:
            print(f"[cache] {step.__name__} failed: {e}")

def cache_maintenance_loop():
    while True:
        time.sleep(CACHE_MAINTENANCE_INTERVAL_SECONDS)
        run_cache_maintenance()
