"""MinimalTube server - the one place that asks yt-dlp about videos.

`ydl(**opts)` is yt-dlp with MinimalTube's quiet defaults. `video_info()` is a full lookup of
one video (no download); results are kept for a few minutes and simultaneous requests for
the same video share one lookup, so /prepare, /description, /chapters, /channel-of and the
caption check don't each ask YouTube again (fewer requests, fewer "confirm you're not a bot").
`video_meta()` is the light one for the feed: title, upload time and length only.
"""
from __future__ import annotations  # `float | None` annotations on Python 3.9

import threading
import time
from datetime import datetime, timezone

import yt_dlp

from .links import watch_url, youtube_ids

QUIET = {"quiet": True, "no_warnings": True, "noprogress": True}
INFO_TTL = 300        # seconds a lookup is reused (stream URLs stay valid for hours)
INFO_KEEP = 24        # lookups kept at once (each is a few hundred KB)

_cache = {}           # key -> (time, info)
_inflight = {}        # key -> Event set when that lookup finishes
_lock = threading.Lock()


def ydl(**opts):
    return yt_dlp.YoutubeDL({**QUIET, **opts})


def _target(video):
    """A video id or a URL -> (cache key, URL to ask yt-dlp); any URL form of a video shares
    its id as the key."""
    video_id = youtube_ids(video)[0]
    return (video_id, watch_url(video_id)) if video_id else (video, video)


def upload_timestamp(info) -> float | None:
    """When a video came out, as a Unix time, from yt-dlp's info of it (a full or light lookup,
    or a channel listing's entry): its release or upload time, else its upload day at UTC
    midnight. None when the info has neither."""
    ts = info.get("release_timestamp") or info.get("timestamp")
    if not ts and info.get("upload_date"):
        try:
            ts = datetime.strptime(str(info["upload_date"]), "%Y%m%d").replace(
                tzinfo=timezone.utc).timestamp()
        except ValueError:
            ts = None
    try:
        return float(ts) if ts else None
    except (TypeError, ValueError):
        return None


def video_info(video: str, *, fresh: bool = False, keep: bool = True):
    """Full info of one video, by id or URL.

    fresh: always ask YouTube (e.g. new stream URLs); keep=False: don't cache (bulk lookups).
    """
    key, url = _target(video)
    while True:
        with _lock:
            hit = _cache.get(key)
            if hit and not fresh and time.time() - hit[0] < INFO_TTL:
                return hit[1]
            waiting = _inflight.get(key)
            if not waiting:
                _inflight[key] = threading.Event()
                break
        waiting.wait(60)  # someone else is looking it up: use their result
        fresh = False
    try:
        with ydl(skip_download=True, noplaylist=True) as y:
            info = y.extract_info(url, download=False)
        if keep:
            with _lock:
                now = time.time()
                _cache[key] = (now, info)
                if info.get("id"):
                    _cache[info["id"]] = (now, info)
                while len(_cache) > INFO_KEEP:
                    _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
        return info
    finally:
        with _lock:
            _inflight.pop(key).set()


# Just YouTube's player API (about 0.2 s): no watch page, player code or formats. The watch page
# (about a second) is the fallback when that doesn't answer.
META_ARGS = (
    {"player_client": ["web"], "player_skip": ["webpage", "configs", "js", "initial_data"],
     "skip": ["dash", "hls"]},
    {"player_client": ["web"], "player_skip": ["js"], "skip": ["dash", "hls"]},
)


def video_meta(video: str):
    """Title, upload time and length of one video, by id or URL (not cached: bulk lookups)."""
    url = _target(video)[1]
    for i, args in enumerate(META_ARGS):
        last = i == len(META_ARGS) - 1
        try:
            with ydl(skip_download=True, noplaylist=True, ignore_no_formats_error=True,
                     extractor_args={"youtube": args}) as y:
                info = y.extract_info(url, download=False)
        except Exception:
            if last:
                raise
            continue
        if last or info.get("timestamp") or info.get("upload_date"):
            return info
