"""MinimalTube server - routes for playing one video: preparing it, streaming it (while it
downloads, or the downloaded file) and what the player shows with it."""
import threading

from flask import Blueprint, Response, jsonify, request, send_file

from .downloads import get_job, is_active, mark_ready, start_download
from .links import watch_url, youtube_ids
from .live import (
    UpstreamError,
    open_upstream,
    refresh_stream,
    register_stream,
    registered_stream,
    stream_age,
    stream_format,
    stream_index,
)
from .media import (
    cached_chapters,
    cached_meta,
    cached_path,
    cached_release_date,
    cached_sponsor_segments,
    clean_chapters,
    description_path,
    fetch_sponsor_segments,
    mark_thumbnail_used,
    meta_public,
    remember_chapters,
    remember_meta,
    remember_release_date,
    remember_sponsor_segments,
    remember_thumbnail,
    subtitle_path,
    thumb_path,
)
from .net import internet_up, is_online
from .store import remember_video, titles
from .subtitles import ensure_stream_subtitles, ensure_subtitle_backfill
from .web import ApiError, full_info, json_body
from .ytinfo import video_info

bp = Blueprint("playback", __name__)

RUNNING = ("downloading", "merging")


def _prepared(video_id: str, job: dict, **more) -> dict:
    return {**job, "video_id": video_id, "has_subtitles": subtitle_path(video_id).exists(), **more}


@bp.route("/prepare", methods=["POST"])
def prepare():
    """Get a video ready to play: {"url", "stream_only": bool, "sponsorblock": bool}.

    Answers the video's job ("status": "ready", "downloading", ... or "streaming" for Stream
    only) with "video_id", "title", "has_subtitles" and, until the file is there, "stream" (the
    formats the player can stream meanwhile) and "duration". A video that isn't downloaded
    starts downloading, unless `stream_only`. POST, so that a page on another site can't start
    downloads with a plain link or image (those carry no Origin for routes.py to refuse).
    """
    data = json_body()
    # Only YouTube videos: yt-dlp would open any site (even ones on the home network) for any
    # link, and a download that isn't YouTube's never shows in Downloads.
    video_id, _playlist = youtube_ids(str(data.get("url") or ""))
    if not video_id:
        raise ApiError("not a YouTube video link")
    url = watch_url(video_id)

    if cached_path(video_id).exists():
        ensure_subtitle_backfill(video_id, url)
        return jsonify(_prepared(video_id, mark_ready(video_id, titles.get(video_id))))
    running = get_job(video_id)
    live = registered_stream(video_id)
    if live and running.get("status") in RUNNING:
        running.setdefault("title", titles.get(video_id))
        return jsonify(_prepared(video_id, running, **live))

    info = full_info(url, "resolve this URL")
    video_id = info.get("id") or video_id
    remember_video(video_id, info)

    # Stream only (a player setting): nothing is downloaded unless a download already runs.
    if data.get("stream_only") is True and not cached_path(video_id).exists() and not is_active(video_id):
        ensure_stream_subtitles(video_id, url, info)
        return jsonify(_prepared(video_id, {"status": "streaming", "title": info.get("title")},
                                 stream=register_stream(video_id, info), duration=info.get("duration")))

    job = start_download(video_id, url, info, sponsorblock=data.get("sponsorblock") is True)
    job.setdefault("title", info.get("title"))
    if job.get("status") == "ready":
        ensure_subtitle_backfill(video_id, url)
        return jsonify(_prepared(video_id, job))
    return jsonify(_prepared(video_id, job, stream=register_stream(video_id, info),
                             duration=info.get("duration")))


STREAM_REFRESH_MIN_AGE = 120
stream_refresh_lock = threading.Lock()


def with_fresh_stream(video_id: str, fn):
    """Run fn(); if YouTube refuses an old stream URL (expired), fetch new URLs once and retry."""
    try:
        return fn()
    except UpstreamError as e:
        age = stream_age(video_id)
        if e.status not in (403, 410) or age is None or age < STREAM_REFRESH_MIN_AGE:
            raise
    with stream_refresh_lock:
        if (stream_age(video_id) or 0) >= STREAM_REFRESH_MIN_AGE:  # not refreshed meanwhile
            try:
                info = video_info(video_id, fresh=True)
            except Exception as e:
                raise UpstreamError(f"couldn't renew the stream: {e}") from e
            refresh_stream(video_id, info)
            print(f"[live] renewed the stream URLs of {video_id}")
    return fn()


@bp.route("/live/<vid:video_id>/<format_id>/index")
def live_index(video_id, format_id):
    try:
        index = with_fresh_stream(video_id, lambda: stream_index(video_id, format_id))
    except UpstreamError as e:
        raise ApiError(str(e), 502) from e
    if not index:
        raise ApiError("unknown stream", 404)
    return jsonify(index)


@bp.route("/live/<vid:video_id>/<format_id>")
def live_bytes(video_id, format_id):
    entry = stream_format(video_id, format_id)
    if not entry:
        raise ApiError("unknown stream", 404)
    try:
        start = int(request.args.get("start", 0))
        end = int(request.args["end"])
    except (KeyError, ValueError):
        raise ApiError("expected ?start=<byte>&end=<byte>") from None
    if start < 0 or end < start:
        raise ApiError("invalid byte range")
    try:
        upstream = with_fresh_stream(
            video_id, lambda: open_upstream(stream_format(video_id, format_id), start, end))
    except UpstreamError as e:
        raise ApiError(str(e), 502) from e

    def body():
        with upstream:
            while chunk := upstream.read(64 * 1024):
                yield chunk

    headers = {"Cache-Control": "no-store"}
    if upstream.headers.get("Content-Length"):
        headers["Content-Length"] = upstream.headers["Content-Length"]
    return Response(body(), status=200, headers=headers,
                    mimetype=entry["mime"].split(";")[0])


@bp.route("/stream/<vid:video_id>")
def stream(video_id):
    path = cached_path(video_id)
    if not path.exists():
        raise ApiError("not ready yet", 404)
    return send_file(path, mimetype="video/mp4", conditional=True)


@bp.route("/thumb/<vid:video_id>")
def thumb(video_id):
    """A video's thumbnail from the cache folder (320 x 180; `?size=720`: 1280 x 720, for the
    cards). The first time it's asked for, it's fetched from YouTube and kept there, so every
    thumbnail shown once also shows offline."""
    large = request.args.get("size") == "720"
    p = thumb_path(video_id, large)
    if p.exists():
        mark_thumbnail_used(p)
    elif not is_online():
        return "", 404
    elif not remember_thumbnail(video_id, large):
        internet_up()  # a failed fetch may be a lost connection: the next ones don't wait for it
        return "", 404
    p = thumb_path(video_id, large)  # the large one may have been saved as WebP
    return send_file(p, mimetype="image/webp" if p.suffix == ".webp" else "image/jpeg", max_age=86400)


@bp.route("/subtitles/<vid:video_id>")
def subtitles(video_id):
    path = subtitle_path(video_id)
    if not path.exists():
        raise ApiError("no subtitles for this video", 404)
    return send_file(path, mimetype="text/vtt")


@bp.route("/description/<vid:video_id>")
def description(video_id):
    path = description_path(video_id)
    if path.exists():
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            text = None
        if text is not None:
            known, date = cached_release_date(video_id)
            meta = cached_meta(video_id)
            if not known or meta is None or "views" not in meta:
                # downloaded before release dates / views were kept: look them up once, but
                # never let a failure (offline) cost the description
                try:
                    info = video_info(video_id)
                    if not known:
                        date = remember_release_date(video_id, info)
                    remember_chapters(video_id, info)
                    meta = remember_meta(video_id, info)
                except Exception:
                    pass
            return jsonify({"description": text, "date": date, **meta_public(meta)})

    info = full_info(video_id, "fetch the description")
    date, meta = remember_video(video_id, info)
    return jsonify({"description": info.get("description") or "", "date": date, **meta_public(meta)})


@bp.route("/channel-of/<vid:video_id>")
def channel_of(video_id):
    """The uploader of a video: from the saved info, else one yt-dlp lookup (then saved)."""
    meta = cached_meta(video_id) or {}
    if not meta.get("channel_id"):
        try:
            info = video_info(video_id)
        except Exception as e:
            raise ApiError(f"yt-dlp couldn't look up the channel: {e}", 502) from e
        meta = remember_meta(video_id, info) or {}
    return jsonify(meta_public(meta))


@bp.route("/chapters/<vid:video_id>")
def chapters(video_id):
    """Chapter list ([] when the video has none). Cached; fetched once for older downloads."""
    saved = cached_chapters(video_id)
    if saved is None:
        info = full_info(video_id, "fetch the chapters")
        remember_video(video_id, info)
        saved = clean_chapters(info.get("chapters"), info.get("duration"))
    return jsonify({"chapters": saved})


@bp.route("/sponsorblock/<vid:video_id>")
def sponsorblock(video_id):
    """Sponsor segments: SponsorBlock's current ones while online, else the ones kept with the
    download."""
    if is_online():
        try:
            segments = fetch_sponsor_segments(video_id)
        except (OSError, ValueError):
            internet_up()  # a failed fetch may be a lost connection
        else:
            if cached_path(video_id).exists() or is_active(video_id):
                remember_sponsor_segments(video_id, segments)
            return jsonify({"segments": segments})
    return jsonify({"segments": cached_sponsor_segments(video_id) or []})
