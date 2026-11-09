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
from urllib.parse import quote, urlparse

from .config import (
    CACHE_DIR,
    CHANNEL_ID_RE,
    DATA_DIR,
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
    return DATA_DIR / "subscriptions.json"

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

CHANNEL_FOLLOWERS = {}   # channel id -> subscriber count, from the latest read of its Videos tab

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

# ---- Collabs: videos a subscribed channel made together with another channel ----
# Such a video is uploaded by one of its channels only, so the others' tabs and RSS feeds never
# list it; YouTube shows it to all of their subscribers in their subscriptions feed. While an
# account is signed in to YouTube, the extension reads that feed and hands its collabs over
# (store_collabs); the feed adds them to the uploads of every subscribed collaborator.
COLLABS = {}             # video id -> {"id", "title", "channels": [{"id", "name"}], "published", ...}
COLLABS_MAX = 500
collabs_lock = threading.Lock()

def collabs_path() -> Path:
    return DATA_DIR / "collabs.json"

def load_collabs():
    COLLABS.update((c["id"], c) for c in read_json(collabs_path(), [])
                   if isinstance(c, dict) and VIDEO_ID_RE.match(str(c.get("id", "")))
                   and isinstance(c.get("channels"), list) and isinstance(c.get("published"), (int, float)))

def _clean_collab(v) -> dict | None:
    """One collab as the extension sent it -> what is kept of it, or None when it isn't valid."""
    vid = str(v.get("id") or "") if isinstance(v, dict) else ""
    if not VIDEO_ID_RE.match(vid):
        return None
    channels, seen = [], set()
    for ch in v.get("channels") if isinstance(v.get("channels"), list) else []:
        cid = str(ch.get("id") or "") if isinstance(ch, dict) else ""
        if CHANNEL_ID_RE.match(cid) and cid not in seen:
            seen.add(cid)
            channels.append({"id": cid, "name": " ".join(str(ch.get("name") or "").split())[:100] or cid})
    published, dur, views = v.get("published"), v.get("duration"), v.get("views")
    if len(channels) < 2 or isinstance(published, bool) or not isinstance(published, (int, float)) \
            or not 1104537600 <= published <= time.time() + 86400:   # YouTube's start .. tomorrow
        return None
    return {"id": vid, "title": " ".join(str(v.get("title") or "").split())[:300] or vid,
            "channels": channels, "published": float(published),
            "duration": float(dur) if isinstance(dur, (int, float)) and not isinstance(dur, bool)
            and 0 < dur < 86400 * 7 else None,
            "views": int(views) if isinstance(views, (int, float)) and not isinstance(views, bool)
            and views >= 0 else None}

def store_collabs(videos) -> list:
    """Remember the collabs the extension found in the signed-in YouTube subscriptions feed.

    Args:
        videos (list[dict]): {"id", "title", "channels": [{"id": "UC...", "name"}, ...] (two or more,
            the uploader first), "published" (unix seconds, approximate), "duration" (seconds or
            None), "views" (int or None)} each. Invalid ones are skipped.

    Returns:
        list[str]: The subscribed channels that got a collab they didn't have, so the app can ask
        for their feeds again. Only collabs with a subscribed collaborator are kept (the newest
        COLLABS_MAX, in collabs.json); the upload time of the first sighting is kept, as it's the
        closest ("3 hours ago" beats "2 days ago"), and the exact one is looked up in the background.
    """
    with subs_lock:
        subscribed = {c["id"] for c in saved_subscriptions}
    found = [c for c in map(_clean_collab, videos if isinstance(videos, list) else []) if c]
    found = [c for c in found if any(ch["id"] in subscribed for ch in c["channels"])]
    changed, new_ids, dirty = set(), [], False
    with collabs_lock:
        for c in found:
            old = COLLABS.get(c["id"])
            ids = {ch["id"] for ch in c["channels"]}
            if old is None or ids != {ch["id"] for ch in old["channels"]}:
                changed |= ids & subscribed
                new_ids.append(c["id"])
            merged = dict(c, published=min(c["published"], old["published"])) if old else c
            dirty = dirty or merged != old
            COLLABS[c["id"]] = merged
        keep = sorted((c for c in COLLABS.values()
                       if any(ch["id"] in subscribed for ch in c["channels"])),
                      key=lambda c: c["published"], reverse=True)[:COLLABS_MAX]
        if len(keep) != len(COLLABS):
            COLLABS.clear()
            COLLABS.update((c["id"], c) for c in keep)
            dirty = True
        if dirty:
            write_json_atomic(collabs_path(), keep, "feed")
    if new_ids and is_online():
        queue_video_info(i for i in new_ids if not exact_ts(i))
    return sorted(changed)

def collab_label(names: list) -> str:
    """A collab's channels, the uploader first: "A and B", "A, B and C"."""
    names = [n for n in names if n]
    return " and ".join([", ".join(names[:-1]), names[-1]]) if len(names) > 1 else "".join(names)

def collab_entries(channel_ids) -> list:
    """The stored collabs of these channels as feed entries, each under its first collaborator
    among them (a collab two subscribed channels share shows once)."""
    with collabs_lock:
        collabs = list(COLLABS.values())
    out = []
    for c in collabs:
        cid = next((ch["id"] for ch in c["channels"] if ch["id"] in channel_ids), None)
        if cid:
            out.append({"id": c["id"], "title": c["title"], "duration": c.get("duration"),
                        "views": c.get("views"), "timestamp": c["published"], "exact": False,
                        "channel_id": cid, "kind": "videos", "date": c["published"]})
    return out

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
    if kind == "videos" and isinstance(info.get("channel_follower_count"), int):
        CHANNEL_FOLLOWERS[channel_id] = info["channel_follower_count"]
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
                ts = datetime.strptime(str(e["upload_date"]), "%Y%m%d").replace(
                    tzinfo=timezone.utc).timestamp()
            except ValueError:
                ts = None
        out.append({"id": vid, "title": e.get("title") or vid,
                    "duration": e.get("duration"), "views": e.get("view_count"),
                    "timestamp": ts,
                    "members_only": e.get("availability") == "subscriber_only"})
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
        # collabs uploaded by a channel that isn't here (one that is lists them itself)
        for e in collab_entries(names):
            pool_all.setdefault(e["id"], dict(e, date=date_of(e)))
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
        # a collab's time comes from "3 days ago" until its exact one is looked up
        dating = queue_video_info([e["id"] for e in page if e["id"] in COLLABS and not exact_ts(e["id"])])
        pending = pending or bool(lengths) or titles > 0 or bool(dating)

    def display_channel(e):
        collab = COLLABS.get(e["id"])   # a collab names all of its channels, as YouTube does
        return collab_label([ch["name"] for ch in collab["channels"]]) if collab else names.get(e["channel_id"], "")

    items = [{
        "id": e["id"], "title": original_title(e["id"], e["title"]), "channel": display_channel(e),
        "channel_id": e["channel_id"],
        # a collab's channels, each its own link in the app
        "channels": (COLLABS.get(e["id"]) or {}).get("channels"),
        "duration": e.get("duration") or (SHORT_INFO.get(e["id"]) or {}).get("dur"),
        "views": e.get("views"),
        "timestamp": e["date"], "url": f"https://www.youtube.com/watch?v={e['id']}",
        "thumbnail": thumbnail_url(e["id"]), "downloaded": cached_path(e["id"]).exists(),
        "short": e.get("kind") == "shorts",
        "members_only": bool(e.get("members_only")),
    } for e in page]
    # Only the Videos tab reports problems: a channel without a Shorts tab is not an error.
    errors = [{"channel": names[cid], "error": source_state(cid, "videos")["error"]}
              for cid in names
              if source_state(cid, "videos")["error"] and not source_state(cid, "videos")["offline"]]
    return items, has_more, errors, offline, pending

# ---- Importing many subscriptions at once (a YouTube account's) ----
# What can't be done on the spot (looking up a channel known only by its @handle, reading every
# new channel's latest uploads so the feed has them when it asks) runs in the background, two at
# a time to go easy on YouTube; import_left() counts what's still to do.
HANDLE_RE = re.compile(r"^@[^\s/?#]{3,100}$")
import_pool = ThreadPoolExecutor(max_workers=2)
_import_lock = threading.Lock()
_import_left = 0

def import_left() -> int:
    return _import_left

def _run_import_task(fn, arg):
    global _import_left
    try:
        fn(arg)
    except Exception as e:
        print(f"[import] {arg}: {str(e).splitlines()[0][:200] if str(e) else repr(e)}")
    finally:
        with _import_lock:
            _import_left -= 1

def _import_later(fn, arg):
    global _import_left
    with _import_lock:
        _import_left += 1
    import_pool.submit(_run_import_task, fn, arg)

def _read_new_channel(channel_id: str):
    for kind in FEED_KINDS:
        ensure_channel_depth(channel_id, FEED_STEP, kind=kind)

def _subscribe_handle(handle: str):
    channel = resolve_channel(f"https://www.youtube.com/{quote(handle, safe='@')}")
    with subs_lock:
        if any(c["id"] == channel["id"] for c in saved_subscriptions):
            return
        channel["added"] = time.time()
        saved_subscriptions.append(channel)
        write_subscriptions()
    _read_new_channel(channel["id"])

def import_subscriptions(channels) -> dict:
    """Subscribe to many channels at once (an import of a YouTube account's subscriptions).

    Args:
        channels (list[dict]): {"id": "UC...", "name": ..., "handle": "@..."} each. One with an
            id is subscribed to on the spot; one with only a handle is looked up first, in the
            background. Entries with neither are skipped.

    Returns:
        dict: "added" (new subscriptions), "already" (channels subscribed to before) and
        "resolving" (handles being looked up). Every new channel's latest uploads are read in
        the background, so the feed has them when it asks.
    """
    added, already, handles = [], 0, {}
    with subs_lock:
        have = {c["id"] for c in saved_subscriptions}
        for entry in channels if isinstance(channels, list) else []:
            if not isinstance(entry, dict):
                continue
            cid = str(entry.get("id") or "")
            handle = str(entry.get("handle") or "").strip()
            handle = handle if HANDLE_RE.match(handle) else None
            if not CHANNEL_ID_RE.match(cid):
                if handle:
                    handles[handle] = True
                continue
            if cid in have:
                already += 1
                continue
            have.add(cid)
            name = " ".join(str(entry.get("name") or "").split())[:100]
            saved_subscriptions.append({"id": cid, "name": name or handle or cid, "handle": handle,
                                        "url": f"https://www.youtube.com/channel/{cid}",
                                        "added": time.time()})
            added.append(cid)
        if added:
            write_subscriptions()
    for cid in added:
        _import_later(_read_new_channel, cid)
    for handle in handles:
        _import_later(_subscribe_handle, handle)
    return {"added": len(added), "already": already, "resolving": len(handles)}

load_short_info()
load_collabs()
