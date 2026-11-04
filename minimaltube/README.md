# The MinimalTube server package

`server.py` next to this folder is only an entry point: it checks that flask,
flask-cors, yt-dlp and ffmpeg are present (and stops with an install hint if one
is missing), starts the cache-maintenance and download worker threads, and serves
the app with waitress (16 threads, so streams and polls don't wait for each other).
Without waitress it falls back to Flask's built-in server. Deno isn't checked:
yt-dlp finds it on the `PATH` by itself. `POST /restart` (Settings → Restart server)
runs it again in the same process, and the downloads that were running continue.
Everything else lives here.

Imports only go down this list, so there are no cycles:

| Module | Imports from the package |
|---|---|
| `config`, `net`, `sublang`, `live` | nothing |
| `ytinfo` | config |
| `media` | config, ytinfo |
| `store` | config, media, ytinfo |
| `subtitles` | config, media, sublang, ytinfo |
| `feed` | config, media, net, store, ytinfo |
| `downloads` | config, media, net, store, subtitles, ytinfo |
| `routes` | all of the above except sublang |

| Module | What it owns |
|---|---|
| `config.py` | `CACHE_DIR`, `DATA_DIR` (what the user made, kept apart from the cache), the cache limits, the yt-dlp format selector, the extension's origin, and the id/regex constants everything shares. |
| `ytinfo.py` | The one place that runs yt-dlp: `ydl(**opts)` (quiet defaults), `video_info()` (a full lookup of one video, kept for a few minutes; simultaneous requests for the same video share one lookup) and `video_meta()` (title, upload time and length only, from YouTube's player API: about 0.2 s, for the feed's bulk lookups). |
| `net.py` | The app-wide connection state: `internet_up()` (a cached probe of YouTube), `is_online()`, `on_online()` callbacks; a watcher re-checks while offline. Every response carries it as `X-MinimalTube-Net`. |
| `store.py` | The JSON files: `titles.json`, `original_titles.json` (cache dir), `order.json`, `playlists.json` (data dir). `write_json_atomic` is the single temp-file-then-rename writer and `read_json` the single tolerant reader they all use. |
| `media.py` | One video's files: the mp4, thumbnail, description, release date, chapters, meta, SponsorBlock segments, plus duration probing and the cache-expiry sweep. |
| `sublang.py` | The caption rule, as pure functions: Turkish videos get Turkish (uploader's, then auto) then English (uploader's); English videos get English (uploader's, then auto); other languages get none. Never a machine translation. |
| `subtitles.py` | Fetching the captions `sublang.py` picks, and re-checking older downloads when the rule changes (`SUBLANG_RULE`). |
| `downloads.py` | The job table, the yt-dlp worker threads, cancellation, and the Downloads listing. |
| `feed.py` | Subscriptions (`subscriptions.json`) and the merged "latest uploads" feed (one channel or all), including the RSS/Shorts date reconciliation. It answers straight away: Shorts still being dated are left out and lengths / own-language titles still being looked up are filled in later, in the background, and the response says `pending` so the app asks again a moment later. RSS titles count as own-language titles (no lookup needed). Looked-up dates and lengths are kept in `video_info.json`. |
| `live.py` | Streaming (while downloading, or Stream only): picks the adaptive formats yt-dlp extracted in `/prepare`, parses each one's segment index (MP4 `sidx` / WebM `Cues`) and proxies byte ranges with yt-dlp's URL and headers. Idle unless the player streams. |
| `routes.py` | The Flask app and all endpoints. Handlers stay thin and call into the modules above. From a browser, only the extension's own origin is answered (CORS plus an Origin check); curl and other tools still work. |

## Conventions

**`library_order` is reassigned by `save_order`,** so other modules read it as
`store.library_order` rather than importing the name. Everything else is
mutated in place and can be imported directly.

**Locks belong to the data they guard** (`titles_lock`, `playlists_lock`,
`subs_lock`, …). A function whose docstring says "caller must hold X" is called
from inside a `with X:` block, so it does not take the lock itself.
