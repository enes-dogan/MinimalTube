# The player's scripts

`player.html` loads these as ordinary scripts, in this order. They share one global scope, as
one big file would: no imports, no build step.

| File | What it owns |
|---|---|
| `stream.js` | `LiveStream`: playing YouTube's separate video + audio streams with Media Source Extensions (adaptive 720p ↔ 1080p in Stream only). Knows nothing about the rest of the page. |
| `core.js` | The page's elements, the connection state (OFFLINE badge, `whenNetChanges`), `notify()`, SponsorBlock lookups, the server API (`api()`, `requestDownloads()`, `preparePath()`), `logQuiet()`, `el()`, `restartAnimation()`, `dialogKeys()` (a dialog's letter keys), `whenLoaded()` and the layer stack (`addLayer`: Esc and click-outside for every panel, menu and dialog). |
| `playback.js` | `playVideo` (prepare, streaming, handover to the downloaded file), captions, adding links to the queue, seek / volume / speed / fullscreen basics, the system's media controls (Media Session). |
| `settings-queue.js` | The Settings card (opening / closing it, switches saved as they're flipped), Ctrl+V pasting a link into the queue, and the queue's state: saving, restoring, the link to a saved playlist, Back / Next, Download all, Clear queue (with Undo). |
| `side-panel.js` | Watch progress (and sending finished videos to YouTube history), the side panel's rows (`makeRow`, `makePlThumb`), queue statuses (one `/statuses` request), the Downloads list. |
| `row-menus.js` | Reordering rows, the side panel's ⋮ menu, its actions, the shared "Save to" popover, the Undo bar (`offerUndo`) and deleting / removing videos with it. |
| `player-ui.js` | Collapsible panel sections, the idle fade, "Up next", the description popup, playback speed, the download indicator (adaptive `/downloads` polling). |
| `playlists.js` | Saved playlists: loading one into the queue, deleting one (with Undo), the "Save as playlist" dialog. |
| `browse.js` | The browse page and mini player, formatting helpers, the shared menu renderer (`fillMenu`) and positioner (`placePopup`), right-click menus, the feed's cards (`makeCard`, `makeThumb`, `videoCardLines` for the channel / views / age lines, `fmtCount` for "15.3M subscribers"), `addNextEntry` (every ⋮ menu's "Add next to queue": it refuses, red, while a saved playlist is in the queue). |
| `feed.js` | Subscriptions and the feed. Every channel remembers its newest 36 videos (30 channels, saved a moment after changes); a channel's page and the Subscriptions feed (all subscribed channels merged, newest first) are drawn from that at once, then each channel is asked again in the background and the cards are updated in place. Importing the YouTube account's subscriptions (the background reads them, `/subscriptions/import` adds them). |
| `playlists-tab.js` | The Playlists tab: reorderable card grids, a playlist's page (its cards' channel / views / age come from `/info`), YouTube playlist sync. |
| `downloads-tab.js` | Default window size, the Downloads tab, the default page, `reloadFromServer()` (after the server (re)starts). |
| `keyboard.js` | Keyboard navigation in lists (`makeRovingList`), the skip link, keyboard-opened menus, Shift+N / Shift+B, **I** and the mini player's close button. |
| `seekbar.js` | Chapters and SponsorBlock marks on the seekbar. |
| `overlays.js` | The keyboard shortcuts overlay and the welcome screen. |

## Conventions

**Order matters only at load time.** Code that runs while the page loads (top-level
statements) may only use what earlier files define; functions called later, from events and
timers, can live in any file. Shared helpers therefore go in `core.js`. A storage read, fetch
or message started while the page loads can answer before the later files have run, so its
callback goes through `whenLoaded()` when it calls into them.

**Use the shared pieces** rather than writing new ones:

- talking to the server: `api(path, {method, body})` (throws with the server's message);
- telling the user something: `notify(text, isError)`;
- something the user can take back: `offerUndo(text, {undo, commit})` (the 5-second Undo bar;
  `commit` does the real work once it's gone);
- something that opens over the app: `addLayer({el, isOpen, close, inside, level})`;
- cards and rows: `makeCard({...})`, `makeRow({...})`, thumbnails `makeThumbImg()`;
- a ⋮ menu: an entries array for `showBpMenu` / `openRowMenu` (rendered by `fillMenu`);
- a new setting: one line in `SETTINGS`;
- errors that shouldn't interrupt anyone: `logQuiet(where, err)` (the extension console).
