"""MinimalTube server - YouTube links: the one place that reads them and writes them."""
import re
from urllib.parse import parse_qs, urlparse

from .config import VIDEO_ID_RE

YOUTUBE_HOSTS = ("youtube.com", "youtu.be", "youtube-nocookie.com")
PATH_VIDEO_RE = re.compile(r"/(?:shorts|live|embed|v)/([A-Za-z0-9_-]{11})")
LIST_ID_RE = re.compile(r"[A-Za-z0-9_-]{2,64}")


def youtube_ids(url: str) -> tuple:
    """The video id and the playlist id in a YouTube link.

    Args:
        url (str): A link on youtube.com (any subdomain: www., m., music.), youtu.be or
            youtube-nocookie.com, with or without "https://"; or a bare 11-character video id.
            Watch, /shorts/, /live/, /embed/ and /v/ links all count.

    Returns:
        tuple: (video id or None, playlist id or None). Both are None for anything that isn't
        a YouTube link, so a caller can refuse it before yt-dlp (which opens any site) sees it.
    """
    url = (url or "").strip()
    if VIDEO_ID_RE.match(url):
        return url, None
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
    except ValueError:
        return None, None
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not any(
            host == h or host.endswith("." + h) for h in YOUTUBE_HOSTS):
        return None, None
    query = parse_qs(parsed.query)
    vid = query.get("v", [None])[0]
    if host == "youtu.be":
        vid = parsed.path.lstrip("/").split("/")[0]
    else:
        m = PATH_VIDEO_RE.match(parsed.path)
        vid = m.group(1) if m else vid
    lst = query.get("list", [None])[0]
    return (vid if vid and VIDEO_ID_RE.match(vid) else None,
            lst if lst and LIST_ID_RE.fullmatch(lst) else None)


def watch_url(video_id: str) -> str:
    """The link of a video, in the one form the app stores and hands to yt-dlp."""
    return f"https://www.youtube.com/watch?v={video_id}"


def channel_url(channel_id: str) -> str:
    return f"https://www.youtube.com/channel/{channel_id}"


def thumbnail_url(video_id: str) -> str:
    # Static 16:9 thumbnail straight from YouTube's image CDN (no yt-dlp call needed).
    return f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"
