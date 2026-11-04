"""MinimalTube server - media."""
from __future__ import annotations  # `str | None` annotations on Python 3.9

import json
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from .config import (
    CACHE_DIR,
    CACHE_MAINTENANCE_INTERVAL_SECONDS,
    CACHE_MAX_AGE_DAYS,
    CACHE_MAX_BYTES,
    VIDEO_ID_RE,
)
from .ytinfo import video_info


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

def thumb_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.jpg"

def fetch_thumbnail_bytes(video_id: str):
    for name in ("mqdefault.jpg", "hqdefault.jpg"):
        try:
            req = urllib.request.Request(f"https://i.ytimg.com/vi/{video_id}/{name}",
                                         headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = resp.read()
            if data:
                return data
        except Exception:
            continue
    return None

def remember_thumbnail(video_id: str):
    """Keep a video's thumbnail on disk so it shows offline. Returns its path or None."""
    if not video_id or not VIDEO_ID_RE.match(video_id):
        return None
    p = thumb_path(video_id)
    if p.exists():
        return p
    data = fetch_thumbnail_bytes(video_id)
    if not data:
        return None
    try:
        # one temp file per thread: the same thumbnail can be asked for twice at once
        tmp = CACHE_DIR / f"{video_id}.jpg.{threading.get_ident()}.tmp"
        tmp.write_bytes(data)
        tmp.replace(p)
        return p
    except OSError as e:
        print(f"[thumb] couldn't save {p.name}: {e}")
        return None

def mark_thumbnail_used(p: Path):
    """A kept thumbnail that's shown again stays (see cleanup_unused_thumbnails); marked at most
    once a day."""
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
    try:
        meta_path(video_id).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        print(f"[meta] couldn't save {meta_path(video_id).name}: {e}")
    return meta

def cached_meta(video_id: str):
    try:
        data = json.loads(meta_path(video_id).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None

duration_failed = set()

def probe_duration(video_id: str):
    """Length in seconds of a downloaded video: from the saved info, else ffprobe (once)."""
    meta = cached_meta(video_id) or {}
    if meta.get("duration"):
        return meta["duration"]
    if video_id in duration_failed:
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
        duration_failed.add(video_id)
        return None
    meta["duration"] = dur
    try:
        meta_path(video_id).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return dur

duration_pending = set()

duration_pool = ThreadPoolExecutor(max_workers=3)

def _lookup_duration(video_id: str):
    try:
        info = video_info(video_id, keep=False)
        remember_meta(video_id, info)
        if not (cached_meta(video_id) or {}).get("duration"):
            duration_failed.add(video_id)
    except Exception:
        duration_failed.add(video_id)
    finally:
        duration_pending.discard(video_id)

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
    if p.exists():
        return
    try:
        p.write_text(json.dumps(clean_chapters(info.get("chapters"), info.get("duration")),
                                ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        print(f"[chapters] couldn't save {p.name}: {e}")

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
        with urllib.request.urlopen(req, timeout=5) as resp:
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
    try:
        sponsor_path(video_id).write_text(json.dumps(segments), encoding="utf-8")
    except OSError as e:
        print(f"[sponsorblock] couldn't save {sponsor_path(video_id).name}: {e}")

def cached_sponsor_segments(video_id: str):
    try:
        data = json.loads(sponsor_path(video_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, list) else None

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
        except FileNotFoundError:
            pass

def enforce_cache_size_limit():
    files = sorted(cache_files(), key=lambda f: f.stat().st_mtime)
    total = sum(f.stat().st_size for f in files)
    i = 0
    while total > CACHE_MAX_BYTES and i < len(files):
        f = files[i]
        try:
            size = f.stat().st_size
            remove_download(f)
            total -= size
            print(f"[cache] removed (size cap {CACHE_MAX_BYTES // (1024**3)}GB): {f.name}")
        except FileNotFoundError:
            pass
        i += 1

def cleanup_unused_thumbnails():
    """Thumbnails of videos that aren't downloaded go once nothing has shown them for
    CACHE_MAX_AGE_DAYS (a download's thumbnail goes with the download)."""
    cutoff = time.time() - CACHE_MAX_AGE_DAYS * 86400
    removed = 0
    for f in CACHE_DIR.glob("*.jpg"):
        try:
            if (VIDEO_ID_RE.match(f.stem) and not cached_path(f.stem).exists()
                    and f.stat().st_mtime < cutoff):
                f.unlink()
                removed += 1
        except FileNotFoundError:
            pass
    if removed:
        print(f"[cache] removed {removed} thumbnails not shown for {CACHE_MAX_AGE_DAYS}d")

def run_cache_maintenance():
    cleanup_old_files()
    enforce_cache_size_limit()
    cleanup_unused_thumbnails()

def cache_maintenance_loop():
    while True:
        time.sleep(CACHE_MAINTENANCE_INTERVAL_SECONDS)
        run_cache_maintenance()

def video_id_from_url(url: str):
    parsed = urlparse(url)
    if (parsed.hostname or "").endswith("youtu.be"):
        return parsed.path.lstrip("/").split("/")[0] or None
    return parse_qs(parsed.query).get("v", [None])[0]

def thumbnail_url(video_id: str) -> str:
    # Static 16:9 thumbnail straight from YouTube's image CDN (no yt-dlp call needed).
    return f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"
