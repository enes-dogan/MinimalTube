/* MinimalTube player - Reordering rows, the side panel's ⋮ menu, its actions, the shared "Save to" popover and
 * deleting / removing with Undo.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Reorder (drag handle) + per-row 3-dot menu
 * ===================================================================== */
let sortDragging = false;
const ICON_GRIP =
  '<svg viewBox="0 0 12 16" fill="currentColor"><circle cx="3.5" cy="3" r="1.4"/><circle cx="8.5" cy="3" r="1.4"/><circle cx="3.5" cy="8" r="1.4"/><circle cx="8.5" cy="8" r="1.4"/><circle cx="3.5" cy="13" r="1.4"/><circle cx="8.5" cy="13" r="1.4"/></svg>';
const ICON_DOTS =
  '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const ICON_CHANNEL =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
const ICON_REMOVE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm11.41 6L17 19.41 19.59 22 21 20.59 18.41 18 21 15.41 19.59 14 17 16.59 14.41 14 13 15.41 15.59 18 13 20.59z"/></svg>';
function makeGrip() {
  const grip = document.createElement("div");
  grip.className = "plGrip";
  grip.title = "Drag to reorder";
  grip.innerHTML = ICON_GRIP;
  // The click that follows a drag/press on the grip must not play the row.
  grip.addEventListener("click", (event) => event.stopPropagation());
  return grip;
}

/* ---------- drag-to-reorder ---------- */
function makeSortable(listEl, onMove) {
  listEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const grip = event.target.closest(".plGrip");
    const row = grip && grip.closest(".plItem");
    if (!row || row.parentElement !== listEl) return;
    event.preventDefault();
    startRowDrag(listEl, row, grip, event, onMove);
  });
}
function startRowDrag(listEl, row, grip, event, onMove) {
  closeRowMenu();
  const rows = Array.from(listEl.children).filter((item) =>
    item.classList.contains("plItem"),
  );
  const from = rows.indexOf(row);
  if (from < 0) return;
  const tops = rows.map((r) => r.offsetTop);
  const heights = rows.map((r) => r.offsetHeight);
  const dragH = heights[from];
  const total = tops[rows.length - 1] + heights[rows.length - 1];
  const rect0 = listEl.getBoundingClientRect();
  const grab = event.clientY - rect0.top + listEl.scrollTop - tops[from];
  let pointerY = event.clientY;
  let to = from;
  let raf = 0;
  let finished = false;
  sortDragging = true;
  listEl.classList.add("sorting");
  row.classList.add("dragging");
  document.body.style.cursor = "grabbing";
  try {
    grip.setPointerCapture(event.pointerId);
  } catch {}
  function update() {
    const rect = listEl.getBoundingClientRect();
    const y = pointerY - rect.top + listEl.scrollTop;
    const dTop = Math.min(Math.max(0, y - grab), Math.max(0, total - dragH));
    const center = dTop + dragH / 2;
    to = 0;
    rows.forEach((other, idx) => {
      if (idx !== from && tops[idx] + heights[idx] / 2 < center) to++;
    });
    rows.forEach((other, idx) => {
      if (idx === from) {
        other.style.transform = `translateY(${dTop - tops[from]}px)`;
        return;
      }
      let shift = 0;
      if (to > from && idx > from && idx <= to) shift = -dragH;
      else if (to < from && idx >= to && idx < from) shift = dragH;
      other.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  }
  function autoScroll() {
    if (finished) return;
    const rect = listEl.getBoundingClientRect();
    const edge = 36;
    let dy = 0;
    if (pointerY < rect.top + edge)
      dy = -Math.ceil((rect.top + edge - pointerY) / 4);
    else if (pointerY > rect.bottom - edge)
      dy = Math.ceil((pointerY - (rect.bottom - edge)) / 4);
    if (dy) {
      listEl.scrollTop += Math.max(-18, Math.min(18, dy));
      update();
    }
    raf = requestAnimationFrame(autoScroll);
  }
  function finish(commit) {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    grip.removeEventListener("pointermove", onMoveEv);
    grip.removeEventListener("pointerup", onUp);
    grip.removeEventListener("pointercancel", onCancel);
    grip.removeEventListener("lostpointercapture", onCancel);
    document.removeEventListener("keydown", onKey, true);
    try {
      grip.releasePointerCapture(event.pointerId);
    } catch {}
    rows.forEach((other) => (other.style.transform = ""));
    row.classList.remove("dragging");
    listEl.classList.remove("sorting");
    document.body.style.cursor = "";
    sortDragging = false;
    if (commit && to !== from) onMove(from, to);
  }
  const onMoveEv = (ev) => {
    pointerY = ev.clientY;
    update();
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    }
  };
  grip.addEventListener("pointermove", onMoveEv);
  grip.addEventListener("pointerup", onUp);
  grip.addEventListener("pointercancel", onCancel);
  grip.addEventListener("lostpointercapture", onCancel);
  document.addEventListener("keydown", onKey, true);
  update();
  raf = requestAnimationFrame(autoScroll);
}
function moveQueueItem(from, to) {
  if (!queue) return;
  const current = queueIndex >= 0 ? queue.items[queueIndex] : null;
  const [moved] = queue.items.splice(from, 1);
  queue.items.splice(to, 0, moved);
  queue.items.forEach((item, index) => (item.index = index + 1));
  queueIndex = current ? queue.items.indexOf(current) : -1;
  renderQueue();
  // "Next video" may have changed - make sure the new next one is downloading.
  prefetchNextInQueue();
  saveQueue();
}
function moveLibraryItem(from, to) {
  const [moved] = library.splice(from, 1);
  library.splice(to, 0, moved);
  libEpoch++;
  libraryKey = libKey(library);
  renderLibrary();
  api("/library/order", { method: "POST", body: { ids: library.map((entry) => entry.id) } }).catch(
    (err) => notify(`Couldn't save the new order: ${netMessage(firstLine(err.message))}`, true, 3000),
  );
}
makeSortable(queueList, moveQueueItem);
makeSortable(libraryList, moveLibraryItem);

/* ---------- 3-dot menu ---------- */
const rowMenu = document.createElement("div");
rowMenu.id = "rowMenu";
queuePanel.appendChild(rowMenu);
let menuRow = null;
function closeRowMenu() {
  rowMenu._keys = null;
  rowMenu.classList.remove("open");
  rowMenu.innerHTML = "";
  if (menuRow) menuRow.classList.remove("menuOpen");
  menuRow = null;
}
function makeKebab(getEntries, row) {
  const btn = document.createElement("button");
  btn.className = "plMenuBtn";
  btn.title = "More";
  btn.innerHTML = ICON_DOTS;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menuRow === row) return closeRowMenu();
    openRowMenu(row, btn, getEntries(btn));
  });
  // Don't let a press on the button start anything else (e.g. text selection).
  btn.addEventListener("mousedown", (event) => event.stopPropagation());
  btn._openMenu = (anchor) => openRowMenu(row, anchor, getEntries(anchor));
  return btn;
}
function menuKeysFor(entries) {
  const keys = new Map(),
    taken = new Set();
  entries.forEach((entry) => {
    if (entry.key) {
      keys.set(entry, entry.key.toUpperCase());
      taken.add(entry.key.toUpperCase());
    }
  });
  const counts = {};
  entries.forEach((entry) => {
    const first = (entry.label || "").trim().charAt(0).toUpperCase();
    if (!entry.key && /^[A-Z]$/.test(first))
      counts[first] = (counts[first] || 0) + 1;
  });
  entries.forEach((entry) => {
    const first = (entry.label || "").trim().charAt(0).toUpperCase();
    if (!entry.key && counts[first] === 1 && !taken.has(first))
      keys.set(entry, first);
  });
  return keys;
}
function addMenuKey(menu, item, key) {
  if (!key) return;
  const hint = document.createElement("kbd");
  hint.className = "menuKey kbd";
  hint.textContent = key;
  item.appendChild(hint);
  menu._keys.set(key, item);
}
function openRowMenu(row, btn, entries) {
  closeRowMenu();
  closeSaveToMenu();
  menuReopen = () => openRowMenu(row, btn, entries);
  fillMenu(rowMenu, entries, closeRowMenu);
  menuRow = row;
  row.classList.add("menuOpen");
  placePopup(rowMenu, btn, queuePanel);
}

addLayer({
  el: rowMenu,
  level: 2,
  isOpen: () => rowMenu.classList.contains("open"),
  close: closeRowMenu,
  inside: [".plMenuBtn"],
  items: ".rowMenuItem:not(:disabled)",
});
[queueList, libraryList].forEach((item) =>
  item.addEventListener("scroll", closeRowMenu, {
    passive: true,
  }),
);

const ICON_BOOKMARK =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15-5-2.18L7 18V5h10v13z"/></svg>';
const ICON_BOOKMARK_FILLED =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>';
const saveToMenu = document.createElement("div");
saveToMenu.id = "saveToMenu";
queuePanel.appendChild(saveToMenu);
const saveToBusy = new Set();
let saveToVideo = null,
  saveToBtn = null,
  saveToBack = null, // reopens the ⋮ menu "Save to playlist" was picked from
  menuReopen = null; // the ⋮ menu shown last (showBpMenu / openRowMenu)
const ICON_BACK =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>';

// "Save to playlist": one popover for every ⋮ menu (queue and Downloads rows, the browse page's
// cards). In the side panel it lives in the panel; elsewhere it floats over the page.
function saveToEntry(btn, v, key = "L") {
  return {
    label: "Save to playlist",
    key,
    icon: ICON_ADDLIST,
    disabled: !v,
    onClick: () => openSaveToMenu(btn, v, menuReopen),
  };
}
function closeSaveToMenu() {
  saveToMenu.classList.remove("open");
  saveToMenu.innerHTML = "";
  saveToVideo = null;
  saveToBtn = null;
  saveToBack = null;
}
function saveToGoBack() {
  const back = saveToBack;
  closeSaveToMenu();
  if (back) back();
}
function openSaveToMenu(btn, v, back) {
  const host = queuePanel.contains(btn) ? queuePanel : document.body;
  if (saveToMenu.parentElement !== host) host.appendChild(saveToMenu);
  saveToMenu.classList.toggle("floating", host === document.body);
  saveToVideo = v;
  saveToBtn = btn;
  saveToBack = back || null;
  renderSaveToMenu();
  loadSavedPlaylists().then(() => {
    if (saveToVideo === v) renderSaveToMenu();
  });
}
function renderSaveToMenu() {
  const v = saveToVideo;
  if (!v) return;
  const listTop = saveToMenu.querySelector(".stList");
  const keepScroll = listTop ? listTop.scrollTop : 0;
  saveToMenu.innerHTML = "";
  if (saveToBack) {
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "rowMenuItem stBack";
    backBtn.innerHTML = ICON_BACK;
    const backLabel = document.createElement("span");
    backLabel.textContent = "Back";
    const backKey = document.createElement("kbd");
    backKey.className = "menuKey kbd";
    backKey.textContent = "B";
    backBtn.append(backLabel, backKey);
    backBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      saveToGoBack();
    });
    saveToMenu.appendChild(backBtn);
  }
  const head = document.createElement("div");
  head.className = "stHead";
  head.textContent = "Save to...";
  const list = document.createElement("div");
  list.className = "stList";
  if (!savedPlaylists.length) {
    const empty = document.createElement("div");
    empty.className = "stEmpty";
    empty.textContent = "No playlists yet.";
    list.appendChild(empty);
  }
  savedPlaylists.forEach((pl) => {
    const items = pl.items || [],
      has = items.some((item) => item.id === v.id),
      first = items[0];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "stRow" + (has ? " saved" : "");
    row.disabled = saveToBusy.has(pl.id);
    const thumb = document.createElement("div");
    thumb.className = "stThumb";
    if (first && first.thumbnail) thumb.appendChild(makeThumbImg(first.thumbnail));
    const text = document.createElement("div");
    text.className = "stText";
    const name = document.createElement("div");
    name.className = "stName";
    name.textContent = pl.name;
    name.title = pl.name;
    const sub = document.createElement("div");
    sub.className = "stSub";
    sub.textContent = `${items.length} video${items.length === 1 ? "" : "s"}`;
    text.append(name, sub);
    const mark = document.createElement("span");
    mark.className = "stMark";
    mark.innerHTML = has ? ICON_BOOKMARK_FILLED : ICON_BOOKMARK;
    row.title = has ? `Remove from ${pl.name}` : `Save to ${pl.name}`;
    row.append(thumb, text, mark);
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSaveTo(pl, v, has);
    });
    list.appendChild(row);
  });
  const foot = document.createElement("div");
  foot.className = "stFoot";
  const create = document.createElement("button");
  create.type = "button";
  create.className = "stNew";
  create.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
  const label = document.createElement("span");
  label.textContent = "New playlist";
  create.appendChild(label);
  create.addEventListener("click", (event) => {
    event.stopPropagation();
    closeSaveToMenu();
    openSavePlaylist({
      items: [v],
      title: "New playlist",
      sub: v.title || v.url,
    });
  });
  foot.appendChild(create);
  saveToMenu.append(head, list, foot);
  saveToMenu.classList.add("open");
  list.scrollTop = keepScroll;
  positionSaveToMenu();
}
function positionSaveToMenu() {
  if (!saveToBtn || !saveToBtn.isConnected) return;
  placePopup(saveToMenu, saveToBtn, saveToMenu.parentElement === queuePanel ? queuePanel : null);
}
async function toggleSaveTo(pl, v, has) {
  if (saveToBusy.has(pl.id)) return;
  saveToBusy.add(pl.id);
  renderSaveToMenu();
  try {
    const base = `/playlists/${encodeURIComponent(pl.id)}/items`;
    const data = has
      ? await api(`${base}/${encodeURIComponent(v.id)}`, { method: "DELETE" })
      : await api(base, { method: "POST", body: { items: [v], position: "top" } });
    applySavedPlaylist(data.playlist);
    renderPlaylistCards();
    notify(has ? `Removed from ${pl.name}` : `Saved to ${pl.name}`);
  } catch (err) {
    notify(
      `Couldn't ${has ? "remove from" : "save to"} playlist: ${firstLine(err.message)}`,
      true,
      4000,
    );
  } finally {
    saveToBusy.delete(pl.id);
    renderSaveToMenu();
  }
}
addLayer({
  el: saveToMenu,
  level: 3,
  isOpen: () => saveToMenu.classList.contains("open"),
  close: closeSaveToMenu,
  inside: [".plMenuBtn", ".vMenuBtn"],
  items: ".stRow, .stNew",
});
// B = its Back row
document.addEventListener("keydown", (event) => {
  if (!saveToMenu.classList.contains("open")) return;
  if (
    event.code === "KeyB" &&
    saveToBack &&
    !(event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) &&
    !isTypingTarget(event.target)
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    saveToGoBack();
  }
});
[queueList, libraryList, document.getElementById("browseBody")].forEach((item) =>
  item.addEventListener("scroll", closeSaveToMenu, {
    passive: true,
  }),
);

/* ---------- menu actions ---------- */
function queueMenuEntries(item, btn) {
  const st = item._st && item._st.status;
  let dl;
  const id = itemVideoId(item);
  if (item._cachedReady || st === "ready")
    dl = {
      label: "Delete file",
      key: "S",
      icon: ICON_TRASH,
      danger: true,
      onClick: () => deleteFile(id, item.title || item.url),
    };
  else if (["queued", "downloading", "merging", "waiting"].includes(st))
    dl = {
      label: "Downloading…",
      key: "S",
      icon: ICON_DOWNLOAD,
      disabled: true,
    };
  else
    dl = {
      label: "Download",
      key: "S",
      icon: ICON_DOWNLOAD,
      onClick: () => downloadQueueItem(item),
    };
  return [
    saveToEntry(
      btn,
      id && {
        id,
        title: item.title,
        url: item.url,
      },
    ),
    dl,
    {
      label: queue && queue.playlistId ? "Remove from playlist" : "Remove from queue",
      key: "D",
      icon: ICON_REMOVE,
      onClick: () => removeQueueItem(item),
    },
  ];
}
function libraryMenuEntries(entry, btn) {
  return [
    btn &&
      saveToEntry(btn, {
        id: entry.id,
        title: entry.title || "",
        url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
      }),
    btn && {
      label: "Add next to queue",
      key: "Q",
      icon: ICON_NEXT,
      onClick: () => queueVideoNext(downloadVideoObj(entry)),
    },
    channelEntry(entry.id, entry),
    {
      label: isActiveEntry(entry) ? "Cancel download" : "Delete",
      key: "D",
      icon: ICON_TRASH,
      danger: true,
      onClick: () => deleteLibraryEntry(entry),
    },
  ];
}
async function downloadQueueItem(item) {
  const id = itemVideoId(item);
  if (!id) return notify("Can't download this item yet", true, 3000);
  try {
    const data = await requestDownloads([id], [item]);
    setQueueItemStatus(item, { status: "queued" });
    notify(data.queued ? "Download queued" : "Already downloading / downloaded");
    pollQueueStatuses();
  } catch (err) {
    notify(`Couldn't queue download: ${netMessage(firstLine(err.message))}`, true, 4000);
  }
}
function deleteVideoOnServer(id) {
  return api(`/video/${id}`, { method: "DELETE", keepalive: true });
}

const UNDO_MS = 5000;
const undoBar = document.createElement("div");
undoBar.id = "undoBar";
undoBar.innerHTML =
  '<span class="ubText"></span><button type="button" class="ubUndo btn btn-sm btn-tint" title="Undo (U)">Undo<kbd class="kbd">U</kbd></button><div class="ubBar"></div>';
document.body.appendChild(undoBar);
const hiddenDeletes = new Set();
let pendingUndo = null;
// `kind` names what can be undone, for code that has to make it final early.
function offerUndo(text, { undo, commit, kind }) {
  flushUndo();
  const entry = { undo, commit, kind };
  entry.timer = setTimeout(() => finishUndo(entry), UNDO_MS);
  pendingUndo = entry;
  undoBar.querySelector(".ubText").textContent = text;
  restartAnimation(undoBar, "show");
}
function finishUndo(entry) {
  if (pendingUndo !== entry) return;
  pendingUndo = null;
  clearTimeout(entry.timer);
  undoBar.classList.remove("show");
  entry.commit();
}
function flushUndo() {
  if (pendingUndo) finishUndo(pendingUndo);
}
undoBar.querySelector(".ubUndo").addEventListener("click", (event) => {
  event.stopPropagation();
  const entry = pendingUndo;
  if (!entry) return;
  pendingUndo = null;
  clearTimeout(entry.timer);
  undoBar.classList.remove("show");
  entry.undo();
});
// U = the Undo button while the bar is up (a ⋮ menu's own letter keys come first)
document.addEventListener("keydown", (event) => {
  if (
    event.code !== "KeyU" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.repeat ||
    !pendingUndo ||
    isTypingTarget(event.target) ||
    popupOpen()
  )
    return;
  event.preventDefault();
  undoBar.querySelector(".ubUndo").click();
});
window.addEventListener("pagehide", flushUndo);

function stopPlayback() {
  loadToken++; // abandon any in-flight prepare/poll loop
  stopLiveStream();
  cancelUpNext();
  closeDesc();
  video.pause();
  video.removeAttribute("src");
  video.load();
  clearSubtitles();
  controls.style.display = "none";
  setDlWait(false);
  setLoadFailed(false);
  loadingBox.style.display = "none";
  titleOverlay.classList.remove("visible");
  captionsBtn.style.display = "none";
  hasSubtitles = false;
  placeholder.style.display = "";
  document.title = "MinimalTube";
  currentVideoId = null;
  queueIndex = -1;
  playerFrame.classList.add("empty");
  clearSeekExtras();
  markActiveLibraryRow();
}

function clearReadyState(id) {
  if (queue)
    queue.items.forEach((item) => {
      if (itemVideoId(item) === id) {
        item._cachedReady = false;
        item._st = null;
      }
    });
}
function removeQueueItem(item) {
  if (!queue) return;
  const idx = queue.items.indexOf(item);
  if (idx < 0) return;
  const owner = queue;
  const plName =
    owner.playlistId &&
    (savedPlaylists.find((playlist) => playlist.id === owner.playlistId) || {}).name;
  if (idx === queueIndex) {
    const keepIndex = queueIndex;
    stopPlayback();
    queueIndex = keepIndex;
  }
  owner.items.splice(idx, 1);
  if (idx < queueIndex) queueIndex--;
  else if (idx === queueIndex) queueIndex = Math.min(idx, owner.items.length) - 1;
  owner.items.forEach((other, index) => (other.index = index + 1));
  holdLinkedSync = true;
  renderQueue();
  prefetchNextInQueue();
  saveQueue();
  const release = () => {
    holdLinkedSync = false;
    if (queue === owner) saveQueue();
  };
  offerUndo(
    `“${item.title || item.url}” removed from ${plName || "the queue"}`,
    {
      undo: () => {
        if (queue === owner) {
          const at = Math.min(idx, owner.items.length);
          owner.items.splice(at, 0, item);
          if (at <= queueIndex) queueIndex++;
          owner.items.forEach((other, index) => (other.index = index + 1));
          renderQueue();
          markActiveQueueRow();
        }
        release();
      },
      commit: () => {
        release();
        if (queue === owner && !owner.items.length) clearQueue();
      },
    },
  );
}

// Marks a video as not downloaded everywhere it shows (Downloads, queue, playlists, feed);
// the returned function puts every flag back.
function hideDownloadedFile(id) {
  const at = library.findIndex((item) => item.id === id);
  const entry = at >= 0 ? library[at] : null;
  hiddenDeletes.add(id);
  if (entry) {
    libEpoch++;
    library = library.filter((item) => item.id !== id);
    libraryKey = libKey(library);
    renderLibrary();
  }
  const queueFlags = queue
    ? queue.items
        .filter((item) => itemVideoId(item) === id)
        .map((item) => [item, item._cachedReady, item._st])
    : [];
  queueFlags.forEach(([item]) => setQueueItemStatus(item, null));
  clearReadyState(id);
  const plFlags = [];
  savedPlaylists.forEach((pl) =>
    (pl.items || []).forEach((item) => {
      if (item.id === id && item.downloaded) {
        plFlags.push(item);
        item.downloaded = false;
      }
    }),
  );
  renderQueue();
  renderPlaylistCards();
  refreshFeedDownloadedFlags();
  return () => {
    hiddenDeletes.delete(id);
    if (entry && !library.some((item) => item.id === id)) {
      libEpoch++;
      library.splice(Math.min(at, library.length), 0, entry);
      libraryKey = libKey(library);
      renderLibrary();
    }
    queueFlags.forEach(([item, ready, st]) => {
      item._cachedReady = ready;
      setQueueItemStatus(item, st);
    });
    plFlags.forEach((item) => (item.downloaded = true));
    renderQueue();
    markActiveQueueRow();
    renderPlaylistCards();
    refreshFeedDownloadedFlags();
  };
}
function deleteFile(id, title) {
  if (!id) return;
  if (id === currentVideoId) {
    const keepIndex = queueIndex;
    stopPlayback();
    queueIndex = keepIndex;
  }
  const restore = hideDownloadedFile(id);
  offerUndo(`“${title || id}” deleted`, {
    undo: restore,
    commit: async () => {
      try {
        await deleteVideoOnServer(id);
      } catch (err) {
        restore();
        libraryKey = null;
        refreshLibrary();
        return notify(`Couldn't delete: ${firstLine(err.message)}`, true, 4000);
      }
      hiddenDeletes.delete(id);
      saveQueue();
      libraryKey = null;
      refreshLibrary();
    },
  });
}
function deleteLibraryEntry(entry) {
  deleteFile(entry.id, entry.title);
}
