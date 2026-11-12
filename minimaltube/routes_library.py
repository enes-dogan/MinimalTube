"""MinimalTube server - routes for downloads: queueing them, the Downloads list, what changes
while the app is open (`/state`), and the lengths and card lines of videos in lists."""
from flask import Blueprint, jsonify, request

from . import lookups
from .config import LOOKUPS_WAITING_MAX, VIDEO_ID_RE
from .downloads import (
    active_jobs,
    ensure_title_backfill,
    forget_download,
    job_status,
    library_changed,
    library_rev,
    list_library,
    queue_download,
)
from .links import watch_url
from .media import (
    cached_meta,
    card_info,
    has_card_info,
    remove_video_files,
    subtitle_path,
    video_duration,
)
from .store import drop_from_order, forget_title, remember_title, save_order
from .subtitles import forget_subtitle_attempt, sublang_current
from .web import id_list, ids_param, json_body

bp = Blueprint("library", __name__)

STATE_WATCH_MAX = 50


@bp.route("/state")
def state():
    """What changes while the app is open, in one answer: the player asks this once a second
    while something downloads (every few seconds otherwise) instead of several things each.

        ?ids=a,b       videos the player waits on (the one loading, the one up next)
        ?captions=id   the video whose captions it waits for

    Answers {"downloads": every download that is queued, running or waiting, as
    [{"id", "status", "percent"}]; "statuses": {id: job or null} for `ids` (a job as in
    /prepare: "status", "percent", "error", "has_subtitles"); "rev": the Downloads list's
    revision (the player loads /library again when it differs from its list's); "captions":
    {"id", "has", "decided"} for `captions`: whether they're there, and whether the caption
    rule has decided (a track, or none)}.
    """
    out = {"downloads": active_jobs(),
           "statuses": {v: job_status(v) for v in ids_param(STATE_WATCH_MAX)},
           "rev": library_rev()}
    captions = request.args.get("captions") or ""
    if VIDEO_ID_RE.match(captions):
        out["captions"] = {"id": captions, "has": subtitle_path(captions).exists(),
                           "decided": sublang_current(captions)}
    return jsonify(out)


@bp.route("/queue", methods=["POST"])
def queue_downloads():
    """Download videos in the background: {"ids": [...], "titles": {id: title}, "sponsorblock":
    bool}. Answers {"queued": how many were new}."""
    data = json_body()
    ids = id_list(data)

    given = data.get("titles")
    if isinstance(given, dict):
        for vid, title in given.items():
            if isinstance(vid, str) and VIDEO_ID_RE.match(vid) and isinstance(title, str):
                t = title.strip()
                if t and not t.lower().startswith(("http://", "https://")):
                    remember_title(vid, t[:300])

    sponsorblock = data.get("sponsorblock") is True
    queued = sum(1 for vid in ids
                 if isinstance(vid, str) and VIDEO_ID_RE.match(vid) and queue_download(vid, sponsorblock))
    return jsonify({"queued": queued})


@bp.route("/library")
def library():
    """The Downloads list, in the user's order, with the downloads still on their way; "rev"
    is the revision /state reports."""
    ensure_title_backfill()
    rev = library_rev(max_age=0)
    items = []
    for i in list_library():
        meta = cached_meta(i["id"]) or {}
        items.append({"id": i["id"], "title": i["title"], "size": i["size"],
                      "status": i["status"], "percent": i.get("percent"),
                      "duration": i.get("duration"),
                      "channel": meta.get("channel"), "channel_id": meta.get("channel_id"),
                      "url": watch_url(i["id"])})
    return jsonify({"items": items, "rev": rev})


@bp.route("/library/order", methods=["POST"])
def library_set_order():
    ids = id_list(json_body())
    save_order([i for i in ids if isinstance(i, str) and VIDEO_ID_RE.match(i)])
    return jsonify({"status": "ok"})


@bp.route("/durations")
def durations():
    """Video lengths for ?ids=a,b,c, as far as they're known (saved info, the downloaded file,
    an earlier lookup); the rest are looked up in the background ("pending": ask again)."""
    ids = ids_param()
    out = {vid: video_duration(vid) or lookups.fact(vid).get("dur") for vid in ids}
    looking = lookups.request(ids, lambda vid: not out[vid] and vid not in lookups.FACTS,
                              limit=LOOKUPS_WAITING_MAX)
    return jsonify({"durations": out, "pending": bool(looking)})


@bp.route("/info")
def videos_info():
    """What video cards show under the title (channel, views, upload day) for ?ids=a,b,c, as far
    as it's saved; videos without it are looked up in the background ("pending": ask again)."""
    ids = ids_param()
    looking = lookups.request(ids, lambda vid: not has_card_info(vid), card=True,
                              limit=LOOKUPS_WAITING_MAX)
    return jsonify({"info": {vid: card_info(vid) for vid in ids}, "pending": bool(looking)})


@bp.route("/video/<vid:video_id>", methods=["DELETE"])
def delete_video(video_id):
    """Delete a video's files. If it's still downloading, abort the download."""
    in_flight = forget_download(video_id)  # a running download notices, aborts and cleans up
    removed = remove_video_files(video_id)
    forget_title(video_id)
    forget_subtitle_attempt(video_id)
    drop_from_order(video_id)
    library_changed()
    return jsonify({"status": "ok", "removed": removed, "cancelled": in_flight})
