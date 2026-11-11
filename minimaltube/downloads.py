"""MinimalTube server - downloads."""
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import yt_dlp

from . import store
from .config import CACHE_DIR, FORMAT_SELECTOR, VIDEO_ID_RE
from .media import (
    cached_path,
    enforce_cache_size_limit,
    fetch_sponsor_segments,
    probe_duration,
    remember_chapters,
    remember_description,
    remember_meta,
    remember_release_date,
    remember_sponsor_segments,
    remember_thumbnail,
    remove_video_files,
    sponsor_path,
)
from .net import internet_up, on_online
from .store import remember_title, titles
from .subtitles import fetch_original_subtitle, sublang_current
from .ytinfo import video_info, ydl

jobs = {}

jobs_lock = threading.Lock()

# Videos whose in-flight download should be aborted because the user deleted them.
cancelled = set()

cancelled_lock = threading.Lock()

def is_cancelled(video_id: str) -> bool:
    with cancelled_lock:
        return video_id in cancelled

def finish_cancel(video_id: str):
    remove_video_files(video_id)
    with jobs_lock:
        jobs.pop(video_id, None)
    with cancelled_lock:
        cancelled.discard(video_id)
    print(f"[delete] cancelled download and removed files: {video_id}")

DownloadCancelled = getattr(yt_dlp.utils, "DownloadCancelled", Exception)

download_queue = queue.Queue()

# "waiting": the connection dropped; the download continues (from its .part file) once
# YouTube can be reached again.
ACTIVE_STATUSES = ("queued", "downloading", "merging", "waiting")
WAITING_TEXT = "Waiting for internet connection"

def set_job(video_id: str, **fields):
    with jobs_lock:
        job = jobs.setdefault(video_id, {})
        job.update(fields)

def get_job(video_id: str):
    with jobs_lock:
        return dict(jobs.get(video_id, {}))

def download_job(video_id: str, url: str):
    def hook(d):
        if is_cancelled(video_id):
            raise DownloadCancelled("deleted by user")
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            downloaded = d.get("downloaded_bytes", 0)
            percent = round((downloaded / total) * 100, 1) if total else 0.0
            set_job(video_id, status="downloading", percent=percent)
        elif d.get("status") == "finished":
            set_job(video_id, status="merging", percent=99)

    ydl_opts = {
        "format": FORMAT_SELECTOR,
        "merge_output_format": "mp4",
        "outtmpl": str(CACHE_DIR / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "progress_hooks": [hook],
    }

    try:
        with ydl(**ydl_opts) as y:
            info = y.extract_info(url, download=True)
        if is_cancelled(video_id):
            raise DownloadCancelled("deleted by user")
        set_job(video_id, status="ready", percent=100, title=info.get("title"))
        remember_title(video_id, info.get("title"))
        remember_description(video_id, info.get("description"))
        remember_chapters(video_id, info)
        remember_release_date(video_id, info)
        remember_meta(video_id, info)
        remember_thumbnail(video_id)
        remember_thumbnail(video_id, large=True)  # its card offline
    except Exception as e:
        if is_cancelled(video_id):
            finish_cancel(video_id)
            return
        if not internet_up():
            set_job(video_id, status="waiting", error=WAITING_TEXT)
            return
        set_job(video_id, status="error", error=str(e))
        return

    if is_cancelled(video_id):
        finish_cancel(video_id)
        return

    # "sponsorblock": the player's SponsorBlock setting, sent with the request that started this
    if get_job(video_id).get("sponsorblock") and not sponsor_path(video_id).exists():
        try:
            remember_sponsor_segments(video_id, fetch_sponsor_segments(video_id))
        except (OSError, ValueError):
            pass  # asked again whenever it plays online

    if not sublang_current(video_id):
        fetch_original_subtitle(video_id, url, info)

    try:
        enforce_cache_size_limit()
    except OSError:
        pass

@on_online
def resume_waiting_downloads():
    with jobs_lock:
        waiting = [vid for vid, job in jobs.items() if job.get("status") == "waiting"]
        for vid in waiting:
            jobs[vid].update(status="queued", error=None)
    for vid in waiting:
        print(f"[download] back online, resuming {vid}")
        download_queue.put(vid)

# Downloads that were running when the server restarted itself (POST /restart) continue in the
# new process, from their .part files.
def resume_path():
    return CACHE_DIR / "resume.json"

def remember_running_downloads():
    with jobs_lock:
        running = {vid: bool(job.get("sponsorblock")) for vid, job in jobs.items()
                   if job.get("status") in ACTIVE_STATUSES and VIDEO_ID_RE.match(vid)}
    store.write_json_atomic(resume_path(), running, "restart")

def resume_running_downloads():
    running = store.read_json(resume_path(), {})
    resume_path().unlink(missing_ok=True)
    for vid, sponsorblock in running.items():
        if not VIDEO_ID_RE.match(vid) or cached_path(vid).exists():
            continue
        with jobs_lock:
            jobs[vid] = {"status": "queued", "percent": 0, "sponsorblock": sponsorblock is True}
        download_queue.put(vid)

def download_worker():
    while True:
        video_id = download_queue.get()
        try:
            with jobs_lock:
                job = jobs.get(video_id)
                if not job or job.get("status") != "queued":
                    continue
                job["status"] = "downloading"
            download_job(video_id, f"https://www.youtube.com/watch?v={video_id}")
        finally:
            download_queue.task_done()

def list_library():
    items = []
    for f in CACHE_DIR.glob("*.mp4"):
        if not VIDEO_ID_RE.match(f.stem):
            continue
        try:
            st = f.stat()
        except FileNotFoundError:
            continue
        items.append({"id": f.stem, "title": titles.get(f.stem),
                      "size": st.st_size, "mtime": st.st_mtime, "status": "ready"})
    # video lengths (kept on disk; older downloads are probed once, in parallel)
    if items:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for it, dur in zip(items, pool.map(lambda i: probe_duration(i["id"]), items)):
                it["duration"] = dur
    # Videos that are queued / downloading / merging right now are listed as well, so they
    # show up in "Downloads" immediately instead of only once the file is playable.
    with jobs_lock:
        active = {vid: dict(job) for vid, job in jobs.items()
                  if job.get("status") in ACTIVE_STATUSES
                  and not is_cancelled(vid)}
    have = {i["id"] for i in items}
    for vid, job in active.items():
        if vid in have or not VIDEO_ID_RE.match(vid):
            continue
        items.append({"id": vid, "title": titles.get(vid) or job.get("title"),
                      "size": 0, "mtime": time.time(),
                      "status": job.get("status"), "percent": job.get("percent", 0)})
    # Newly downloaded files (not yet in the saved order) go on top, newest first;
    # everything else follows the order the user arranged by dragging.
    pos = {vid: n for n, vid in enumerate(store.library_order)}
    fresh = sorted((i for i in items if i["id"] not in pos),
                   key=lambda i: i["mtime"], reverse=True)
    known = sorted((i for i in items if i["id"] in pos), key=lambda i: pos[i["id"]])
    return fresh + known

backfill_lock = threading.Lock()

backfill_running = False

backfill_failed = set()

def missing_titles():
    return [i["id"] for i in list_library()
            if not i["title"] and i["id"] not in backfill_failed]

def backfill_titles():
    global backfill_running
    try:
        while True:
            todo = missing_titles()
            if not todo:
                return
            video_id = todo[0]
            try:
                info = video_info(video_id, keep=False)
                title = info.get("title")
                if title:
                    remember_title(video_id, title)
                else:
                    backfill_failed.add(video_id)
            except Exception:
                backfill_failed.add(video_id)
    finally:
        with backfill_lock:
            backfill_running = False

def ensure_title_backfill():
    global backfill_running
    with backfill_lock:
        if backfill_running or not missing_titles():
            return
        backfill_running = True
    threading.Thread(target=backfill_titles, daemon=True).start()
