/* MinimalTube player - Saved playlists: loading one into the queue and the "Save as playlist" dialog.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Saved playlists
 *
 * They live on the server (playlists.json) and appear on the Playlists tab.
 * Loading one REPLACES the queue, so an unsaved queue is gone. Separate from
 * "Remember queue between sessions": it never touches `savedQueue`.
 * ===================================================================== */
const byId = (id) => document.getElementById(id);
const ICON_PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_ADDLIST =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h12v2H3zM3 11h12v2H3zM3 16h8v2H3zM18 13v3h-3v2h3v3h2v-3h3v-2h-3v-3z"/></svg>';
const ICON_NEXT =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h11v2H3zM3 11h11v2H3zM3 16h7v2H3zM16 10v8l6-4z"/></svg>';
const savePlBtn = byId("savePlBtn"),
  savePlModal = byId("savePlModal"),
  savePlTitle = byId("savePlTitle"),
  savePlSub = byId("savePlSub"),
  savePlName = byId("savePlName"),
  savePlHint = byId("savePlHint"),
  savePlConfirm = byId("savePlConfirm"),
  savePlCancel = byId("savePlCancel");
let savedPlaylists = [],
  savePlPending = null; // {items, title, sub} when creating a playlist from a single video

function findSavedByName(name) {
  const key = name.trim().toLowerCase();
  return key
    ? savedPlaylists.find(
        (playlist) => (playlist.name || "").toLowerCase() === key,
      )
    : null;
}
const hiddenPlaylists = new Set(); // deleted, while their Undo bar is up
async function loadSavedPlaylists() {
  try {
    const data = await api("/playlists");
    if (sortDragging) return;
    savedPlaylists = (Array.isArray(data.playlists) ? data.playlists : []).filter(
      (pl) => !hiddenPlaylists.has(pl.id),
    );
    renderPlaylistCards();
    if (queue && queue.playlistId) queuePlName.textContent = (savedPlaylists.find((playlist) => playlist.id === queue.playlistId) || {}).name || "";
  } catch (err) {
    logQuiet("playlists", err);
  }
}

function loadPlaylistIntoQueue(pl, startIndex = 0) {
  const items = (pl.items || []).map((entry) => ({
    id: entry.id,
    title: entry.title || entry.url,
    url: entry.url,
  }));
  if (!items.length) return notify("This playlist is empty", true, 3000);
  queueAddToken++; // abandon any playlist/URL still being resolved for the old queue
  playSource = "queue";
  const start = Math.min(Math.max(0, startIndex), items.length - 1);
  queue = {
    items,
    currentIndex: start,
    playlistId: pl.id,
  };
  linkedPlaylistKey = playlistSyncKey(pl.id, items);
  queue.items.forEach((item, index) => (item.index = index + 1));
  queueIndex = start;
  resetDownloadAllButton();
  renderQueue();
  queuePanel.classList.add("open");
  queueToggleBtn.classList.add("active");
  refreshLibrary();
  markActiveQueueRow();
  scrollActiveQueueRowIntoView();
  startQueuePolling();
  prefetchNextInQueue();
  saveQueue();
  notify(`Loaded playlist: ${pl.name}`);
  playVideo(items[start].url);
}
// Gone at once; deleted on the server when its Undo bar goes.
function deleteSavedPlaylist(pl) {
  const at = savedPlaylists.findIndex((playlist) => playlist.id === pl.id);
  if (at < 0) return;
  const linked = queue && queue.playlistId === pl.id ? queue : null;
  hiddenPlaylists.add(pl.id);
  savedPlaylists.splice(at, 1);
  if (linked) {
    linked.playlistId = null;
    renderQueue();
    saveQueue();
  }
  renderPlaylistCards();
  const restore = () => {
    hiddenPlaylists.delete(pl.id);
    if (!savedPlaylists.some((playlist) => playlist.id === pl.id))
      savedPlaylists.splice(Math.min(at, savedPlaylists.length), 0, pl);
    if (linked && queue === linked && !linked.playlistId) {
      linked.playlistId = pl.id;
      renderQueue();
      saveQueue();
    }
    renderPlaylistCards();
  };
  offerUndo(`Playlist “${pl.name}” deleted`, {
    undo: restore,
    commit: async () => {
      try {
        await api(`/playlists/${encodeURIComponent(pl.id)}`, { method: "DELETE", keepalive: true });
        hiddenPlaylists.delete(pl.id);
      } catch (err) {
        restore();
        notify(`Couldn't delete playlist: ${firstLine(err.message)}`, true, 4000);
      }
    },
  });
}

/* ---------- name popup ---------- */
function refreshSavePlHint() {
  const exists = findSavedByName(savePlName.value);
  if (savePlPending && !savePlPending.allowReplace) {
    // Creating a playlist from one video must never overwrite an existing playlist.
    savePlHint.textContent = exists
      ? `"${exists.name}" already exists - choose another name (or use "Save to playlist").`
      : "";
    savePlConfirm.textContent = "Create";
    savePlConfirm.disabled = !!exists;
    return;
  }
  savePlHint.textContent = exists
    ? `"${exists.name}" already exists - saving will replace it.`
    : "";
  savePlConfirm.textContent = exists ? "Replace" : "Save";
  savePlConfirm.disabled = false;
}
function savePlKeys(event) {
  // While the popup is open it owns the keyboard: nothing reaches the
  // player shortcuts (Space, arrows, F, M, ...) or the panel's Escape handler.
  event.stopPropagation();
  if (event.type !== "keydown") return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeSavePlaylist();
  } else if (
    event.key === "Enter" &&
    event.target === savePlName &&
    !event.isComposing
  ) {
    event.preventDefault();
    submitSavePlaylist();
  }
}

// opts omitted: save the current queue. opts = {items, title, sub}: create from those videos.
function openSavePlaylist(opts) {
  savePlPending = opts && opts.items ? opts : null;
  if (!savePlPending && (!queue || !queue.items.length))
    return notify("The queue is empty", true, 2500);
  closeRowMenu();
  closeBpMenu();
  savePlTitle.textContent = savePlPending
    ? savePlPending.title
    : "Save queue as playlist";
  savePlSub.textContent = savePlPending
    ? savePlPending.sub
    : `${queue.items.length} video${queue.items.length === 1 ? "" : "s"} from the current queue`;
  savePlName.value = "";
  refreshSavePlHint();
  savePlModal.classList.add("open");
  document.addEventListener("keydown", savePlKeys, true);
  document.addEventListener("keyup", savePlKeys, true);
  savePlName.focus();
}
// From a YouTube playlist page: it replaces whatever is playing and queued, nothing starts, and
// the "Save as playlist" dialog opens; its videos play from the queue whenever you like.
function takeYouTubePlaylist(pl) {
  queueAddToken++;
  if (currentVideoId) stopPlayback();
  setQueueFromPlaylist({ items: pl.items, currentIndex: -1 });
  offerSaveYouTubePlaylist(pl);
}
async function offerSaveYouTubePlaylist(pl) {
  try {
    await loadSavedPlaylists(); // so an existing name is recognised
  } catch {}
  const count = pl.items.length;
  openSavePlaylist({
    items: pl.items.map((item) => ({
      id: null,
      title: item.title,
      url: item.url,
    })),
    title: "Save as playlist",
    sub:
      `${count} video${count === 1 ? "" : "s"} from the YouTube playlist` +
      (pl.name ? ` "${pl.name}"` : ""),
    allowReplace: true,
    ytListId: pl.listId || null,
  });
  savePlName.value = pl.name || "";
  refreshSavePlHint();
  savePlName.select();
}
function closeSavePlaylist() {
  savePlModal.classList.remove("open");
  savePlPending = null;
  document.removeEventListener("keydown", savePlKeys, true);
  document.removeEventListener("keyup", savePlKeys, true);
}
async function submitSavePlaylist() {
  const name = savePlName.value.trim();
  if (!name) return savePlName.focus();
  if (savePlConfirm.disabled) return;
  let items;
  if (savePlPending) items = savePlPending.items;
  else {
    if (!queue || !queue.items.length) return closeSavePlaylist();
    items = queue.items.map((item) => ({
      id: itemVideoId(item) || null,
      title: item.title,
      url: item.url,
    }));
  }
  const fromQueue = !savePlPending,
    savedQueueObj = queue,
    ytListId = savePlPending && savePlPending.ytListId,
    pendingIds = items
      .map((item) => item.id || videoIdFromUrl(item.url))
      .join();
  const replacing =
    (!savePlPending || !!savePlPending.allowReplace) && !!findSavedByName(name);
  savePlConfirm.disabled = true;
  try {
    const data = await api("/playlists", {
      method: "POST",
      body: { name, items, overwrite: replacing },
    });
    closeSavePlaylist();
    if (fromQueue && data.playlist && queue && queue === savedQueueObj) {
      queue.playlistId = data.playlist.id;
      linkedPlaylistKey = playlistSyncKey(queue.playlistId, queue.items);
    }
    const skipped = data.skipped || 0;
    notify(
      `${data.replaced ? "Updated" : "Saved"} playlist: ${name}` +
        (skipped
          ? ` (${skipped} unresolved video${skipped === 1 ? "" : "s"} skipped)`
          : ""),
      false,
      skipped ? 3500 : 2500,
    );
    await loadSavedPlaylists();
    if (fromQueue) {
      renderQueue();
      saveQueue();
    }
    if (ytListId && data.playlist)
      linkYouTubePlaylist(data.playlist.id, ytListId, pendingIds);
  } catch (err) {
    notify(`Couldn't save playlist: ${firstLine(err.message)}`, true, 4000);
  } finally {
    savePlConfirm.disabled = false;
  }
}
savePlBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  openSavePlaylist();
});
savePlName.addEventListener("input", refreshSavePlHint);
savePlConfirm.addEventListener("click", submitSavePlaylist);
savePlCancel.addEventListener("click", closeSavePlaylist);
savePlModal.addEventListener("mousedown", (event) => {
  if (event.target === savePlModal) closeSavePlaylist(); // click on the dimmed backdrop
});
