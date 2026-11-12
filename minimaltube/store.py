"""MinimalTube server - the JSON files: titles, the Downloads order, saved playlists."""
import re
import threading
from pathlib import Path

from .config import CACHE_DIR, DATA_DIR, ORIGINAL_TITLES_MAX, PLAYLIST_ID_RE, VIDEO_ID_RE
from .jsonfile import read_json, write_json_atomic
from .links import thumbnail_url, watch_url, youtube_ids
from .media import (
    cached_path,
    card_info,
    remember_chapters,
    remember_description,
    remember_meta,
    remember_release_date,
)

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

def forget_title(video_id: str):
    with titles_lock:
        if titles.pop(video_id, None) is None:
            return
        write_json_atomic(titles_path(), titles, "titles")

def remember_video(video_id: str, info: dict):
    """Keep what a full lookup of a video (ytinfo.video_info) tells about it, for later and for
    offline: its title, description, chapters, release date and meta (views, length, channel).

    Args:
        video_id (str): An 11-character YouTube video id.
        info (dict): yt-dlp's info of that video.

    Returns:
        tuple: (release date "YYYY-MM-DD" or None, the saved meta dict or None).
    """
    remember_title(video_id, info.get("title"))
    remember_description(video_id, info.get("description") or "")  # "": checked, it has none
    remember_chapters(video_id, info)
    return remember_release_date(video_id, info), remember_meta(video_id, info)

# ---- Original titles -------------------------------------------------------------
# Channel listings (the feed, playlists) come back in YouTube's *translated* title when the
# uploader added one (e.g. an English title on a Turkish video). A lookup of the video itself
# gives the title in its own language, so those are kept in original_titles.json and used
# instead (lookups.py fills it). Videos opened / downloaded already have theirs in titles.json.
original_titles_lock = threading.Lock()

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

def original_title(video_id: str, listed=None):
    """The video's own-language title if known, else the one the listing gave."""
    return titles.get(video_id) or original_titles.get(video_id) or listed

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

def drop_from_order(video_id: str):
    if video_id in library_order:
        save_order([i for i in library_order if i != video_id])

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

def find_playlist(playlist_id: str):
    """The saved playlist with this id, or None. Caller must hold playlists_lock."""
    return next((p for p in saved_playlists if p.get("id") == playlist_id), None)

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
            vid = youtube_ids(url)[0]
        if not vid:
            skipped += 1
            continue
        canonical = watch_url(vid)
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
