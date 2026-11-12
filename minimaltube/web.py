"""MinimalTube server - what the route modules share: the error type that becomes a JSON answer,
the URL converters that only let valid ids through, and the readers of what a request carries."""
import time

import yt_dlp
from flask import request
from werkzeug.routing import BaseConverter

from .config import VIDEO_ID_RE
from .ytinfo import video_info

NET_HEADER = "X-MinimalTube-Net"
STARTED = time.time()


class ApiError(Exception):
    """An error answer. Raised anywhere under a route, the app answers
    {"error": message, **extra} with `status` (routes.py turns it into the response).

    Args:
        message (str): What went wrong, in words the player can show.
        status (int): The HTTP status (400 unless said otherwise).
        **extra: More fields for the answer's JSON.
    """

    def __init__(self, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.message, self.status, self.extra = message, status, extra


class VideoIdConverter(BaseConverter):
    """<vid:video_id> in a route: only an 11-character YouTube id matches. Ids become file
    names in the cache folder, and on Windows "\\" or "C:" in one would point outside it."""
    regex = r"[A-Za-z0-9_-]{11}"


class PlaylistIdConverter(BaseConverter):
    """<pl:playlist_id>: the id of a saved playlist (12 hex digits)."""
    regex = r"[a-f0-9]{12}"


class ChannelIdConverter(BaseConverter):
    """<chan:channel_id>: a YouTube channel id."""
    regex = r"UC[A-Za-z0-9_-]{22}"


def json_body() -> dict:
    """The request's JSON body ({} when there is none or it isn't an object)."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def ids_param(limit: int = 200) -> list:
    """The video ids of ?ids=a,b,c: the valid ones, at most `limit`."""
    return [v for v in (request.args.get("ids") or "").split(",") if VIDEO_ID_RE.match(v)][:limit]


def id_list(data: dict, example: str = "<video_id>") -> list:
    """The "ids" list of a JSON body.

    Raises:
        ApiError: The body has no such list (400, naming the body it expected).
    """
    ids = data.get("ids")
    if not isinstance(ids, list):
        raise ApiError(f'expected a JSON body like {{"ids": ["{example}", ...]}}')
    return ids


def full_info(video: str, doing: str) -> dict:
    """ytinfo.video_info for a route.

    Args:
        video (str): A video id or watch URL.
        doing (str): What the lookup is for, completing "yt-dlp failed to ...".

    Raises:
        ApiError: yt-dlp couldn't look the video up (502), or anything else went wrong (500).
    """
    try:
        return video_info(video)
    except yt_dlp.utils.DownloadError as e:
        raise ApiError(f"yt-dlp failed to {doing}: {e}", 502) from e
    except Exception as e:
        raise ApiError(str(e), 500) from e
