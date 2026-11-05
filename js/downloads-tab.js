/* MinimalTube player - Default window size, the Downloads tab and the default page.
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
  chrome.storage.local.remove("windowSizeApplied"); // older versions sized only the first window
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
 * Downloads tab + default page
 * ===================================================================== */
const dlView = byId("dlView"),
  dlGrid = byId("dlGrid");
function fmtSize(bytes) {
  if (!bytes || !isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0,
    size = bytes;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : Math.round(size * 10) / 10} ${units[unit]}`;
}
function paintDlBadge(badge, entry) {
  const state = entry.status;
  badge.classList.toggle("prog", isActiveEntry(entry));
  badge.textContent =
    state === "downloading"
      ? `${Math.round(entry.percent ?? 0)}%`
      : state === "merging"
        ? "Merging…"
        : state === "waiting"
          ? "Paused"
          : state === "queued"
          ? "Queued"
          : entry.duration
            ? fmtDur(entry.duration)
            : ""; // video length (the size is in the line below)
  badge.style.display = badge.textContent ? "" : "none";
}
function refreshDownloadBadges() {
  dlGrid
    .querySelectorAll(".vCard")
    .forEach(
      (el) => el._entry && el._badge && paintDlBadge(el._badge, el._entry),
    );
}
function downloadVideoObj(entry) {
  const url = entry.url || `https://www.youtube.com/watch?v=${entry.id}`;
  return {
    id: entry.id,
    title: entry.title || url,
    url,
    thumbnail: `${serverBase}/thumb/${entry.id}`,
    // stored by the server, so it also shows offline
    thumbFallback: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
    downloaded: !entry.status || entry.status === "ready",
  };
}
function playDownload(entry) {
  exitBrowse();
  playLibraryEntry(entry);
}
function downloadMenuEntries(entry, anchor) {
  const v = downloadVideoObj(entry);
  return [
    {
      label: "Play",
      key: "P",
      icon: ICON_PLAY,
      onClick: () => playDownload(entry),
    },
    saveToEntry(anchor, videoItem(v)),
    addNextEntry(v),
    ...libraryMenuEntries(entry), // Delete / Cancel download
  ];
}
function makeDownloadCard(entry) {
  const v = downloadVideoObj(entry);
  const card = makeCard({
    thumb: v.thumbnail,
    fallback: v.thumbFallback,
    videoId: entry.id,
    badge: "",
    title: entry.title || `${entry.id} (looking up title…)`,
    lines: [
      isActiveEntry(entry)
        ? activeEntryText(entry)
        : ["Downloaded", fmtSize(entry.size)].filter(Boolean).join(" · "),
    ],
    open: () => playDownload(entry),
    menu: (anchor) => downloadMenuEntries(entry, anchor),
    className: entry.id === currentVideoId ? "playing" : "",
  });
  card.dataset.vid = entry.id;
  card._entry = entry;
  paintDlBadge(card._badge, entry);
  return card;
}
function renderDownloadCards() {
  if (
    !document.body.classList.contains("browsing") ||
    browseTab !== "downloads"
  )
    return;
  if (bpMenuAnchor && dlGrid.contains(bpMenuAnchor)) closeBpMenu();
  dlGrid.innerHTML = "";
  if (!library.length) {
    const empty = document.createElement("div");
    empty.className = "bpEmpty";
    empty.textContent =
      "No downloads yet. Use ⋮ on any video → Download, or Download all in the queue.";
    dlGrid.appendChild(empty);
    return;
  }
  library.forEach((entry) => dlGrid.appendChild(makeDownloadCard(entry)));
}
makeGridSortable(
  dlGrid,
  ".vCard[data-vid]",
  () => library.length > 1,
  moveLibraryItem,
);

// Queue / settings are one click away from the browse page.
// They open the side panels on top of the page the user is on (no switch to the player).
const bpQueueBtn = byId("bpQueueBtn"),
  bpSettingsBtn = byId("bpSettingsBtn");
function setBpTop() {
  document.documentElement.style.setProperty(
    "--bpTop",
    `${byId("browseTop").offsetHeight}px`,
  );
}
window.addEventListener("resize", setBpTop);
bpQueueBtn.addEventListener("click", () => {
  setBpTop();
  closeSettings();
  queueToggleBtn.click();
});
bpSettingsBtn.addEventListener("click", () => {
  setBpTop();
  closeQueuePanel();
  gearBtn.click();
});
const syncBpButtons = () => {
  resetStrayScroll();
  bpQueueBtn.classList.toggle("active", queuePanel.classList.contains("open"));
  const queueOpen =
    queuePanel.classList.contains("open") &&
    document.body.classList.contains("browsing");
  if (queueOpen)
    document.documentElement.style.setProperty(
      "--bpQueueW",
      `${queuePanel.offsetWidth}px`,
    );
  document.body.classList.toggle("queueOpen", queueOpen);
  bpSettingsBtn.classList.toggle(
    "active",
    settingsPanel.classList.contains("open"),
  );
};
[queuePanel, settingsPanel].forEach((el) =>
  new MutationObserver(syncBpButtons).observe(el, {
    attributes: true,
    attributeFilter: ["class"],
  }),
);
byId("placeholderBrowse").addEventListener("click", () => enterBrowse());

/**
 * Loads again what the page shows from the server (saved playlists, Downloads, download
 * progress, the Subscriptions feed when it's open): for a server that has just (re)started.
 */
function reloadFromServer() {
  loadSavedPlaylists();
  refreshLibrary();
  pollDownloadsSoon();
  if (document.body.classList.contains("browsing") && browseTab === "subs")
    loadSubscriptions().then(() => showFeed());
}
// Opened straight from the app menu, the server may not be running yet: the extension starts it
// (native host), and what loaded before it answered loads again. The extension also finds it on
// whichever of its ports it runs (and remembers that as serverBase): the player follows.
chrome.runtime.sendMessage({ type: "minimaltube-ensure-server" }, (res) => {
  if (chrome.runtime.lastError || !res || !res.ok) return;
  const moved = !!res.serverBase && res.serverBase !== serverBase;
  if (moved) serverBase = res.serverBase;
  if (moved || res.started) whenLoaded(reloadFromServer);
});
chrome.storage.onChanged.addListener((changes, area) => {
  const base = area === "local" && changes.serverBase && changes.serverBase.newValue;
  if (!base || base === serverBase) return;
  serverBase = base;
  whenLoaded(reloadFromServer);
});

// Default page: Subscriptions - unless a video is being opened (from YouTube / the popup).
if (!new URLSearchParams(window.location.search).get("url")) {
  playerFrame.classList.add("empty"); // nothing loaded yet, so no empty mini window
  enterBrowse(true);
}

bpDlInd.addEventListener("click", () => setBrowseTab("downloads"));
