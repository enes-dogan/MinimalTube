/* MinimalTube player - The browse page and mini player, formatting helpers, the browse page's ⋮ menu (shared menu
 * renderer and popup positioning), right-click menus and the feed's video cards.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Mini player + browse page (Subscriptions / Playlists / Downloads)
 *
 * The button left of fullscreen shrinks the player into a small floating
 * window (same <video>, so playback never restarts) and shows the browse page:
 * the subscriptions feed, the saved playlists and the downloads.
 * ===================================================================== */
const browseBody = byId("browseBody"),
  browseTabBtns = Array.from(document.querySelectorAll("#browseTabs button")),
  subsView = byId("subsView"),
  plView = byId("plView"),
  feedGrid = byId("feedGrid"),
  feedStatus = byId("feedStatus"),
  subAddInput = byId("subAddInput"),
  subAddBtn = byId("subAddBtn"),
  subChips = byId("subChips"),
  subFocus = byId("subFocus"),
  subsToggle = byId("subsToggle"),
  subsToggleCount = byId("subsToggleCount"),
  subImportBtn = byId("subImportBtn"),
  feedRefresh = byId("feedRefresh"),
  plGrid = byId("plGrid"),
  miniToggle = byId("miniToggle"),
  miniExpand = byId("miniExpand");
const FEED_LIMIT = 24, // videos per "load more"
  FEED_BG_REFRESH_MS = 2 * 60 * 1000, // a channel fetched longer ago is asked again when shown
  FEED_CHANNEL_MAX = 36, // videos remembered per channel
  FEED_CHANNELS_KEPT = 30; // channels remembered
let browseTab = "subs",
  subscriptions = [],
  subsLoaded = false;
// The feed on screen: which view (`key`: "all" / "ch:<id>"), its videos (newest first), and per
// channel the upload time they're complete down to (`bounds`; 0 = all of its videos).
const feedState = {
  key: null,
  channels: "",
  items: [],
  bounds: new Map(),
  offline: false,
  loading: false,
  failed: false,
  loaded: false,
  epoch: 0,
  serverError: null,
};

// While the browse page is up, the queue panel (and the save-playlist dialog) are moved out of the
// (small / hidden) player frame so the two buttons of the browse page can open them right on
// top of the page; they go back into the player when it is expanded again.
const panelHomes = [queuePanel, byId("savePlModal")].map(
  (el) => ({
    el,
    parent: el.parentNode,
    next: el.nextSibling,
  }),
);
function floatPanels(on) {
  panelHomes.forEach(({ el, parent, next }) => {
    el.classList.toggle("bpFloat", on);
    if (on) document.body.appendChild(el);
    else
      parent.insertBefore(el, next && next.parentNode === parent ? next : null);
  });
}
const FRAME_ANIM_MS = 300;
function frameRect() {
  if (
    document.fullscreenElement ||
    playerFrame.classList.contains("empty") ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return null;
  const rect = playerFrame.getBoundingClientRect();
  return rect.width && rect.height ? rect : null;
}
function animateFrameFrom(from) {
  if (!from) return;
  const to = playerFrame.getBoundingClientRect();
  if (!to.width || !to.height) return;
  const toMini = playerFrame.classList.contains("mini");
  playerFrame.animate(
    [
      {
        transformOrigin: "top left",
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        borderRadius: toMini ? "0px" : "12px",
      },
      {
        transformOrigin: "top left",
        transform: "none",
        borderRadius: toMini ? "12px" : "0px",
      },
    ],
    { duration: FRAME_ANIM_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  );
  if (toMini)
    document.getElementById("browsePage").animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: FRAME_ANIM_MS,
      easing: "ease-out",
    });
}
function enterBrowse(noLoad) {
  const from = document.body.classList.contains("browsing") ? null : frameRect();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  closeQueuePanel();
  closeSettings();
  floatPanels(true);
  refreshWatchBars();
  closeDesc();
  closeRowMenu();
  document.body.classList.add("browsing");
  playerFrame.classList.add("mini");
  playerFrame.classList.remove("idle");
  animateFrameFrom(from);
  if (noLoad !== true) setBrowseTab(browseTab);
}
function exitBrowse() {
  playerFrame.classList.remove("tucked");
  const from = document.body.classList.contains("browsing") ? frameRect() : null;
  closeBpMenu();
  closeQueuePanel();
  closeSettings();
  floatPanels(false);
  document.body.classList.remove("browsing");
  playerFrame.classList.remove("mini");
  animateFrameFrom(from);
}
miniToggle.addEventListener("click", () => enterBrowse());
miniExpand.addEventListener("click", exitBrowse);
// Don't let a click on the mini window's buttons also toggle play/pause.
[miniExpand].forEach((item) =>
  item.addEventListener("dblclick", (event) => event.stopPropagation()),
);
// Each tab keeps its own place on the page: they share one scrolling area
const tabScroll = {};
function setBrowseTab(tab) {
  if (tab !== "playlists") closePlaylistPage();
  const switching = tab !== browseTab;
  if (switching) tabScroll[browseTab] = browseBody.scrollTop;
  browseTab = tab;
  browseTabBtns.forEach((item) =>
    item.classList.toggle("active", item.dataset.tab === tab),
  );
  subsView.classList.toggle("active", tab === "subs");
  plView.classList.toggle("active", tab === "playlists");
  dlView.classList.toggle("active", tab === "downloads");
  closeBpMenu();
  if (tab === "subs") {
    feedMemoryReady.then(() => feedState.loaded || showFeed(false)); // before the server answers
    loadSubscriptions().then(() => showFeed());
  } else if (tab === "playlists") {
    renderPlaylistCards();
    loadSavedPlaylists();
  } else {
    renderDownloadCards();
    refreshLibrary(); // refresh the list from the server
  }
  if (switching) browseBody.scrollTop = tabScroll[tab] || 0;
}
browseTabBtns.forEach((item) =>
  item.addEventListener("click", () => {
    if (item.dataset.tab === "playlists" && browseTab === "playlists")
      closePlaylistPage();
    setBrowseTab(item.dataset.tab);
  }),
);

/* ---------- formatting ---------- */
function fmtDur(sec) {
  if (!isFinite(sec) || sec == null) return "";
  sec = Math.floor(sec);
  const hours = Math.floor(sec / 3600),
    minutes = Math.floor((sec % 3600) / 60),
    seconds = String(sec % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}
/**
 * A count the way YouTube shortens it: 1234 → "1.2K views", 15300000 → "15.3M views".
 * @param {number|null} count The number; null / not finite gives "".
 * @param {string} noun What is counted, singular ("view", "subscriber"); an "s" is added.
 * @returns {string}
 */
function fmtCount(count, noun) {
  if (count == null || !isFinite(count)) return "";
  const fmt = (v, u) =>
    `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)}${u}`;
  if (count >= 1e9) return `${fmt(count / 1e9, "B")} ${noun}s`;
  if (count >= 1e6) return `${fmt(count / 1e6, "M")} ${noun}s`;
  if (count >= 1e3) return `${fmt(count / 1e3, "K")} ${noun}s`;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function fmtViews(count) {
  return fmtCount(count, "view");
}
function timeAgo(ts) {
  if (!ts) return "";
  const ago = Math.max(0, Date.now() / 1000 - ts);
  if (ago < 3600) return `${Math.max(1, Math.floor(ago / 60))}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  if (ago < 86400 * 30) return `${Math.floor(ago / 86400)}d ago`;
  if (ago < 86400 * 365) return `${Math.floor(ago / (86400 * 30))}mo ago`;
  return `${Math.floor(ago / (86400 * 365))}y ago`;
}

/* ---------- popover menu ---------- */
const bpMenu = document.createElement("div");
bpMenu.id = "bpMenu";
document.body.appendChild(bpMenu);
let bpMenuAnchor = null;
let bpDotsTimer = null;
const DOT_FRAMES = ["...", "..", "."]; // three, two, one

function closeBpMenu() {
  bpMenu._keys = null;
  clearInterval(bpDotsTimer);
  bpMenu.classList.remove("open");
  bpMenu.innerHTML = "";
  bpMenuAnchor = null;
}
function showBpMenu(anchor, entries) {
  closeSaveToMenu(); // another card's ⋮: the "Save to" list of the last one goes
  clearInterval(bpDotsTimer);
  menuReopen = () => showBpMenu(anchor, entries);
  bpDotsTimer = fillMenu(bpMenu, entries, closeBpMenu);
  bpMenuAnchor = anchor;
  placePopup(bpMenu, anchor, null);
}
// One renderer for both ⋮ menus (#bpMenu over the page, #rowMenu in the side panel). Entries:
// {label, icon, key, danger, disabled, dots, keepOpen, cls, refuse, onClick} or {separator: true};
// a letter key picks an item (menuKeysFor). `refuse()` returns why the item can't run right now
// (or nothing): then the menu stays open and the item turns red. Returns the timer of animated
// "…" dots, if any.
function fillMenu(menu, entries, close) {
  menu.innerHTML = "";
  entries = entries.filter(Boolean);
  const keys = menuKeysFor(entries.filter((entry) => !entry.separator));
  menu._keys = new Map();
  const dotEls = [];
  entries.forEach((entry) => {
    if (entry.separator) return menu.appendChild(el("div", "bpSep"));
    const item = el("button", "rowMenuItem" + (entry.danger ? " danger" : "") + (entry.cls ? ` ${entry.cls}` : ""));
    item.type = "button";
    item.disabled = !!entry.disabled;
    item.innerHTML = entry.icon || "";
    const label = el("span", null, entry.label);
    if (entry.dots) {
      const dots = el("span", "dots", DOT_FRAMES[0]);
      label.appendChild(dots);
      dotEls.push(dots);
    }
    item.appendChild(label);
    addMenuKey(menu, item, keys.get(entry));
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      if (entry.disabled) return;
      const refusal = entry.refuse && entry.refuse();
      if (refusal) return refuseMenuItem(item, refusal);
      if (!entry.keepOpen) close();
      if (entry.onClick) entry.onClick();
    });
    menu.appendChild(item);
  });
  menu.classList.add("open");
  if (!dotEls.length) return 0;
  let frame = 0;
  return setInterval(() => {
    frame = (frame + 1) % DOT_FRAMES.length;
    dotEls.forEach((dots) => (dots.textContent = DOT_FRAMES[frame]));
  }, 450);
}
function refuseMenuItem(item, reason) {
  restartAnimation(item, "refused");
  clearTimeout(item._refusedTimer);
  item._refusedTimer = setTimeout(() => item.classList.remove("refused"), 1800);
  notify(reason, true, 5000);
}
// Puts a popup next to the button it belongs to (above it when there's no room below), within
// `container` or the window; menus opened by right-click appear at the pointer instead.
function placePopup(popup, anchor, container) {
  const box = container
      ? container.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
    width = popup.offsetWidth,
    height = popup.offsetHeight;
  let left, top;
  if (anchor === menuPoint) {
    left = parseFloat(menuPoint.style.left) - box.left;
    top = parseFloat(menuPoint.style.top) - box.top;
    if (top + height > box.height - 8) top = Math.max(8, top - height);
  } else {
    const rect = anchor.getBoundingClientRect();
    left = rect.right - box.left - width + 6;
    top = rect.bottom - box.top + 4;
    if (top + height > box.height - 8) top = Math.max(8, rect.top - box.top - height - 4);
  }
  popup.style.left = `${Math.max(8, Math.min(left, box.width - width - 8))}px`;
  popup.style.top = `${top}px`;
}
function makeMenuButton(getEntries) {
  const btn = document.createElement("button");
  btn.className = "vMenuBtn";
  btn.title = "More";
  btn.innerHTML = ICON_DOTS;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (bpMenuAnchor === btn && bpMenu.classList.contains("open"))
      return closeBpMenu();
    showBpMenu(btn, getEntries(btn));
  });
  btn.addEventListener("mousedown", (event) => event.stopPropagation());
  btn._openMenu = (anchor) => showBpMenu(anchor, getEntries(anchor));
  return btn;
}
addLayer({
  el: bpMenu,
  level: 2,
  isOpen: () => bpMenu.classList.contains("open"),
  close: closeBpMenu,
  inside: [".vMenuBtn"],
  items: ".rowMenuItem:not(:disabled)",
});
document.addEventListener(
  "keydown",
  (event) => {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.repeat ||
      isTypingTarget(event.target) ||
      !/^Key[A-Z]$/.test(event.code)
    )
      return;
    const menu = [bpMenu, rowMenu].find(
      (el) => el._keys && el.classList.contains("open"),
    );
    if (!menu) return;
    const item = menu._keys.get(event.code.slice(3));
    if (!item) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!item.disabled) item.click();
  },
  true,
);
browseBody.addEventListener("scroll", closeBpMenu, {
  passive: true,
});
window.addEventListener("resize", closeBpMenu);

/* ---------- "Back to top": past about five rows of cards, scrolls the page back up ---------- */
const backToTop = byId("backToTop"),
  BACK_TO_TOP_ROWS = 5;
let backToTopFrame = 0;
function cardRowHeight() {
  const card = [...browseBody.querySelectorAll(".bpView.active .vCard")].find((c) => c.offsetHeight);
  if (!card) return 280;
  return card.offsetHeight + (parseFloat(getComputedStyle(card.parentElement).rowGap) || 0);
}
browseBody.addEventListener(
  "scroll",
  () => {
    if (backToTopFrame) return;
    backToTopFrame = requestAnimationFrame(() => {
      backToTopFrame = 0;
      browseBody.classList.toggle("scrolled", browseBody.scrollTop > 0); // the sticky bars' shadow
      backToTop.classList.toggle("show", browseBody.scrollTop > BACK_TO_TOP_ROWS * cardRowHeight());
    });
  },
  { passive: true },
);
// the sticky bar's real height (it wraps on a narrow window), for browse.css's scroll-padding
const stickyBars = [byId("subsBar"), byId("plHead")],
  stickyBarsSize = new ResizeObserver(() =>
    browseBody.style.setProperty("--stickyH", `${Math.max(...stickyBars.map((bar) => bar.offsetHeight))}px`),
  );
stickyBars.forEach((bar) => stickyBarsSize.observe(bar));
backToTop.addEventListener("click", () => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  browseBody.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
});

/* ---------- right-click opens the same menu as the card's / row's ⋮ button ---------- */
const menuPoint = document.createElement("div");
menuPoint.style.cssText =
  "position:fixed;width:0;height:0;pointer-events:none;visibility:hidden";
document.body.appendChild(menuPoint);
document.addEventListener("contextmenu", (event) => {
  const item = event.target.closest && event.target.closest(".vCard, .plItem");
  const btn = item && item.querySelector(".vMenuBtn, .plMenuBtn");
  if (!btn || !btn._openMenu || isTypingTarget(event.target)) return;
  event.preventDefault();
  menuPoint.style.left = `${event.clientX}px`;
  menuPoint.style.top = `${event.clientY}px`;
  btn._openMenu(menuPoint);
});

/* ---------- video actions (feed cards) ---------- */
const videoItem = (chapter) => ({
  id: chapter.id,
  title: chapter.title,
  url: chapter.url,
  duration: chapter.duration || undefined,
});

// A YouTube link opened in the browser (background.js): it plays now, like a card's Play.
function playLinkNow(url) {
  const id = videoIdFromUrl(url);
  if (id && id === currentVideoId && !playerFrame.classList.contains("empty")) return exitBrowse();
  playVideoNow({ id, url, title: url });
}
// Play right away: it goes in right after the current queue item, so the queue carries on after it.
function playVideoNow(v) {
  const item = videoItem(v);
  exitBrowse();
  if (queueLockedReason()) {
    // the queue is a saved playlist, so this one plays on the side, outside it; "Up next" then
    // takes the playlist up where it was left (resolveNext)
    playSource = "detour";
    updateSkipButtons();
    playVideo(item.url);
    return;
  }
  if (!queue || !queue.items.length) {
    appendToQueue([item]);
    return;
  }
  const at = queueIndex >= 0 ? queueIndex + 1 : queue.items.length;
  queue.items.splice(at, 0, item);
  queue.items.forEach((other, index) => (other.index = index + 1));
  playSource = "queue";
  queueIndex = at;
  resetDownloadAllButton();
  renderQueue();
  markActiveQueueRow();
  scrollActiveQueueRowIntoView();
  startQueuePolling();
  prefetchNextInQueue();
  saveQueue();
  playVideo(item.url);
}
/**
 * Why videos can't be added to the queue right now: a queue loaded from a saved playlist is that
 * playlist (its changes are saved to it), so adding a video there would add it to the playlist.
 * @returns {string|null} The message to show, or null when adding is fine.
 */
function queueLockedReason() {
  if (!queue || !queue.playlistId || !queue.items.length) return null;
  const pl = savedPlaylists.find((playlist) => playlist.id === queue.playlistId);
  return `${pl ? `"${pl.name}"` : "A"} playlist is open. Clear queue first to add videos to it.`;
}
/**
 * The ⋮ menus' "Add next to queue" for a video. While a saved playlist is in the queue it
 * refuses (queueLockedReason) instead of adding the video to that playlist.
 * @param {object} video What queueVideoNext takes ({id, title, url, duration}).
 * @returns {object} A fillMenu entry.
 */
function addNextEntry(video) {
  return {
    label: "Add next to queue",
    key: "Q",
    icon: ICON_NEXT,
    refuse: queueLockedReason,
    onClick: () => queueVideoNext(video),
  };
}
function queueVideoNext(chapter) {
  const locked = queueLockedReason();
  if (locked) return notify(locked, true, 5000);
  const item = videoItem(chapter);
  if (
    (!queue || !queue.items.length) &&
    currentVideoId &&
    !playerFrame.classList.contains("empty")
  ) {
    const entry = library.find((other) => other.id === currentVideoId);
    const playing = {
      id: currentVideoId,
      title:
        (entry && entry.title) || titleOverlay.textContent || currentVideoId,
      url: `https://www.youtube.com/watch?v=${currentVideoId}`,
      duration:
        isFinite(video.duration) && video.duration > 0
          ? video.duration
          : undefined,
    };
    appendToQueue(item.id === currentVideoId ? [playing] : [playing, item], {
      autoPlayIfEmpty: false,
    });
    playSource = "queue";
    queueIndex = 0;
    markActiveQueueRow();
    scrollActiveQueueRowIntoView();
    prefetchNextInQueue();
    saveQueue();
    return notify(`Playing next: ${chapter.title}`);
  }
  if (!queue || !queue.items.length) {
    appendToQueue([item]); // empty queue: it simply becomes the queue (and starts playing)
    return notify(`Playing: ${chapter.title}`);
  }
  const at = queueIndex >= 0 ? queueIndex + 1 : queue.items.length;
  queue.items.splice(at, 0, item);
  queue.items.forEach((other, index) => (other.index = index + 1));
  renderQueue();
  prefetchNextInQueue();
  saveQueue();
  notify(`Playing next: ${chapter.title}`);
}
async function downloadVideo(item) {
  try {
    const data = await requestDownloads([item.id], [item]);
    if (data.queued)
      activeDownloads.set(item.id, {
        id: item.id,
        status: "queued",
        percent: 0,
      });
    notify(
      data.queued ? "Download queued" : "Already downloading / downloaded",
    );
  } catch (err) {
    notify(`Couldn't queue download: ${netMessage(firstLine(err.message))}`, true, 4000);
  }
}
function videoMenuEntries(v, anchor) {
  return [
    saveToEntry(anchor, videoItem(v), "P"),
    addNextEntry(v),
    downloadEntryFor(v),
    {
      label: "Open on YouTube",
      key: "Y",
      icon: ICON_EXTERNAL,
      // the marker lets it past "Open YouTube links in MinimalTube" (background.js)
      onClick: () => chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${v.id}&minimaltube=skip` }),
    },
  ];
}

function downloadEntryFor(item) {
  if (activeDownloads.has(item.id))
    return activeDownloads.get(item.id).status === "waiting"
      ? {
          label: "Waiting for connection",
          key: "S",
          cls: "busy",
          icon: ICON_DOWNLOAD,
          disabled: true,
        }
      : {
          label: "Downloading",
          key: "S",
          dots: true,
          cls: "busy",
          icon: ICON_DOWNLOAD,
          disabled: true,
        };
  if (item.downloaded)
    return {
      label: "Delete file",
      key: "S",
      icon: ICON_TRASH,
      danger: true,
      onClick: () => deleteFile(item.id, item.title),
    };
  return {
    label: "Download",
    key: "S",
    icon: ICON_DOWNLOAD,
    onClick: () => downloadVideo(item),
  };
}
// A thumbnail that couldn't load is hidden, not removed, until the connection has been checked:
// if it was lost, the image is tried again once it's back.
const failedThumbs = new Set();
whenNetChanges((offline) => {
  if (offline) return;
  failedThumbs.forEach((img) => {
    failedThumbs.delete(img);
    if (!img.isConnected) return;
    img._retried = true;
    img.src = img._first;
  });
});
// A card's width at each window width (the grid's columns, see browse.css): the browser picks the
// server's 1280 x 720 thumbnail for anything bigger than the 320 x 180 one
const CARD_SIZES = "(max-width: 575px) 100vw, (max-width: 883px) 50vw, (max-width: 1695px) 34vw, 25vw";
function makeThumbImg(url, fallback, large = false) {
  const img = el("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  if (large && url.startsWith(`${serverBase}/thumb/`)) {
    img.srcset = `${url} 320w, ${url}?size=720 1280w`;
    img.sizes = CARD_SIZES;
  }
  img.src = img._first = url;
  img.addEventListener("load", () => img.classList.remove("failed"));
  img.addEventListener("error", () => {
    // the large one isn't there (offline, never fetched): the 320 x 180 one, then YouTube's
    if (img.hasAttribute("srcset")) {
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      return;
    }
    if (fallback && img.src !== fallback) {
      img.src = fallback;
    } else if (img._retried && !isOffline()) img.remove();
    else {
      img.classList.add("failed");
      failedThumbs.add(img);
      if (!img.src.startsWith(serverBase)) checkNet();
    }
  });
  return img;
}
function makeThumb(url, fallback) {
  const thumb = el("div", "vThumb");
  if (url) thumb.appendChild(makeThumbImg(url, fallback, true));
  return thumb;
}
function paintFeedDownloaded(card) {
  const ok = card._thumb.querySelector(".vBadge.ok");
  if (card._video.downloaded && !ok) {
    const badge = document.createElement("span");
    badge.className = "vBadge ok";
    badge.textContent = "✓ Downloaded";
    card._thumb.appendChild(badge);
  } else if (!card._video.downloaded && ok) ok.remove();
}

function refreshFeedDownloadedFlags() {
  if (libraryKey === null) return; // library not loaded yet
  const ready = new Set(
    library
      .filter((entry) => !entry.status || entry.status === "ready")
      .map((el) => el.id),
  );
  feedGrid.querySelectorAll(".vCard").forEach((card) => {
    const item = card._video;
    if (!item) return;
    const now = ready.has(item.id);
    if (item.downloaded !== now) {
      item.downloaded = now;
      paintFeedDownloaded(card);
    }
  });
}
// A card on the browse page (the feed, playlists, a playlist's videos, Downloads): thumbnail with
// a badge, title, lines under it and a ⋮ menu. The thumbnail and the title both run `open`.
function makeCard({ thumb, fallback, videoId, badge, video, title, lines = [], open, menu, className }) {
  const card = el("div", "vCard" + (className ? ` ${className}` : ""));
  const thumbEl = makeThumb(thumb, fallback);
  if (videoId) {
    thumbEl.dataset.vid = videoId;
    paintWatch(thumbEl);
  }
  if (badge != null) {
    card._badge = el("span", "vBadge", badge);
    thumbEl.appendChild(card._badge);
  }
  card._thumb = thumbEl;
  if (video) {
    card._video = video;
    paintFeedDownloaded(card);
  }
  thumbEl.addEventListener("click", open);
  const titleEl = el("div", "vTitle", title);
  titleEl.title = title;
  titleEl.addEventListener("click", open);
  const text = el("div", "vText");
  text.append(titleEl, ...lines.map((line) => (typeof line === "string" ? el("div", "vSub", line) : line)));
  const meta = el("div", "vMeta");
  meta.append(text, makeMenuButton(menu));
  card.append(thumbEl, meta);
  return card;
}
/**
 * The lines under a video card's title: its channel (a click opens the channel's page) and
 * "views · age". Missing parts are left out. A collab names each of its channels, each a link.
 * @param {{channel?: string, channel_id?: string, channels?: Array<{id: string, name: string}>,
 *   views?: number, timestamp?: number}} video
 * @returns {HTMLElement[]} For makeCard's `lines`.
 */
function videoCardLines(video) {
  const chan = el("div", "vSub", video.channel || "");
  if (Array.isArray(video.channels) && video.channels.length > 1) {
    chan.textContent = "";
    video.channels.forEach((ch, i) => {
      if (i) chan.append(i === video.channels.length - 1 ? " and " : ", ");
      const link = el("span", "vChanLink", ch.name);
      link.title = `Latest uploads from ${ch.name}`;
      link.addEventListener("click", () => selectedChannel !== ch.id && openChannel({ id: ch.id, name: ch.name }));
      chan.append(link);
    });
  } else if (video.channel_id) {
    chan.classList.add("vChan");
    chan.title = `Latest uploads from ${video.channel}`;
    chan.addEventListener("click", () => {
      if (selectedChannel !== video.channel_id)
        openChannel({ id: video.channel_id, name: video.channel });
    });
  }
  return [chan, el("div", "vSub", [fmtViews(video.views), timeAgo(video.timestamp)].filter(Boolean).join(" · "))];
}
function makeVideoCard(chapter) {
  const card = makeCard({
    thumb: `${serverBase}/thumb/${chapter.id}`, // kept by the server, so it also shows offline
    fallback: chapter.thumbnail,
    videoId: chapter.id,
    badge: chapter.duration ? fmtDur(chapter.duration) : null, // Shorts too: the badge is the length
    video: chapter,
    title: chapter.title,
    lines: videoCardLines(chapter),
    open: () => playVideoNow(chapter),
    menu: (anchor) => videoMenuEntries(chapter, anchor),
  });
  if (chapter.members_only) {
    const badge = el("span", "vBadge members", "Members only");
    badge.title = "Only the channel's members can watch this";
    card._thumb.appendChild(badge);
  }
  return card;
}
