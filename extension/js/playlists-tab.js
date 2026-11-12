/* MinimalTube player - The Playlists tab: the playlists' cards, a playlist's page and YouTube playlist sync.
 * Loaded in order by player.html (classic scripts sharing one scope). */

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
makeSortable(plGrid, { item: ".vCard[data-plid]", scroller: browseBody, canSort: () => savedPlaylists.length > 1, onMove: movePlaylist });

function renderPlaylistCards() {
  renderPlaylistPage();
  plGrid.innerHTML = "";
  if (!savedPlaylists.length) {
    plGrid.appendChild(
      el("div", "bpEmpty", "No saved playlists yet. Use + in the queue panel to save the current queue, or ⋮ on any video → Save to playlist."),
    );
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
      badge: plural(count, "video"),
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
  if (bpMenu.owner && plItemsGrid.contains(bpMenu.owner)) closeBpMenu();
  const items = pl.items || [],
    dl = items.filter((item) => item.downloaded).length;
  plHeadTitle.textContent = pl.name;
  plHeadTitle.title = pl.name;
  plHeadSub.textContent = `${plural(items.length, "video")} · ${dl} downloaded`;
  if (pl.yt) plHeadSub.appendChild(makeYtSyncTag());
  plPlayAll.disabled = !items.length;
  plItemsGrid.innerHTML = "";
  if (!items.length) {
    plItemsGrid.appendChild(el("div", "bpEmpty", "This playlist is empty. Use ⋮ on any video → Save to playlist."));
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
      addNextEntry(item),
      channelEntry(item.id, item),
      downloadEntry(item),
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
makeSortable(plItemsGrid, {
  item: ".vCard[data-vid]",
  scroller: browseBody,
  canSort: () => ((openPlaylist() || {}).items || []).length > 1,
  onMove: movePlaylistItem,
});
const YT_SYNC_EVERY_MS = 10 * 60 * 1000;
const ytSyncTimers = new Map();
const isYtLinked = (id) =>
  savedPlaylists.some((playlist) => playlist.id === id && playlist.yt);

function makeYtSyncTag() {
  const tag = el("span", "ytSyncTag");
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
      // the queue it was saved from is that playlist from now on
      if (queue && !queue.playlistId && queue.items.map(itemVideoId).join() === pendingIds)
        linkQueueToPlaylist(playlistId);
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
