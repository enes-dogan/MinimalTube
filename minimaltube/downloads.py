"""MinimalTube server - downloads: the job table, the yt-dlp worker threads and the Downloads list.

A job is `jobs[video_id]`: {"status", "percent", "title", "error", "sponsorblock"}. Its status is
"queued" (waiting for a worker), "downloading", "merging", "waiting" (the connection dropped: it
continues from its .part file once YouTube can be reached again), "ready" or "error". Routes never
touch the table: they start, queue, cancel and read jobs through the functions here.
"""
import hashlib
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import yt_dlp

from . import store
from .cache import enforce_cache_size_limit
from .config import CACHE_DIR, FORMAT_SELECTOR, VIDEO_ID_RE
from .jsonfile import read_json, write_json_atomic
from .links import watch_url
from .media import (
    cached_path,
    fetch_sponsor_segments,
    remember_sponsor_segments,
    remember_thumbnail,
    remove_video_files,
    sponsor_path,
    subtitle_path,
    video_duration,
)
from .net import internet_up, on_online
from .store import remember_title, remember_video, titles
from .subtitles import fetch_original_subtitle, sublang_current
from .ytinfo import video_info, ydl

jobs = {}

jobs_lock = threading.Lock()

# Videos whose in-flight download should be aborted because the user deleted them.
cancelled = set()

cancelled_lock = threading.Lock()

DownloadCancelled = getattr(yt_dlp.utils, "DownloadCancelled", Exception)

download_queue = queue.Queue()

ACTIVE_STATUSES = ("queued", "downloading", "merging", "waiting")
RUNNING_STATUSES = ("downloading", "merging")
WAITING_TEXT = "Waiting for internet connection"


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

def set_job(video_id: str, **fields):
    with jobs_lock:
        job = jobs.setdefault(video_id, {})
        job.update(fields)

def get_job(video_id: str) -> dict:
    """A copy of a video's job ({} when it has none)."""
    with jobs_lock:
        return dict(jobs.get(video_id, {}))

def is_active(video_id: str) -> bool:
    """Whether a download of this video is queued, running or waiting for the connection."""
    return get_job(video_id).get("status") in ACTIVE_STATUSES

def active_jobs() -> list:
    """Every download that is queued, running or waiting: [{"id", "status", "percent"}, ...]."""
    with jobs_lock:
        return [{"id": vid, "status": job.get("status"), "percent": job.get("percent", 0)}
                for vid, job in jobs.items() if job.get("status") in ACTIVE_STATUSES]

def job_status(video_id: str):
    """A video's download state for the player: its job plus "has_subtitles"; a downloaded
    video without a job counts as ready. None: not downloaded and no job."""
    job = get_job(video_id)
    if job.get("status") == "ready" and not cached_path(video_id).exists():
        job = {}  # its file was removed since (by the cache sweep, or by hand)
    if not job:
        if not cached_path(video_id).exists():
            return None
        job = {"status": "ready", "percent": 100}
    job["has_subtitles"] = subtitle_path(video_id).exists()
    return job

def mark_ready(video_id: str, title=None) -> dict:
    """Note that a video is downloaded (its file is there); returns its job."""
    with jobs_lock:
        jobs[video_id] = {"status": "ready", "percent": 100, "title": title}
        return dict(jobs[video_id])

def start_download(video_id: str, url: str, info: dict, sponsorblock: bool = False) -> dict:
    """Download a video now, unless it is downloaded or already being downloaded.

    Args:
        video_id (str): An 11-character YouTube video id.
        url (str): Its watch URL.
        info (dict): A full lookup of it (ytinfo.video_info), for its title and captions.
        sponsorblock (bool): The player's SponsorBlock setting: the download then keeps the
            video's sponsor segments, for skipping them offline.

    Returns:
        dict: A copy of the video's job. A new download starts in its own thread right away
        (not through the queue: this is the video being played), with its captions fetched
        alongside; "ready" when the file is already there.
    """
    title = info.get("title")
    with jobs_lock:
        if cached_path(video_id).exists():
            jobs[video_id] = {"status": "ready", "percent": 100, "title": title}
            return dict(jobs[video_id])
        if (jobs.get(video_id) or {}).get("status") in RUNNING_STATUSES:
            return dict(jobs[video_id])
        jobs[video_id] = {"status": "downloading", "percent": 0, "title": title,
                          "sponsorblock": sponsorblock}
        job = dict(jobs[video_id])
    with cancelled_lock:
        cancelled.discard(video_id)
    threading.Thread(target=download_job, args=(video_id, url), daemon=True).start()
    threading.Thread(target=fetch_original_subtitle, args=(video_id, url, info), daemon=True).start()
    return job

def queue_download(video_id: str, sponsorblock: bool = False) -> bool:
    """Put a video in line for the download workers (MAX_PARALLEL_DOWNLOADS run at once).

    Returns:
        bool: False when there was nothing to do: it is downloaded, or already queued, running
        or waiting.
    """
    if cached_path(video_id).exists():
        return False
    with jobs_lock:
        if (jobs.get(video_id) or {}).get("status") in ACTIVE_STATUSES:
            return False
        jobs[video_id] = {"status": "queued", "percent": 0, "sponsorblock": sponsorblock}
    with cancelled_lock:
        cancelled.discard(video_id)
    download_queue.put(video_id)
    return True

def forget_download(video_id: str) -> bool:
    """Drop a video's job (the video is being deleted). One that is downloading right now is
    told to stop: its thread notices, aborts and removes what it wrote.

    Returns:
        bool: Whether a running download was cancelled.
    """
    with jobs_lock:
        job = jobs.pop(video_id, None)
    in_flight = bool(job) and job.get("status") in RUNNING_STATUSES
    if in_flight:
        with cancelled_lock:
            cancelled.add(video_id)
    backfill_failed.discard(video_id)
    library_changed()
    return in_flight

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
        library_changed()
        remember_video(video_id, info)
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
    library_changed()

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
    write_json_atomic(resume_path(), running, "restart")

def resume_running_downloads():
    running = read_json(resume_path(), {})
    resume_path().unlink(missing_ok=True)
    for vid, sponsorblock in running.items():
        if VIDEO_ID_RE.match(vid):
            queue_download(vid, sponsorblock is True)

def download_worker():
    while True:
        video_id = download_queue.get()
        try:
            with jobs_lock:
                job = jobs.get(video_id)
                if not job or job.get("status") != "queued":
                    continue
                job["status"] = "downloading"
            download_job(video_id, watch_url(video_id))
        finally:
            download_queue.task_done()

# ---- The Downloads list -----------------------------------------------------------------
# The list is the cache folder's *.mp4 files. Its revision is a short hash of their ids: the
# player keeps the one its list was made from and loads the list again when the server's differs
# (a download finished, a video was deleted, the sweep or the user removed files).
LIBRARY_REV_MAX_AGE = 2.0
_library_rev = {"at": 0.0, "value": ""}

def downloaded_ids() -> list:
    return sorted(f.stem for f in CACHE_DIR.glob("*.mp4") if VIDEO_ID_RE.match(f.stem))

def library_rev(max_age: float = LIBRARY_REV_MAX_AGE) -> str:
    """The Downloads list's revision: changes whenever the set of downloaded videos does. The
    folder is read at most every `max_age` seconds (0: now)."""
    now = time.time()
    if now - _library_rev["at"] >= max_age:
        digest = hashlib.sha1("\n".join(downloaded_ids()).encode("ascii")).hexdigest()[:12]
        _library_rev.update(at=now, value=digest)
    return _library_rev["value"]

def library_changed():
    """The server itself added or removed a download: the next library_rev() reads the folder."""
    _library_rev["at"] = 0.0

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
            for it, dur in zip(items, pool.map(lambda i: video_duration(i["id"]), items)):
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
