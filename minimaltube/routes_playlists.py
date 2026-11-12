"""MinimalTube server - routes for the saved playlists (playlists.json)."""
import re
import time
import uuid

from flask import Blueprint, jsonify

from .config import VIDEO_ID_RE
from .store import (
    clean_playlist_items,
    find_playlist,
    playlist_public,
    playlists_lock,
    saved_playlists,
    write_playlists,
)
from .web import ApiError, id_list, json_body

bp = Blueprint("playlists", __name__)


def _playlist(playlist_id: str) -> dict:
    """The saved playlist a route is about. Caller must hold playlists_lock."""
    playlist = find_playlist(playlist_id)
    if not playlist:
        raise ApiError("unknown playlist", 404)
    return playlist


def _changed(playlist: dict, **more):
    """Save a changed playlist and answer with it. Caller must hold playlists_lock."""
    playlist["updated"] = time.time()
    write_playlists()
    return jsonify({"playlist": playlist_public(playlist), **more})


@bp.route("/playlists", methods=["GET"])
def playlists_list():
    with playlists_lock:
        snapshot = list(saved_playlists)
    return jsonify({"playlists": [playlist_public(p) for p in snapshot]})


@bp.route("/playlists", methods=["POST"])
def playlists_save():
    """Save the given queue under a name: {"name": "...", "items": [...], "overwrite": bool}."""
    data = json_body()
    name = str(data.get("name") or "").strip()[:80]
    if not name:
        raise ApiError("a playlist name is required")
    items, skipped = clean_playlist_items(data.get("items"))
    if not items:
        raise ApiError("none of the queued videos could be saved "
                       "(wait for their titles to load and try again)")

    now = time.time()
    with playlists_lock:
        existing = next((p for p in saved_playlists
                         if p.get("name", "").casefold() == name.casefold()), None)
        if existing and not data.get("overwrite"):
            raise ApiError(f'a playlist named "{existing["name"]}" already exists', 409, exists=True)
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


@bp.route("/playlists/order", methods=["POST"])
def playlists_set_order():
    """Store the order of the saved playlists: {"ids": ["<playlist id>", ...]}."""
    ids = id_list(json_body(), "<playlist id>")
    with playlists_lock:
        by_id = {p.get("id"): p for p in saved_playlists}
        ordered = [by_id[i] for i in dict.fromkeys(ids) if i in by_id]
        ordered += [p for p in saved_playlists if p.get("id") not in set(ids)]  # unknown ids keep their place at the end
        saved_playlists[:] = ordered
        write_playlists()
    return jsonify({"status": "ok"})


@bp.route("/playlists/<pl:playlist_id>", methods=["DELETE"])
def playlists_delete(playlist_id):
    with playlists_lock:
        saved_playlists.remove(_playlist(playlist_id))
        write_playlists()
    return jsonify({"status": "ok"})


@bp.route("/playlists/<pl:playlist_id>/items", methods=["POST"])
def playlists_add_items(playlist_id):
    """Append videos to a saved playlist: {"items": [{id,title,url}, ...]} (duplicates are
    skipped; "position": "top" puts them first)."""
    data = json_body()
    items, _skipped = clean_playlist_items(data.get("items"))
    if not items:
        raise ApiError("no valid videos to add")
    with playlists_lock:
        playlist = _playlist(playlist_id)
        have = {it.get("id") for it in playlist["items"]}
        added = [it for it in items if it["id"] not in have]
        if not added:
            return jsonify({"playlist": playlist_public(playlist), "added": 0})
        if data.get("position") == "top":
            playlist["items"][:0] = added
        else:
            playlist["items"].extend(added)
        return _changed(playlist, added=len(added))


@bp.route("/playlists/<pl:playlist_id>/items", methods=["PUT"])
def playlists_replace_items(playlist_id):
    data = json_body()
    if not isinstance(data.get("items"), list):
        raise ApiError('expected a JSON body like {"items": [{id,title,url}, ...]}')
    items, skipped = clean_playlist_items(data["items"])
    seen = set()
    items = [it for it in items if not (it["id"] in seen or seen.add(it["id"]))]
    with playlists_lock:
        playlist = _playlist(playlist_id)
        playlist["items"] = items
        return _changed(playlist, skipped=skipped)


@bp.route("/playlists/<pl:playlist_id>/yt", methods=["PUT"])
def playlists_set_yt(playlist_id):
    """Link a saved playlist to one on YouTube, or unlink it: {"yt": {"list_id", "base": [video
    ids as of the last sync]}} or {"yt": null}."""
    yt = json_body().get("yt")
    if yt is not None:
        list_id = str(yt.get("list_id") or "") if isinstance(yt, dict) else ""
        base = yt.get("base") if isinstance(yt, dict) else None
        if not re.fullmatch(r"[A-Za-z0-9_-]{2,64}", list_id) or not isinstance(base, list):
            raise ApiError('expected {"yt": {"list_id": "...", "base": [...]}} or {"yt": null}')
        yt = {"list_id": list_id,
              "base": [i for i in base if isinstance(i, str) and VIDEO_ID_RE.match(i)],
              "synced_at": time.time()}
    with playlists_lock:
        playlist = _playlist(playlist_id)
        if yt is None:
            playlist.pop("yt", None)
        else:
            playlist["yt"] = yt
        write_playlists()
        return jsonify({"playlist": playlist_public(playlist)})


@bp.route("/playlists/<pl:playlist_id>/items/order", methods=["POST"])
def playlists_set_items_order(playlist_id):
    ids = id_list(json_body())
    with playlists_lock:
        playlist = _playlist(playlist_id)
        by_id = {it.get("id"): it for it in playlist["items"]}
        wanted = [i for i in dict.fromkeys(ids) if isinstance(i, str) and i in by_id]
        ordered = [by_id[i] for i in wanted]
        ordered += [it for it in playlist["items"] if it.get("id") not in set(wanted)]
        playlist["items"] = ordered
        return _changed(playlist)


@bp.route("/playlists/<pl:playlist_id>/items/<vid:video_id>", methods=["DELETE"])
def playlists_remove_item(playlist_id, video_id):
    with playlists_lock:
        playlist = _playlist(playlist_id)
        kept = [it for it in playlist["items"] if it.get("id") != video_id]
        if len(kept) == len(playlist["items"]):
            raise ApiError("video not in playlist", 404)
        playlist["items"] = kept
        return _changed(playlist)
