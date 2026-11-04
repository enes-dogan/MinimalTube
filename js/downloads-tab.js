/* MinimalTube player - Default window size, the Downloads tab and the default page.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Default window size, relative to the screen
 *
 * 2/3 of the screen width x 5/6 of its height = 1280x900 on a 1920x1080
 * monitor, and the same proportions on any other screen. Chromium remembers
 * an app window's last size and ignores --window-size afterwards, so the
 * default is applied once to the existing app/popup window (never to a normal
 * browser tab). After that the window keeps whatever size you give it.
 * New popup windows opened by the extension use the stored size too.
 * ===================================================================== */
(function initWindowSize() {
  if (!chrome.windows || !chrome.windows.getCurrent) return;
  const sw = screen.width || 1920,
    sh = screen.height || 1080,
    aw = screen.availWidth || sw,
    ah = screen.availHeight || sh;
  const width = Math.round(
      Math.max(Math.min(900, aw), Math.min(sw * (2 / 3), aw)),
    ),
    height = Math.round(
      Math.max(Math.min(600, ah), Math.min(sh * (5 / 6), ah)),
    );
  chrome.storage.local.get(["windowSizeApplied"], (st) => {
    chrome.storage.local.set({
      windowSize: {
        width,
        height,
      },
    }); // read by background.js
    if (st && st.windowSizeApplied) return;
    chrome.windows.getCurrent((win) => {
      if (chrome.runtime.lastError || !win || win.type === "normal") return;
      const left = Math.round((screen.availLeft || 0) + (aw - width) / 2),
        top = Math.round((screen.availTop || 0) + (ah - height) / 2);
      const done = () =>
        chrome.storage.local.set({
          windowSizeApplied: 1,
        });
      chrome.windows.update(
        win.id,
        {
          state: "normal",
          width,
          height,
          left,
          top,
        },
        () => {
          if (!chrome.runtime.lastError) return done();
          // some window managers reject the position: size alone is what matters
          chrome.windows.update(
            win.id,
            {
              state: "normal",
              width,
              height,
            },
            () => {
              if (!chrome.runtime.lastError) done();
            },
          );
        },
      );
    });
  });
})();

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
    {
      label: "Add next to queue",
      key: "Q",
      icon: ICON_NEXT,
      onClick: () => queueVideoNext(v),
    },
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
// (native host), and what loaded before it answered loads again.
chrome.runtime.sendMessage({ type: "minimaltube-ensure-server" }, (res) => {
  if (chrome.runtime.lastError || !res || !res.started) return;
  whenLoaded(reloadFromServer);
});

// Default page: Subscriptions - unless a video is being opened (from YouTube / the popup).
if (!new URLSearchParams(window.location.search).get("url")) {
  playerFrame.classList.add("empty"); // nothing loaded yet, so no empty mini window
  enterBrowse(true);
}

bpDlInd.addEventListener("click", () => setBrowseTab("downloads"));
