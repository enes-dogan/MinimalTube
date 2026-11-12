"""MinimalTube server - one video's files in the cache folder.

Next to a download (`<id>.mp4`) the cache keeps what the app shows about the video, so all of it
works offline: thumbnails, captions, description, release date, chapters, sponsor segments and
`<id>.meta.json` (views, length, channel). Most of it is also kept for videos that were only
streamed or listed.
"""
from __future__ import annotations  # `str | None` annotations on Python 3.9

import json
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from .config import CACHE_DIR, VIDEO_ID_RE
from .jsonfile import read_json, write_json_atomic
from .system import replace_file


def remove_video_files(video_id: str) -> int:
    """Delete the video, subtitles and any leftover yt-dlp temp/part files."""
    removed = 0
    if not VIDEO_ID_RE.match(video_id):
        return 0
    for f in CACHE_DIR.glob(f"{video_id}.*"):
        try:
            f.unlink()
            removed += 1
        except FileNotFoundError:
            pass
        except OSError as e:
            print(f"[delete] couldn't remove {f.name}: {e}")
    return removed

def cached_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.mp4"

def subtitle_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.en.vtt"

def description_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.description"

def remember_description(video_id: str, text):
    """Keep the video description on disk so it's available offline."""
    if not video_id or text is None or not VIDEO_ID_RE.match(video_id):
        return
    p = description_path(video_id)
    if p.exists():
        return
    try:
        p.write_text(text, encoding="utf-8")
    except OSError as e:
        print(f"[description] couldn't save {p.name}: {e}")

def date_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.date"

def release_date_from_info(info) -> str | None:
    """'YYYY-MM-DD' release date of a video from yt-dlp's info (None if it has none)."""
    if not isinstance(info, dict):
        return None
    raw = str(info.get("upload_date") or "")
    if re.fullmatch(r"\d{8}", raw):
        try:
            return datetime.strptime(raw, "%Y%m%d").strftime("%Y-%m-%d")
        except ValueError:
            pass
    ts = info.get("release_timestamp") or info.get("timestamp")
    try:
        return (datetime.fromtimestamp(float(ts), timezone.utc).strftime("%Y-%m-%d")
                if ts else None)
    except (TypeError, ValueError, OverflowError, OSError):
        return None

def remember_release_date(video_id: str, info) -> str | None:
    """Keep the release date on disk (an empty file means 'checked, unknown') so it works offline."""
    if not video_id or not VIDEO_ID_RE.match(video_id) or not isinstance(info, dict):
        return None
    date = release_date_from_info(info)
    p = date_path(video_id)
    if not p.exists():
        try:
            p.write_text(date or "", encoding="utf-8")
        except OSError as e:
            print(f"[date] couldn't save {p.name}: {e}")
    return date

def cached_release_date(video_id: str):
    """(known, date): known is False when the date was never looked up."""
    p = date_path(video_id)
    if not p.exists():
        return False, None
    try:
        text = p.read_text(encoding="utf-8").strip()
    except OSError:
        return False, None
    return True, (text if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text) else None)

# Two sizes: 320 x 180 for the small rows (<id>.jpg), 1280 x 720 for the cards, which YouTube-sized
# cards on a big screen need (<id>.hq.webp: WebP is half the size of YouTube's JPEG; <id>.hq.jpg
# when there's only a JPEG). A video without a 720p thumbnail gets the 480 x 360 one (letterboxed
# 4:3: the card crops the bars off).
THUMB_SOURCES = ("vi/{id}/mqdefault.jpg", "vi/{id}/hqdefault.jpg")
LARGE_THUMB_SOURCES = ("vi_webp/{id}/hq720.webp", "vi_webp/{id}/maxresdefault.webp",
                       "vi/{id}/hq720.jpg", "vi/{id}/hqdefault.jpg")
THUMB_NAMES = ("{id}.jpg", "{id}.hq.webp", "{id}.hq.jpg")

def thumb_path(video_id: str, large: bool = False) -> Path:
    """Where a video's thumbnail is kept; the large one as whichever kind it was saved in."""
    if not large:
        return CACHE_DIR / f"{video_id}.jpg"
    webp = CACHE_DIR / f"{video_id}.hq.webp"
    return webp if webp.exists() else CACHE_DIR / f"{video_id}.hq.jpg"

def fetch_thumbnail_bytes(video_id: str, large: bool = False):
    for name in LARGE_THUMB_SOURCES if large else THUMB_SOURCES:
        try:
            req = urllib.request.Request(f"https://i.ytimg.com/{name.format(id=video_id)}",
                                         headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = resp.read()
            if data:
                return data
        except Exception:
            continue
    return None

def remember_thumbnail(video_id: str, large: bool = False):
    """Keep a video's thumbnail on disk so it shows offline (`large`: the 1280 x 720 one).
    Returns its path or None."""
    if not video_id or not VIDEO_ID_RE.match(video_id):
        return None
    p = thumb_path(video_id, large)
    if p.exists():
        return p
    data = fetch_thumbnail_bytes(video_id, large)
    if not data:
        return None
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        p = CACHE_DIR / f"{video_id}.hq.webp"
    try:
        # one temp file per thread: the same thumbnail can be asked for twice at once
        tmp = CACHE_DIR / f"{p.name}.{threading.get_ident()}.tmp"
        tmp.write_bytes(data)
        replace_file(tmp, p)
        return p
    except OSError as e:
        print(f"[thumb] couldn't save {p.name}: {e}")
        return None

def mark_thumbnail_used(p: Path):
    """A kept thumbnail that's shown again stays (see cache.cleanup_unused_thumbnails); marked
    at most once a day."""
    try:
        if time.time() - p.stat().st_mtime > 86400:
            p.touch()
    except OSError:
        pass

def meta_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.meta.json"

def meta_from_info(info) -> dict:
    handle = str(info.get("uploader_id") or "")
    if not handle.startswith("@"):
        m = re.search(r"/(@[^/?#]+)", str(info.get("uploader_url") or info.get("channel_url") or ""))
        handle = m.group(1) if m else None
    views = info.get("view_count")
    dur = info.get("duration")
    return {"views": views if isinstance(views, int) else None,
            "duration": dur if isinstance(dur, (int, float)) and dur > 0 else None,
            "channel": info.get("channel") or info.get("uploader"),
            "channel_id": info.get("channel_id"),
            "handle": handle or None}

def remember_meta(video_id: str, info):
    """Views / channel of a video, kept on disk so the description works offline."""
    if not video_id or not VIDEO_ID_RE.match(video_id) or not isinstance(info, dict):
        return None
    meta = meta_from_info(info)
    write_json_atomic(meta_path(video_id), meta, "meta")
    return meta

def cached_meta(video_id: str):
    """A video's saved meta (views, duration, channel, channel_id, handle), or None."""
    return read_json(meta_path(video_id), {}) or None

_unprobeable = set()

def video_duration(video_id: str):
    """Length in seconds of a video, as far as its files tell: from the saved meta, else (a
    downloaded one) from ffprobe, once. None when neither knows."""
    meta = cached_meta(video_id) or {}
    if meta.get("duration"):
        return meta["duration"]
    if video_id in _unprobeable or not cached_path(video_id).exists():
        return None
    dur = None
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            out = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", str(cached_path(video_id))],
                capture_output=True, text=True, timeout=15, check=False).stdout.strip()
            dur = float(out) if out else None
        except Exception:
            dur = None
    if not dur or dur <= 0:
        _unprobeable.add(video_id)
        return None
    meta["duration"] = dur
    write_json_atomic(meta_path(video_id), meta, "meta")
    return dur

def card_info(video_id: str) -> dict:
    """What a video card shows under its title, as far as it's saved for this video.

    Args:
        video_id (str): An 11-character YouTube video id.

    Returns:
        dict: "channel", "channel_id", "views" (each None when unknown) and "timestamp": the
        upload day as a Unix time (UTC midnight; only the day is kept), or None.
    """
    meta = cached_meta(video_id) or {}
    _known, date = cached_release_date(video_id)
    return {"channel": meta.get("channel") or meta.get("handle"), "channel_id": meta.get("channel_id"),
            "views": meta.get("views"),
            "timestamp": datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
            if date else None}

def has_card_info(video_id: str) -> bool:
    # a download's length alone (video_duration) isn't the card's info: no channel in it
    return bool((cached_meta(video_id) or {}).get("channel_id")) and cached_release_date(video_id)[0]

def meta_public(meta) -> dict:
    meta = meta or {}
    return {k: meta.get(k) for k in ("views", "channel", "channel_id", "handle")}

def chapters_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.chapters.json"

def clean_chapters(raw, duration=None) -> list:
    """yt-dlp's `chapters` -> [{start, end, title}] (seconds), sorted and validated.

    Fewer than two chapters is treated as "no chapters": the player then shows a regular seekbar."""
    rows = []
    for ch in (raw if isinstance(raw, list) else []):
        if not isinstance(ch, dict):
            continue
        try:
            start = float(ch.get("start_time"))
            end = float(ch["end_time"]) if ch.get("end_time") is not None else None
        except (TypeError, ValueError):
            continue
        if start < 0 or start != start:  # negative / NaN
            continue
        rows.append([start, end, str(ch.get("title") or "").strip()])
    rows.sort(key=lambda r: r[0])
    try:
        total = float(duration) if duration else None
    except (TypeError, ValueError):
        total = None
    out = []
    for i, (start, end, title) in enumerate(rows):
        nxt = rows[i + 1][0] if i + 1 < len(rows) else total
        end = end if end is not None else nxt
        if end is None or end <= start:
            continue
        out.append({"start": round(start, 2), "end": round(end, 2),
                    "title": title or f"Chapter {len(out) + 1}"})
    return out if len(out) >= 2 else []

def remember_chapters(video_id: str, info: dict):
    """Keep the chapter list on disk (an empty list means 'checked, none') so it works offline."""
    if not video_id or not VIDEO_ID_RE.match(video_id) or not isinstance(info, dict):
        return
    p = chapters_path(video_id)
    if not p.exists():
        write_json_atomic(p, clean_chapters(info.get("chapters"), info.get("duration")), "chapters")

def cached_chapters(video_id: str):
    """The saved chapter list ([] when the video has none), or None when it was never saved."""
    p = chapters_path(video_id)
    return read_json(p, []) if p.exists() else None

SPONSORBLOCK_API = "https://sponsor.ajay.app/api/skipSegments"

def sponsor_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.sponsor.json"

def fetch_sponsor_segments(video_id: str) -> list:
    """Ask SponsorBlock for a video's "sponsor" segments.

    Args:
        video_id (str): An 11-character YouTube video id.

    Returns:
        list[dict]: [{"start": seconds, "end": seconds}, ...] sorted by start; [] when the
        video has none (SponsorBlock answers 404 for that).

    Raises:
        OSError: SponsorBlock couldn't be reached or answered with another error
            (urllib's URLError / HTTPError are OSErrors).
        ValueError: The answer wasn't JSON.
    """
    query = urlencode({"videoID": video_id, "categories": '["sponsor"]'})
    req = urllib.request.Request(f"{SPONSORBLOCK_API}?{query}", headers={"User-Agent": "MinimalTube"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    segments = []
    for entry in data if isinstance(data, list) else []:
        if not isinstance(entry, dict) or entry.get("category") != "sponsor":
            continue
        span = entry.get("segment")
        if not isinstance(span, list) or len(span) != 2:
            continue
        try:
            start, end = float(span[0]), float(span[1])
        except (TypeError, ValueError):
            continue
        if 0 <= start < end:
            segments.append({"start": start, "end": end})
    return sorted(segments, key=lambda s: s["start"])

def remember_sponsor_segments(video_id: str, segments: list):
    """Keep a video's sponsor segments on disk, so skipping them works offline. The file is
    one of the video's files, so it goes with the download (remove_video_files).

    Args:
        video_id (str): An 11-character YouTube video id.
        segments (list[dict]): What fetch_sponsor_segments returned ([] is kept too: "none").
    """
    write_json_atomic(sponsor_path(video_id), segments, "sponsorblock")

def cached_sponsor_segments(video_id: str):
    """The saved sponsor segments, or None when none were saved."""
    p = sponsor_path(video_id)
    return read_json(p, []) if p.exists() else None
