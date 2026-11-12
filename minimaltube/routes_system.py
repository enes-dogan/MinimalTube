"""MinimalTube server - routes about the server itself: is it there, is the internet there, the
downloads' size cap, the videos folder, restarting and updating yt-dlp."""
import threading

import yt_dlp
from flask import Blueprint, jsonify, request

from .cache import (
    CACHE_LIMIT_GB_MAX,
    CACHE_LIMIT_GB_MIN,
    cache_limit_gb,
    downloads_bytes,
    set_cache_limit_gb,
)
from .config import CACHE_DIR
from .downloads import remember_running_downloads
from .net import internet_up
from .system import open_folder, run_again
from .web import STARTED, ApiError, json_body
from .ytdlp_copy import install_latest, running_own_copy, up_to_date

bp = Blueprint("system", __name__)


@bp.route("/health")
def health():
    # "app" is how the extension tells this server from another program on the same port
    return jsonify({"status": "ok", "app": "minimaltube", "started": STARTED})


@bp.route("/net")
def net():
    """Whether YouTube can be reached at all (the player's OFFLINE badge)."""
    return jsonify({"online": internet_up(max_age=1)})


@bp.route("/cache-limit", methods=["GET", "PUT"])
def cache_limit():
    """The downloads' size cap: GET answers {"gb", "used_bytes", "min", "max"}; PUT {"gb": n}
    sets it, refused (409) while the downloads already take more than n GB."""
    if request.method == "PUT":
        gb = json_body().get("gb")
        if isinstance(gb, bool) or not isinstance(gb, int) or not CACHE_LIMIT_GB_MIN <= gb <= CACHE_LIMIT_GB_MAX:
            raise ApiError(f"Choose a size from {CACHE_LIMIT_GB_MIN} to {CACHE_LIMIT_GB_MAX} GB.")
        used = downloads_bytes()
        if used > gb * 1024 ** 3:
            raise ApiError(f"Your downloads already take {used / 1024 ** 3:.1f} GB, more than "
                           f"{gb} GB. Delete some first.", 409, used_bytes=used)
        try:
            set_cache_limit_gb(gb)
        except OSError as e:
            raise ApiError(str(e), 500) from e
    return jsonify({"gb": cache_limit_gb(), "used_bytes": downloads_bytes(),
                    "min": CACHE_LIMIT_GB_MIN, "max": CACHE_LIMIT_GB_MAX})


@bp.route("/open-folder", methods=["POST"])
def show_videos_folder():
    """Open the folder where downloaded videos are kept in the file manager. POST: a page on
    another site must not be able to pop it open with a link or image."""
    try:
        open_folder(CACHE_DIR)
    except Exception as e:
        raise ApiError(str(e), 500) from e
    return jsonify({"status": "ok", "path": str(CACHE_DIR)})


def schedule_restart():
    remember_running_downloads()
    # once this answer is out; on Windows the new server waits for this one's port
    threading.Timer(0.5, run_again, kwargs={"windows_arg": "--wait-for-port"}).start()


@bp.route("/restart", methods=["POST"])
def restart():
    """Run the server again (new code, a new yt-dlp); the running downloads continue."""
    schedule_restart()
    return jsonify({"status": "restarting", "started": STARTED})


@bp.route("/ytdlp/update", methods=["POST"])
def ytdlp_update():
    """Install the newest yt-dlp as MinimalTube's own copy (no sudo), then restart to use it."""
    running = yt_dlp.version.__version__
    if running_own_copy() and up_to_date(running):
        return jsonify({"status": "current", "version": running})
    try:
        version = install_latest()
    except RuntimeError as e:
        raise ApiError(str(e), 500) from e
    schedule_restart()
    return jsonify({"status": "restarting", "started": STARTED, "version": version})
