"""MinimalTube server - looking up videos nobody has opened yet, in the background.

The feed, a playlist's cards and the queue's rows all show things about videos that were never
played: a Short's upload time and length, a video's own-language title, a card's channel, views
and upload day. One light request per video (ytinfo.video_meta: YouTube's player API, about
0.2 s) answers all of them, so this is the one place that makes it: a single pool, and a video is
looked up once whoever asked first. What a lookup learns is kept where each part is read from:

    exact upload time, length    FACTS (video_info.json in the cache folder)
    own-language title           store.original_titles (original_titles.json)
    channel, views, upload day   the video's <id>.meta.json and <id>.date (only when asked: `card`)

Nothing here blocks a request: `request()` starts the lookups and says which are still running,
and the app asks again a moment later.
"""
from __future__ import annotations  # `int | None` annotations on Python 3.9

import json
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from .config import CACHE_DIR, VIDEO_ID_RE
from .jsonfile import read_json, write_json_atomic
from .links import watch_url
from .media import cached_meta, remember_meta, remember_release_date
from .store import remember_original_titles
from .ytinfo import upload_timestamp, video_meta

FACTS = {}            # video id -> {"ts": exact upload time or None, "dur": seconds or None}
FACTS_MAX = 20000     # the oldest quarter goes when there are more

_pool = ThreadPoolExecutor(max_workers=8)
_lock = threading.Lock()
_pending = {}         # video id -> Future of its lookup
_looked_up = {}       # video id -> whether that lookup kept the card's info too (this run)
_failed = set()       # lookups that raised (this run): not tried again


def facts_path():
    return CACHE_DIR / "video_info.json"


def _save_facts():
    with _lock:
        if len(FACTS) > FACTS_MAX:
            for video_id in list(FACTS)[: FACTS_MAX // 4]:
                FACTS.pop(video_id, None)
        snapshot = dict(FACTS)
    write_json_atomic(facts_path(), snapshot, "lookups")


def _oembed_author(video_id: str):
    req = urllib.request.Request(
        f"https://www.youtube.com/oembed?format=json&url={watch_url(video_id)}",
        headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8")).get("author_name")


def _look_up(video_id: str, card: bool):
    try:
        info = video_meta(video_id)
        remember_original_titles({video_id: info.get("title")})
        dur = info.get("duration")
        FACTS[video_id] = {"ts": upload_timestamp(info),
                           "dur": float(dur) if isinstance(dur, (int, float)) and dur > 0 else None}
        if card:
            if not (info.get("channel") or info.get("uploader")):
                # YouTube's player API leaves the channel's name out; its oEmbed answer has it
                try:
                    info["channel"] = _oembed_author(video_id)
                except (OSError, ValueError):
                    pass
            if not (cached_meta(video_id) or {}).get("channel_id"):  # a full lookup's knows more: keep it
                remember_meta(video_id, info)
            remember_release_date(video_id, info)
        failed = False
    except Exception:
        failed = True
    with _lock:
        _pending.pop(video_id, None)
        if failed:
            _failed.add(video_id)
        else:
            _looked_up[video_id] = card or _looked_up.get(video_id, False)
        idle = not _pending
    if idle:  # saved once a batch is done
        _save_facts()


def request(ids, missing, card: bool = False, limit: int | None = None) -> set:
    """Start a background lookup of every video that still lacks something.

    Args:
        ids (Iterable[str]): Video ids, in the order they matter (the first ones start first).
        missing (Callable[[str], bool]): Whether a video still lacks what the caller shows of it
            (asked for every id on every call, so it should be cheap).
        card (bool): Also keep the channel, views and upload day (<id>.meta.json, <id>.date):
            what a video card shows. It can cost a second small request per video.
        limit (int | None): The most lookups that may be waiting at once across all callers;
            videos beyond it aren't started but still count as busy, so the caller asks again.

    Returns:
        set[str]: The videos being looked up (or still to be). Empty means: nothing more will
        come. A video is looked up once per run of the server; one whose lookup failed, or
        told all it knows, is never in the set again.
    """
    wanted = [v for v in dict.fromkeys(ids) if v and VIDEO_ID_RE.match(v) and missing(v)]
    busy = set()
    with _lock:
        for video_id in wanted:
            if video_id in _failed:
                continue
            if video_id in _pending:
                busy.add(video_id)
                continue
            if video_id in _looked_up and (_looked_up[video_id] or not card):
                continue  # it told all it knows
            if limit is None or len(_pending) < limit:
                _pending[video_id] = _pool.submit(_look_up, video_id, card)
            busy.add(video_id)
    return busy


def fact(video_id: str) -> dict:
    """What a lookup learned about a video: {"ts": exact upload time or None, "dur": seconds or
    None}; {} when it was never looked up."""
    return FACTS.get(video_id) or {}


def gave_up(video_id: str) -> bool:
    """Whether this video's lookup failed (it isn't tried again while the server runs)."""
    return video_id in _failed


FACTS.update({k: v for k, v in read_json(facts_path(), {}).items()
              if VIDEO_ID_RE.match(str(k)) and isinstance(v, dict)})
