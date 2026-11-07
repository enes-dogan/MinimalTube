"""MinimalTube server - config."""
import base64
import hashlib
import json
import re
import shutil
from pathlib import Path

from .system import app_dir, cache_dir, data_dir

# Per OS: see system.py
CACHE_DIR = cache_dir()
CACHE_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR = data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)
APP_DIR = app_dir()
APP_DIR.mkdir(parents=True, exist_ok=True)
for _name in ("playlists.json", "subscriptions.json", "order.json"):  # older versions kept them in the cache
    if (CACHE_DIR / _name).exists() and not (DATA_DIR / _name).exists():
        shutil.move(CACHE_DIR / _name, DATA_DIR / _name)


def _extension_origin_re():
    # The id Chrome gives an extension with a "key" (install.py works it out the same way): the
    # SHA-256 of the key, its first 32 hex digits written with the letters a-p.
    try:
        manifest = json.loads((Path(__file__).resolve().parent.parent / "manifest.json")
                              .read_text(encoding="utf-8"))
        digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    except (OSError, ValueError, KeyError, TypeError):
        return re.compile(r"chrome-extension://[a-p]{32}$")  # no key: Chrome picks the id, so any extension
    ext_id = digest.translate(str.maketrans("0123456789abcdef", "abcdefghijklmnop"))
    return re.compile(f"chrome-extension://{ext_id}$")


# The only browser origin the server answers (its CORS headers and the Origin check in routes).
EXTENSION_ORIGIN_RE = _extension_origin_re()

CACHE_MAX_AGE_DAYS = 60

CACHE_MAX_BYTES = 64 * 1024 ** 3

CACHE_MAINTENANCE_INTERVAL_SECONDS = 6 * 3600

# ---- Original titles -------------------------------------------------------------
# Channel listings (the feed, playlists) come back in YouTube's *translated* title when the
# uploader added one (e.g. an English title on a Turkish video). A full per-video lookup gives
# the title in the video's own language, so those are kept in original_titles.json and used
# instead. Videos opened / downloaded already store theirs in titles.json.
ORIGINAL_TITLES_MAX = 20000

PLAYLIST_ID_RE = re.compile(r"^[a-f0-9]{12}$")

# Videos with several audio tracks (dubs / auto-dubbing): take the one YouTube marks as the
# "original"; videos with a single track (or no such mark) fall through to plain bestaudio.
FORMAT_SELECTOR = (
    "bestvideo*+bestaudio[format_note~='(?i)original']"
    "/bestvideo*+bestaudio"
    "/best"
)

MAX_PARALLEL_DOWNLOADS = 2

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

MAX_DURATION_LOOKUPS = 30

SHORTS_LIVE_RE = re.compile(r"/(?:shorts|live)/([A-Za-z0-9_-]{11})")

CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")

# ---- feed: newest uploads of every subscribed channel, merged by date ----
# Every channel contributes two independent sources: its Videos tab and its Shorts tab
# (a Short is just another video here). Collaboration videos are listed on every
# collaborator's tab, so they reach the feed through whichever collaborator is subscribed.
FEED_STEP = 30           # videos fetched per source per yt-dlp request (one page of a channel tab)

FEED_TTL = 600           # seconds before a source's cached uploads are refetched

FEED_KINDS = ("videos", "shorts")

RSS_TTL = 300
