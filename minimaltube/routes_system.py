"""MinimalTube server - routes about the server itself: is it there, is the internet there, the
downloads' size cap, the videos folder, restarting, updating yt-dlp and updating MinimalTube, and the
installed app's icon."""
import os
import sys
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
from . import launchers, updater
from .system import app_version, open_folder, own_command, run_again
from .web import STARTED, ApiError, json_body
from .ytdlp_copy import install_latest, running_own_copy, up_to_date

bp = Blueprint("system", __name__)


@bp.route("/health")
def health():
    # "app" is how the extension tells this server from another program on the same port;
    # "version" is the one installed in the folder now (after an update, ahead of a running player)
    return jsonify({"status": "ok", "app": "minimaltube", "started": STARTED, "version": app_version()})


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


# ---- Updating MinimalTube itself from GitHub's releases (updater.py) ----
@bp.route("/update/status")
def update_status():
    """What Settings shows about updates: see updater.status()."""
    return jsonify(updater.status())


@bp.route("/update/check", methods=["POST"])
def update_check():
    """Ask GitHub for its latest release now (at most once a minute); answers the status, which
    carries what went wrong."""
    updater.check(manual=True)
    return jsonify(updater.status())


@bp.route("/update/download", methods=["POST"])
def update_download():
    """Download and check the latest release in the background; the status follows it."""
    try:
        updater.start_download()
    except updater.UpdateError as e:
        raise ApiError(str(e), 409) from e
    return jsonify(updater.status())


def _stop_server():
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


def _start_apply(start):
    # the updater runs as a process of its own; when server files change, it waits for this one
    # to end, which happens once this answer is out
    try:
        res = start(own_command(), int(request.environ.get("SERVER_PORT") or 0))
    except updater.UpdateError as e:
        raise ApiError(str(e), 409) from e
    except OSError as e:
        raise ApiError(f"couldn't start the update: {e}", 500) from e
    if res["restart"]:
        remember_running_downloads()
        threading.Timer(0.5, _stop_server).start()
    return jsonify({"status": "installing", "started": STARTED, **res})


@bp.route("/update/install", methods=["POST"])
def update_install():
    """Install the downloaded release: {"id", "version", "restart", "started"}. With "restart"
    the server stops now and the updater starts the new one; follow it with the status's
    "install" (same id)."""
    return _start_apply(updater.start_install)


@bp.route("/update/rollback", methods=["POST"])
def update_rollback():
    """Go back to the version the last update replaced; answered like /update/install."""
    return _start_apply(updater.start_rollback)


@bp.route("/update/settings", methods=["PUT"])
def update_settings():
    """{"auto": true|false}: Settings' "Install updates automatically"."""
    auto = json_body().get("auto")
    if not isinstance(auto, bool):
        raise ApiError('expected {"auto": true} or {"auto": false}')
    try:
        updater.set_auto(auto)
    except OSError as e:
        raise ApiError(str(e), 500) from e
    return jsonify(updater.status())


@bp.route("/launcher-icon", methods=["PUT"])
def launcher_icon():
    """{"theme": "<id>"}: give the installed app (menu entry, Start menu, ~/Applications) that colour
    theme's icon, and keep the theme for the installer. Answers {"theme", "updated", "note"}."""
    theme = json_body().get("theme")
    if theme not in launchers.THEMES:
        raise ApiError(f"Unknown theme. Choose one of: {', '.join(launchers.THEMES)}.")
    try:
        return jsonify(launchers.set_launcher_theme(theme))
    except (OSError, RuntimeError) as e:
        raise ApiError(str(e), 500) from e
