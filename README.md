# MinimalTube

YouTube without the noise: your subscriptions, playlists and downloads in one calm player.

MinimalTube is a Chromium-based browser extension plus a small local Python server. The extension is the
app you see (opened as its own window from your application menu); the server uses yt-dlp
to fetch, download and stream videos. No YouTube page ever loads.

## What it does

- **Watch without the noise.** Any YouTube video plays ad-free in its own window,
  downloaded in the best quality so it's yours offline. On youtube.com, right-click a
  video or link → *Add to MinimalTube queue*, or paste a link in Settings.
- **Subscriptions.** Add channels by @handle or link; their new uploads arrive in one
  feed. Click a channel name to see only that channel's content. The latest 36 videos of up to 30 channels are remembered, so the feed
  and channel pages open instantly; new uploads slot in as they're found.
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
  playing, and everything (the feed, downloads, history and playlist syncs) catches up
  by itself when the connection is back.
- **Made for the keyboard.** Every list works with Tab, the arrow keys and Enter; every ⋮
  menu has letter shortcut keys. Press the **i** in Settings for all shortcuts.

## Install (Linux)

Arch-based and Debian-based distributions differ only in step 1 (and in where you get the
browser); everything after that is the same.

1. **Packages.**

   **Arch-based** (Arch, CachyOS, EndeavourOS, Manjaro):

   ```bash
   sudo pacman -S python python-flask python-flask-cors python-waitress yt-dlp ffmpeg deno
   ```

   **Debian-based** (Debian 12, Ubuntu 24.04 or newer, and the distributions built on them,
   such as Linux Mint 22):

   ```bash
   sudo apt install python3 python3-pip python3-flask python3-flask-cors python3-waitress ffmpeg curl unzip
   ```

   The yt-dlp in apt is usually too old for YouTube, so get the current one from pip
   (`[default]` brings the part that solves YouTube's player challenges). `--user` keeps it
   in your home folder; `--break-system-packages` is how pip allows that on these systems:

   ```bash
   pip install --user --break-system-packages -U "yt-dlp[default]"
   ```

   Deno isn't in the Debian / Ubuntu repositories. Its own installer, pointed at
   `~/.local`, puts it in `~/.local/bin`, where the server finds it:

   ```bash
   curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$HOME/.local" sh
   ```

   On both: the server runs on waitress (`python-waitress` / `python3-waitress`), which
   keeps long streams steady; without it, it falls back to Flask's built-in server. yt-dlp
   uses Deno to solve YouTube's player challenges.

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

   It lets the extension start the server by itself, and adds **MinimalTube** to your
   application menu.

5. **Reload the extension** on `chrome://extensions` and start MinimalTube from the
   application menu. The first start shows a short tour, then the keyboard shortcuts.

Run `./install.sh` again if you move this folder.

## Using it

- **Subscriptions / Playlists / Downloads** are the tabs of the browse page. Click a
  thumbnail to play; the player shrinks to a mini player while you browse (**I**).
- **The side panel** (**T**, or the list button at the top right) holds the queue and your downloads.
- **⋮ on any video or row** (or right-click it) for its actions; each has a letter shortcut key.
- **Settings** (⚙): add a link to the queue, the server address, SponsorBlock, *Remember
  queue*, YouTube history sync, *Stream while downloading* and *Stream only*. ★ shows
  the tour again; **i** shows the keyboard shortcuts.

## Where things are (Linux)

| What | Where |
|---|---|
| Downloads, thumbnails, captions, playlists, subscriptions | `~/.cache/minimaltube/` |
| Server log | `~/.cache/minimaltube/server.log` |
| Settings, queue, watch progress, the feed's memory | the browser's extension storage |
| The application-menu entry | `~/.local/share/applications/minimaltube.desktop` |
| What lets the extension start the server | `~/.config/<browser>/NativeMessagingHosts/com.minimaltube.host.json` |

Downloads older than 60 days are removed, and the folder is kept under 64 GB
(`minimaltube/config.py`).

## Updating (Linux)

YouTube changes often, so keep yt-dlp current:

- **Arch-based:** `sudo pacman -Syu`
- **Debian-based:** `pip install --user --break-system-packages -U "yt-dlp[default]"`
  (and `deno upgrade` now and then)

After pulling new code, reload the extension on `chrome://extensions`. After updating
yt-dlp or anything in the server, restart the server so it runs the new code; the next
MinimalTube window starts it again:

```bash
pkill -f "server.py --host 127.0.0.1 --port 7860"
```

(A server you started by hand in a terminal stops with Ctrl+C there.)

## Troubleshooting (Linux)

- **"MinimalTube server isn't running":** check `~/.cache/minimaltube/server.log`, or
  start it by hand to see its errors:

  ```bash
  python3 server.py
  ```

- **Nothing happens from the application menu, or the server never starts:** Check the
  extensions ID. Copy it from `chrome://extensions` and run
  `./install.sh <extension-id>` again. A Flatpak or Snap browser can't start the server.
- **A video won't play:** yt-dlp is probably out of date: update it (see *Updating*) and
  restart the server.
- **Small errors that don't interrupt anything** are logged to the extension console:
  right-click the player → *Inspect* (or *service worker* on `chrome://extensions` for
  the background).

## For developers

- `manifest.json`, `background.js` (service worker), `youtube.js` (everything that reads
  YouTube's own data), `content-youtube.js` (buttons on youtube.com), `popup.*`.
- `player.html` + `js/`: the player, split by area. See `js/README.md`.
- `css/`: the stylesheets, built on the tokens in `css/tokens.css`. See `css/README.md`.
- `server.py` + `minimaltube/`: the server (its Python packages are in `requirements.txt`).
  See `minimaltube/README.md`.
- `minimaltube_host.py` + `install.sh`: the native messaging host that starts the server,
  and its installer (for Linux).
