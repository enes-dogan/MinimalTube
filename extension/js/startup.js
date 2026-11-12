/* MinimalTube player - Starting up: the window's size and place, what the rest of the extension asks
 * of the player, and opening whatever the player was started for. This file runs last.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Window size and place
 *
 * Every new player window opens with a 16:9 page 3/4 as wide as the main
 * screen (1200x675 on a 1600x1000 screen, 1440x810 on 1920x1080), plus its
 * title bar, in the middle of that screen. On a screen too short for that
 * (ultrawide) the whole window is kept to 4/5 of the screen's height, still
 * 16:9. Chromium restores an app window's last size by itself, and that
 * drifts on some systems (on Wayland the window comes back a little taller
 * each launch until it runs under the taskbar), so this runs for each new
 * app/popup window, not just the first. Wayland doesn't let apps place their
 * windows: there the desktop picks the spot, and only the size applies.
 * A window that comes back maximized or fullscreen is left that way; opening
 * another video in the same window keeps whatever size you gave it; a normal
 * browser tab is never touched. New popup windows opened by the extension
 * start at the stored size too.
 * ===================================================================== */
(function initWindowSize() {
  if (!chrome.windows || !chrome.windows.getCurrent) return;
  // this tab's storage outlives a reload or another video opened in it, not the window
  try {
    if (sessionStorage.getItem("windowPlaced")) return;
    sessionStorage.setItem("windowPlaced", "1");
  } catch {}
  placeWindow().catch((err) => console.warn("MinimalTube (window size):", err));
})();

async function placeWindow() {
  const win = await chrome.windows.getCurrent();
  if (!win || win.type === "normal" || win.state === "maximized" || win.state === "fullscreen") return;
  const area = await mainScreenArea();
  let zoom = 1;
  try {
    zoom = (await chrome.tabs.getZoom()) || 1;
  } catch {}
  const page = () => ({ w: window.innerWidth * zoom, h: window.innerHeight * zoom }); // in screen pixels
  // what the window adds around the page (title bar, borders); kept sane in case the page isn't laid out yet
  const frameW = Math.min(40, Math.max(0, win.width - page().w)),
    frameH = Math.min(120, Math.max(0, win.height - page().h));
  const w = Math.round(Math.min(area.width * 0.75, ((area.height * 0.8 - frameH) * 16) / 9)),
    h = Math.round((w * 9) / 16);
  let width = Math.round(w + frameW),
    height = Math.round(h + frameH);
  const centred = () => ({
    width,
    height,
    left: Math.round(area.left + (area.width - width) / 2),
    top: Math.round(area.top + (area.height - height) / 2),
  });
  // already there (Chromium reopened it where it saved it): nothing to move
  const there = (b) => ["width", "height", "left", "top"].every((k) => Math.abs(win[k] - b[k]) <= 2);
  if (!there(centred())) await moveWindow(win.id, centred());
  // some systems add or take a few pixels: measure the page again and make up the difference once
  await new Promise((resolve) => setTimeout(resolve, 400));
  const dw = Math.round(w - page().w),
    dh = Math.round(h - page().h);
  if (Math.abs(dw) > 2 || Math.abs(dh) > 2) {
    const now = await chrome.windows.get(win.id);
    if (now.state !== "normal") return;
    width += dw;
    height += dh;
    await moveWindow(win.id, centred());
  }
  chrome.storage.local.set({ windowSize: centred() }); // read by background.js for new popup windows
}

// The main screen's usable area (without the taskbar, where the system says where that is)
async function mainScreenArea() {
  try {
    const displays = await chrome.system.display.getInfo();
    const main = displays.find((d) => d.isPrimary) || displays[0];
    if (main && main.workArea && main.workArea.width) return main.workArea;
  } catch {} // the extension wasn't reloaded since it got that permission: the window's own screen
  return {
    left: screen.availLeft || 0,
    top: screen.availTop || 0,
    width: screen.availWidth || screen.width || 1920,
    height: screen.availHeight || screen.height || 1080,
  };
}

async function moveWindow(id, bounds) {
  const size = { state: "normal", width: bounds.width, height: bounds.height };
  try {
    await chrome.windows.update(id, { ...size, left: Math.round(bounds.left), top: Math.round(bounds.top) });
  } catch {
    await chrome.windows.update(id, size); // some window managers refuse the position: the size alone
  }
}

/* =====================================================================
 * What the rest of the extension asks of a running player (background.js)
 * ===================================================================== */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const type = message && message.type;
  let run = null;
  if (type === "minimaltube-queue-add" && message.url) run = () => addUrlToQueue(message.url);
  else if (type === "minimaltube-play-now" && message.url) run = () => playLinkNow(message.url);
  else if (type === "minimaltube-take-playlist" && message.playlist) run = () => takeYouTubePlaylist(message.playlist);
  else if (type === "minimaltube-subscriptions-imported") run = () => subscriptionsImported(message.result);
  if (!run) return;
  whenLoaded(run);
  respond({ ok: true });
});

/* =====================================================================
 * Start: the settings first, then whatever the player was opened for
 *   player.html                 the browse page (and, with "Remember queue", the queue as it was)
 *   player.html?url=<link>      that video or playlist
 *   player.html?url=..&pid=..   the same, with a playlist read from a YouTube page: the
 *                               background left it in storage under `pid` (too big for an address)
 * ===================================================================== */
chrome.storage.local.get(["serverBase", "captionsEnabled", ...SETTINGS.map((setting) => setting.key)], (stored) =>
  whenLoaded(() => {
    loadSettings(stored);
    if (stored.serverBase) serverBase = stored.serverBase;
    if (stored.captionsEnabled !== undefined) captionsWanted = stored.captionsEnabled;
    const params = new URLSearchParams(window.location.search),
      openUrl = params.get("url"),
      playlistKey = params.get("pid");
    if (playlistKey)
      chrome.storage.local.get([playlistKey], (found) => {
        chrome.storage.local.remove(playlistKey);
        const playlist = found[playlistKey];
        openAtStart(openUrl, playlist && Array.isArray(playlist.items) && playlist.items.length ? playlist : null);
      });
    else openAtStart(openUrl, null);
    refreshLibrary();
  }),
);
async function openAtStart(openUrl, playlist) {
  if (playlist && playlist.savePrompt) {
    // a YouTube playlist page's button: its videos become the queue, with the offer to save them
    takeYouTubePlaylist(playlist);
    if (document.body.classList.contains("browsing")) setBrowseTab(browseTab);
    return;
  }
  // With "Remember queue" on, the saved queue comes back first, so anything opened from YouTube
  // goes in below it, not over it.
  const saved = rememberQueue ? await loadSavedQueue() : null,
    hasSaved = !!(saved && saved.items && saved.items.length);
  if (playlist) {
    if (hasSaved) appendToSavedQueue(saved, playlist, openUrl);
    else {
      setQueue(playlist.items, { index: playlist.currentIndex });
      if (openUrl) playVideo(openUrl);
    }
  } else if (openUrl) {
    if (hasSaved) restoreSavedQueue(saved);
    // a video opened from YouTube plays either way: beside a playlist queue, not in it
    if (queueLockedReason() && !playlistIdFromUrl(openUrl)) playVideoNow({ url: openUrl, title: openUrl });
    else addUrlToQueue(openUrl);
  } else {
    if (hasSaved) {
      restoreSavedQueue(saved);
      resumeSavedVideo();
    }
    setTimeout(() => document.body.classList.contains("browsing") && setBrowseTab(browseTab), 0);
    maybeWelcome();
  }
}

// The extension finds the server on whichever of its ports it runs (core.js: serverReady) and
// remembers that as serverBase; when it turns up somewhere else later, the player follows.
chrome.storage.onChanged.addListener((changes, area) => {
  const base = area === "local" && changes.serverBase && changes.serverBase.newValue;
  if (!base || base === serverBase) return;
  serverBase = base;
  whenLoaded(reloadFromServer);
});

byId("pasteHint").textContent = PASTE_KEYS.join("+");

// Default page: Subscriptions - unless a video is being opened (from YouTube / the popup).
if (!new URLSearchParams(window.location.search).get("url")) {
  playerFrame.classList.add("empty"); // nothing loaded yet, so no empty mini window
  enterBrowse(true);
}
