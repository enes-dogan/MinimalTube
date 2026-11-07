"""MinimalTube server - store."""
import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import wait as futures_wait
from pathlib import Path
from urllib.parse import urlparse

from .config import (
    CACHE_DIR,
    DATA_DIR,
    ORIGINAL_TITLES_MAX,
    PLAYLIST_ID_RE,
    SHORTS_LIVE_RE,
    VIDEO_ID_RE,
)
from .media import cached_path, card_info, thumbnail_url, video_id_from_url
from .system import replace_file
from .ytinfo import video_meta


def write_json_atomic(path, data, label: str):
    """Write JSON through a temp file so a crash can never leave a half file."""
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        replace_file(tmp, path)
    except OSError as e:
        print(f"[{label}] couldn't save {path.name}: {e}")


def read_json(path, default):
    """Parse a JSON file, falling back to `default` when it is missing or broken."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
    return data if isinstance(data, type(default)) else default

titles_lock = threading.Lock()

def titles_path() -> Path:
    return CACHE_DIR / "titles.json"

titles = read_json(titles_path(), {})

def remember_title(video_id: str, title):
    if not video_id or not title:
        return
    with titles_lock:
        if titles.get(video_id) == title:
            return
        titles[video_id] = title
        write_json_atomic(titles_path(), titles, "titles")

original_titles_lock = threading.Lock()

original_title_failed = set()

original_title_pending = {}

original_title_pool = ThreadPoolExecutor(max_workers=6)

def original_titles_path() -> Path:
    return CACHE_DIR / "original_titles.json"

original_titles = read_json(original_titles_path(), {})

def remember_original_titles(found: dict):
    """{video id: own-language title}, saved in one write."""
    with original_titles_lock:
        new = {k: v for k, v in found.items() if k and v and original_titles.get(k) != v}
        if not new:
            return
        original_titles.update(new)
        if len(original_titles) > ORIGINAL_TITLES_MAX:
            for k in list(original_titles)[: ORIGINAL_TITLES_MAX // 4]:
                original_titles.pop(k, None)
        write_json_atomic(original_titles_path(), original_titles, "titles")

def remember_original_title(video_id: str, title):
    remember_original_titles({video_id: title})

def original_title(video_id: str, listed=None):
    """The video's own-language title if known, else the one the listing gave."""
    return titles.get(video_id) or original_titles.get(video_id) or listed

def _lookup_original_title(video_id: str):
    try:
        info = video_meta(video_id)
        title = info.get("title")
        if title:
            remember_original_title(video_id, title)
        else:
            original_title_failed.add(video_id)
    except Exception:
        original_title_failed.add(video_id)
    finally:
        with original_titles_lock:
            original_title_pending.pop(video_id, None)

def ensure_original_titles(ids, wait: float = 0) -> int:
    """Look up the original title of every id not known yet (in the background, 6 at a time);
    optionally wait up to `wait` seconds. Returns how many are still being looked up."""
    futs = []
    with original_titles_lock:
        for vid in dict.fromkeys(ids):
            if (not vid or vid in titles or vid in original_titles
                    or vid in original_title_failed):
                continue
            fut = original_title_pending.get(vid)
            if fut is None:
                fut = original_title_pending[vid] = original_title_pool.submit(
                    _lookup_original_title, vid)
            futs.append(fut)
    if wait and futs:
        futures_wait(futs, timeout=wait)
    return sum(1 for fut in futs if not fut.done())

# User-defined order of the "Downloaded" list (list of video ids).
order_lock = threading.Lock()

def order_path() -> Path:
    return DATA_DIR / "order.json"

library_order = [i for i in read_json(order_path(), []) if isinstance(i, str)]

def save_order(ids: list):
    global library_order
    with order_lock:
        library_order = list(ids)
        write_json_atomic(order_path(), library_order, "order")

# Named, user-saved playlists (snapshots of the queue). Stored on their own in
# playlists.json so they never touch the remembered queue or the library order.
playlists_lock = threading.Lock()

def playlists_path() -> Path:
    return DATA_DIR / "playlists.json"

saved_playlists = [p for p in read_json(playlists_path(), [])
                   if isinstance(p, dict) and PLAYLIST_ID_RE.match(str(p.get("id", "")))
                   and isinstance(p.get("items"), list)]

def write_playlists():
    """Caller must hold playlists_lock."""
    write_json_atomic(playlists_path(), saved_playlists, "playlists")

def forget_title(video_id: str):
    with titles_lock:
        if titles.pop(video_id, None) is None:
            return
        write_json_atomic(titles_path(), titles, "titles")

def clean_playlist_items(raw) -> tuple:
    """Validate queue items from the player -> (items, skipped_count).

    Each kept item stores the video's id, title, canonical url and the path of
    its offline copy (None if it isn't downloaded yet)."""
    items, skipped = [], 0
    for entry in (raw if isinstance(raw, list) else []):
        if not isinstance(entry, dict):
            skipped += 1
            continue
        url = str(entry.get("url") or "").strip()
        vid = entry.get("id")
        if not (isinstance(vid, str) and VIDEO_ID_RE.match(vid)):
            vid = video_id_from_url(url) if url else None
        if not (vid and VIDEO_ID_RE.match(vid)):
            m = SHORTS_LIVE_RE.search(urlparse(url).path) if url else None
            vid = m.group(1) if m else None
        if not vid:
            skipped += 1
            continue
        canonical = f"https://www.youtube.com/watch?v={vid}"
        title = str(entry.get("title") or "").strip()
        if not title or title == url or re.match(r"^https?://", title):
            title = titles.get(vid) or canonical
        path = cached_path(vid)
        item = {
            "id": vid,
            "title": title,
            "url": canonical,
            "file": str(path) if path.exists() else None,
        }
        dur = entry.get("duration")
        if isinstance(dur, (int, float)) and not isinstance(dur, bool) and dur > 0:
            item["duration"] = float(dur)
        items.append(item)
    return items, skipped

def playlist_public(p: dict) -> dict:
    """What the player sees: stored metadata plus the *current* offline state."""
    items = []
    for it in p.get("items", []):
        path = cached_path(it["id"]) if VIDEO_ID_RE.match(str(it.get("id", ""))) else None
        have = bool(path and path.exists())
        items.append({**it, "file": str(path) if have else None, "downloaded": have,
                      "thumbnail": thumbnail_url(it.get("id", "")),
                      **(card_info(it["id"]) if path else {})})
    return {"id": p["id"], "name": p.get("name", ""), "created": p.get("created"),
            "updated": p.get("updated"), "count": len(items), "items": items,
            "yt": p.get("yt")}
