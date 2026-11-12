# The player's scripts

`player.html` loads these as ordinary scripts, in this order. They share one global scope, as
one big file would: no imports, no build step. A name can be declared only once among them.

| File | What it owns |
|---|---|
| `common.js` | What every part of the extension shares (the player, the background worker, the popup and the script on youtube.com all load it): the server's address and ports, the installer's name per OS, `youTubeIds()` (the one reader of YouTube links) with `watchUrl()`, `youTubeLink()`, `youTubeVideoLink()`, `stripPlaylistParams()`, plus `logQuiet()`, `errorText()`, `sleep()`. Nothing in it touches a page. |
| `stream.js` | `LiveStream`: playing YouTube's separate video + audio streams with Media Source Extensions (adaptive 720p ↔ 1080p in Stream only). Knows nothing about the rest of the page. |
| `core.js` | The page's elements, the connection state (OFFLINE badge, `whenNetChanges`), `notify()`, the server API (`api()`, `prepareVideo()`), `el()`, `byId()`, `isTypingTarget()`, `restartAnimation()`, `dialogKeys()` (a dialog's letter keys), `whenLoaded()` and the layer stack (`addLayer`: Esc and click-outside for every panel, menu and dialog). |
| `format.js` | How things are written out: `formatTime`, `fmtDur`, `fmtCount`, `plural`, `timeAgo`, `fmtSize`, `fmtReleaseDate`, `firstLine`. |
| `icons.js` | The `ICON_*` SVGs the scripts draw. |
| `jobs.js` | The one loop that asks the server what changed (`GET /state`): `whenStateChanges()`, `pollStateSoon()`, `untilDownloaded()`, `activeDownloads`, `requestDownloads()`, and the download ring. |
| `playback.js` | `playVideo` (prepare, streaming, handover to the downloaded file), `stopPlayback`, SponsorBlock, captions, seek / volume / speed / fullscreen basics, the system's media controls (Media Session). |
| `settings.js` | The Settings card: its switches (one line each in `SETTINGS`, saved as they're flipped), the window / tab switch, the downloads' size cap, and the server's buttons (videos folder, restart, update yt-dlp; `reloadFromServer()`). |
| `queue.js` | **The queue's home.** Its state (`queue`, `queueIndex`, `playSource`) and every way of changing it: `setQueue`, `appendToQueue`, `queueVideoNext`, `playVideoNow`, `moveQueueItem`, `removeQueueItem`, `clearQueue`, `addUrlToQueue` (links and pasting), `playQueueItem`, Back / Next (`resolveNext`, `skipVideo`), "Remember queue", the saved playlist behind the queue, Download all. After any change: `queueChanged()`. |
| `watch-progress.js` | Where each video was stopped, the red bar on thumbnails, and sending finished videos to YouTube history. |
| `undo.js` | The Undo bar (`offerUndo`). |
| `reorder.js` | `makeSortable()`: drag to reorder, for the side panel's rows (by their grip) and the card grids. |
| `menus.js` | The ⋮ menus: `openMenu()` for both (`rowMenu` in the side panel, `bpMenu` over the browse page), `menuButton()`, `placePopup()`, right-click, and the "Save to playlist" list (`saveToEntry`). |
| `side-panel.js` | The side panel: its two sections, `makeRow`, `renderQueue`, the rows' download progress (`paintQueueStatuses`), and the Downloads list itself (`library`, `downloadedIds`, `refreshLibrary`, `setLibrary`). |
| `video-actions.js` | What can be done with a video wherever it shows: `videoJob()`, download, delete (with Undo), go to channel, and the menu entries built from them (`downloadEntry`, `addNextEntry`, `channelEntry`, `queueMenuEntries`, `libraryMenuEntries`, `videoMenuEntries`). |
| `player-ui.js` | Around the video: the idle fade, "Up next" (and a video that waits for its download while another plays), the description popup. |
| `playlists.js` | Saved playlists: loading one into the queue, deleting one (with Undo), the "Save as playlist" dialog. |
| `browse.js` | The browse page and mini player: tabs, moving the side panel over the page, the page's round buttons, back to top, sticky bars, the mini player's own buttons. |
| `cards.js` | The browse page's cards: `makeThumbImg`, `makeCard`, `videoCardLines`, `makeVideoCard`. |
| `feed.js` | Subscriptions and the feed. Every channel remembers its newest 36 videos (30 channels, saved a moment after changes); a channel's page and the Subscriptions feed are drawn from that at once, then each channel is asked again in the background and the cards are updated in place. Importing the YouTube account's subscriptions; collabs. |
| `playlists-tab.js` | The Playlists tab: the playlists' cards, a playlist's page (its cards' channel / views / age come from `/info`), YouTube playlist sync. |
| `downloads-tab.js` | The Downloads tab's cards. |
| `keyboard.js` | Keyboard navigation in lists (`makeRovingList`), inside the ⋮ menus, the skip link, and the keys of the player and the app. |
| `seekbar.js` | Chapters and SponsorBlock marks on the seekbar. |
| `overlays.js` | The keyboard shortcuts overlay and the welcome screen. |
| `startup.js` | Runs last: the window's size and place, what the background asks of a running player (messages), and opening whatever the player was started for. |

The background service worker is `background.js` plus the files in `background/` (its header
lists them); it loads `common.js` too.

## Conventions

**Order matters only at load time.** Code that runs while the page loads (top-level
statements) may only use what earlier files define; functions called later, from events and
timers, can live in any file. A storage read, fetch or message started while the page loads can
answer before the later files have run, so its callback goes through `whenLoaded()` when it
calls into them.

**`video` is the page's `<video>` element.** A video's data (`{id, title, url, duration}`) is
called `v` in parameters, a queue item `item`, a download `entry`.

**Use the shared pieces** rather than writing new ones:

- talking to the server: `api(path, {method, body})` (throws with the server's message);
- telling the user something: `notify(text, isError)`;
- something the user can take back: `offerUndo(text, {undo, commit})` (the 5-second Undo bar;
  `commit` does the real work once it's gone);
- something that opens over the app: `addLayer({el, isOpen, close, inside, level})`;
- changing the queue: a function in `queue.js`, never `queue.items` directly;
- following the server's work: `whenStateChanges(fn)`, or `untilDownloaded(id, isStale)` to wait
  for one download; never a timer of your own;
- reading a YouTube link: `youTubeIds(link)`;
- building elements: `el(tag, className, text)`; cards and rows: `makeCard({...})`,
  `makeRow({...})`, thumbnails `makeThumbImg()`;
- a ⋮ menu: an entries array for `menuButton()` / `openMenu()`;
- drag to reorder: `makeSortable(container, {item, handle, onMove})`;
- a new setting: one line in `SETTINGS`;
- errors that shouldn't interrupt anyone: `logQuiet(where, err)` (the extension console).
