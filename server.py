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
from pathlib import Path

# This folder is also the extension, and Chromium refuses to load one that holds a name
# starting with "_": never write the package's bytecode (__pycache__) here.
sys.dont_write_bytecode = True

REQUIREMENTS = Path(__file__).resolve().parent / "requirements.txt"


def check_dependencies():
    try:
        import flask  # noqa: F401
        import flask_cors  # noqa: F401
    except ImportError:
        sys.exit(
            "Missing dependencies. Install with:\n"
            f"  pip install --break-system-packages -r {REQUIREMENTS}\n"
            "or, on CachyOS/Arch:\n"
            "  sudo pacman -S python-pip python-flask python-flask-cors python-waitress ffmpeg deno"
        )
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        sys.exit(
            "yt-dlp isn't available: MinimalTube has no copy of its own yet, and there's no "
            "system-wide yt-dlp either.\nWith pip installed, get MinimalTube's copy with:\n"
            f"  python3 {Path(__file__).resolve()} --update-yt-dlp"
        )
    if shutil.which("ffmpeg") is None:
        sys.exit(
            "ffmpeg is required (to merge separate video+audio streams) but was "
            "not found on PATH.\nInstall it with:\n  sudo pacman -S ffmpeg"
        )


def main():
    parser = argparse.ArgumentParser(description="MinimalTube local server")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--update-yt-dlp", action="store_true",
                        help="install the newest yt-dlp as MinimalTube's own copy (used from "
                             "the server's next start), then exit")
    args = parser.parse_args()

    from minimaltube.ytdlp_copy import install_latest, running_own_copy, use_own_copy

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
        CACHE_MAX_BYTES,
        MAX_PARALLEL_DOWNLOADS,
    )
    from minimaltube.downloads import download_worker, resume_running_downloads
    from minimaltube.media import cache_maintenance_loop, run_cache_maintenance
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
        f"capped at {CACHE_MAX_BYTES // (1024**3)}GB)"
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
              "(sudo pacman -S python-waitress for the steadier one).")
        app.run(host=host, port=port, threaded=True)
        return
    waitress_serve(app, host=host, port=port, threads=WSGI_THREADS, ident="MinimalTube")


if __name__ == "__main__":
    main()
