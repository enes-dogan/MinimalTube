#!/usr/bin/env python3
"""MinimalTube local server.

Resolves, downloads, caches and serves YouTube videos plus their metadata for
the MinimalTube extension. The code lives in the `minimaltube` package next to
this file; see its docstring for what each module covers.

    python3 server.py [--host 127.0.0.1] [--port 7860]
    python3 server.py --update-yt-dlp     # install the newest yt-dlp as MinimalTube's own copy
"""

import argparse
import shutil
import sys
import threading
import time
from pathlib import Path

# This folder is also the extension, and Chromium refuses to load one that holds a name
# starting with "_": never write the package's bytecode (__pycache__) here.
sys.dont_write_bytecode = True

REQUIREMENTS = Path(__file__).resolve().parent / "requirements.txt"


def check_dependencies():
    from minimaltube.system import installer_hint

    # the installer sets all of this up on every OS
    again = f"Run the installer again ({installer_hint()}) to set it up."
    try:
        import flask  # noqa: F401
        import flask_cors  # noqa: F401
    except ImportError:
        sys.exit(
            f"This Python ({sys.executable}) is missing Flask / Flask-CORS. {again}\n"
            f"By hand: {Path(sys.executable).name} -m pip install -r {REQUIREMENTS}"
        )
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        sys.exit(
            "yt-dlp isn't available: MinimalTube has no copy of its own yet, and there's no "
            f"system-wide yt-dlp either. {again}\nOr get MinimalTube's copy with:\n"
            f"  {Path(sys.executable).name} {Path(__file__).resolve()} --update-yt-dlp"
        )
    if shutil.which("ffmpeg") is None:
        sys.exit(f"ffmpeg is required (to merge separate video+audio streams) but wasn't found. {again}")


def wait_for_port(host, port, seconds=20):
    """A restart on Windows starts this server before the old one has let go of the port."""
    from minimaltube.system import port_is_free

    deadline = time.time() + seconds
    while time.time() < deadline and not port_is_free(host, port):
        time.sleep(0.25)


def main():
    from minimaltube.system import SERVER_PORT

    parser = argparse.ArgumentParser(description="MinimalTube local server")
    parser.add_argument("--port", type=int, default=SERVER_PORT)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--wait-for-port", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--update-yt-dlp", action="store_true",
                        help="install the newest yt-dlp as MinimalTube's own copy (used from "
                             "the server's next start), then exit")
    args = parser.parse_args()

    if args.wait_for_port:  # first: the old server's files (its yt-dlp, its downloads) are let go too
        wait_for_port(args.host, args.port)
    from minimaltube.system import use_own_tools
    from minimaltube.ytdlp_copy import install_latest, running_own_copy, use_own_copy

    use_own_tools()  # ffmpeg, ffprobe and deno: MinimalTube's own ones (if it fetched any) first

    if args.update_yt_dlp:
        try:
            version = install_latest()
        except RuntimeError as e:
            sys.exit(f"Couldn't install yt-dlp: {e}")
        print(f"Installed yt-dlp {version} as MinimalTube's own copy (used from the server's next start).")
        return

    use_own_copy()
    check_dependencies()
    from yt_dlp.version import __version__ as ytdlp_version

    from minimaltube.config import (
        CACHE_DIR,
        CACHE_MAX_AGE_DAYS,
        MAX_PARALLEL_DOWNLOADS,
    )
    from minimaltube.cache import cache_limit_gb, cache_maintenance_loop, run_cache_maintenance
    from minimaltube.downloads import download_worker, resume_running_downloads
    from minimaltube.routes import app

    run_cache_maintenance()
    threading.Thread(target=cache_maintenance_loop, daemon=True).start()

    for _ in range(MAX_PARALLEL_DOWNLOADS):
        threading.Thread(target=download_worker, daemon=True).start()
    resume_running_downloads()

    print(f"MinimalTube server running at http://{args.host}:{args.port}")
    source = "MinimalTube's own copy" if running_own_copy() else "system-wide"
    print(f"yt-dlp {ytdlp_version} ({source})")
    print(
        f"Cache directory: {CACHE_DIR} (auto-expires after {CACHE_MAX_AGE_DAYS}d, "
        f"capped at {cache_limit_gb()}GB)"
    )
    serve(app, args.host, args.port)


WSGI_THREADS = 16  # streaming keeps several requests open at once (video + audio + polls)


def serve(app, host, port):
    """waitress when it's installed (a real server, steadier for long streams); otherwise
    Flask's built-in development server."""
    try:
        from waitress import serve as waitress_serve
    except ImportError:
        print("waitress isn't installed: using Flask's built-in server "
              "(the installer sets up the steadier one: pip install waitress).")
        app.run(host=host, port=port, threaded=True)
        return
    waitress_serve(app, host=host, port=port, threads=WSGI_THREADS, ident="MinimalTube")


if __name__ == "__main__":
    main()
