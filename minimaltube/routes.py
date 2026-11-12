"""MinimalTube server - the Flask app: who may talk to it, and its routes.

The routes live in five modules, one per part of the app; this one puts them together.

    routes_playback    preparing a video, streaming it, what the player shows with it
    routes_library     downloads, the Downloads list, /state, lengths and card lines
    routes_playlists   the saved playlists
    routes_feed        subscriptions, the feed, collabs, reading a YouTube playlist
    routes_system      health, the connection, the size cap, restart, yt-dlp update
"""
from flask import Flask, jsonify, request
from flask_cors import CORS

from . import routes_feed, routes_library, routes_playback, routes_playlists, routes_system
from .config import EXTENSION_ORIGIN_RE
from .net import internet_up, is_online
from .web import NET_HEADER, ApiError, ChannelIdConverter, PlaylistIdConverter, VideoIdConverter

app = Flask(__name__)
app.url_map.converters.update(vid=VideoIdConverter, pl=PlaylistIdConverter, chan=ChannelIdConverter)
CORS(app, origins=[EXTENSION_ORIGIN_RE], expose_headers=[NET_HEADER])
for module in (routes_playback, routes_library, routes_playlists, routes_feed, routes_system):
    app.register_blueprint(module.bp)


@app.before_request
def only_the_extension():
    # CORS headers only keep other pages from reading the answers; this also refuses what those
    # pages may send without asking first (simple POSTs, fetch() GETs). Requests without an
    # Origin (curl, a link, an <img>) still get through, which is why everything that changes
    # something is a POST, PUT or DELETE: browsers send those with an Origin.
    origin = request.headers.get("Origin")
    if origin and not EXTENSION_ORIGIN_RE.match(origin):
        return jsonify({"error": "only the MinimalTube extension can use this server"}), 403


@app.errorhandler(ApiError)
def api_error(error):
    return jsonify({"error": error.message, **error.extra}), error.status


@app.after_request
def add_net_state(response):
    # A failed request may be a lost connection: probe (cached) so the header is current.
    if response.status_code >= 500:
        internet_up()
    response.headers[NET_HEADER] = "online" if is_online() else "offline"
    return response
