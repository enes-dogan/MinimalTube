/* MinimalTube player - Keyboard: lists (makeRovingList), skip link, Shift+N / Shift+B, the mini player keys.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Keyboard in lists: every list (the feed, playlists, a playlist's videos, Downloads, the
 * channel chips, the queue and Downloads rows) is one Tab stop and the arrow keys move inside
 * it. Enter plays / opens, "." (or the Menu key, Shift+F10) opens the item's ⋮ menu, Delete
 * removes it (with the Undo bar). Tab leaves the list and comes back to the same item.
 * ===================================================================== */
const ROVE_INNER = "button, a[href], input, [tabindex]";
const roveKey = (el) =>
  el.dataset.vid ||
  el.dataset.plid ||
  (el._video && el._video.id) ||
  (el._item && (el._item.id || el._item.url)) ||
  el.textContent;
let menuReturn = null; // the list item a keyboard-opened ⋮ menu goes back to
function makeRovingList(list, { item, primary, onDelete }) {
  let current = null,
    currentIndex = 0,
    hasFocus = false;
  const allItems = () => [...list.children].filter((el) => el.matches(item));
  const items = () => allItems().filter((el) => el.getClientRects().length);
  function sync() {
    const all = allItems();
    if (!all.includes(current)) {
      const key = current && roveKey(current);
      current =
        (key && all.find((el) => roveKey(el) === key)) ||
        all[Math.min(currentIndex, all.length - 1)] ||
        null;
    }
    currentIndex = Math.max(0, all.indexOf(current));
    all.forEach((el) => {
      el.tabIndex = el === current ? 0 : -1;
      el.querySelectorAll(ROVE_INNER).forEach((inner) => (inner.tabIndex = -1));
    });
    // the focused item was re-rendered away: keep the keyboard where it was
    if (hasFocus && current && document.activeElement === document.body)
      current.focus({ preventScroll: true });
  }
  function focusItem(el) {
    if (!el) return;
    current = el;
    hasFocus = true;
    sync();
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  // the item in the next / previous visual row, closest to this one horizontally
  function vertical(el, dir) {
    const r = el.getBoundingClientRect(),
      cx = r.left + r.width / 2;
    let best = null,
      bestRow = Infinity,
      bestDx = Infinity;
    items().forEach((other) => {
      const q = other.getBoundingClientRect();
      const row = (q.top - r.top) * dir;
      if (row < 4) return;
      const dx = Math.abs(q.left + q.width / 2 - cx);
      if (row < bestRow - 4 || (Math.abs(row - bestRow) <= 4 && dx < bestDx)) {
        best = other;
        bestRow = row;
        bestDx = dx;
      }
    });
    return best;
  }
  function activate(el) {
    (primary && el.querySelector(primary) || el).click();
  }
  function openMenu(el) {
    const btn = el.querySelector(".vMenuBtn, .plMenuBtn");
    if (!btn || !btn._openMenu) return;
    menuReturn = { restore: () => focusItem(current) };
    btn._openMenu(btn);
  }
  list.addEventListener("keydown", (event) => {
    const el = event.target;
    if (el.parentElement !== list || !el.matches(item)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    hasFocus = true;
    const all = items(),
      at = all.indexOf(el);
    const menuKey =
      event.key === "." || event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
    if (event.shiftKey && !menuKey) return;
    if (event.key === "ArrowLeft") focusItem(all[at - 1]);
    else if (event.key === "ArrowRight") focusItem(all[at + 1]);
    else if (event.key === "ArrowUp") focusItem(vertical(el, -1));
    else if (event.key === "ArrowDown") focusItem(vertical(el, 1));
    else if (event.key === "Home") focusItem(all[0]);
    else if (event.key === "End") focusItem(all[all.length - 1]);
    else if (event.key === "Enter") activate(el);
    else if (menuKey) openMenu(el);
    else if (event.key === "Delete" && onDelete) onDelete(el);
    else return;
    event.preventDefault();
    event.stopPropagation(); // not the player's arrow / Enter shortcuts
  });
  list.addEventListener("focusin", (event) => {
    hasFocus = true;
    const el = event.target.closest(item);
    if (el && el.parentElement === list && el !== current) {
      current = el;
      sync();
    }
  });
  // focus that left on purpose; an item removed by a re-render keeps it (sync puts it back)
  list.addEventListener("focusout", (event) => {
    setTimeout(() => {
      if (event.target.isConnected && !list.contains(document.activeElement)) hasFocus = false;
    }, 0);
  });
  new MutationObserver(sync).observe(list, { childList: true });
  sync();
  return { focus: () => (sync(), focusItem(current)) };
}

// Inside a ⋮ menu (or the "Save to" list it leads to) opened from the keyboard: ↑ / ↓ move,
// Enter picks (the letter keys work too). When it closes, the keyboard goes back to the item.
const POPUPS = layers.filter((layer) => layer.items).map((layer) => [layer.el, layer.items]);
const popupOpen = () => POPUPS.some(([menu]) => menu.classList.contains("open"));
document.addEventListener("keydown", (event) => {
  const entry = POPUPS.find(([menu]) => menu.contains(event.target));
  if (!entry) return;
  if (event.key === ".") {
    // "." opened it, "." closes it (the keyboard goes back to the item)
    event.preventDefault();
    event.stopPropagation();
    closeBpMenu();
    closeRowMenu();
    closeSaveToMenu();
    return;
  }
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const buttons = [...entry[0].querySelectorAll(entry[1])];
  const at = buttons.indexOf(event.target);
  const next =
    event.key === "Home"
      ? buttons[0]
      : event.key === "End"
        ? buttons[buttons.length - 1]
        : buttons[(at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
  event.preventDefault();
  event.stopPropagation();
  if (next) next.focus();
});
POPUPS.forEach(([menu, selector]) => {
  let index = 0; // the button that had the keyboard, kept across re-renders ("Save to" ticks)
  menu.addEventListener("focusin", (event) => {
    const at = [...menu.querySelectorAll(selector)].indexOf(event.target);
    if (at >= 0) index = at;
  });
  new MutationObserver(() => {
    if (!menuReturn) return;
    setTimeout(() => {
      if (!menuReturn) return;
      const active = document.activeElement;
      if (menu.classList.contains("open")) {
        if (menu.contains(active)) return;
        const buttons = menu.querySelectorAll(selector);
        const target = buttons[Math.min(index, buttons.length - 1)];
        if (target) target.focus({ preventScroll: true });
        return;
      }
      index = 0;
      if (popupOpen()) return;
      const back = menuReturn;
      menuReturn = null;
      if (active && active !== document.body && !isPopupButton(active)) return; // e.g. a dialog took it
      back.restore();
    }, 0);
  }).observe(menu, { attributes: true, attributeFilter: ["class"], childList: true });
});
const isPopupButton = (el) => POPUPS.some(([menu]) => menu.contains(el)) || !el.isConnected;

const rovers = {
  feed: makeRovingList(feedGrid, { item: ".vCard", primary: ".vThumb" }),
  playlists: makeRovingList(plGrid, { item: ".vCard", primary: ".vThumb" }),
  playlistItems: makeRovingList(plItemsGrid, {
    item: ".vCard",
    primary: ".vThumb",
    onDelete: (card) => {
      const pl = openPlaylist();
      const it = pl && (pl.items || []).find((other) => other.id === card.dataset.vid);
      if (it) removeFromPlaylist(pl, it);
    },
  }),
  downloads: makeRovingList(dlGrid, {
    item: ".vCard",
    primary: ".vThumb",
    onDelete: (card) => card._entry && deleteLibraryEntry(card._entry),
  }),
  chips: makeRovingList(subChips, {
    item: ".subChip",
    primary: ".subChipName",
    onDelete: (chip) => chip.querySelector("button").click(), // "Unsubscribe?" asks first
  }),
  queue: makeRovingList(queueList, {
    item: ".plItem",
    onDelete: (row) => row._item && removeQueueItem(row._item),
  }),
  library: makeRovingList(libraryList, {
    item: ".plItem",
    onDelete: (row) => row._entry && deleteLibraryEntry(row._entry),
  }),
};

// "Skip to videos": the first Tab on the browse page jumps past the header and channel list.
const skipLink = byId("skipLink");
function skipTarget() {
  if (browseTab === "subs") return ["videos", rovers.feed];
  if (browseTab === "downloads") return ["downloads", rovers.downloads];
  return plView.classList.contains("detail")
    ? ["videos", rovers.playlistItems]
    : ["playlists", rovers.playlists];
}
skipLink.addEventListener("focus", () => {
  skipLink.textContent = `Skip to ${skipTarget()[0]}`;
});
skipLink.addEventListener("click", () => skipTarget()[1].focus());

/* =====================================================================
 * Keyboard: Shift+N next video, Shift+B previous video, I mini player.
 * Close button of the mini player.
 * ===================================================================== */
// Mirror of resolveNext.
function resolvePrev() {
  if (playSource === "detour") return resolveNext(); // either way: back to the playlist
  if (playSource === "library") {
    const index = library.findIndex((entry) => entry.id === currentVideoId),
      prev = index > 0 ? library[index - 1] : null;
    return prev
      ? {
          title: prev.title || "Previous video",
          play: () => playLibraryEntry(prev),
        }
      : null;
  }
  if (!queue || queueIndex < 1) return null;
  const prev = queue.items[queueIndex - 1];
  if (!prev) return null;
  return {
    title: prev.title || prev.url,
    play: () => {
      const idx = queue ? queue.items.indexOf(prev) : -1;
      if (idx < 0) return;
      playSource = "queue";
      queueIndex = idx;
      markActiveQueueRow();
      scrollActiveQueueRowIntoView();
      playVideo(prev.url);
      prefetchNextInQueue();
      saveQueue();
    },
  };
}
function skipVideo(direction) {
  cancelUpNext();
  const target = direction > 0 ? resolveNext() : resolvePrev();
  if (!target)
    return notify(
      direction > 0 ? "No next video" : "No previous video",
      false,
      1800,
    );
  notify(
    `${direction > 0 ? "Next" : "Previous"}: ${target.title}`,
    false,
    1800,
  );
  target.play();
}

function toggleMiniPlayer() {
  if (document.body.classList.contains("browsing")) {
    if (!playerFrame.classList.contains("empty")) exitBrowse(); // nothing to restore if nothing was played
  } else enterBrowse();
}
document.addEventListener("keydown", (event) => {
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.repeat ||
    isTypingTarget(event.target)
  )
    return;
  if (event.shiftKey && event.code === "KeyN") {
    event.preventDefault();
    skipVideo(1);
  } else if (event.shiftKey && event.code === "KeyB") {
    event.preventDefault();
    skipVideo(-1);
  } else if (event.code === "KeyI") {
    event.preventDefault();
    toggleMiniPlayer();
  } else if (event.key === "," && !event.shiftKey) {
    event.preventDefault();
    gearBtn.click();
  } else if (event.code === "KeyT" && !event.shiftKey) {
    event.preventDefault();
    if (document.body.classList.contains("browsing")) bpQueueBtn.click();
    else queueToggleBtn.click();
  } else if (
    (event.code === "KeyQ" || event.code === "KeyD") &&
    !event.shiftKey &&
    queuePanel.classList.contains("open") &&
    !popupOpen()
  ) {
    event.preventDefault();
    const key = event.code === "KeyQ" ? "queue" : "library";
    setSectionCollapsed(key, !sectionEls[key].classList.contains("collapsed"));
  } else if (
    event.code === "KeyC" &&
    !event.shiftKey &&
    queuePanel.classList.contains("open") &&
    !popupOpen()
  ) {
    event.preventDefault();
    byId("clearQueueBtn").click();
  }
});

// Close the mini player: it fades and shrinks away, then playback stops. The queue and its
// position are kept, so Shift+N / playing something again carries on from there.
const miniClose = byId("miniClose");
function closeMiniPlayer() {
  if (
    !playerFrame.classList.contains("mini") ||
    playerFrame.classList.contains("closing")
  )
    return;
  playerFrame.classList.add("closing");
  setTimeout(() => {
    const keepW = queueIndex,
      keepSource = playSource;
    stopPlayback(); // pauses, empties the video, hides the (now empty) mini window
    queueIndex = keepW;
    playSource = keepSource;
    playerFrame.classList.remove("closing");
  }, 240);
}
miniClose.addEventListener("click", closeMiniPlayer);
