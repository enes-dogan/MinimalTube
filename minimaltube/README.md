# The MinimalTube server package

`server.py` next to this folder is only an entry point: it puts MinimalTube's own
yt-dlp first on the import path (`ytdlp_copy`; the system-wide one is the fallback),
checks that flask, flask-cors, yt-dlp and ffmpeg are present (and stops with an install
hint if one is missing), starts the cache-maintenance, update-check and download worker threads, and serves
the app with waitress (16 threads, so streams and polls don't wait for each other).
Without waitress it falls back to Flask's built-in server. Deno isn't checked:
yt-dlp finds it on the `PATH` by itself. `POST /restart` (Settings → Restart server)
runs it again in the same process, and the downloads that were running continue.
`server.py --update-yt-dlp` (run by the installer) and `POST /ytdlp/update` (Settings →
Update yt-dlp, which then restarts) install the newest yt-dlp as that own copy.
`/health` answers `"app": "minimaltube"`: that's how the extension and the native host tell this
server from another program's. Its `"version"` is the one installed in the folder now (manifest.json),
which after an update can be ahead of the extension the browser is running. The host starts it on port 7860, or on the next free one up to
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
| `updater` | jsonfile, system |
| `launchers` | jsonfile, system |
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
| `system.py` | What differs per OS, with no side effects (the native host and `install.py` use it too): the cache / data / app folders on Linux, macOS and Windows, the server's ports, `extension_id()` (from `manifest.json`'s key), `app_version()` (`manifest.json`'s version: the only one), `uses_own_python()`, `use_own_tools()` (MinimalTube's own ffmpeg, ffprobe and deno first on PATH), `spawn_detached()`, `own_command()` and `run_again()` (restart in place), `pid_alive()`, `replace_file()` (`os.replace` that rides out Windows' file locks), `port_is_free()`, `open_folder()`, `installer_hint()`. |
| `config.py` | `CACHE_DIR`, `DATA_DIR` (what the user made, kept apart from the cache), `APP_DIR` (MinimalTube's own Python, yt-dlp and tools), the cache limits, the yt-dlp format selector, the extension's origin, and the id regexes everything shares. |
| `jsonfile.py` | `read_json` (tolerant) and `write_json_atomic` (temp file, then rename): the one reader and writer of every JSON file. |
| `links.py` | `youtube_ids()`: the one reader of YouTube links (nothing else may reach yt-dlp), and the writers `watch_url`, `channel_url`, `thumbnail_url`. |
| `ytinfo.py` | The one place that runs yt-dlp lookups: `ydl(**opts)` (quiet defaults), `video_info()` (a full lookup of one video, kept for a few minutes; simultaneous requests for the same video share one lookup), `video_meta()` (the light one: YouTube's player API, about 0.2 s) and `upload_timestamp()`. |
| `ytdlp_copy.py` | MinimalTube's own yt-dlp: pip installs every version into a folder of its own in the app folder (`--target`, no sudo) and `yt-dlp.json` names the one to use, so an update never touches the running copy. |
| `updater.py` | Updates from GitHub's releases (Settings → Updates), standard library only. The server checks the latest release (`check()`, once a day from `check_loop()`), downloads its source zip and checks every file against the tag's git tree (`stage_release()`: `unpack_release()`, `check_release()`), and works out which files differ here (`plan_changes()`). Installing (`start_install()`, `start_rollback()`) runs the new release's own copy of this file as a process of its own (`updater.py apply`): it backs up what it replaces, swaps only the changed files, restarts the server when server files changed and undoes everything when a step fails. The native host runs `updater.py recover` before it starts a server, for an install that was cut off. Its files are in the app folder's `updates/` (the module docstring lists them); a git checkout is never updated. |
| `launchers.py` | The installed app's icon in the colour theme picked in Settings (`PUT /launcher-icon`; the installer uses it too): `set_launcher_theme()` rewrites the Linux `.desktop` entry's `Icon=`, points the Windows Start-menu shortcut and a taskbar pin at the theme's `.ico` (`SHChangeNotify`), or rebuilds the macOS app's `.icns`; `saved_theme()` (`launcher_theme` in `settings.json`), `icon_file()`, `write_ico()`, `write_icns()`. |
| `net.py` | The app-wide connection state: `internet_up()` (a cached probe of YouTube), `is_online()`, `on_online()` callbacks; a watcher re-checks while offline. Every response carries it as `X-MinimalTube-Net`. |
| `media.py` | One video's files in the cache folder: the mp4, thumbnails (320 x 180 and 1280 x 720), description, release date, chapters, `<id>.meta.json`, SponsorBlock segments; `video_duration()`, `card_info()`. |
| `cache.py` | Keeping the cache folder in bounds: the age sweep, the size cap (set in Settings, `settings.json`), unused thumbnails, the maintenance loop. |
| `store.py` | The user's JSON files: `titles.json`, `original_titles.json` (cache dir), `order.json`, `playlists.json` (data dir); `remember_video()` keeps what a full lookup tells. |
| `lookups.py` | Background lookups of videos nobody opened yet: one pool and one light request per video answers the feed (a Short's time and length, own-language titles), a playlist's cards (channel, views, upload day) and the queue's lengths. `request(ids, missing)` starts them and says which are still running. |
| `sublang.py` | The caption rule, as pure functions: Turkish videos get Turkish (uploader's, then auto) then English (uploader's); English videos get English (uploader's, then auto); other languages get none. Never a machine translation. |
| `subtitles.py` | Fetching the captions `sublang.py` picks, and re-checking older downloads when the rule changes (`SUBLANG_RULE`). |
| `downloads.py` | The job table and everything done to it (`start_download`, `queue_download`, `forget_download`, `job_status`, `active_jobs`), the yt-dlp worker threads, and the Downloads list with its revision (`library_rev`). Routes never touch `jobs` themselves. |
| `feed.py` | Subscriptions (`subscriptions.json`) and the merged "latest uploads" feed (one channel or all), including the RSS/Shorts date reconciliation. It answers straight away and says `pending` while lookups run, so the app asks again a moment later. Collabs (`collabs.json`): `store_collabs()` keeps the ones the extension read from the signed-in YouTube feed. The state of the last subscription sync per YouTube account (`youtube-sync.json`): `sync_base()`, `set_sync_base()`. |
| `live.py` | Streaming (while downloading, or Stream only): picks the adaptive formats yt-dlp extracted in `/prepare`, parses each one's segment index (MP4 `sidx` / WebM `Cues`) and proxies byte ranges with yt-dlp's URL and headers. Idle unless the player streams. |
| `web.py` | What the route modules share: `ApiError` (raise it anywhere under a route: it becomes `{"error": ...}` with its status), the URL converters `<vid:…>`, `<pl:…>`, `<chan:…>` (only valid ids match), `json_body()`, `ids_param()`, `id_list()`, `full_info()`. |
| `routes.py` | The Flask app: CORS and the Origin check (only the extension's origin is answered from a browser; curl still works), the error handler, the connection header, and the five blueprints. |
| `routes_playback.py` | `/prepare`, `/live/…`, `/stream`, `/thumb`, `/subtitles`, `/description`, `/chapters`, `/sponsorblock`, `/channel-of`. |
| `routes_library.py` | `/state`, `/queue`, `/library`, `/library/order`, `/durations`, `/info`, `DELETE /video`. |
| `routes_playlists.py` | `/playlists` and everything under it. |
| `routes_feed.py` | `/subscriptions…` (with `/subscriptions/youtube-sync`: what the last sync with a YouTube account left on both sides), `/feed`, `/feed/collabs`, `/channel` (the channel an @handle names), `/playlist` (reading a YouTube playlist). |
| `routes_system.py` | `/health`, `/net`, `/cache-limit`, `/open-folder`, `/restart`, `/ytdlp/update`, and the updates: `/update/status`, `/update/check`, `/update/download`, `/update/install`, `/update/rollback` (the last two answer at once; with server files changing the server then stops and the updater starts the new one), `/update/settings` (automatic updates), and `/launcher-icon` (the installed app's icon in a colour theme: `launchers.py`). |

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
