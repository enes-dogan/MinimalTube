# The MinimalTube server package

`server.py` next to this folder is only an entry point: it puts MinimalTube's own
yt-dlp first on the import path (`ytdlp_copy`; the system-wide one is the fallback),
checks that flask, flask-cors, yt-dlp and ffmpeg are present (and stops with an install
hint if one is missing), starts the cache-maintenance and download worker threads, and serves
the app with waitress (16 threads, so streams and polls don't wait for each other).
Without waitress it falls back to Flask's built-in server. Deno isn't checked:
yt-dlp finds it on the `PATH` by itself. `POST /restart` (Settings → Restart server)
runs it again in the same process, and the downloads that were running continue.
`server.py --update-yt-dlp` (run by the installer) and `POST /ytdlp/update` (Settings →
Update yt-dlp, which then restarts) install the newest yt-dlp as that own copy.
`/health` answers `"app": "minimaltube"`: that's how the extension and the native host tell this
server from another program's. The host starts it on port 7860, or on the next free one up to
7869; the extension finds it on any of those and remembers it as `serverBase`.
Everything else lives here.

Imports only go down this list, so there are no cycles:

| Module | Imports from the package |
|---|---|
| `system` | nothing |
| `config`, `jsonfile` | system |
| `net`, `sublang`, `live` | nothing |
| `links` | config |
| `ytinfo` | links |
| `ytdlp_copy` | config, jsonfile, system |
| `media` | config, jsonfile, system |
| `cache` | config, jsonfile, media |
| `store` | config, jsonfile, links, media |
| `lookups` | config, jsonfile, links, media, store, ytinfo |
| `subtitles` | config, media, sublang, system, ytinfo |
| `feed` | config, jsonfile, links, lookups, media, net, store, ytinfo |
| `downloads` | cache, config, jsonfile, links, media, net, store, subtitles, ytinfo |
| `web` | config, ytinfo |
| `routes_*` | web and the modules above |
| `routes` | the five `routes_*` modules, config, net, web |

| Module | What it owns |
|---|---|
| `system.py` | What differs per OS, with no side effects (the native host and `install.py` use it too): the cache / data / app folders on Linux, macOS and Windows, the server's ports, `extension_id()` (from `manifest.json`'s key), `use_own_tools()` (MinimalTube's own ffmpeg, ffprobe and deno first on PATH), `spawn_detached()`, `run_again()` (restart in place), `replace_file()` (`os.replace` that rides out Windows' file locks), `port_is_free()`, `open_folder()`, `installer_hint()`. |
| `config.py` | `CACHE_DIR`, `DATA_DIR` (what the user made, kept apart from the cache), `APP_DIR` (MinimalTube's own Python, yt-dlp and tools), the cache limits, the yt-dlp format selector, the extension's origin, and the id regexes everything shares. |
| `jsonfile.py` | `read_json` (tolerant) and `write_json_atomic` (temp file, then rename): the one reader and writer of every JSON file. |
| `links.py` | `youtube_ids()`: the one reader of YouTube links (nothing else may reach yt-dlp), and the writers `watch_url`, `channel_url`, `thumbnail_url`. |
| `ytinfo.py` | The one place that runs yt-dlp lookups: `ydl(**opts)` (quiet defaults), `video_info()` (a full lookup of one video, kept for a few minutes; simultaneous requests for the same video share one lookup), `video_meta()` (the light one: YouTube's player API, about 0.2 s) and `upload_timestamp()`. |
| `ytdlp_copy.py` | MinimalTube's own yt-dlp: pip installs every version into a folder of its own in the app folder (`--target`, no sudo) and `yt-dlp.json` names the one to use, so an update never touches the running copy. |
| `net.py` | The app-wide connection state: `internet_up()` (a cached probe of YouTube), `is_online()`, `on_online()` callbacks; a watcher re-checks while offline. Every response carries it as `X-MinimalTube-Net`. |
| `media.py` | One video's files in the cache folder: the mp4, thumbnails (320 x 180 and 1280 x 720), description, release date, chapters, `<id>.meta.json`, SponsorBlock segments; `video_duration()`, `card_info()`. |
| `cache.py` | Keeping the cache folder in bounds: the age sweep, the size cap (set in Settings, `settings.json`), unused thumbnails, the maintenance loop. |
| `store.py` | The user's JSON files: `titles.json`, `original_titles.json` (cache dir), `order.json`, `playlists.json` (data dir); `remember_video()` keeps what a full lookup tells. |
| `lookups.py` | Background lookups of videos nobody opened yet: one pool and one light request per video answers the feed (a Short's time and length, own-language titles), a playlist's cards (channel, views, upload day) and the queue's lengths. `request(ids, missing)` starts them and says which are still running. |
| `sublang.py` | The caption rule, as pure functions: Turkish videos get Turkish (uploader's, then auto) then English (uploader's); English videos get English (uploader's, then auto); other languages get none. Never a machine translation. |
| `subtitles.py` | Fetching the captions `sublang.py` picks, and re-checking older downloads when the rule changes (`SUBLANG_RULE`). |
| `downloads.py` | The job table and everything done to it (`start_download`, `queue_download`, `forget_download`, `job_status`, `active_jobs`), the yt-dlp worker threads, and the Downloads list with its revision (`library_rev`). Routes never touch `jobs` themselves. |
| `feed.py` | Subscriptions (`subscriptions.json`) and the merged "latest uploads" feed (one channel or all), including the RSS/Shorts date reconciliation. It answers straight away and says `pending` while lookups run, so the app asks again a moment later. Collabs (`collabs.json`): `store_collabs()` keeps the ones the extension read from the signed-in YouTube feed. |
| `live.py` | Streaming (while downloading, or Stream only): picks the adaptive formats yt-dlp extracted in `/prepare`, parses each one's segment index (MP4 `sidx` / WebM `Cues`) and proxies byte ranges with yt-dlp's URL and headers. Idle unless the player streams. |
| `web.py` | What the route modules share: `ApiError` (raise it anywhere under a route: it becomes `{"error": ...}` with its status), the URL converters `<vid:…>`, `<pl:…>`, `<chan:…>` (only valid ids match), `json_body()`, `ids_param()`, `id_list()`, `full_info()`. |
| `routes.py` | The Flask app: CORS and the Origin check (only the extension's origin is answered from a browser; curl still works), the error handler, the connection header, and the five blueprints. |
| `routes_playback.py` | `/prepare`, `/live/…`, `/stream`, `/thumb`, `/subtitles`, `/description`, `/chapters`, `/sponsorblock`, `/channel-of`. |
| `routes_library.py` | `/state`, `/queue`, `/library`, `/library/order`, `/durations`, `/info`, `DELETE /video`. |
| `routes_playlists.py` | `/playlists` and everything under it. |
| `routes_feed.py` | `/subscriptions…`, `/feed`, `/feed/collabs`, `/playlist` (reading a YouTube playlist). |
| `routes_system.py` | `/health`, `/net`, `/cache-limit`, `/open-folder`, `/restart`, `/ytdlp/update`. |

## Conventions

**Everything that changes something is a POST, PUT or DELETE.** A page on another site can make
the browser send a GET without an Origin (an image, a link), which the Origin check can't
refuse; requests that change something always carry one. So `/prepare` (it can start a
download) and `/open-folder` are POSTs.

**`/state` is the one thing the player polls.** It carries the running downloads, the jobs of
the videos the player waits on, the Downloads list's revision and the captions' state. Add to
it rather than adding an endpoint to poll.

**Errors are raised, not returned:** `raise ApiError("unknown playlist", 404)`.

**`library_order` is reassigned by `save_order`,** so other modules read it as
`store.library_order` rather than importing the name. Everything else is
mutated in place and can be imported directly.

**Locks belong to the data they guard** (`titles_lock`, `playlists_lock`,
`subs_lock`, …). A function whose docstring says "caller must hold X" is called
from inside a `with X:` block, so it does not take the lock itself.
