"""MinimalTube server - feed."""
from __future__ import annotations  # `str | None` annotations on Python 3.9

import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from .config import (
    CACHE_DIR,
    CHANNEL_ID_RE,
    FEED_KINDS,
    FEED_STEP,
    FEED_TTL,
    RSS_TTL,
    VIDEO_ID_RE,
)
from .media import cached_path, thumbnail_url
from .net import internet_up, is_online
from .ytinfo import video_meta, ydl
from .store import (
    ensure_original_titles,
    original_title,
    remember_original_title,
    remember_original_titles,
    read_json,
    write_json_atomic,
)

# ---------------------------------------------------------------------------
# Subscriptions + the merged "latest uploads" feed
# ---------------------------------------------------------------------------
subs_lock = threading.Lock()

def subs_path() -> Path:
    return CACHE_DIR / "subscriptions.json"

saved_subscriptions = [c for c in read_json(subs_path(), [])
                       if isinstance(c, dict) and CHANNEL_ID_RE.match(str(c.get("id", "")))]

def write_subscriptions():
    """Caller must hold subs_lock."""
    write_json_atomic(subs_path(), saved_subscriptions, "subscriptions")

def parse_channel_input(text: str) -> str:
    """'Youtube', '@youtube' or a youtube.com channel URL -> a channel URL yt-dlp understands."""
    t = (text or "").strip()
    if not t:
        raise ValueError("Enter a channel URL or name.")
    if re.match(r"^(https?://|(www\.|m\.)?youtube\.com/)", t, re.I):
        if not t.lower().startswith("http"):
            t = "https://" + t
        u = urlparse(t)
        host = (u.hostname or "").lower()
        host = host[4:] if host.startswith("www.") else host
        host = host[2:] if host.startswith("m.") else host
        if host != "youtube.com":
            raise ValueError("That isn't a YouTube channel URL.")
        parts = [x for x in u.path.split("/") if x]
        if parts and parts[0].startswith("@") and len(parts[0]) > 1:
            return f"https://www.youtube.com/{parts[0]}"
        if len(parts) > 1 and parts[0] == "channel" and CHANNEL_ID_RE.match(parts[1]):
            return f"https://www.youtube.com/channel/{parts[1]}"
        if len(parts) > 1 and parts[0] in ("c", "user"):
            return f"https://www.youtube.com/{parts[0]}/{parts[1]}"
        raise ValueError("Couldn't find a channel in that URL (use a /@handle or /channel/ link).")
    name = t.lstrip("@")
    if not re.match(r"^[A-Za-z0-9._-]{3,30}$", name):
        raise ValueError("Channel names may only contain letters, numbers, . _ and -")
    return f"https://www.youtube.com/@{name}"

def resolve_channel(channel_url: str) -> dict:
    """Ask yt-dlp who owns this channel URL (one flat request, 1 video)."""
    with ydl(skip_download=True, extract_flat="in_playlist", playlistend=1) as y:
        info = y.extract_info(channel_url.rstrip("/") + "/videos", download=False)
    first = next((e for e in (info.get("entries") or []) if isinstance(e, dict)), {})
    cid = info.get("channel_id") or first.get("channel_id")
    if not (isinstance(cid, str) and CHANNEL_ID_RE.match(cid)):
        raise ValueError("Couldn't find that channel.")
    name = (info.get("channel") or info.get("uploader") or first.get("channel")
            or re.sub(r"\s+-\s+Videos$", "", str(info.get("title") or ""))) or cid
    handle = info.get("uploader_id") if str(info.get("uploader_id") or "").startswith("@") else None
    return {"id": cid, "name": name, "handle": handle,
            "url": f"https://www.youtube.com/channel/{cid}"}

def subscription_public(c: dict) -> dict:
    return {"id": c["id"], "name": c.get("name") or c["id"],
            "handle": c.get("handle"), "url": c.get("url")}

feed_cache = {}          # (channel_id, kind) -> state dict (see source_state)

feed_cache_lock = threading.Lock()

RSS_ALL = {}             # video id -> exact publish time, from every RSS feed read so far

rss_cache = {}           # channel_id -> (fetched_at, {video id: time})

rss_locks = {}

# Exact upload time and length of videos the channel tabs don't date (Shorts). They are looked up
# one by one with yt-dlp, in the background, but only when a video could actually land on the page
# being built, and remembered on disk, so each video is looked up once. The feed answers straight
# away without the ones still being looked up and says so (`pending`); the app asks again shortly.
SHORT_INFO = {}          # video id -> {"ts": exact upload time or None, "dur": seconds or None}

SHORT_INFO_FAILED = set()

short_info_lock = threading.Lock()

info_pool = ThreadPoolExecutor(max_workers=8)

info_pending = {}        # video id -> Future of its lookup

def short_info_path() -> Path:
    return CACHE_DIR / "video_info.json"

def load_short_info():
    SHORT_INFO.update({k: v for k, v in read_json(short_info_path(), {}).items()
                       if VIDEO_ID_RE.match(str(k)) and isinstance(v, dict)})

def save_short_info():
    with short_info_lock:
        write_json_atomic(short_info_path(), dict(SHORT_INFO), "feed")

def lookup_video_info(video_id: str):
    try:
        info = video_meta(video_id)
        ts = info.get("release_timestamp") or info.get("timestamp")
        if not ts and info.get("upload_date"):
            try:
                ts = datetime.strptime(str(info["upload_date"]), "%Y%m%d").replace(
                    tzinfo=timezone.utc).timestamp()
            except ValueError:
                ts = None
        dur = info.get("duration")
        remember_original_title(video_id, info.get("title"))
        SHORT_INFO[video_id] = {"ts": float(ts) if ts else None,
                                "dur": float(dur) if isinstance(dur, (int, float)) and dur > 0 else None}
    except Exception:
        SHORT_INFO_FAILED.add(video_id)

def _lookup_in_background(video_id: str):
    try:
        lookup_video_info(video_id)
    finally:
        with short_info_lock:
            info_pending.pop(video_id, None)
            idle = not info_pending
        if idle:  # saved once a batch is done
            save_short_info()

def queue_video_info(ids) -> set:
    """Start looking these videos up (8 at a time); returns the ones still being looked up."""
    busy = set()
    with short_info_lock:
        for vid in dict.fromkeys(ids):
            if vid in SHORT_INFO or vid in SHORT_INFO_FAILED:
                continue
            if vid not in info_pending:
                info_pending[vid] = info_pool.submit(_lookup_in_background, vid)
            busy.add(vid)
    return busy

def exact_ts(video_id: str):
    """An exact upload time if we know one (RSS feed or a lookup), else None."""
    return RSS_ALL.get(video_id) or (SHORT_INFO.get(video_id) or {}).get("ts")

def source_state(channel_id: str, kind: str = "videos") -> dict:
    with feed_cache_lock:
        st = feed_cache.get((channel_id, kind))
        if st is None:
            st = feed_cache[(channel_id, kind)] = {
                "lock": threading.Lock(), "entries": [], "depth": 0,
                "exhausted": False, "fetched": 0.0, "error": None, "offline": False,
            }
        return st

def ytdlp_channel_entries(channel_id: str, count: int, kind: str = "videos") -> list:
    """Newest `count` uploads of one tab of a channel (flat listing: no per-video requests)."""
    with ydl(skip_download=True, extract_flat="in_playlist", playlistend=count,
             # ask the channel tab for an approximate upload time of every video
             extractor_args={"youtubetab": {"approximate_date": [""]}}) as y:
        info = y.extract_info(f"https://www.youtube.com/channel/{channel_id}/{kind}",
                              download=False)
    out = []
    for e in (info.get("entries") or []):
        if not isinstance(e, dict):
            continue
        vid = e.get("id")
        if not (isinstance(vid, str) and VIDEO_ID_RE.match(vid)):
            continue
        if e.get("live_status") in ("is_upcoming",):
            continue
        ts = e.get("timestamp") or e.get("release_timestamp")
        if not ts and e.get("upload_date"):
            try:
                ts = datetime.strptime(str(e["upload_date"]), "%Y%m%d").timestamp()
            except ValueError:
                ts = None
        owner_id = e.get("channel_id")
        out.append({"id": vid, "title": e.get("title") or vid,
                    "duration": e.get("duration"), "views": e.get("view_count"),
                    "timestamp": ts,
                    # who actually owns the video (differs from this channel for collabs)
                    "owner": e.get("channel") or e.get("uploader"),
                    "owner_id": owner_id if isinstance(owner_id, str) and CHANNEL_ID_RE.match(owner_id) else None})
    return out

def rss_dates(channel_id: str) -> dict:
    """Exact publish times of a channel's 15 newest uploads (videos and Shorts) from its RSS feed.
    Their titles there are the videos' own-language ones, which saves looking those up."""
    try:
        req = urllib.request.Request(
            f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}",
            headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            root = ET.fromstring(resp.read())
    except Exception:
        return {}
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}
    dates, titles = {}, {}
    for entry in root.findall("a:entry", ns):
        vid = entry.findtext("yt:videoId", default="", namespaces=ns)
        pub = entry.findtext("a:published", default="", namespaces=ns)
        if not VIDEO_ID_RE.match(vid):
            continue
        titles[vid] = entry.findtext("a:title", default="", namespaces=ns).strip()
        try:
            dates[vid] = datetime.fromisoformat(pub.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    remember_original_titles(titles)
    return dates

def rss_dates_cached(channel_id: str) -> dict:
    """One RSS request per channel even though two sources (videos, shorts) ask for it."""
    with feed_cache_lock:
        lock = rss_locks.setdefault(channel_id, threading.Lock())
    with lock:
        hit = rss_cache.get(channel_id)
        if hit and time.time() - hit[0] < RSS_TTL:
            return hit[1]
        dates = rss_dates(channel_id)
        if dates:
            rss_cache[channel_id] = (time.time(), dates)
            RSS_ALL.update(dates)
        return dates

def rss_window(rss: dict):
    """(cutoff, typical gap) of a channel's RSS window.

    The RSS feed lists a channel's 15 newest uploads (videos and Shorts). When it is full, every
    upload that is *not* in it is older than its oldest entry: that is the cutoff. The gap is the
    median spacing between those uploads, used to spread older undated Shorts out sensibly."""
    times = sorted(rss.values(), reverse=True)
    if len(times) < 15:
        return None, 86400.0
    diffs = sorted(a - b for a, b in zip(times, times[1:]) if a > b)
    gap = diffs[len(diffs) // 2] if diffs else 86400.0
    return times[-1], min(14 * 86400.0, max(600.0, gap))

def assign_dates(entries: list, exact: dict, cutoff=None, gap: float = 1.0, blind_anchor=None) -> list:
    """Give every entry a sortable 'date' (entries are newest first).

    Exact (RSS) time > yt-dlp's estimate > placed next to its neighbours: an undated entry sits
    `gap` below the previous dated one, or just above the first dated one if it leads the list.
    With a `cutoff` (see rss_window) an undated entry is never placed above it: Shorts carry no
    dates from yt-dlp, so the ones beyond the RSS window must not jump to the top of the feed."""
    known = {}
    for i, e in enumerate(entries):
        exact_ts = exact.get(e["id"])
        e["exact"] = bool(exact_ts)
        ts = exact_ts or e.get("timestamp")
        if ts:
            known[i] = float(ts)
    if not known:
        base = cutoff if cutoff is not None else blind_anchor
        for i, e in enumerate(entries):
            e["date"] = (base - gap * (i + 1)) if base is not None else time.time() - i
        return entries
    first, last, run = min(known), None, 0
    for i, e in enumerate(entries):
        if i in known:
            e["date"] = known[i]
            last, run = e["date"], 0
        elif i < first:
            e["date"] = known[first] + (first - i)
        else:
            run += 1
            base = last if cutoff is None else min(last, cutoff)
            e["date"] = base - gap * run
    return entries

def assign_short_bounds(entries: list, cutoff=None) -> list:
    """Dates for a Shorts tab (newest first). yt-dlp gives Shorts no dates; the RSS feed and earlier
    lookups know some. An undated Short gets an *upper bound*: it is older than the oldest entry of
    the channel's RSS window (a Short newer than that would be in the RSS feed itself) and than the
    entry before it. Such a Short is only looked up when that bound says it could be on the page."""
    prev = None
    for e in entries:
        ts = exact_ts(e["id"])
        e["exact"] = bool(ts)
        if ts:
            e["date"] = float(ts)
            prev = e["date"]
            continue
        bound = cutoff if cutoff is not None else time.time()
        if prev is not None:
            bound = min(bound, prev)
        e["date"] = prev = bound - 1.0
    return entries

def ensure_channel_depth(channel_id: str, depth: int, reset: bool = False, kind: str = "videos") -> dict:
    st = source_state(channel_id, kind)
    with st["lock"]:
        if reset:  # the old entries stay until a fetch succeeds (it may fail offline)
            st.update(depth=0, exhausted=False, fetched=0.0, error=None)
        if st["exhausted"] or st["depth"] >= depth:
            return st
        try:
            entries = ytdlp_channel_entries(channel_id, depth, kind=kind)
            rss = rss_dates_cached(channel_id)
            if kind == "shorts":
                cutoff, _gap = rss_window(rss)
                dated = assign_short_bounds(entries, cutoff)
            else:
                dated = assign_dates(entries, RSS_ALL)
            st["entries"] = dated
            st["depth"] = depth
            st["exhausted"] = len(entries) < depth
            st["error"] = None
            st["offline"] = False
        except Exception as e:
            if not internet_up():
                # Not the channel's fault: keep what we have and try again next time.
                st["offline"] = True
                return st
            # Keep whatever we already had; don't let one broken source block the feed.
            # (A channel with no Shorts tab raises here too - that is simply "no Shorts".)
            st["offline"] = False
            st["exhausted"] = True
            st["error"] = str(e).splitlines()[0][:200] if str(e) else "unknown error"
        st["fetched"] = time.time()
        return st

def build_feed(offset: int, limit: int, refresh: bool, channel: str | None = None,
               channel_name: str | None = None):
    with subs_lock:
        subs = list(saved_subscriptions)
    if channel:  # only this channel's uploads
        subs = [c for c in subs if c["id"] == channel]
        if not subs:  # a channel opened from a video's description: browse it without subscribing
            subs = [{"id": channel, "name": channel_name or channel}]
    if not subs:
        return [], False, [], False, False
    names = {c["id"]: c.get("name") or c["id"] for c in subs}
    sources = [(c["id"], k) for c in subs for k in FEED_KINDS]

    if refresh:
        for c in subs:
            rss_cache.pop(c["id"], None)

    def first_page(src):
        cid, kind = src
        st = source_state(cid, kind)
        stale = (time.time() - st["fetched"]) > FEED_TTL if st["fetched"] else False
        return ensure_channel_depth(cid, FEED_STEP, reset=(refresh or (offset == 0 and stale)), kind=kind)

    with ThreadPoolExecutor(max_workers=min(6, len(sources))) as pool:
        list(pool.map(first_page, sources))

    def date_of(e):  # an exact time (RSS feed / lookup) beats an estimate
        return exact_ts(e["id"]) or e["date"]

    def is_exact(e):
        return bool(exact_ts(e["id"])) or (e.get("kind") != "shorts" and e.get("exact"))

    need = offset + limit
    held = set()   # undated Shorts being looked up: left out until their date is known
    for _ in range(80):
        states = {src: source_state(*src) for src in sources}
        open_src = [s for s, st in states.items() if not st["exhausted"] and st["entries"]]
        pool_all = {}
        for (cid, kind), st in states.items():
            for e in st["entries"]:
                cand = dict(e, channel_id=cid, kind=kind, date=date_of(e))
                cur = pool_all.get(e["id"])
                # a collab video is listed by every collaborator: keep one copy, preferring
                # the one whose date is exact
                if cur is None or (not is_exact(cur) and is_exact(cand)):
                    pool_all[e["id"]] = cand
        everything = list(pool_all.values())
        # Shorts without a real date yet: look up the ones that could still land on this page
        # (their upper bound is at or above the date of the last dated video that fits)
        undated = {e["id"] for e in everything if e.get("kind") == "shorts" and not is_exact(e)
                   and e["id"] not in SHORT_INFO_FAILED}
        dates_desc = sorted((e["date"] for e in everything if e["id"] not in undated), reverse=True)
        threshold = dates_desc[need - 1] if len(dates_desc) >= need else None
        if is_online():
            held |= queue_video_info(e["id"] for e in everything if e["id"] in undated
                                     and (threshold is None or e["date"] >= threshold))
        held -= {i for i in held if exact_ts(i) or i in SHORT_INFO_FAILED}
        # Anything newer than the oldest video fetched from a source that still has more to
        # give is guaranteed to be in the right place; older items may be preceded by videos
        # we haven't fetched yet.
        oldest = {s: min(date_of(e) for e in states[s]["entries"]) for s in open_src}
        horizon = max(oldest.values(), default=None)
        safe = [e for e in everything if (horizon is None or e["date"] >= horizon)
                and e["id"] not in held]
        if len(safe) > need or horizon is None:
            break
        # The source holding the horizon back is fetched further, unless it can't be reached
        # right now or its Shorts are still being dated (then this page waits for it).
        laggard = max(open_src, key=lambda s: oldest[s])
        if states[laggard]["offline"] or any(e["id"] in held for e in states[laggard]["entries"]):
            break
        ensure_channel_depth(laggard[0], states[laggard]["depth"] + FEED_STEP, kind=laggard[1])

    safe.sort(key=lambda e: e["date"], reverse=True)
    page = safe[offset:offset + limit]
    offline = any(source_state(*src)["offline"] for src in sources)
    has_more = len(safe) > need or horizon is not None or offline
    pending = bool(held)
    if not offline:
        # Shorts come without a length from yt-dlp's channel listing: look it up for the visible
        # ones (that lookup brings their own-language title too)
        lengths = queue_video_info([e["id"] for e in page if not e.get("duration")])
        # the channel listing gives YouTube's translated titles: use each video's own-language one
        titles = ensure_original_titles([e["id"] for e in page if e["id"] not in lengths])
        pending = pending or bool(lengths) or titles > 0

    def display_channel(e):
        sub = names.get(e["channel_id"], "")
        owner, owner_id = e.get("owner"), e.get("owner_id")
        if owner and owner_id and owner_id != e["channel_id"]:
            return f"{owner} and {sub}"   # a collaboration, shown the way YouTube shows it
        return sub

    items = [{
        "id": e["id"], "title": original_title(e["id"], e["title"]), "channel": display_channel(e),
        "channel_id": e["channel_id"],
        "duration": e.get("duration") or (SHORT_INFO.get(e["id"]) or {}).get("dur"),
        "views": e.get("views"),
        "timestamp": e["date"], "url": f"https://www.youtube.com/watch?v={e['id']}",
        "thumbnail": thumbnail_url(e["id"]), "downloaded": cached_path(e["id"]).exists(),
        "short": e.get("kind") == "shorts",
    } for e in page]
    # Only the Videos tab reports problems: a channel without a Shorts tab is not an error.
    errors = [{"channel": names[cid], "error": source_state(cid, "videos")["error"]}
              for cid in names
              if source_state(cid, "videos")["error"] and not source_state(cid, "videos")["offline"]]
    return items, has_more, errors, offline, pending

load_short_info()
