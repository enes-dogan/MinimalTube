"""MinimalTube server - routes."""
import json
import os
import re
import sys
import threading
import time
import uuid

import yt_dlp
from flask import Flask, Response, jsonify, request, send_file
from werkzeug.routing import BaseConverter
from flask_cors import CORS

NET_HEADER = "X-MinimalTube-Net"

from . import store
from .config import (
    CACHE_DIR,
    CHANNEL_ID_RE,
    EXTENSION_ORIGIN_RE,
    FEED_KINDS,
    MAX_DURATION_LOOKUPS,
    PLAYLIST_ID_RE,
    VIDEO_ID_RE,
)
from .downloads import (
    ACTIVE_STATUSES,
    backfill_failed,
    cancelled,
    cancelled_lock,
    download_job,
    download_queue,
    ensure_title_backfill,
    get_job,
    jobs,
    jobs_lock,
    list_library,
    remember_running_downloads,
)
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
    subs_lock,
    subscription_public,
    write_subscriptions,
)
from .media import (
    _lookup_duration,
    cached_meta,
    cached_path,
    cached_release_date,
    cached_sponsor_segments,
    card_info,
    card_info_pending,
    card_info_pool,
    chapters_path,
    clean_chapters,
    description_path,
    duration_failed,
    duration_pending,
    duration_pool,
    fetch_sponsor_segments,
    lookup_card_info,
    mark_thumbnail_used,
    meta_public,
    needs_card_info,
    probe_duration,
    remember_chapters,
    remember_description,
    remember_meta,
    remember_release_date,
    remember_sponsor_segments,
    remember_thumbnail,
    remove_video_files,
    subtitle_path,
    thumb_path,
    youtube_ids,
)
from .store import (
    clean_playlist_items,
    forget_title,
    order_lock,
    original_title,
    playlist_public,
    playlists_lock,
    remember_title,
    save_order,
    saved_playlists,
    titles,
    write_playlists,
)
from .net import internet_up, is_online
from .system import WINDOWS, spawn_detached
from .system import open_folder as show_folder
from .ytinfo import video_info, ydl
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
from .subtitles import (
    ensure_subtitle_backfill,
    fetch_original_subtitle,
    sublang_current,
    subtitle_backfill_attempted,
    subtitle_backfill_lock,
)
from .ytdlp_copy import install_latest, running_own_copy, up_to_date

class VideoIdConverter(BaseConverter):
    """<vid:video_id> in a route: only an 11-character YouTube id matches. Ids become file
    names in the cache folder, and on Windows "\\" or "C:" in one would point outside it."""
    regex = r"[A-Za-z0-9_-]{11}"


app = Flask(__name__)
app.url_map.converters["vid"] = VideoIdConverter
CORS(app, origins=[EXTENSION_ORIGIN_RE], expose_headers=[NET_HEADER])
STARTED = time.time()


@app.before_request
def only_the_extension():
    # CORS headers only keep other pages from reading the answers; this also refuses what those
    # pages may send without asking first (simple POSTs, fetch() GETs). Requests without an
    # Origin (curl, a link, an <img>) still get through.
    origin = request.headers.get("Origin")
    if origin and not EXTENSION_ORIGIN_RE.match(origin):
        return jsonify({"error": "only the MinimalTube extension can use this server"}), 403


@app.after_request
def add_net_state(response):
    # A failed request may be a lost connection: probe (cached) so the header is current.
    if response.status_code >= 500:
        internet_up()
    response.headers[NET_HEADER] = "online" if is_online() else "offline"
    return response

@app.route("/prepare")
def prepare():
    # Only YouTube videos: yt-dlp would open any site (even ones on the home network) for any
    # link, and a download that isn't YouTube's never shows in Downloads.
    quick_id, _list = youtube_ids(request.args.get("url", ""))
    if not quick_id:
        return jsonify({"error": "not a YouTube video link"}), 400
    url = f"https://www.youtube.com/watch?v={quick_id}"

    if cached_path(quick_id).exists():
        title = titles.get(quick_id)
        with jobs_lock:
            jobs[quick_id] = {"status": "ready", "percent": 100, "title": title}
        ensure_subtitle_backfill(quick_id, url)
        return jsonify({
            "status": "ready", "percent": 100, "title": title, "video_id": quick_id,
            "has_subtitles": subtitle_path(quick_id).exists(),
        })
    with jobs_lock:
        running = dict(jobs.get(quick_id) or {})
    live = registered_stream(quick_id)
    if live and running.get("status") in ("downloading", "merging"):
        running.update(live, video_id=quick_id,
                       has_subtitles=subtitle_path(quick_id).exists())
        running.setdefault("title", titles.get(quick_id))
        return jsonify(running)

    try:
        info = video_info(url)
    except yt_dlp.utils.DownloadError as e:
        return jsonify({"error": f"yt-dlp failed to resolve this URL: {e}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    video_id = info.get("id")
    title = info.get("title")
    remember_title(video_id, title)
    remember_description(video_id, info.get("description"))
    remember_chapters(video_id, info)
    remember_release_date(video_id, info)
    remember_meta(video_id, info)

    # Stream only (a player setting): nothing is downloaded unless a download already runs.
    if request.args.get("stream_only") == "1" and not cached_path(video_id).exists():
        with jobs_lock:
            running = (jobs.get(video_id) or {}).get("status") in ACTIVE_STATUSES
        if not running:
            start_stream_subtitles(video_id, url, info)
            return jsonify({
                "status": "streaming", "video_id": video_id, "title": title,
                "has_subtitles": subtitle_path(video_id).exists(),
                "stream": register_stream(video_id, info), "duration": info.get("duration"),
            })

    with jobs_lock:
        existing = jobs.get(video_id)
        already_running = existing and existing.get("status") in ("downloading", "merging")
        needs_start = cached_path(video_id).exists() is False and not already_running

        if cached_path(video_id).exists():
            jobs[video_id] = {"status": "ready", "percent": 100, "title": title}
        elif needs_start:
            jobs[video_id] = {"status": "downloading", "percent": 0, "title": title,
                              "sponsorblock": request.args.get("sponsorblock") == "1"}
            with cancelled_lock:
                cancelled.discard(video_id)

        job = dict(jobs[video_id])

    if needs_start:
        threading.Thread(target=download_job, args=(video_id, url), daemon=True).start()
        threading.Thread(target=fetch_original_subtitle, args=(video_id, url, info),
                         daemon=True).start()
    elif cached_path(video_id).exists():
        ensure_subtitle_backfill(video_id, url)

    job["video_id"] = video_id
    job.setdefault("title", title)
    job["has_subtitles"] = subtitle_path(video_id).exists()
    if job.get("status") != "ready":
        job["stream"] = register_stream(video_id, info)
        job["duration"] = info.get("duration")
    return jsonify(job)


def start_stream_subtitles(video_id: str, url: str, info: dict):
    """Captions for a video that is only streamed: fetched once, as for a download."""
    if subtitle_path(video_id).exists() or sublang_current(video_id):
        return
    with subtitle_backfill_lock:
        if video_id in subtitle_backfill_attempted:
            return
        subtitle_backfill_attempted.add(video_id)
    threading.Thread(target=fetch_original_subtitle, args=(video_id, url, info),
                     daemon=True).start()


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

@app.route("/live/<vid:video_id>/<format_id>/index")
def live_index(video_id, format_id):
    try:
        index = with_fresh_stream(video_id, lambda: stream_index(video_id, format_id))
    except UpstreamError as e:
        return jsonify({"error": str(e)}), 502
    if not index:
        return jsonify({"error": "unknown stream"}), 404
    return jsonify(index)

@app.route("/live/<vid:video_id>/<format_id>")
def live_bytes(video_id, format_id):
    entry = stream_format(video_id, format_id)
    if not entry:
        return jsonify({"error": "unknown stream"}), 404
    try:
        start = int(request.args.get("start", 0))
        end = int(request.args["end"])
    except (KeyError, ValueError):
        return jsonify({"error": "expected ?start=<byte>&end=<byte>"}), 400
    if start < 0 or end < start:
        return jsonify({"error": "invalid byte range"}), 400
    try:
        upstream = with_fresh_stream(
            video_id, lambda: open_upstream(stream_format(video_id, format_id), start, end))
    except UpstreamError as e:
        return jsonify({"error": str(e)}), 502

    def body():
        with upstream:
            while chunk := upstream.read(64 * 1024):
                yield chunk

    headers = {"Cache-Control": "no-store"}
    if upstream.headers.get("Content-Length"):
        headers["Content-Length"] = upstream.headers["Content-Length"]
    return Response(body(), status=200, headers=headers,
                    mimetype=entry["mime"].split(";")[0])

@app.route("/thumb/<vid:video_id>")
def thumb(video_id):
    """A video's thumbnail from the cache folder. The first time it's asked for, it's fetched
    from YouTube and kept there, so every thumbnail shown once also shows offline."""
    p = thumb_path(video_id)
    if p.exists():
        mark_thumbnail_used(p)
    elif not is_online():
        return "", 404
    elif not remember_thumbnail(video_id):
        internet_up()  # a failed fetch may be a lost connection: the next ones don't wait for it
        return "", 404
    return send_file(p, mimetype="image/jpeg", max_age=86400)

@app.route("/playlist")
def playlist():
    current_id, list_id = youtube_ids(request.args.get("url", ""))
    if not list_id:
        return jsonify({"error": "not a YouTube playlist link"}), 400
    url = (f"https://www.youtube.com/watch?v={current_id}&list={list_id}" if current_id
           else f"https://www.youtube.com/playlist?list={list_id}")

    try:
        with ydl(skip_download=True, noplaylist=False, extract_flat="in_playlist") as y:
            info = y.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        return jsonify({"error": f"yt-dlp failed to load this playlist: {e}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    entries = info.get("entries")
    items = []
    for entry in (entries if entries is not None else []):
        vid = entry.get("id") if entry else None
        if not vid or not VIDEO_ID_RE.match(vid):
            continue
        n = len(items) + 1
        items.append({
            "index": n,
            "id": vid,
            "title": original_title(vid, entry.get("title")) or f"Video {n}",
            "url": f"https://www.youtube.com/watch?v={vid}",
        })

    if current_id:
        current_index = next((i for i, it in enumerate(items) if it["id"] == current_id), -1)
    else:
        current_index = 0

    return jsonify({"items": items, "currentIndex": current_index})

@app.route("/queue", methods=["POST"])
def queue_downloads():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list):
        return jsonify({"error": 'expected a JSON body like {"ids": ["<video_id>", ...]}'}), 400

    given = data.get("titles")
    if isinstance(given, dict):
        for vid, title in given.items():
            if isinstance(vid, str) and VIDEO_ID_RE.match(vid) and isinstance(title, str):
                t = title.strip()
                if t and not t.lower().startswith(("http://", "https://")):
                    remember_title(vid, t[:300])

    queued = 0
    for video_id in ids:
        if not isinstance(video_id, str) or not VIDEO_ID_RE.match(video_id):
            continue
        if cached_path(video_id).exists():
            continue
        with jobs_lock:
            existing = jobs.get(video_id)
            if existing and existing.get("status") in ACTIVE_STATUSES:
                continue
            jobs[video_id] = {"status": "queued", "percent": 0,
                              "sponsorblock": data.get("sponsorblock") is True}
        with cancelled_lock:
            cancelled.discard(video_id)
        download_queue.put(video_id)
        queued += 1

    return jsonify({"queued": queued})

@app.route("/downloads")
def downloads():
    """Every video that is currently queued / downloading / merging / waiting."""
    with jobs_lock:
        items = [
            {"id": vid, "status": job.get("status"), "percent": job.get("percent", 0)}
            for vid, job in jobs.items()
            if job.get("status") in ACTIVE_STATUSES
        ]
    return jsonify({"items": items})

@app.route("/library")
def library():
    ensure_title_backfill()
    items = []
    for i in list_library():
        meta = cached_meta(i["id"]) or {}
        items.append({"id": i["id"], "title": i["title"], "size": i["size"],
                      "status": i["status"], "percent": i.get("percent"),
                      "duration": i.get("duration"),
                      "channel": meta.get("channel"), "channel_id": meta.get("channel_id"),
                      "url": f"https://www.youtube.com/watch?v={i['id']}"})
    return jsonify({"items": items})

@app.route("/durations")
def durations():
    """Video lengths we already know (saved info, or probed from the downloaded file)."""
    ids = [v for v in (request.args.get("ids") or "").split(",") if VIDEO_ID_RE.match(v)][:200]
    out, waiting = {}, False
    for vid in ids:
        d = (cached_meta(vid) or {}).get("duration")
        if not d and cached_path(vid).exists():
            d = probe_duration(vid)
        if not d and vid not in duration_failed:
            waiting = True  # not known yet: looked up in the background, ask again shortly
            if vid not in duration_pending and len(duration_pending) < MAX_DURATION_LOOKUPS:
                duration_pending.add(vid)
                duration_pool.submit(_lookup_duration, vid)
        out[vid] = d
    return jsonify({"durations": out, "pending": waiting})

@app.route("/info")
def videos_info():
    """What video cards show under the title (channel, views, upload day) for ?ids=a,b,c, as far
    as it's saved; videos without it are looked up in the background ("pending": ask again)."""
    ids = [v for v in (request.args.get("ids") or "").split(",") if VIDEO_ID_RE.match(v)][:200]
    waiting = False
    for vid in ids:
        if needs_card_info(vid):
            waiting = True
            if vid not in card_info_pending and len(card_info_pending) < MAX_DURATION_LOOKUPS:
                card_info_pending.add(vid)
                card_info_pool.submit(lookup_card_info, vid)
    return jsonify({"info": {vid: card_info(vid) for vid in ids}, "pending": waiting})

@app.route("/library/order", methods=["POST"])
def library_set_order():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list):
        return jsonify({"error": 'expected a JSON body like {"ids": ["<video_id>", ...]}'}), 400
    save_order([i for i in ids if isinstance(i, str) and VIDEO_ID_RE.match(i)])
    return jsonify({"status": "ok"})

@app.route("/playlists", methods=["GET"])
def playlists_list():
    with playlists_lock:
        snapshot = list(saved_playlists)
    return jsonify({"playlists": [playlist_public(p) for p in snapshot]})

@app.route("/playlists", methods=["POST"])
def playlists_save():
    """Save the given queue under a name: {"name": "...", "items": [...], "overwrite": bool}."""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()[:80]
    if not name:
        return jsonify({"error": "a playlist name is required"}), 400
    items, skipped = clean_playlist_items(data.get("items"))
    if not items:
        return jsonify({"error": "none of the queued videos could be saved "
                                 "(wait for their titles to load and try again)"}), 400

    now = time.time()
    with playlists_lock:
        existing = next((p for p in saved_playlists
                         if p.get("name", "").casefold() == name.casefold()), None)
        if existing and not data.get("overwrite"):
            return jsonify({"error": f'a playlist named "{existing["name"]}" already exists',
                            "exists": True}), 409
        if existing:
            existing.update(name=name, items=items, updated=now)
            existing.pop("yt", None)
            playlist = existing
        else:
            playlist = {"id": uuid.uuid4().hex[:12], "name": name,
                        "created": now, "updated": now, "items": items}
            saved_playlists.append(playlist)
        write_playlists()
        result = playlist_public(playlist)
    return jsonify({"playlist": result, "replaced": bool(existing), "skipped": skipped})

@app.route("/playlists/order", methods=["POST"])
def playlists_set_order():
    """Store the order of the saved playlists: {"ids": ["<playlist id>", ...]}."""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list):
        return jsonify({"error": 'expected a JSON body like {"ids": ["<playlist id>", ...]}'}), 400
    with playlists_lock:
        by_id = {p.get("id"): p for p in saved_playlists}
        ordered = [by_id[i] for i in dict.fromkeys(ids) if i in by_id]
        ordered += [p for p in saved_playlists if p.get("id") not in set(ids)]  # unknown ids keep their place at the end
        saved_playlists[:] = ordered
        write_playlists()
    return jsonify({"status": "ok"})

@app.route("/playlists/<playlist_id>", methods=["DELETE"])
def playlists_delete(playlist_id):
    if not PLAYLIST_ID_RE.match(playlist_id):
        return jsonify({"error": "invalid playlist id"}), 400
    with playlists_lock:
        before = len(saved_playlists)
        saved_playlists[:] = [p for p in saved_playlists if p.get("id") != playlist_id]
        removed = before - len(saved_playlists)
        if removed:
            write_playlists()
    if not removed:
        return jsonify({"error": "unknown playlist"}), 404
    return jsonify({"status": "ok"})

@app.route("/playlists/<playlist_id>/items", methods=["POST"])
def playlists_add_items(playlist_id):
    """Append videos to a saved playlist: {"items": [{id,title,url}, ...]} (duplicates are skipped)."""
    if not PLAYLIST_ID_RE.match(playlist_id):
        return jsonify({"error": "invalid playlist id"}), 400
    data = request.get_json(silent=True) or {}
    items, _skipped = clean_playlist_items(data.get("items"))
    if not items:
        return jsonify({"error": "no valid videos to add"}), 400
    with playlists_lock:
        playlist = next((p for p in saved_playlists if p.get("id") == playlist_id), None)
        if not playlist:
            return jsonify({"error": "unknown playlist"}), 404
        have = {it.get("id") for it in playlist["items"]}
        added = [it for it in items if it["id"] not in have]
        if added:
            if data.get("position") == "top":
                playlist["items"][:0] = added
            else:
                playlist["items"].extend(added)
            playlist["updated"] = time.time()
            write_playlists()
        result = playlist_public(playlist)
    return jsonify({"playlist": result, "added": len(added)})

@app.route("/playlists/<playlist_id>/items", methods=["PUT"])
def playlists_replace_items(playlist_id):
    if not PLAYLIST_ID_RE.match(playlist_id):
        return jsonify({"error": "invalid playlist id"}), 400
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get("items"), list):
        return jsonify({"error": 'expected a JSON body like {"items": [{id,title,url}, ...]}'}), 400
    items, skipped = clean_playlist_items(data["items"])
    seen = set()
    items = [it for it in items if not (it["id"] in seen or seen.add(it["id"]))]
    with playlists_lock:
        playlist = next((p for p in saved_playlists if p.get("id") == playlist_id), None)
        if not playlist:
            return jsonify({"error": "unknown playlist"}), 404
        playlist["items"] = items
        playlist["updated"] = time.time()
        write_playlists()
        result = playlist_public(playlist)
    return jsonify({"playlist": result, "skipped": skipped})

@app.route("/playlists/<playlist_id>/yt", methods=["PUT"])
def playlists_set_yt(playlist_id):
    if not PLAYLIST_ID_RE.match(playlist_id):
        return jsonify({"error": "invalid playlist id"}), 400
    yt = (request.get_json(silent=True) or {}).get("yt")
    if yt is not None:
        list_id = str(yt.get("list_id") or "") if isinstance(yt, dict) else ""
        base = yt.get("base") if isinstance(yt, dict) else None
        if not re.fullmatch(r"[A-Za-z0-9_-]{2,64}", list_id) or not isinstance(base, list):
            return jsonify({"error": 'expected {"yt": {"list_id": "...", "base": [...]}} or {"yt": null}'}), 400
        yt = {"list_id": list_id,
              "base": [i for i in base if isinstance(i, str) and VIDEO_ID_RE.match(i)],
              "synced_at": time.time()}
    with playlists_lock:
        playlist = next((p for p in saved_playlists if p.get("id") == playlist_id), None)
        if not playlist:
            return jsonify({"error": "unknown playlist"}), 404
        if yt is None:
            playlist.pop("yt", None)
        else:
            playlist["yt"] = yt
        write_playlists()
        result = playlist_public(playlist)
    return jsonify({"playlist": result})

@app.route("/playlists/<playlist_id>/items/order", methods=["POST"])
def playlists_set_items_order(playlist_id):
    if not PLAYLIST_ID_RE.match(playlist_id):
        return jsonify({"error": "invalid playlist id"}), 400
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list):
        return jsonify({"error": 'expected a JSON body like {"ids": ["<video_id>", ...]}'}), 400
    with playlists_lock:
        playlist = next((p for p in saved_playlists if p.get("id") == playlist_id), None)
        if not playlist:
            return jsonify({"error": "unknown playlist"}), 404
        by_id = {it.get("id"): it for it in playlist["items"]}
        wanted = [i for i in dict.fromkeys(ids) if isinstance(i, str) and i in by_id]
        ordered = [by_id[i] for i in wanted]
        ordered += [it for it in playlist["items"] if it.get("id") not in set(wanted)]
        playlist["items"] = ordered
        playlist["updated"] = time.time()
        write_playlists()
        result = playlist_public(playlist)
    return jsonify({"playlist": result})

@app.route("/playlists/<playlist_id>/items/<vid:video_id>", methods=["DELETE"])
def playlists_remove_item(playlist_id, video_id):
    if not PLAYLIST_ID_RE.match(playlist_id):
        return jsonify({"error": "invalid playlist id"}), 400
    with playlists_lock:
        playlist = next((p for p in saved_playlists if p.get("id") == playlist_id), None)
        if not playlist:
            return jsonify({"error": "unknown playlist"}), 404
        before = len(playlist["items"])
        playlist["items"] = [it for it in playlist["items"] if it.get("id") != video_id]
        if len(playlist["items"]) == before:
            return jsonify({"error": "video not in playlist"}), 404
        playlist["updated"] = time.time()
        write_playlists()
        result = playlist_public(playlist)
    return jsonify({"playlist": result})

@app.route("/subscriptions", methods=["GET"])
def subscriptions_list():
    with subs_lock:
        snapshot = list(saved_subscriptions)
    return jsonify({"subscriptions": [subscription_public(c) for c in snapshot],
                    "importing": import_left()})

@app.route("/subscriptions/import", methods=["POST"])
def subscriptions_import():
    """Subscribe to many channels at once: {"channels": [{"id", "name", "handle"}, ...]}."""
    channels = (request.get_json(silent=True) or {}).get("channels")
    if not isinstance(channels, list):
        return jsonify({"error": 'expected a JSON body like {"channels": [{"id": "UC...", "name": "...", '
                                 '"handle": "@..."}, ...]}'}), 400
    return jsonify(import_subscriptions(channels))

@app.route("/subscriptions", methods=["POST"])
def subscriptions_add():
    data = request.get_json(silent=True) or {}
    try:
        channel_url = parse_channel_input(str(data.get("input") or ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    try:
        channel = resolve_channel(channel_url)
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except yt_dlp.utils.DownloadError as e:
        return jsonify({"error": f"yt-dlp couldn't open that channel: {e}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    with subs_lock:
        existing = next((c for c in saved_subscriptions if c["id"] == channel["id"]), None)
        if existing:
            return jsonify({"subscription": subscription_public(existing), "already": True})
        channel["added"] = time.time()
        saved_subscriptions.append(channel)
        write_subscriptions()
    return jsonify({"subscription": subscription_public(channel), "already": False})

@app.route("/channel-lookup")
def channel_lookup():
    """Whose channel a link is (/@handle, /channel/UC..., /c/..., /user/...), without subscribing."""
    try:
        channel = resolve_channel(parse_channel_input(request.args.get("url", "")))
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        return jsonify({"error": f"yt-dlp couldn't open that channel: {e}"}), 502
    return jsonify(subscription_public(channel))

@app.route("/subscriptions/<channel_id>", methods=["DELETE"])
def subscriptions_delete(channel_id):
    if not CHANNEL_ID_RE.match(channel_id):
        return jsonify({"error": "invalid channel id"}), 400
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
        return jsonify({"error": "unknown channel"}), 404
    return jsonify({"status": "ok"})

@app.route("/feed")
def feed():
    try:
        offset = max(0, int(request.args.get("offset", 0)))
        limit = min(60, max(1, int(request.args.get("limit", 24))))
    except ValueError:
        return jsonify({"error": "offset and limit must be integers"}), 400
    refresh = request.args.get("refresh") == "1"
    channel = request.args.get("channel") or None
    if channel:
        if not CHANNEL_ID_RE.match(channel):
            return jsonify({"error": "invalid channel id"}), 400
    channel_name = (request.args.get("name") or "").strip()[:100] or None
    items, has_more, errors, offline, pending = build_feed(offset, limit, refresh, channel, channel_name)
    return jsonify({"items": items, "has_more": has_more, "errors": errors, "offline": offline,
                    "pending": pending, "subscribers": CHANNEL_FOLLOWERS.get(channel) if channel else None})

@app.route("/video/<vid:video_id>", methods=["DELETE"])
def delete_video(video_id):
    """Delete a video's files. If it's still downloading, abort the download."""

    with jobs_lock:
        job = jobs.pop(video_id, None)
    in_flight = bool(job) and job.get("status") in ("downloading", "merging")
    if in_flight:
        # The download thread notices this flag, aborts, and cleans up after itself.
        with cancelled_lock:
            cancelled.add(video_id)

    removed = remove_video_files(video_id)
    forget_title(video_id)
    with subtitle_backfill_lock:
        subtitle_backfill_attempted.discard(video_id)
    backfill_failed.discard(video_id)
    with order_lock:
        if video_id in store.library_order:
            store.library_order.remove(video_id)
    save_order(store.library_order)
    return jsonify({"status": "ok", "removed": removed, "cancelled": in_flight})

def job_status(video_id: str):
    """A video's download state (None: not downloaded and no job)."""
    job = get_job(video_id)
    if job.get("status") == "ready" and not cached_path(video_id).exists():
        job = {}  # its file was removed since (by the cache sweep, or by hand)
    if not job:
        if not cached_path(video_id).exists():
            return None
        job = {"status": "ready", "percent": 100}
    job["has_subtitles"] = subtitle_path(video_id).exists()
    return job

@app.route("/status/<vid:video_id>")
def status(video_id):
    job = job_status(video_id)
    if job is None:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(job)

STATUSES_MAX = 300

@app.route("/statuses")
def statuses():
    """Many videos at once (?ids=a,b,c): {"statuses": {id: state or null}}; the queue asks
    for all its videos in one request."""
    ids = [v for v in (request.args.get("ids") or "").split(",") if VIDEO_ID_RE.match(v)]
    return jsonify({"statuses": {v: job_status(v) for v in ids[:STATUSES_MAX]}})

@app.route("/stream/<vid:video_id>")
def stream(video_id):
    path = cached_path(video_id)
    if not path.exists():
        return jsonify({"error": "not ready yet"}), 404
    return send_file(path, mimetype="video/mp4", conditional=True)

@app.route("/subtitles/<vid:video_id>/state")
def subtitles_state(video_id):
    """Captions of a video: there yet, and has the caption rule decided (track or none)?"""
    return jsonify({"has": subtitle_path(video_id).exists(), "decided": sublang_current(video_id)})

@app.route("/subtitles/<vid:video_id>")
def subtitles(video_id):
    path = subtitle_path(video_id)
    if not path.exists():
        return jsonify({"error": "no subtitles for this video"}), 404
    return send_file(path, mimetype="text/vtt")

@app.route("/description/<vid:video_id>")
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

    try:
        info = video_info(video_id)
    except yt_dlp.utils.DownloadError as e:
        return jsonify({"error": f"yt-dlp failed to fetch the description: {e}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    text = info.get("description") or ""
    remember_title(video_id, info.get("title"))
    remember_description(video_id, text)
    remember_chapters(video_id, info)
    date = remember_release_date(video_id, info)
    meta = remember_meta(video_id, info)
    return jsonify({"description": text, "date": date, **meta_public(meta)})

@app.route("/channel-of/<vid:video_id>")
def channel_of(video_id):
    """The uploader of a video: from the saved info, else one yt-dlp lookup (then saved)."""
    meta = cached_meta(video_id) or {}
    if not meta.get("channel_id"):
        try:
            info = video_info(video_id)
        except Exception as e:
            return jsonify({"error": f"yt-dlp couldn't look up the channel: {e}"}), 502
        meta = remember_meta(video_id, info) or {}
    return jsonify(meta_public(meta))

@app.route("/net")
def net():
    """Whether YouTube can be reached at all (the player's OFFLINE badge)."""
    return jsonify({"online": internet_up(max_age=1)})

@app.route("/chapters/<vid:video_id>")
def chapters(video_id):
    """Chapter list ([] when the video has none). Cached; fetched once for older downloads."""
    path = chapters_path(video_id)
    if path.exists():
        try:
            return jsonify({"chapters": json.loads(path.read_text(encoding="utf-8"))})
        except (OSError, ValueError):
            pass
    try:
        info = video_info(video_id)
    except yt_dlp.utils.DownloadError as e:
        return jsonify({"error": f"yt-dlp failed to fetch the chapters: {e}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    remember_title(video_id, info.get("title"))
    remember_description(video_id, info.get("description"))
    remember_chapters(video_id, info)
    remember_release_date(video_id, info)
    return jsonify({"chapters": clean_chapters(info.get("chapters"), info.get("duration"))})

@app.route("/sponsorblock/<vid:video_id>")
def sponsorblock(video_id):
    """Sponsor segments: SponsorBlock's current ones while online, else the ones kept with the
    download."""
    if is_online():
        try:
            segments = fetch_sponsor_segments(video_id)
        except (OSError, ValueError):
            internet_up()  # a failed fetch may be a lost connection
        else:
            if cached_path(video_id).exists() or get_job(video_id).get("status") in ACTIVE_STATUSES:
                remember_sponsor_segments(video_id, segments)
            return jsonify({"segments": segments})
    return jsonify({"segments": cached_sponsor_segments(video_id) or []})

@app.route("/open-folder")
def open_folder():
    """Open the folder where downloaded videos are kept in the file manager."""
    try:
        show_folder(CACHE_DIR)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"status": "ok", "path": str(CACHE_DIR)})

@app.route("/restart", methods=["POST"])
def restart():
    """Run the server again (new code, a new yt-dlp); the running downloads continue."""
    schedule_restart()
    return jsonify({"status": "restarting", "started": STARTED})

@app.route("/ytdlp/update", methods=["POST"])
def ytdlp_update():
    """Install the newest yt-dlp as MinimalTube's own copy (no sudo), then restart to use it."""
    running = yt_dlp.version.__version__
    if running_own_copy() and up_to_date(running):
        return jsonify({"status": "current", "version": running})
    try:
        version = install_latest()
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    schedule_restart()
    return jsonify({"status": "restarting", "started": STARTED, "version": version})

def schedule_restart():
    remember_running_downloads()
    threading.Timer(0.5, restart_server).start()  # once this answer is out

def restart_server():
    sys.stdout.flush()
    sys.stderr.flush()
    argv = list(getattr(sys, "orig_argv", None) or [sys.executable, "-u", *sys.argv])
    if not WINDOWS:
        # POSIX replaces the process in place: same PID, same terminal or log
        os.execv(sys.executable, argv)
    # Windows has no real exec: a new server starts (and waits for this one to let go of the
    # port), into the same log, and this one ends
    if "--wait-for-port" not in argv:
        argv.append("--wait-for-port")
    spawn_detached(argv, cwd=os.getcwd(), stdout=sys.stdout, stderr=sys.stderr)
    os._exit(0)

@app.route("/health")
def health():
    # "app" is how the extension tells this server from another program on the same port
    return jsonify({"status": "ok", "app": "minimaltube", "started": STARTED})
