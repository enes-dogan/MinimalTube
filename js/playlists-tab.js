/* MinimalTube player - The Playlists tab: reordering card grids, a playlist's page and YouTube playlist sync.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* ---------- Playlists tab ---------- */
/* ---- Reorder a card grid (saved playlists, a playlist's videos, downloads): press and hold
 * a card (or drag it), move it over another spot and let go. The cards in between shift by
 * one place. Works across rows. ---- */
function makeGridSortable(grid, cardSelector, canSort, onMove) {
  grid.addEventListener("dragstart", (event) => event.preventDefault());
  grid.addEventListener(
    "click",
    (event) => {
      if (grid._dragged) {
        event.stopPropagation();
        event.preventDefault();
      }
    },
    true,
  );
  grid.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const card = event.target.closest(cardSelector);
    if (!card || card.parentElement !== grid || !canSort()) return;
    const startX = event.clientX,
      startY = event.clientY;
    let started = false,
      timer = setTimeout(begin, 220);
    function cleanup() {
      clearTimeout(timer);
      document.removeEventListener("pointermove", pre);
      document.removeEventListener("pointerup", cleanup);
      document.removeEventListener("pointercancel", cleanup);
    }
    function pre(ev) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) begin();
    }
    function begin() {
      if (started) return;
      started = true;
      clearTimeout(timer);
      document.removeEventListener("pointermove", pre);
      document.removeEventListener("pointerup", cleanup);
      document.removeEventListener("pointercancel", cleanup);
      startGridDrag(grid, cardSelector, card, startX, startY, onMove);
    }
    document.addEventListener("pointermove", pre);
    document.addEventListener("pointerup", cleanup);
    document.addEventListener("pointercancel", cleanup);
  });
}
function startGridDrag(grid, cardSelector, card, startX, startY, onMove) {
  closeBpMenu();
  const cards = Array.from(grid.children).filter((other) =>
      other.matches(cardSelector),
    ),
    from = cards.indexOf(card);
  if (from < 0) return;
  const sc = browseBody;
  // positions in content coordinates, so scrolling while dragging keeps working
  const slots = cards.map((other) => {
    const rect = other.getBoundingClientRect();
    return {
      x: rect.left + sc.scrollLeft,
      y: rect.top + sc.scrollTop,
      w: rect.width,
      h: rect.height,
    };
  });
  const startCX = startX + sc.scrollLeft,
    startCY = startY + sc.scrollTop;
  let px = startX,
    py = startY,
    to = from,
    raf = 0,
    done = false;
  sortDragging = true;
  grid.classList.add("sorting");
  card.classList.add("dragging");
  document.body.style.cursor = "grabbing";
  function update() {
    const cx = px + sc.scrollLeft,
      cy = py + sc.scrollTop,
      dx = cx - startCX,
      dy = cy - startCY;
    card.style.transform = `translate(${dx}px, ${dy}px) scale(1.03)`;
    // the slot whose centre is nearest to the card's centre
    const mx = slots[from].x + slots[from].w / 2 + dx,
      my = slots[from].y + slots[from].h / 2 + dy;
    let best = from,
      bestD = Infinity;
    slots.forEach((slot, idx) => {
      const value = Math.hypot(
        slot.x + slot.w / 2 - mx,
        slot.y + slot.h / 2 - my,
      );
      if (value < bestD) {
        bestD = value;
        best = idx;
      }
    });
    to = best;
    cards.forEach((other, idx) => {
      if (idx === from) return;
      let target = idx;
      if (to > from && idx > from && idx <= to) target = idx - 1;
      else if (to < from && idx >= to && idx < from) target = idx + 1;
      other.style.transform =
        target === idx
          ? ""
          : `translate(${slots[target].x - slots[idx].x}px, ${slots[target].y - slots[idx].y}px)`;
    });
  }
  function autoScroll() {
    if (done) return;
    const rect = sc.getBoundingClientRect(),
      edge = 60;
    let delta = 0;
    if (py < rect.top + edge) delta = -Math.ceil((rect.top + edge - py) / 4);
    else if (py > rect.bottom - edge)
      delta = Math.ceil((py - (rect.bottom - edge)) / 4);
    if (delta) {
      sc.scrollTop += Math.max(-20, Math.min(20, delta));
      update();
    }
    raf = requestAnimationFrame(autoScroll);
  }
  function finish(commit) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("keydown", onKey, true);
    cards.forEach((other) => (other.style.transform = ""));
    card.classList.remove("dragging");
    grid.classList.remove("sorting");
    document.body.style.cursor = "";
    sortDragging = false;
    grid._dragged = true;
    setTimeout(() => (grid._dragged = false), 0);
    if (commit && to !== from) onMove(from, to);
  }
  const onPointerMove = (event) => {
    px = event.clientX;
    py = event.clientY;
    update();
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
  document.addEventListener("keydown", onKey, true);
  raf = requestAnimationFrame(autoScroll);
  update();
}
function movePlaylist(from, to) {
  const [moved] = savedPlaylists.splice(from, 1);
  savedPlaylists.splice(to, 0, moved);
  renderPlaylistCards();
  api("/playlists/order", {
    method: "POST",
    body: { ids: savedPlaylists.map((playlist) => playlist.id) },
  })
    .catch((err) =>
      notify(
        `Couldn't save the playlist order: ${netMessage(firstLine(err.message))}`,
        true,
        4000,
      ),
    );
}
makeGridSortable(
  plGrid,
  ".vCard[data-plid]",
  () => savedPlaylists.length > 1,
  movePlaylist,
);

function renderPlaylistCards() {
  renderPlaylistPage();
  plGrid.innerHTML = "";
  if (!savedPlaylists.length) {
    const empty = document.createElement("div");
    empty.className = "bpEmpty";
    empty.textContent =
      "No saved playlists yet. Use + in the queue panel to save the current queue, or ⋮ on any video → Save to playlist.";
    plGrid.appendChild(empty);
    return;
  }
  savedPlaylists.forEach((pl) => {
    const count = pl.count ?? (pl.items || []).length;
    const first = (pl.items || [])[0];
    const play = () => {
      exitBrowse();
      loadPlaylistIntoQueue(pl);
    };
    const dl = (pl.items || []).filter((item) => item.downloaded).length;
    const sub = el("div", "vSub", `${dl} of ${count} downloaded`);
    if (pl.yt) sub.appendChild(makeYtSyncTag());
    const card = makeCard({
      thumb: first && `${serverBase}/thumb/${first.id}`,
      fallback: first && first.thumbnail,
      badge: `${count} video${count === 1 ? "" : "s"}`,
      title: pl.name,
      lines: [sub],
      open: () => openPlaylistPage(pl.id),
      menu: () => [
        {
          label: "Load to queue",
          key: "L",
          icon: ICON_PLAY,
          onClick: play,
        },
        pl.yt && {
          label: "Sync with YouTube now",
          key: "S",
          icon: ICON_SYNC,
          onClick: () => requestYtSync(pl.id, true),
        },
        pl.yt && {
          label: "Unlink from YouTube",
          key: "U",
          icon: ICON_UNLINK,
          onClick: () => unlinkYouTubePlaylist(pl),
        },
        {
          label: "Delete",
          key: "D",
          icon: ICON_TRASH,
          danger: true,
          onClick: () => deleteSavedPlaylist(pl),
        },
      ],
    });
    card.dataset.plid = pl.id;
    plGrid.appendChild(card);
  });
}

const plItemsGrid = byId("plItemsGrid"),
  plHeadTitle = byId("plHeadTitle"),
  plHeadSub = byId("plHeadSub"),
  plPlayAll = byId("plPlayAll");
let openPlaylistId = null;
const openPlaylist = () =>
  openPlaylistId
    ? savedPlaylists.find((playlist) => playlist.id === openPlaylistId)
    : null;

function openPlaylistPage(id) {
  openPlaylistId = id;
  closeBpMenu();
  renderPlaylistPage();
  browseBody.scrollTop = 0;
  if (isYtLinked(id)) requestYtSync(id);
}
function closePlaylistPage() {
  if (!openPlaylistId) return;
  openPlaylistId = null;
  closeBpMenu();
  renderPlaylistPage();
  browseBody.scrollTop = 0;
}
byId("plBack").addEventListener("click", closePlaylistPage);
plPlayAll.addEventListener("click", () => {
  const pl = openPlaylist();
  if (!pl) return;
  exitBrowse();
  loadPlaylistIntoQueue(pl);
});

function renderPlaylistPage() {
  const pl = openPlaylist();
  if (!pl) openPlaylistId = null;
  plView.classList.toggle("detail", !!openPlaylistId);
  if (!pl) return;
  if (bpMenuAnchor && plItemsGrid.contains(bpMenuAnchor)) closeBpMenu();
  const items = pl.items || [],
    dl = items.filter((item) => item.downloaded).length;
  plHeadTitle.textContent = pl.name;
  plHeadTitle.title = pl.name;
  plHeadSub.textContent = `${items.length} video${
    items.length === 1 ? "" : "s"
  } · ${dl} downloaded`;
  if (pl.yt) plHeadSub.appendChild(makeYtSyncTag());
  plPlayAll.disabled = !items.length;
  plItemsGrid.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "bpEmpty";
    empty.textContent =
      "This playlist is empty. Use ⋮ on any video → Save to playlist.";
    plItemsGrid.appendChild(empty);
    return;
  }
  items.forEach((item, idx) =>
    plItemsGrid.appendChild(makePlaylistItemCard(pl, item, idx)),
  );
  wantCardInfo(pl);
}
// Channel, views and upload day for the cards whose videos the server has no saved info on
// yet: it looks them up in the background, and the cards fill in as the answers come.
const cardInfoAsked = new Map(); // video id -> when last asked
async function wantCardInfo(pl, tries = 0) {
  const now = Date.now(),
    missing = (pl.items || []).filter(
      (item) =>
        (!item.channel || !item.channel_id || item.views == null || !item.timestamp) &&
        now - (cardInfoAsked.get(item.id) || 0) > 2500,
    ),
    batch = missing.slice(0, 200);
  if (!batch.length) return;
  batch.forEach((item) => cardInfoAsked.set(item.id, now));
  let data;
  try {
    data = await api(`/info?ids=${batch.map((item) => item.id).join(",")}`);
  } catch (err) {
    return logQuiet("card info", err);
  }
  batch.forEach((item) => {
    const info = (data.info || {})[item.id];
    if (!info) return;
    Object.entries(info).forEach(([key, value]) => value != null && (item[key] = value));
    const text = plItemsGrid.querySelector(`.vCard[data-vid="${item.id}"] .vText`);
    if (!text || openPlaylistId !== pl.id) return;
    text.querySelectorAll(".vSub").forEach((line) => line.remove());
    text.append(...videoCardLines(item));
  });
  if ((data.pending || missing.length > batch.length) && tries < 20)
    setTimeout(() => {
      const open = openPlaylist();
      if (open && open.id === pl.id) wantCardInfo(open, tries + 1);
    }, 3000);
}
function makePlaylistItemCard(pl, item, idx) {
  const play = () => {
    exitBrowse();
    loadPlaylistIntoQueue(pl, idx);
  };
  const card = makeCard({
    thumb: `${serverBase}/thumb/${item.id}`,
    fallback: item.thumbnail,
    videoId: item.id,
    badge: item.duration ? fmtDur(item.duration) : null,
    video: item,
    title: item.title || item.url,
    lines: videoCardLines(item),
    open: play,
    className: item.id === currentVideoId ? "playing" : "",
    menu: () => [
      {
        label: "Play from here",
        key: "P",
        icon: ICON_PLAY,
        onClick: play,
      },
      {
        label: "Add next to queue",
        key: "Q",
        icon: ICON_NEXT,
        onClick: () => queueVideoNext(item),
      },
      channelEntry(item.id, item),
      downloadEntryFor(item),
      {
        separator: true,
      },
      {
        label: "Remove from playlist",
        key: "D",
        icon: ICON_REMOVE,
        onClick: () => removeFromPlaylist(pl, item),
      },
    ],
  });
  card.dataset.vid = item.id;
  const position = el("span", "vBadge num", String(idx + 1));
  position.title = `${idx + 1} of ${(pl.items || []).length}`;
  card._thumb.appendChild(position);
  return card;
}
function applySavedPlaylist(updated, follow = true) {
  if (!updated) return;
  const at = savedPlaylists.findIndex(
    (playlist) => playlist.id === updated.id,
  );
  if (at >= 0) savedPlaylists[at] = updated;
  if (follow) queueFollowPlaylist(updated);
  scheduleYtSync(updated.id);
}
async function savePlaylistItemsOrder(pl) {
  try {
    await api(`/playlists/${encodeURIComponent(pl.id)}/items/order`, {
      method: "POST",
      body: { ids: pl.items.map((item) => item.id) },
    });
    scheduleYtSync(pl.id);
  } catch (err) {
    notify(
      `Couldn't save the video order: ${firstLine(err.message)}`,
      true,
      4000,
    );
    loadSavedPlaylists();
  }
}
function movePlaylistItem(from, to) {
  const pl = openPlaylist();
  if (!pl || !pl.items) return;
  const [moved] = pl.items.splice(from, 1);
  pl.items.splice(to, 0, moved);
  renderPlaylistCards();
  queueFollowPlaylist(pl);
  savePlaylistItemsOrder(pl);
}
function removeFromPlaylist(pl, item) {
  const local = savedPlaylists.find((playlist) => playlist.id === pl.id) || pl;
  const at = (local.items || []).findIndex((other) => other.id === item.id);
  if (at < 0) return;
  local.items.splice(at, 1);
  local.count = local.items.length;
  renderPlaylistCards();
  offerUndo(`“${item.title || item.url}” removed from ${pl.name}`, {
    undo: () => {
      const current = savedPlaylists.find((playlist) => playlist.id === pl.id);
      if (!current || current.items.some((other) => other.id === item.id)) return;
      current.items.splice(Math.min(at, current.items.length), 0, item);
      current.count = current.items.length;
      renderPlaylistCards();
    },
    commit: async () => {
      try {
        const data = await api(
          `/playlists/${encodeURIComponent(pl.id)}/items/${encodeURIComponent(item.id)}`,
          { method: "DELETE", keepalive: true },
        );
        applySavedPlaylist(data.playlist);
        renderPlaylistCards();
      } catch (err) {
        notify(`Couldn't remove the video: ${netMessage(firstLine(err.message))}`, true, 4000);
        loadSavedPlaylists();
      }
    },
  });
}
makeGridSortable(
  plItemsGrid,
  ".vCard[data-vid]",
  () => {
    const pl = openPlaylist();
    return !!pl && (pl.items || []).length > 1;
  },
  movePlaylistItem,
);
const ICON_SYNC =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';
const ICON_UNLINK =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1 0 1.43-.98 2.63-2.31 2.98l1.46 1.46C20.88 15.61 22 13.95 22 12c0-2.76-2.24-5-5-5zm-1 4h-2.19l2 2H16v-2zM2 4.27l3.11 3.11A4.99 4.99 0 0 0 2 12c0 2.76 2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1 0-1.59 1.21-2.9 2.76-3.07L8.73 11H8v2h2.73L13 15.27V17h1.73l4.01 4L20 19.74 3.27 3 2 4.27z"/></svg>';
const YT_SYNC_EVERY_MS = 10 * 60 * 1000;
const ytSyncTimers = new Map();
const isYtLinked = (id) =>
  savedPlaylists.some((playlist) => playlist.id === id && playlist.yt);

function makeYtSyncTag() {
  const tag = document.createElement("span");
  tag.className = "ytSyncTag";
  tag.title = "Kept in sync with the playlist on your YouTube account";
  tag.innerHTML = ICON_SYNC;
  tag.append("YouTube");
  return tag;
}
async function followSyncedPlaylist(playlistId) {
  await loadSavedPlaylists();
  queueFollowPlaylist(
    savedPlaylists.find((playlist) => playlist.id === playlistId),
  );
}
function linkYouTubePlaylist(playlistId, listId, pendingIds) {
  chrome.runtime.sendMessage(
    {
      type: "minimaltube-yt-link",
      playlistId,
      listId,
    },
    (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        notify(
          `Saved, but not synced with YouTube: ${
            (res && res.error) || "the extension didn't answer"
          }`,
          true,
          6000,
        );
        return;
      }
      if (
        queue &&
        !queue.playlistId &&
        queue.items.map(itemVideoId).join() === pendingIds
      ) {
        queue.playlistId = playlistId;
        linkedPlaylistKey = playlistSyncKey(playlistId, queue.items);
      }
      followSyncedPlaylist(playlistId);
    },
  );
}
function requestYtSync(playlistId, manual = false) {
  clearTimeout(ytSyncTimers.get(playlistId));
  ytSyncTimers.delete(playlistId);
  chrome.runtime.sendMessage(
    {
      type: "minimaltube-yt-sync",
      playlistId,
    },
    async (res) => {
      if (chrome.runtime.lastError || !res) {
        if (manual)
          notify(
            "Couldn't sync with YouTube: the extension didn't answer",
            true,
            4000,
          );
        return;
      }
      if (res.retry) return scheduleYtSync(playlistId);
      if (!res.ok) {
        if (manual)
          notify(`Couldn't sync with YouTube: ${netMessage(res.error)}`, true, 5000);
        return;
      }
      if (res.changed) await followSyncedPlaylist(playlistId);
      if (manual) notify("Synced with YouTube");
    },
  );
}
function scheduleYtSync(playlistId, delay = 3000) {
  if (!isYtLinked(playlistId)) return;
  clearTimeout(ytSyncTimers.get(playlistId));
  ytSyncTimers.set(
    playlistId,
    setTimeout(() => requestYtSync(playlistId), delay),
  );
}
function syncAllYtPlaylists() {
  savedPlaylists
    .filter((playlist) => playlist.yt)
    .forEach((playlist) => requestYtSync(playlist.id));
}
async function unlinkYouTubePlaylist(pl) {
  try {
    const data = await api(`/playlists/${encodeURIComponent(pl.id)}/yt`, {
      method: "PUT",
      body: { yt: null },
    });
    applySavedPlaylist(data.playlist, false);
    renderPlaylistCards();
    notify(`Unlinked ${pl.name} from YouTube`);
  } catch (err) {
    notify(`Couldn't unlink: ${firstLine(err.message)}`, true, 4000);
  }
}
whenLoaded(() => loadSavedPlaylists().then(syncAllYtPlaylists));
setInterval(syncAllYtPlaylists, YT_SYNC_EVERY_MS);
