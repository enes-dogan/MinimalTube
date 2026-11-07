"""MinimalTube server - subtitles."""
import threading
from pathlib import Path

from .config import CACHE_DIR
from .media import subtitle_path
from .sublang import choose_subtitle_track
from .system import replace_file
from .ytinfo import video_info, ydl

SUBLANG_RULE = "2"


def download_subtitle(video_id: str, url: str, lang: str, is_auto: bool):
    try:
        sub_opts = {
            "skip_download": True,
            "writesubtitles": not is_auto,
            "writeautomaticsub": is_auto,
            "subtitleslangs": [lang],
            "subtitlesformat": "vtt",
            "outtmpl": str(CACHE_DIR / f"{video_id}.%(ext)s"),
            "noplaylist": True,
        }
        with ydl(**sub_opts) as y:
            y.download([url])
    except Exception as e:
        print(f"[subtitles] {video_id}: couldn't fetch {lang} (auto={is_auto}): {e}")
        return

    produced = CACHE_DIR / f"{video_id}.{lang}.vtt"
    try:
        if produced.exists() and produced != subtitle_path(video_id):
            replace_file(produced, subtitle_path(video_id))
    except OSError as e:
        print(f"[subtitles] {video_id}: couldn't finalize file: {e}")

def sublang_path(video_id: str) -> Path:
    """Records which caption rule picked this video's captions ('<rule>:<track>')."""
    return CACHE_DIR / f"{video_id}.sublang"

def sublang_current(video_id: str) -> bool:
    try:
        return sublang_path(video_id).read_text(encoding="utf-8").startswith(f"{SUBLANG_RULE}:")
    except OSError:
        return False

def drop_stale_subtitle(video_id: str):
    if sublang_current(video_id):
        return
    try:
        subtitle_path(video_id).unlink()
    except OSError:
        pass

def fetch_original_subtitle(video_id: str, url: str, info: dict):
    drop_stale_subtitle(video_id)
    lang, is_auto = choose_subtitle_track(info)
    if lang:
        download_subtitle(video_id, url, lang, is_auto)
    try:
        sublang_path(video_id).write_text(f"{SUBLANG_RULE}:{lang or '-'}", encoding="utf-8")
    except OSError:
        pass

subtitle_backfill_attempted = set()

subtitle_backfill_lock = threading.Lock()

def ensure_subtitle_backfill(video_id: str, url: str):
    if sublang_current(video_id):
        return
    drop_stale_subtitle(video_id)
    with subtitle_backfill_lock:
        if video_id in subtitle_backfill_attempted:
            return
        subtitle_backfill_attempted.add(video_id)

    def worker():
        try:
            info = video_info(url)
        except Exception:
            return
        fetch_original_subtitle(video_id, url, info)

    threading.Thread(target=worker, daemon=True).start()
