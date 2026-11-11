# MinimalTube

YouTube without the noise: your subscriptions, playlists and downloads in one calm player.

MinimalTube is a Chromium-based browser extension plus a small local Python server. The extension is the
app you see (opened as its own window from your application menu, or from the toolbar button
as a window or a browser tab; only one runs at a time, the button left of ★ in Settings moves
it between the two without interrupting anything, and YouTube links you open start it the way
you used it last); the server uses yt-dlp
to fetch, download and stream videos. No YouTube page ever loads.

## What it does

- **Watch without the noise.** Any YouTube video plays ad-free in its own window,
  downloaded in the best quality so it's yours offline. On youtube.com, right-click a
  video or link → *Add to MinimalTube queue*, or paste a YouTube link anywhere in the app
  (Ctrl+V) to add it to the queue.
- **YouTube videos open here.** Turn on *Open YouTube videos in MinimalTube* in Settings (off
  by default) and a video or Shorts link opened in this browser (or in another app, when this
  browser is your default) plays in MinimalTube instead of on YouTube. Playlists and channels
  stay on YouTube; a video's ⋮ → *Open on YouTube* still takes you there.
- **Subscriptions.** Add channels by @handle or link; their new uploads arrive in one
  feed. Click a channel name to see only that channel's content. The latest 36 videos of up to 30 channels are remembered, so the feed
  and channel pages open instantly; new uploads slot in as they're found. The import button
  next to *Channels* brings over all your YouTube subscriptions at once (you need to be signed
  in to YouTube in this browser); their videos fill the feed as they're read. While you're
  signed in, collabs show up too: a video a channel you follow made with another channel,
  which YouTube lists only under the channel that uploaded it. Signed out, the feed works the
  same without them.
- **Queue and playlists.** *Add next to queue*, drag to reorder, Back / Next. Save the
  queue (or any video) to your own playlists.
- **Synced with YouTube.** Save one of your YouTube playlists from its page and it stays
  two-way synced. Finished videos can go to your YouTube history (Settings → *Sync
  finished videos to YouTube history*; you need to be signed in to YouTube in this
  browser).
- **Instant start.** *Stream while downloading* starts a video in a second while it
  downloads; *Stream only* just streams (720p, stepping up to 1080p when your connection
  allows) without keeping a copy.
- **Downloads.** Everything you watched plays offline (if "Stream Only" mode disabled) from the Downloads tab.
- **Picks up where you left off**, with progress bars for every video. Captions in the
  video's own language, SponsorBlock skipping and chapters on the seekbar.
- **Works offline.** Without internet an **OFFLINE** badge appears, downloaded videos keep
  playing, every thumbnail you've seen keeps showing, and everything (the feed, downloads,
  history and playlist syncs) catches up by itself when the connection is back.
- **Made for the keyboard.** Every list works with Tab, the arrow keys and Enter; every ⋮
  menu has letter shortcut keys. Press the **i** in Settings for all shortcuts. Media keys
  and your system's media controls work too.

## Install (Linux)

Arch-based and Debian-based distributions differ only in step 1 (and in where you get the
browser); everything after that is the same.

1. **Packages.**

   **Arch-based** (Arch, CachyOS, EndeavourOS, Manjaro):

   ```bash
   sudo pacman -S python python-pip python-flask python-flask-cors python-waitress ffmpeg deno
   ```

   **Debian-based** (Debian 12, Ubuntu 24.04 or newer, and the distributions built on them,
   such as Linux Mint 22):

   ```bash
   sudo apt install python3 python3-pip python3-flask python3-flask-cors python3-waitress ffmpeg curl unzip
   ```

   Deno isn't in the Debian / Ubuntu repositories. Its own installer, pointed at
   `~/.local`, puts it in `~/.local/bin`, where the server finds it:

   ```bash
   curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$HOME/.local" sh
   ```

   Missing some of them? The installer (step 4) fills in what isn't there, without sudo:
   MinimalTube's own Python with Flask (in `~/.local/share/minimaltube/`) and its own ffmpeg
   and Deno.

   On both: the server runs on waitress (`python-waitress` / `python3-waitress`), which
   keeps long streams steady; without it, it falls back to Flask's built-in server. yt-dlp
   uses Deno to solve YouTube's player challenges.

   yt-dlp itself comes from pip: the installer (step 4) puts MinimalTube's own copy in
   `~/.local/share/minimaltube/`, and Settings → **Update yt-dlp** keeps it current without
   sudo. A yt-dlp installed system-wide is used only when that copy is missing; with neither,
   the server stops and says how to get it.

2. **A Chromium-based browser**, installed as a normal package, not as a Flatpak or Snap:
   their sandbox stops the extension from starting the server.

   - **Arch-based:** `chromium`, or `ungoogled-chromium-bin` from the AUR. Brave, Vivaldi
     and Google Chrome work too.
   - **Debian-based:** Google Chrome, Brave, Vivaldi or Microsoft Edge from their own
     `.deb` downloads, or Debian's `chromium` package. Ubuntu's `chromium` is a Snap.

3. **Load the extension:** open `chrome://extensions`, switch on *Developer mode*, click
   *Load unpacked* and pick this folder. Its ID is always
   `bnenkakahnieeabjicmgndndommgehje`, on every machine.

4. **Run the installer** (or double-click `install.sh`):

   ```bash
   ./install.sh
   ```

   It installs MinimalTube's own yt-dlp, lets the extension start the server by itself, and
   adds **MinimalTube** to your application menu.

5. **Reload the extension** on `chrome://extensions` and start MinimalTube from the
   application menu. The first start shows a short tour, then the keyboard shortcuts.

Run `./install.sh` again if you move this folder.

## Install (Windows 11)

1. **A Chromium-based browser:** Google Chrome, Microsoft Edge, Brave, Vivaldi or Chromium.
2. **Load the extension:** open `chrome://extensions` (`edge://extensions` in Edge), switch on
   *Developer mode*, click *Load unpacked* and pick this folder.
3. **Run the installer:** double-click `install.cmd`. If Windows says it protected your PC
   (the folder came from the internet), click *More info* → *Run anyway*.

   It needs no admin rights and changes nothing outside your user folder: MinimalTube's own
   Python, yt-dlp, ffmpeg and Deno go in `%LOCALAPPDATA%\MinimalTube` (about 200 MB, fetched
   the first time), the extension gets permission to start the server, and **MinimalTube** is
   added to the Start menu.
4. **Reload the extension** and start MinimalTube from the Start menu.

Run `install.cmd` again if you move this folder.

## Install (macOS)

1. **A Chromium-based browser** in Applications: Google Chrome, Brave, Microsoft Edge,
   Vivaldi or Chromium.
2. **Load the extension:** open `chrome://extensions`, switch on *Developer mode*, click
   *Load unpacked* and pick this folder.
3. **Run the installer:** double-click `install.command` (or run `./install.sh` in
   Terminal). If macOS won't open it because it came from the internet, right-click it →
   *Open* → *Open*.

   It needs no admin password: MinimalTube's own Python and yt-dlp go in
   `~/Library/Application Support/MinimalTube`, with ffmpeg and Deno from Homebrew when you
   have them and its own otherwise. The extension gets permission to start the server, and
   **MinimalTube** is added to `~/Applications` (Launchpad, Spotlight).
4. **Reload the extension** and open MinimalTube from Launchpad or Spotlight.

Run the installer again if you move this folder.

## Using it

- **Subscriptions / Playlists / Downloads** are the tabs of the browse page. Click a
  thumbnail to play; the player shrinks to a mini player while you browse (**I**).
- **The side panel** (**T**, or the list button at the top right) holds the queue and your downloads.
- **⋮ on any video or row** (or right-click it) for its actions; each has a letter shortcut key.
- **Settings** (⚙ or **,**) opens over the app: SponsorBlock, *Stream while downloading*,
  *Stream only*, *Open YouTube videos in MinimalTube*, YouTube history sync and *Remember
  queue* (the app then also comes back with the last video, paused where you left it).
  Switches apply right away. *Max … GB* sets how much space downloads may take.
  ★ shows the tour again; **i** shows the keyboard shortcuts.
- **The server's address** finds itself: port 7860, or the next free one (up to 7869) when
  another program already uses it.

## Where things are

On Linux:

| What | Where |
|---|---|
| Downloads, thumbnails, captions | `~/.cache/minimaltube/` |
| Playlists, subscriptions, collabs found in your YouTube feed, the order of your downloads, MinimalTube's own yt-dlp | `~/.local/share/minimaltube/` |
| Server log | `~/.cache/minimaltube/server.log` |
| Settings, queue, watch progress, the feed's memory | the browser's extension storage |
| The application-menu entry | `~/.local/share/applications/minimaltube.desktop` |
| What lets the extension start the server | `~/.config/<browser>/NativeMessagingHosts/com.minimaltube.host.json` |

On macOS and Windows:

| What | macOS | Windows |
|---|---|---|
| Downloads, thumbnails, captions, server log | `~/Library/Caches/MinimalTube/` | `%LOCALAPPDATA%\MinimalTube\Cache\` |
| Playlists, subscriptions, collabs found in your YouTube feed, the order of your downloads | `~/Library/Application Support/MinimalTube/` | `%APPDATA%\MinimalTube\` |
| MinimalTube's own Python, yt-dlp, ffmpeg and Deno | `~/Library/Application Support/MinimalTube/` | `%LOCALAPPDATA%\MinimalTube\` |
| The app | `~/Applications/MinimalTube.app` | Start menu → MinimalTube |
| What lets the extension start the server | `~/Library/Application Support/<browser>/NativeMessagingHosts/` | registry: `HKCU\Software\<browser>\NativeMessagingHosts\com.minimaltube.host` |

Downloads older than 60 days are removed together with their thumbnails, captions and other
saved info, thumbnails that nothing has shown for 60 days go too, and the downloads are kept
under 64 GB, the oldest going first. Change that size in Settings (*Max … GB*, 16 to 1024).

## Updating

YouTube changes often, so keep yt-dlp current: Settings → **Update yt-dlp** installs the
newest one (no sudo) and restarts the server. The rest updates with your system
(`sudo pacman -Syu` / `sudo apt upgrade`; on Debian-based, `deno upgrade` now and then).

After pulling new code, reload the extension on `chrome://extensions` and restart the server
so it runs the new code: Settings → **Restart server**. Or stop it by hand; the next
MinimalTube window starts it again:

```bash
pkill -f "server.py --host 127.0.0.1"
```

(A server you started by hand in a terminal stops with Ctrl+C there.)

On macOS and Windows, **Update yt-dlp** and **Restart server** work the same. To stop the
server by hand: on macOS the `pkill` line above; on Windows, end *python.exe* in Task Manager.
Running the installer again updates the server's Python packages too.

## Troubleshooting

- **"MinimalTube server isn't running":** check `~/.cache/minimaltube/server.log`, or
  start it by hand to see its errors:

  ```bash
  python3 server.py
  ```

- **Nothing happens from the application menu, or the server never starts:** Check the
  extensions ID. Copy it from `chrome://extensions` and run
  `./install.sh <extension-id>` (Windows: `install.cmd <extension-id>`) again. A Flatpak or
  Snap browser can't start the server. A browser installed after the installer ran needs the
  installer run once more.
- **macOS / Windows:** the server log is in the cache folder above (`server.log`).
- **A video won't play:** yt-dlp is probably out of date: Settings → **Update yt-dlp**.
- **Small errors that don't interrupt anything** are logged to the extension console:
  right-click the player → *Inspect* (or *service worker* on `chrome://extensions` for
  the background).

## For developers

- `manifest.json`, `background.js` (service worker), `youtube.js` (everything that reads
  YouTube's own data), `content-youtube.js` (buttons on youtube.com), `open.*` (where
  YouTube links land on their way to the app), `popup.*`.
- `player.html` + `js/`: the player, split by area. See `js/README.md`.
- `css/`: the stylesheets, built on the tokens in `css/tokens.css`. See `css/README.md`.
- `server.py` + `minimaltube/`: the server (its Python packages are in `requirements.txt`).
  See `minimaltube/README.md`.
- `minimaltube_host.py`: the native messaging host that starts the server.
- `install.py`: the installer, the same on every OS. `install.sh` (Linux, macOS; double-click
  `install.command` on macOS) and `install.cmd` + `install.ps1` (Windows) find or fetch the
  Python it runs with. What differs per OS at runtime (folders, PATH, starting the server, the
  file manager) is in `minimaltube/system.py`.
