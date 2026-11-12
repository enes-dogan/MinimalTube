/* MinimalTube background - a saved playlist linked to one on the YouTube account stays the same
 * on both sides: a three-way merge of what the playlist held at the last sync (`base`), what it
 * holds here and what it holds on YouTube.
 * Loaded by background.js (importScripts: one scope with the other background files). */

const YT_SYNC_LIST_RE = /^(?!LL$)[A-Za-z0-9_-]{2,64}$/,
  PLAYLIST_ID_RE = /^[0-9a-f]{12}$/;

const putPlaylist = (playlistId, part, body) => serverJson(`/playlists/${playlistId}/${part}`, { method: "PUT", body });

async function getSavedPlaylist(id) {
  const data = await serverJson("/playlists");
  return (data.playlists || []).find((playlist) => playlist.id === id) || null;
}

// What of a YouTube playlist can be kept in a saved one: playable videos, each once.
function syncableItems(items) {
  const seen = new Set();
  return items.filter((item) => item.playable && !seen.has(item.videoId) && seen.add(item.videoId));
}

function ytItemToEntry(item) {
  return { id: item.videoId, title: item.title, url: watchUrl(item.videoId), duration: item.duration };
}

/**
 * The three-way merge of a playlist's video ids.
 * @param {string[]} base What both sides held at the last sync.
 * @param {string[]} local What the saved playlist holds now.
 * @param {string[]} remote What the YouTube playlist holds now.
 * @returns {string[]} The order both sides should end up with: a video removed on either side
 *   is gone, one added on either side is there (next to its neighbour on that side), and the
 *   order follows the side that reordered (YouTube's when both did).
 */
function mergePlaylist(base, local, remote) {
  const localSet = new Set(local),
    remoteSet = new Set(remote);
  const removed = new Set(base.filter((id) => !localSet.has(id) || !remoteSet.has(id)));
  const common = base.filter((id) => !removed.has(id));
  const commonSet = new Set(common);
  const sameOrder = (list) => list.filter((id) => commonSet.has(id)).join() === common.join();
  const primary = !sameOrder(remote) || sameOrder(local) ? remote : local;
  const other = primary === remote ? local : remote;
  const result = primary.filter((id) => !removed.has(id));
  const inResult = new Set(result);
  other.forEach((id, index) => {
    if (inResult.has(id) || removed.has(id)) return;
    let at = 0;
    for (let k = index - 1; k >= 0; k--) {
      const pos = result.indexOf(other[k]);
      if (pos >= 0) {
        at = pos + 1;
        break;
      }
    }
    result.splice(at, 0, id);
    inResult.add(id);
  });
  return result;
}

// The "move this video before that one" edits that put YouTube's playlist in the target order.
function playlistMoves(target, current) {
  const wanted = new Set(target);
  const list = current.filter((item) => wanted.has(item.videoId));
  const actions = [];
  target.forEach((id, i) => {
    if (!list[i] || list[i].videoId === id) return;
    const from = list.findIndex((item) => item.videoId === id);
    if (from < 0) return;
    const successor = list[i];
    const [moved] = list.splice(from, 1);
    list.splice(i, 0, moved);
    actions.push({
      action: "ACTION_MOVE_VIDEO_BEFORE",
      setVideoId: moved.setVideoId,
      movedSetVideoIdSuccessor: successor.setVideoId,
    });
  });
  return actions;
}

// A saved playlist just made from a YouTube playlist the account owns: it takes that playlist's
// videos and is linked to it from then on.
async function linkPlaylistToYouTube(playlistId, listId) {
  if (!YT_SYNC_LIST_RE.test(listId)) return { ok: false, error: "this list can't be synced" };
  const remote = await ytFetchPlaylist(listId);
  if (!remote.editable) return { ok: false, error: "not your playlist" };
  const saved = await putPlaylist(playlistId, "items", { items: syncableItems(remote.items).map(ytItemToEntry) });
  await putPlaylist(playlistId, "yt", { yt: { list_id: listId, base: saved.playlist.items.map((item) => item.id) } });
  return { ok: true, changed: true };
}

// The playlist-page button: read every video through YouTube's own API (youtube.js) and open
// them as the queue, offering to save them as a MinimalTube playlist.
async function openYouTubePlaylist(listId, name) {
  const remote = await ytFetchPlaylist(listId, { signedIn: false, max: YT_PLAYLIST_READ_MAX });
  const items = syncableItems(remote.items).map(ytItemToEntry);
  if (!items.length) throw new Error("no playable videos in this playlist");
  return openPlaylistToSave({ items, currentIndex: -1, savePrompt: true, name, listId });
}

async function syncPlaylistWithYouTube(playlistId) {
  const pl = await getSavedPlaylist(playlistId);
  if (!pl || !pl.yt) return { ok: true, changed: false };
  const listId = pl.yt.list_id;
  let remote = await ytFetchPlaylist(listId);
  if (!remote.editable) throw new Error("this account can't edit the YouTube playlist");
  const local = pl.items.map((item) => item.id);
  const remoteItems = syncableItems(remote.items);
  const remoteIds = remoteItems.map((item) => item.videoId);
  const base = pl.yt.base || [];
  if (!remoteIds.length && base.length > 1) throw new Error("YouTube returned an empty playlist, skipped");
  const target = mergePlaylist(base, local, remoteIds);
  const targetSet = new Set(target),
    remoteSet = new Set(remoteIds);
  const edits = [
    ...remote.items
      .filter((item) => item.setVideoId && remoteSet.has(item.videoId) && !targetSet.has(item.videoId))
      .map((item) => ({ action: "ACTION_REMOVE_VIDEO", setVideoId: item.setVideoId })),
    ...target.filter((id) => !remoteSet.has(id)).map((id) => ({ action: "ACTION_ADD_VIDEO", addedVideoId: id })),
  ];
  if (edits.length) {
    await ytEditPlaylist(listId, remote.cfg, edits);
    remote = await ytFetchPlaylist(listId);
  }
  const moves = playlistMoves(target, syncableItems(remote.items));
  if (moves.length) await ytEditPlaylist(listId, remote.cfg, moves);
  let newBase = target,
    changed = false;
  if (target.join() !== local.join()) {
    // the saved playlist changed while YouTube was asked: nothing is written, the sync runs again
    const fresh = await getSavedPlaylist(playlistId);
    if (!fresh || fresh.items.map((item) => item.id).join() !== local.join()) return { ok: false, retry: true };
    const own = new Map(pl.items.map((item) => [item.id, item]));
    const fromYt = new Map(remoteItems.map((item) => [item.videoId, item]));
    const saved = await putPlaylist(playlistId, "items", {
      items: target.map((id) => {
        const item = own.get(id);
        return item ? { id, title: item.title, url: item.url, duration: item.duration } : ytItemToEntry(fromYt.get(id));
      }),
    });
    newBase = saved.playlist.items.map((item) => item.id);
    changed = true;
  }
  await putPlaylist(playlistId, "yt", { yt: { list_id: listId, base: newBase } });
  return { ok: true, changed };
}

// One sync at a time, in the order they were asked for.
let ytSyncChain = Promise.resolve();
function runYtPlaylistTask(task) {
  const run = ytSyncChain.then(task, task).catch((err) => {
    console.warn("MinimalTube: YouTube playlist sync failed:", err);
    return { ok: false, error: errorText(err) };
  });
  ytSyncChain = run;
  return run;
}

// Playlists whose sync didn't reach YouTube (no connection): synced again, one after another,
// when the player reports the connection is back or the browser starts. Nothing is lost in
// between: the edits wait in the saved playlist and the three-way merge applies them.
const YT_SYNC_PENDING_KEY = "ytSyncPending";
async function setYtSyncPending(playlistId, pending) {
  const stored = await chrome.storage.local.get([YT_SYNC_PENDING_KEY]);
  const ids = new Set(stored[YT_SYNC_PENDING_KEY] || []);
  if (pending === ids.has(playlistId)) return;
  if (pending) ids.add(playlistId);
  else ids.delete(playlistId);
  await chrome.storage.local.set({ [YT_SYNC_PENDING_KEY]: [...ids] });
}
function syncPlaylistTask(playlistId) {
  return runYtPlaylistTask(async () => {
    try {
      const res = await syncPlaylistWithYouTube(playlistId);
      await setYtSyncPending(playlistId, false);
      return res;
    } catch (err) {
      if (err && err.name === "TypeError") await setYtSyncPending(playlistId, true); // fetch failed
      throw err;
    }
  });
}
async function flushYtSyncPending() {
  const stored = await chrome.storage.local.get([YT_SYNC_PENDING_KEY]);
  (stored[YT_SYNC_PENDING_KEY] || []).forEach((id) => syncPlaylistTask(id));
}
chrome.runtime.onStartup.addListener(() => flushYtSyncPending());
