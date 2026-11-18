"""MinimalTube server - routes for what comes from YouTube's listings: subscriptions, the feed
of their uploads, collabs, and reading a YouTube playlist."""
import re
import time

import yt_dlp
from flask import Blueprint, jsonify, request

from .config import CHANNEL_ID_RE, FEED_KINDS, VIDEO_ID_RE
from .feed import (
    CHANNEL_FOLLOWERS,
    build_feed,
    feed_cache,
    feed_cache_lock,
    import_left,
    import_subscriptions,
    parse_channel_input,
    resolve_channel,
    saved_subscriptions,
    set_sync_base,
    sync_base,
    store_collabs,
    subs_lock,
    subscription_public,
    write_subscriptions,
)
from .links import watch_url, youtube_ids
from .store import original_title
from .web import ApiError, json_body
from .ytinfo import ydl

bp = Blueprint("feed", __name__)
TITLE_HANDLE_RE = re.compile(r"^@[A-Za-z0-9._-]{3,30}$")


@bp.route("/playlist")
def playlist():
    """The videos of a YouTube playlist link (?url=): {"items": [{index, id, title, url}],
    "currentIndex": where the link's own video is in it (0 without one, -1 when it isn't)}."""
    current_id, list_id = youtube_ids(request.args.get("url", ""))
    if not list_id:
        raise ApiError("not a YouTube playlist link")
    url = (f"{watch_url(current_id)}&list={list_id}" if current_id
           else f"https://www.youtube.com/playlist?list={list_id}")

    try:
        with ydl(skip_download=True, noplaylist=False, extract_flat="in_playlist") as y:
            info = y.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        raise ApiError(f"yt-dlp failed to load this playlist: {e}", 502) from e
    except Exception as e:
        raise ApiError(str(e), 500) from e

    items = []
    for entry in info.get("entries") or []:
        vid = entry.get("id") if entry else None
        if not vid or not VIDEO_ID_RE.match(vid):
            continue
        n = len(items) + 1
        items.append({"index": n, "id": vid,
                      "title": original_title(vid, entry.get("title")) or f"Video {n}",
                      "url": watch_url(vid)})

    if current_id:
        current_index = next((i for i, it in enumerate(items) if it["id"] == current_id), -1)
    else:
        current_index = 0
    return jsonify({"items": items, "currentIndex": current_index})


@bp.route("/subscriptions", methods=["GET"])
def subscriptions_list():
    with subs_lock:
        snapshot = list(saved_subscriptions)
    return jsonify({"subscriptions": [subscription_public(c) for c in snapshot],
                    "importing": import_left()})


@bp.route("/subscriptions/import", methods=["POST"])
def subscriptions_import():
    """Subscribe to many channels at once: {"channels": [{"id", "name", "handle"}, ...]}."""
    channels = json_body().get("channels")
    if not isinstance(channels, list):
        raise ApiError('expected a JSON body like {"channels": [{"id": "UC...", "name": "...", '
                       '"handle": "@..."}, ...]}')
    return jsonify(import_subscriptions(channels))


@bp.route("/subscriptions/youtube-sync", methods=["GET"])
def subscriptions_sync_get():
    """What the last sync with a YouTube account left on both sides: {"base": [ids] or null}."""
    return jsonify({"base": sync_base(str(request.args.get("account") or ""))})


@bp.route("/subscriptions/youtube-sync", methods=["PUT"])
def subscriptions_sync_put():
    """Remember what a sync left on both sides: {"account": key, "base": ["UC…", …]}."""
    data = json_body()
    if not isinstance(data.get("base"), list):
        raise ApiError('expected {"account": "...", "base": ["UC...", ...]}')
    try:
        set_sync_base(str(data.get("account") or ""), data["base"])
    except ValueError as e:
        raise ApiError(str(e)) from e
    return jsonify({"status": "ok"})


@bp.route("/subscriptions", methods=["POST"])
def subscriptions_add():
    """Subscribe to a channel: {"input": a channel URL, @handle or name}."""
    try:
        url = parse_channel_input(str(json_body().get("input") or ""))
    except ValueError as e:
        raise ApiError(str(e)) from e
    try:
        channel = resolve_channel(url)
    except ValueError as e:
        raise ApiError(str(e), 404) from e
    except yt_dlp.utils.DownloadError as e:
        raise ApiError(f"yt-dlp couldn't open that channel: {e}", 502) from e
    except Exception as e:
        raise ApiError(str(e), 500) from e

    with subs_lock:
        existing = next((c for c in saved_subscriptions if c["id"] == channel["id"]), None)
        if existing:
            return jsonify({"subscription": subscription_public(existing), "already": True})
        channel["added"] = time.time()
        saved_subscriptions.append(channel)
        write_subscriptions()
    return jsonify({"subscription": subscription_public(channel), "already": False})


_handle_channels = {}  # "@handle" in lower case -> the channel it names (looked up once per run)


@bp.route("/channel")
def channel_by_handle():
    """The channel an @handle names (?handle=@name): {"channel": {"id", "name", "handle", "url"}}.
    A subscribed channel is answered from the list; any other costs one yt-dlp lookup."""
    handle = str(request.args.get("handle") or "")
    if not TITLE_HANDLE_RE.match(handle):
        raise ApiError("not a channel handle")
    key = handle.lower()
    with subs_lock:
        known = next((c for c in saved_subscriptions if str(c.get("handle") or "").lower() == key), None)
    if known:
        return jsonify({"channel": subscription_public(known)})
    if key not in _handle_channels:
        try:
            channel = resolve_channel(f"https://www.youtube.com/{handle}")
        except (ValueError, yt_dlp.utils.DownloadError) as e:
            raise ApiError("YouTube has no channel by that name, or couldn't be reached", 404) from e
        if len(_handle_channels) >= 500:
            _handle_channels.clear()
        _handle_channels[key] = channel
    return jsonify({"channel": subscription_public(_handle_channels[key])})


@bp.route("/subscriptions/<chan:channel_id>", methods=["DELETE"])
def subscriptions_delete(channel_id):
    with subs_lock:
        before = len(saved_subscriptions)
        saved_subscriptions[:] = [c for c in saved_subscriptions if c["id"] != channel_id]
        removed = before - len(saved_subscriptions)
        if removed:
            write_subscriptions()
    with feed_cache_lock:
        for kind in FEED_KINDS:
            feed_cache.pop((channel_id, kind), None)
    if not removed:
        raise ApiError("unknown channel", 404)
    return jsonify({"status": "ok"})


@bp.route("/feed")
def feed():
    """The newest uploads of the subscribed channels, merged by date (?channel=: one channel's,
    subscribed or not; ?offset, ?limit; ?refresh=1 reads the channels again)."""
    try:
        offset = max(0, int(request.args.get("offset", 0)))
        limit = min(60, max(1, int(request.args.get("limit", 24))))
    except ValueError:
        raise ApiError("offset and limit must be integers") from None
    refresh = request.args.get("refresh") == "1"
    channel = request.args.get("channel") or None
    if channel and not CHANNEL_ID_RE.match(channel):
        raise ApiError("invalid channel id")
    channel_name = (request.args.get("name") or "").strip()[:100] or None
    items, has_more, errors, offline, pending = build_feed(offset, limit, refresh, channel, channel_name)
    return jsonify({"items": items, "has_more": has_more, "errors": errors, "offline": offline,
                    "pending": pending, "subscribers": CHANNEL_FOLLOWERS.get(channel) if channel else None})


@bp.route("/feed/collabs", methods=["POST"])
def feed_collabs():
    """Collabs the extension read from the signed-in YouTube subscriptions feed: {"videos": [...]}
    (see feed.store_collabs). Answers {"channels": [...]}, the subscribed channels that got one."""
    videos = json_body().get("videos")
    if not isinstance(videos, list):
        raise ApiError('expected a JSON body like {"videos": [{"id": "...", "channels": [...], '
                       '"published": ...}, ...]}')
    return jsonify({"channels": store_collabs(videos[:500])})
