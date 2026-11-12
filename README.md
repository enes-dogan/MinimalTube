# MinimalTube

YouTube without the noise: your subscriptions, playlists and downloads in one calm player.

MinimalTube is a Chromium-based browser extension plus a small local Python server. The
extension is the app you see; the server uses yt-dlp to fetch, download and stream videos. No
YouTube page ever loads.

It runs on Linux, Windows 11 and macOS. Setting it up is two steps on each: load the extension,
run the installer. The installer needs no admin rights and installs nothing system-wide.

## What it does

- **Watch without the noise.** Any YouTube video plays ad-free in its own window,
  downloaded in the best quality so it's yours offline. On youtube.com, right-click a
  video or link → *Add to MinimalTube queue*, or paste a YouTube link anywhere in the app
  (Ctrl+V, ⌘V on a Mac) to add it to the queue.
- **YouTube videos open here.** Turn on *Open YouTube videos in MinimalTube* in Settings (off
  by default) and a video or Shorts link opened in this browser (or in another app, when this
  browser is your default) plays in MinimalTube instead of on YouTube. Playlists and channels
  stay on YouTube; a video's ⋮ → *Open on YouTube* still takes you there.
- **Subscriptions.** Add channels by @handle or link; their new uploads arrive in one
  feed. Click a channel name to see only that channel's videos. The latest 36 videos of up to
  30 channels are remembered, so the feed and channel pages open instantly; new uploads slot in
  as they're found. The import button next to *Channels* brings over all your YouTube
  subscriptions at once (you need to be signed in to YouTube in this browser). While you're
  signed in, collabs show up too: a video a channel you follow made with another channel,
  which YouTube lists only under the channel that uploaded it.
- **Queue and playlists.** *Add next to queue*, drag to reorder, Back / Next. Save the
  queue (or any video) to your own playlists.
- **Synced with YouTube.** Save one of your YouTube playlists from its page and it stays
  two-way synced. Finished videos can go to your YouTube history (Settings → *Sync
  finished videos to YouTube history*; you need to be signed in to YouTube in this
  browser).
- **Instant start.** *Stream while downloading* starts a video in a second while it
  downloads; *Stream only* just streams (720p, stepping up to 1080p when your connection
  allows) without keeping a copy.
- **Downloads.** Everything you watched plays offline from the Downloads tab (unless *Stream
  only* is on, which keeps nothing).
- **Picks up where you left off**, with progress bars for every video. Captions in the
  video's own language, SponsorBlock skipping and chapters on the seekbar.
- **Works offline.** Without internet an **OFFLINE** badge appears, downloaded videos keep
  playing, every thumbnail you've seen keeps showing, and everything (the feed, downloads,
  history and playlist syncs) catches up by itself when the connection is back.
- **Made for the keyboard.** Every list works with Tab, the arrow keys and Enter; every ⋮
  menu has letter keys. Press the **i** in Settings for all shortcuts. Media keys and your
  system's media controls work too.

## Install

You need a Chromium-based browser: Google Chrome, Chromium (ungoogled-chromium too), Brave,
Microsoft Edge, Vivaldi or Opera. Everything else the installer brings along.

1. **Load the extension:** open `chrome://extensions` (`edge://extensions` in Edge), switch on
   *Developer mode*, click *Load unpacked* and pick the `extension` folder inside this one. Its ID is always
   `bnenkakahnieeabjicmgndndommgehje`, on every machine.
2. **Run the installer** from this folder:

   | | |
   |---|---|
   | Linux | `./install-linux.sh` in a terminal, or double-click `install-linux.sh` |
   | Windows 11 | double-click `install-windows.cmd`. If Windows says it protected your PC, click *More info* → *Run anyway* |
   | macOS | double-click `install-macos.command`. If macOS won't open it, right-click it → *Open* → *Open* |

3. **Reload the extension** on `chrome://extensions` and start **MinimalTube** from your
   application menu (Linux), the Start menu (Windows) or Launchpad / Spotlight (macOS). The
   first start shows a short tour, then the keyboard shortcuts.

Keep the folder somewhere permanent that you can write to (not *Program Files*), and run the
installer again if you move it, or after installing another browser.

### What the installer does

Nothing it does needs sudo or an admin password, and nothing goes outside your user folder:

- **Python for the server.** MinimalTube gets a Python of its own (a standalone build, about
  30 MB, checked against its published checksum) with Flask, Flask-CORS and waitress in it. On
  Linux, when your system's `python3` already has Flask, Flask-CORS and pip (from your
  distribution's packages), that one is used and nothing is downloaded;
  `MINIMALTUBE_OWN_PYTHON=1 ./install-linux.sh` gives it its own anyway.
- **yt-dlp**, always as MinimalTube's own copy, so Settings → **Update yt-dlp** can keep it
  current. A yt-dlp of your system is only the fallback.
- **ffmpeg and Deno.** The ones on your system when it has them; otherwise MinimalTube's own.
  yt-dlp uses Deno to solve YouTube's player challenges.
- **The native host:** a small registration with each browser it finds, which lets the
  extension start the server by itself.
- **MinimalTube in your application menu**, opening in the browser that has the extension.

### Linux notes

- It's the same on Arch-based and Debian-based distributions (and others with glibc): the
  installer fills in whatever isn't there. Installing your distribution's packages first is
  optional and only saves the downloads: `python-flask python-flask-cors python-waitress
  python-pip ffmpeg deno` on Arch, `python3-flask python3-flask-cors python3-waitress
  python3-pip ffmpeg` on Debian / Ubuntu.
- **Snap and Flatpak browsers** run in a sandbox that keeps the extension from starting the
  server. Ubuntu's `chromium` is a snap: the installer notices and makes the application-menu
  entry start the server first, so MinimalTube works when you start it from there. A Flatpak
  browser can't be used; install one as a normal package (Chrome, Brave, Vivaldi and Edge offer
  `.deb` downloads).

## Using it

- **Subscriptions / Playlists / Downloads** are the tabs of the browse page. Click a
  thumbnail to play; the player shrinks to a mini player while you browse (**I**). Its **›**
  tucks it away at the window's edge, still playing; the **‹** left there brings it back.
- **A window or a tab.** MinimalTube opens as its own window from your application menu, or
  from the toolbar button as a window or a browser tab. Only one runs at a time; the button
  left of ★ in Settings moves it between the two without interrupting anything.
- **The side panel** (**T**, or the list button at the top right) holds the queue and your downloads.
- **⋮ on any video or row** (or right-click it) for its actions; each has a letter key.
- **Settings** (⚙ or **,**) opens over the app: SponsorBlock, *Stream while downloading*,
  *Stream only*, *Open YouTube videos in MinimalTube*, YouTube history sync and *Remember
  queue* (the app then also comes back with the last video, paused where you left it).
  Switches apply right away. *Max … GB* sets how much space downloads may take.
  ★ shows the tour again; **i** shows the keyboard shortcuts.
- **The server's address** finds itself: port 7860, or the next free one (up to 7869) when
  another program already uses it.

## Where things are

| What | Linux | macOS | Windows |
|---|---|---|---|
| Downloads, thumbnails, captions, the server log (`server.log`) | `~/.cache/minimaltube/` | `~/Library/Caches/MinimalTube/` | `%LOCALAPPDATA%\MinimalTube\Cache\` |
| Playlists, subscriptions, collabs found in your YouTube feed, the order of your downloads, the size cap | `~/.local/share/minimaltube/` | `~/Library/Application Support/MinimalTube/` | `%APPDATA%\MinimalTube\` |
| MinimalTube's own Python, yt-dlp, ffmpeg and Deno | `~/.local/share/minimaltube/` | `~/Library/Application Support/MinimalTube/` | `%LOCALAPPDATA%\MinimalTube\` |
| The app's entry | `~/.local/share/applications/minimaltube.desktop` | `~/Applications/MinimalTube.app` | Start menu → MinimalTube |
| What lets the extension start the server | `~/.config/<browser>/NativeMessagingHosts/` | `~/Library/Application Support/<browser>/NativeMessagingHosts/` | registry: `HKCU\Software\<browser>\NativeMessagingHosts\com.minimaltube.host` |

Settings, the queue, watch progress and the feed's memory are in the browser's extension storage.

Downloads older than 60 days are removed together with their thumbnails, captions and other
saved info, thumbnails that nothing has shown for 60 days go too, and the downloads are kept
under 64 GB, the oldest going first. Change that size in Settings (*Max … GB*, 16 to 1024).

## Updating

YouTube changes often, so keep yt-dlp current: Settings → **Update yt-dlp** installs the
newest one and restarts the server.

After getting new code for this folder: reload the extension on `chrome://extensions`, then
Settings → **Restart server**, so both halves run the new code. Run the installer again when
the update says so; that also updates the server's Python packages.

Coming from a version where the browser loaded this whole folder: remove MinimalTube on
`chrome://extensions`, *Load unpacked* the `extension` folder and run the installer once more.
The ID stays the same, so your settings, queue and watch progress are kept.

To stop the server by hand (the next MinimalTube window starts it again): on Linux and macOS
`pkill -f "server.py --host 127.0.0.1"`; on Windows, end *python.exe* in Task Manager. A
server you started in a terminal stops with Ctrl+C there.

## Troubleshooting

- **"MinimalTube server isn't running":** look at `server.log` in the cache folder above, or
  start the server by hand to see its errors: `python3 server.py` (with MinimalTube's own
  Python: the `python` folder in the app folder above).
- **Nothing happens from the application menu, or the server never starts:** run the
  installer again; a browser installed after it ran isn't registered yet. If the extension's
  ID on `chrome://extensions` isn't the one above, pass it: `./install-linux.sh <extension-id>`
  (Windows: `install-windows.cmd <extension-id>`). A Flatpak browser can't start the server; a snap
  browser only through the application-menu entry.
- **A video won't play:** yt-dlp is probably out of date: Settings → **Update yt-dlp**.
- **"The running server is outdated":** the extension is newer than the server that is
  running: Settings → **Restart server**.
- **Small errors that don't interrupt anything** are logged to the extension console:
  right-click the player → *Inspect* (or *service worker* on `chrome://extensions` for
  the background).

## For developers

- `extension/`: the folder the browser loads, and nothing but the extension.
  `manifest.json`; `background.js` (the service worker's entry) + `background/` (one file per
  job: the server, the player window, links, YouTube, history, playlist sync, subscriptions);
  `content-youtube.js` (buttons on youtube.com); `open.*` (where YouTube links land on their way
  to the app); `popup.*`.
- `extension/player.html` + `extension/js/`: the player, one file per part. `js/common.js` is
  shared with the background, the popup and the content script. See `extension/js/README.md`.
- `extension/css/`: the stylesheets, built on the tokens in `css/tokens.css`. See
  `extension/css/README.md`.
- `server.py` + `minimaltube/`: the server (its Python packages are in `requirements.txt`).
  See `minimaltube/README.md`.
- `minimaltube_host.py`: the native messaging host that starts the server.
- `install-linux.sh`, `install-macos.command`, `install-windows.cmd`: what you run; each only
  starts its script in `installer/`. There, `install.sh` (Linux, macOS) and `install.ps1`
  (Windows) find or fetch the Python that `install.py`, the installer itself and the same on
  every OS, runs with. What differs per OS at runtime (folders, PATH, starting and restarting
  the server, the file manager) is in `minimaltube/system.py`.
- Chromium refuses to load an extension folder that holds a top-level name starting with `_`,
  so nothing else is kept in `extension/`. Python writes no bytecode (`-B`), which keeps the
  whole folder to the files it came with.
