# The MinimalTube server package

`server.py` next to this folder is only an entry point: it puts MinimalTube's own
yt-dlp first on the import path (`ytdlp_copy`; the system-wide one is the fallback),
checks that flask, flask-cors, yt-dlp and ffmpeg are present (and stops with an install
hint if one is missing), starts the cache-maintenance and download worker threads, and serves
the app with waitress (16 threads, so streams and polls don't wait for each other).
Without waitress it falls back to Flask's built-in server. Deno isn't checked:
yt-dlp finds it on the `PATH` by itself. `POST /restart` (Settings → Restart server)
runs it again in the same process, and the downloads that were running continue.
`server.py --update-yt-dlp` (run by `install.sh`) and `POST /ytdlp/update` (Settings →
Update yt-dlp, which then restarts) install the newest yt-dlp as that own copy.
`/health` answers `"app": "minimaltube"`: that's how the extension and the native host tell this
server from another program's. The host starts it on port 7860, or on the next free one up to
7869; the extension finds it on any of those and remembers it as `serverBase`.
Everything else lives here.

Imports only go down this list, so there are no cycles:

| Module | Imports from the package |
|---|---|
| `config`, `net`, `sublang`, `live` | nothing |
| `ytinfo`, `ytdlp_copy` | config |
| `media` | config, ytinfo |
| `store` | config, media, ytinfo |
| `subtitles` | config, media, sublang, ytinfo |
| `feed` | config, media, net, store, ytinfo |
| `downloads` | config, media, net, store, subtitles, ytinfo |
| `routes` | all of the above except sublang |

| Module | What it owns |
|---|---|
| `system.py` | What differs per OS, with no side effects (the native host and `install.py` use it too): the cache / data / app folders on Linux, macOS and Windows, `use_own_tools()` (MinimalTube's own ffmpeg, ffprobe and deno first on PATH), `spawn_detached()` (starting the server so it outlives its starter; on Windows with a console that never shows), `replace_file()` (`os.replace` that rides out Windows' file locks) and `open_folder()`. |
| `config.py` | `CACHE_DIR`, `DATA_DIR` (what the user made, kept apart from the cache), `APP_DIR` (MinimalTube's own Python, yt-dlp and tools), the cache limits, the yt-dlp format selector, the extension's origin, and the id/regex constants everything shares. |
| `ytinfo.py` | The one place that runs yt-dlp: `ydl(**opts)` (quiet defaults), `video_info()` (a full lookup of one video, kept for a few minutes; simultaneous requests for the same video share one lookup) and `video_meta()` (title, upload time and length only, from YouTube's player API: about 0.2 s, for the feed's bulk lookups). |
| `ytdlp_copy.py` | MinimalTube's own yt-dlp: pip installs every version into a folder of its own in the app folder (`--target`, no sudo) and `yt-dlp.json` names the one to use, so an update never touches the running copy; `use_own_copy()` puts it on `sys.path` at start, before anything imports yt-dlp. |
| `net.py` | The app-wide connection state: `internet_up()` (a cached probe of YouTube), `is_online()`, `on_online()` callbacks; a watcher re-checks while offline. Every response carries it as `X-MinimalTube-Net`. |
| `store.py` | The JSON files: `titles.json`, `original_titles.json` (cache dir), `order.json`, `playlists.json` (data dir). `write_json_atomic` is the single temp-file-then-rename writer and `read_json` the single tolerant reader they all use. |
| `media.py` | One video's files: the mp4, thumbnail, description, release date, chapters, meta, SponsorBlock segments, plus duration probing and the cache-expiry sweep. `card_info()` is what a video card shows under its title (channel, views, upload day); `/info` looks up the videos that have none saved. |
| `sublang.py` | The caption rule, as pure functions: Turkish videos get Turkish (uploader's, then auto) then English (uploader's); English videos get English (uploader's, then auto); other languages get none. Never a machine translation. |
| `subtitles.py` | Fetching the captions `sublang.py` picks, and re-checking older downloads when the rule changes (`SUBLANG_RULE`). |
| `downloads.py` | The job table, the yt-dlp worker threads, cancellation, and the Downloads listing. |
| `feed.py` | Subscriptions (`subscriptions.json`) and the merged "latest uploads" feed (one channel or all), including the RSS/Shorts date reconciliation. It answers straight away: Shorts still being dated are left out and lengths / own-language titles still being looked up are filled in later, in the background, and the response says `pending` so the app asks again a moment later. RSS titles count as own-language titles (no lookup needed). Looked-up dates and lengths are kept in `video_info.json`. A channel's subscriber count comes with its feed (`subscribers`); `import_subscriptions()` (`/subscriptions/import`) adds many channels at once and reads them in the background. |
| `live.py` | Streaming (while downloading, or Stream only): picks the adaptive formats yt-dlp extracted in `/prepare`, parses each one's segment index (MP4 `sidx` / WebM `Cues`) and proxies byte ranges with yt-dlp's URL and headers. Idle unless the player streams. |
| `routes.py` | The Flask app and all endpoints. Handlers stay thin and call into the modules above. From a browser, only the extension's own origin is answered (CORS plus an Origin check); curl and other tools still work. Routes take video ids as `<vid:video_id>` (only an 11-character id matches), and `/prepare` / `/playlist` accept only YouTube links (`media.youtube_ids`). |

## Conventions

**`library_order` is reassigned by `save_order`,** so other modules read it as
`store.library_order` rather than importing the name. Everything else is
mutated in place and can be imported directly.

**Locks belong to the data they guard** (`titles_lock`, `playlists_lock`,
`subs_lock`, …). A function whose docstring says "caller must hold X" is called
from inside a `with X:` block, so it does not take the lock itself.
