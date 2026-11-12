"""MinimalTube server - config."""
import re
from pathlib import Path

from .system import app_dir, cache_dir, data_dir, extension_id

# Per OS: see system.py
CACHE_DIR = cache_dir()
CACHE_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR = data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)
APP_DIR = app_dir()
APP_DIR.mkdir(parents=True, exist_ok=True)

# The only browser origin the server answers (its CORS headers and the Origin check in routes.py).
# A manifest without a "key" gets an id of the browser's choosing, so any extension counts then.
_EXTENSION_ID = extension_id(Path(__file__).resolve().parent.parent / "manifest.json")
EXTENSION_ORIGIN_RE = re.compile(f"chrome-extension://{_EXTENSION_ID or '[a-p]{32}'}$")

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

# Background lookups one request may have waiting (a playlist's cards, the queue's lengths): the
# app asks again for the rest.
LOOKUPS_WAITING_MAX = 30

CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")

# ---- feed: newest uploads of every subscribed channel, merged by date ----
# Every channel contributes two independent sources: its Videos tab and its Shorts tab
# (a Short is just another video here). Collaboration videos are listed on every
# collaborator's tab, so they reach the feed through whichever collaborator is subscribed.
FEED_STEP = 30           # videos fetched per source per yt-dlp request (one page of a channel tab)

FEED_TTL = 600           # seconds before a source's cached uploads are refetched

FEED_KINDS = ("videos", "shorts")

RSS_TTL = 300
