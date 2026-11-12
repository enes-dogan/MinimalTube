/* MinimalTube player - The queue: what plays after what. Its state lives here, and so does every
 * way of changing it: the other files call these functions and never touch `queue` themselves
 * (side-panel.js draws it).
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* ---- State ----
 * queue: null while it's empty, else {items, playlistId}.
 *   An item is {id, title, url, duration, index}. `id` can be missing for a moment (a pasted link
 *   the server hasn't resolved yet: itemVideoId reads it from the link); `index` is its place,
 *   from 1.
 *   `playlistId` set means the queue IS that saved playlist: changes to it are saved to the
 *   playlist ("The saved playlist behind the queue", below) and nothing else may be added to it
 *   (queueLockedReason).
 * A video given to these functions (`v`) is {id, title, url, duration}; `video` is always the
 * page's <video> element. */
let queue = null,
  queueIndex = -1, // the item that is playing (or was, last); -1: none of them
  queueAddToken = 0, // bumped when the queue is replaced: a link still loading for the old one gives up
  // "queue" | "library": which list the current video came from; "detour": played on the side
  // of a queue that is a saved playlist (playVideoNow), which carries on after it
  playSource = "queue";

const queueHasItems = () => !!(queue && queue.items.length);
const videoItem = (v) => ({ id: v.id, title: v.title, url: v.url, duration: v.duration || undefined });
function itemVideoId(item) {
  return item.id || videoIdFromUrl(item.url);
}
function queueIndexOfId(videoId) {
  return queue && videoId ? queue.items.findIndex((item) => itemVideoId(item) === videoId) : -1;
}
/**
 * Why videos can't be added to the queue right now: a queue loaded from a saved playlist is that
 * playlist (its changes are saved to it), so adding a video there would add it to the playlist.
 * @returns {string|null} The message to show, or null when adding is fine.
 */
function queueLockedReason() {
  if (!queueHasItems() || !queue.playlistId) return null;
  const pl = savedPlaylists.find((playlist) => playlist.id === queue.playlistId);
  return `${pl ? `"${pl.name}"` : "A"} playlist is open. Clear queue first to add videos to it.`;
}

/**
 * Call after the queue changed in any way: numbers its items, draws it (the playing item
 * marked), gets the item after the playing one ready, and saves it.
 * @param {object} [options]
 * @param {boolean} [options.scroll] Bring the playing item's row into view.
 * @param {boolean} [options.prefetch=true] False: don't get the next item ready.
 * @param {boolean} [options.fresh] The queue has new videos: "Download all" starts over.
 */
function queueChanged({ scroll = false, prefetch = true, fresh = false } = {}) {
  if (queue) queue.items.forEach((item, index) => (item.index = index + 1));
  if (fresh) resetDownloadAllButton();
  renderQueue();
  if (scroll) scrollActiveQueueRowIntoView();
  if (prefetch) prefetchNextInQueue();
  saveQueue();
}

/* ---- Replacing, adding, removing, moving ---- */

/**
 * Replaces the queue.
 * @param {object[]} items Its videos; none clears the queue.
 * @param {object} [options]
 * @param {number} [options.index=-1] The item that is playing (or about to).
 * @param {string|null} [options.playlistId] The saved playlist this queue is.
 * @param {boolean} [options.prefetch=true] As for queueChanged.
 */
function setQueue(items, { index = -1, playlistId = null, prefetch = true } = {}) {
  if (!items || !items.length) return clearQueue();
  playSource = "queue";
  queue = { items: items.map((item) => ({ ...item })), playlistId };
  if (playlistId) linkedPlaylistKey = playlistSyncKey(playlistId, queue.items);
  queueIndex = Math.min(index, queue.items.length - 1);
  queueChanged({ scroll: true, prefetch, fresh: true });
}
function clearQueue() {
  queue = null;
  queueIndex = -1;
  queueChanged({ prefetch: false });
}
// Undo brings the same queue back (while nothing new has been put in it: see renderQueue).
function clearQueueWithUndo() {
  if (!queueHasItems()) return;
  queueAddToken++;
  const old = queue,
    playing = queueIndex >= 0 ? old.items[queueIndex] : null;
  clearQueue();
  offerUndo("Queue cleared", {
    kind: "queue-clear",
    undo: () => {
      queue = old;
      queueIndex = playing && itemVideoId(playing) === currentVideoId ? old.items.indexOf(playing) : -1;
      queueChanged();
    },
    commit: () => {},
  });
}
document.getElementById("clearQueueBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  clearQueueWithUndo();
});

/**
 * Adds videos at the end of the queue. Into an empty queue, the first of them starts playing
 * (unless `autoPlayIfEmpty` is false).
 * @returns {number} Where the first of them is in the queue (-1: there were none).
 */
function appendToQueue(newItems, { autoPlayIfEmpty = true } = {}) {
  if (!newItems || !newItems.length) return -1;
  const wasEmpty = !queueHasItems(),
    starts = wasEmpty && autoPlayIfEmpty;
  if (wasEmpty) queue = { items: [], playlistId: null };
  const firstIndex = queue.items.length;
  newItems.forEach((item) => queue.items.push({ ...item }));
  if (starts) {
    playSource = "queue";
    queueIndex = firstIndex;
  }
  queueChanged({ scroll: starts, fresh: true });
  if (starts) playVideo(queue.items[queueIndex].url);
  else if (!wasEmpty) notify(newItems.length > 1 ? `Added ${newItems.length} to queue` : "Added to queue");
  return firstIndex;
}
function insertAfterPlaying(item) {
  const at = queueIndex >= 0 ? queueIndex + 1 : queue.items.length;
  queue.items.splice(at, 0, item);
  return at;
}
/**
 * "Add next to queue": the video goes in right after the playing one. With nothing in the queue
 * it becomes the queue; when something plays outside any queue, that video becomes the queue's
 * first item and this one its second.
 */
function queueVideoNext(v) {
  const locked = queueLockedReason();
  if (locked) return notify(locked, true, 5000);
  const item = videoItem(v);
  if (!queueHasItems() && currentVideoId && !playerFrame.classList.contains("empty")) {
    const entry = library.find((other) => other.id === currentVideoId);
    const playing = {
      id: currentVideoId,
      title: (entry && entry.title) || titleOverlay.textContent || currentVideoId,
      url: watchUrl(currentVideoId),
      duration: isFinite(video.duration) && video.duration > 0 ? video.duration : undefined,
    };
    playSource = "queue";
    queueIndex = 0;
    appendToQueue(item.id === currentVideoId ? [playing] : [playing, item], { autoPlayIfEmpty: false });
    return notify(`Playing next: ${v.title}`);
  }
  if (!queueHasItems()) {
    appendToQueue([item]); // an empty queue: it simply becomes the queue (and starts playing)
    return notify(`Playing: ${v.title}`);
  }
  insertAfterPlaying(item);
  queueChanged();
  notify(`Playing next: ${v.title}`);
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
  if (!queueHasItems()) return void appendToQueue([item]);
  playSource = "queue";
  queueIndex = insertAfterPlaying(item);
  queueChanged({ scroll: true, fresh: true });
  playVideo(item.url);
}
// A YouTube link opened in the browser (background.js): it plays now, like a card's Play.
function playLinkNow(url) {
  const id = videoIdFromUrl(url);
  if (id && id === currentVideoId && !playerFrame.classList.contains("empty")) return exitBrowse();
  playVideoNow({ id, url, title: url });
}
function moveQueueItem(from, to) {
  if (!queue) return;
  const current = queueIndex >= 0 ? queue.items[queueIndex] : null;
  const [moved] = queue.items.splice(from, 1);
  queue.items.splice(to, 0, moved);
  queueIndex = current ? queue.items.indexOf(current) : -1;
  queueChanged(); // "next" may be another video now: that one is got ready
}
function removeQueueItem(item) {
  if (!queue) return;
  const idx = queue.items.indexOf(item);
  if (idx < 0) return;
  const owner = queue;
  const plName = owner.playlistId && (savedPlaylists.find((playlist) => playlist.id === owner.playlistId) || {}).name;
  if (idx === queueIndex) {
    const keepIndex = queueIndex;
    stopPlayback();
    queueIndex = keepIndex;
  }
  owner.items.splice(idx, 1);
  if (idx < queueIndex) queueIndex--;
  else if (idx === queueIndex) queueIndex = Math.min(idx, owner.items.length) - 1;
  holdLinkedSync = true; // a saved playlist behind the queue isn't told until the Undo bar is gone
  queueChanged();
  const release = () => {
    holdLinkedSync = false;
    if (queue === owner) saveQueue();
  };
  offerUndo(`“${item.title || item.url}” removed from ${plName || "the queue"}`, {
    undo: () => {
      if (queue === owner) {
        const at = Math.min(idx, owner.items.length);
        owner.items.splice(at, 0, item);
        if (at <= queueIndex) queueIndex++;
        queueChanged({ prefetch: false });
      }
      release();
    },
    commit: () => {
      release();
      if (queue === owner && !owner.items.length) clearQueue();
    },
  });
}

/* ---- Links: pasted, opened from YouTube, clicked in a description ---- */

/**
 * Adds a YouTube link to the queue: a video goes in at once (under its link until the server
 * knows its title), a playlist link adds all of its videos. Refused while the queue is a saved
 * playlist.
 * @param {string} rawUrl A YouTube video or playlist link.
 */
async function addUrlToQueue(rawUrl) {
  const locked = queueLockedReason();
  if (locked) return notify(locked, true, 5000);
  const url = stripPlaylistParams(rawUrl),
    token = ++queueAddToken;
  if (!playlistIdFromUrl(url)) {
    const at = appendToQueue([{ title: url, url }]);
    try {
      const job = await prepareVideo(url),
        item = queue && queue.items[at];
      if (item && item.url === url) setQueueItemTitle(item, job.title, job.video_id);
    } catch (err) {
      logQuiet("queue a link", err);
    }
    return;
  }
  notify("Loading playlist…");
  let playlist;
  try {
    playlist = await api(`/playlist?url=${encodeURIComponent(url)}`);
    if (!playlist.items || !playlist.items.length) throw new Error("This playlist is empty.");
  } catch (err) {
    if (token === queueAddToken) notify(`Couldn't load playlist: ${firstLine(err.message)}`, true, 4000);
    return;
  }
  if (token === queueAddToken) appendToQueue(playlist.items);
}
// A YouTube link pasted anywhere in the app (outside text fields), or into the empty queue's
// field, goes into the queue. Anything else is refused with a message.
function queuePastedText(text) {
  const link = youTubeLink(text);
  if (!link) {
    notify("That isn't a YouTube link", true, 3000);
    return false;
  }
  addUrlToQueue(link);
  return true;
}
document.addEventListener("paste", (event) => {
  if (isTypingTarget(event.target)) return;
  const text = event.clipboardData && event.clipboardData.getData("text");
  if (!text || !text.trim()) return;
  event.preventDefault();
  closeSettings();
  queuePastedText(text);
});
function submitQueuePaste() {
  if (queuePasteInput.value.trim() && queuePastedText(queuePasteInput.value)) queuePasteInput.value = "";
}
queuePasteInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitQueuePaste();
});
queuePasteInput.addEventListener("paste", () => setTimeout(submitQueuePaste, 0));

// The server's title comes from a lookup of the video itself (its own language); the one a queue
// item was created with may be a translated one from a channel listing, or just its link.
function setQueueItemTitle(item, title, videoId) {
  if (!item.id && videoId) item.id = videoId;
  if (!title || item.title === title) return;
  item.title = title;
  const titleEl = queueRowOf(item)?.querySelector(".plTitle");
  if (titleEl) {
    titleEl.textContent = title;
    titleEl.title = title;
  }
  saveQueue();
}
function syncQueueTitle(url, title) {
  // every item with that link: the same video can be in the queue twice
  if (queue) queue.items.filter((item) => item.url === url).forEach((item) => setQueueItemTitle(item, title));
}
// The item after the playing one is got ready ahead of time: downloaded, or (Stream only) just
// looked up, so it starts at once when its turn comes.
function prefetchNextInQueue() {
  const next = queue && queueIndex >= 0 ? queue.items[queueIndex + 1] : null;
  if (!next) return;
  prepareVideo(next.url)
    .then((job) => {
      if (job.status !== "ready" && job.status !== "streaming") pollStateSoon();
      setQueueItemTitle(next, job.title, job.video_id);
    })
    .catch((err) => logQuiet("prefetch the next video", err));
}

/* ---- Playing from the queue: a row, Back / Next, "Up next" ---- */

function playQueueItem(index, { scroll = false } = {}) {
  const item = queue && queue.items[index];
  if (!item) return;
  playSource = "queue";
  queueIndex = index;
  markActiveQueueRow();
  if (scroll) scrollActiveQueueRowIntoView();
  playVideo(item.url);
  prefetchNextInQueue();
  saveQueue();
}
function playLibraryEntry(entry) {
  playSource = "library";
  queueIndex = queueIndexOfId(entry.id);
  markActiveQueueRow();
  prefetchNextInQueue();
  playVideo(entry.url || watchUrl(entry.id));
  saveQueue();
}
const queueTarget = (item, scroll = false) => ({
  title: item.title || item.url,
  play: () => playQueueItem(queue ? queue.items.indexOf(item) : -1, { scroll }),
});
function libraryNeighbour(step, title) {
  const index = library.findIndex((entry) => entry.id === currentVideoId),
    entry = index >= 0 ? library[index + step] : null;
  return entry ? { title: entry.title || title, play: () => playLibraryEntry(entry) } : null;
}
/**
 * The video after the current one, in whichever list the current one was started from.
 * @returns {{title: string, play: () => void}|null} null at the end of the list.
 */
function resolveNext() {
  if (playSource === "library") return libraryNeighbour(1, "Next video");
  if (!queue || queueIndex < 0) return null;
  // after a video played on the side of a playlist queue: the playlist goes on where it was left,
  // with the video that was playing, or the one after it if that one was watched to the end
  const interrupted = queue.items[queueIndex],
    next =
      playSource === "detour"
        ? queue.items[queueIndex + (interrupted && watchDone(itemVideoId(interrupted)) ? 1 : 0)]
        : queue.items[queueIndex + 1];
  return next ? queueTarget(next) : null;
}
/** The video before the current one: the mirror of resolveNext. */
function resolvePrev() {
  if (playSource === "detour") return resolveNext(); // either way: back to the playlist
  if (playSource === "library") return libraryNeighbour(-1, "Previous video");
  const prev = queue && queueIndex >= 1 ? queue.items[queueIndex - 1] : null;
  return prev ? queueTarget(prev, true) : null;
}
function skipVideo(direction) {
  cancelUpNext();
  const target = direction > 0 ? resolveNext() : resolvePrev();
  if (!target) return notify(direction > 0 ? "No next video" : "No previous video", false, 1800);
  notify(`${direction > 0 ? "Next" : "Previous"}: ${target.title}`, false, 1800);
  target.play();
}
prevBtn.addEventListener("click", () => skipVideo(-1));
nextBtn.addEventListener("click", () => skipVideo(1));

/* ---- "Remember queue": the queue (and the item that was playing) across sessions ---- */

function saveQueue() {
  syncLinkedPlaylist();
  if (!rememberQueue) return;
  chrome.storage.local.set({
    savedQueue: queueHasItems()
      ? { items: queue.items, currentIndex: queueIndex, playlistId: queue.playlistId || null }
      : { items: [], currentIndex: -1 },
  });
}
function loadSavedQueue() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["savedQueue"], (stored) => resolve(stored.savedQueue || null));
  });
}
function restoreSavedQueue(saved) {
  setQueue(saved.items, {
    index: Math.max(saved.currentIndex, 0),
    playlistId: saved.playlistId || null,
    prefetch: false, // nothing is fetched until something plays
  });
}
// With "Remember queue" on, the app comes back with the video it showed last: loaded at its place
// in the queue and where it was stopped (its watch progress), paused.
function resumeSavedVideo() {
  const item = queue && queueIndex >= 0 ? queue.items[queueIndex] : null;
  if (!item) return;
  playSource = "queue";
  playVideo(item.url, { gentle: false, autoplay: false });
}
// A playlist read from a YouTube page (plus the video being watched there) arrives while a saved
// queue exists: the saved queue stays, the new videos go in below it and the video that was open
// on YouTube starts playing. Videos already in the queue aren't added twice: the one that's
// there plays.
function appendToSavedQueue(saved, pl, playUrl) {
  const items = saved.items.map((item) => ({ ...item })),
    seen = new Set(items.map(itemVideoId).filter(Boolean)),
    before = items.length;
  pl.items.forEach((item) => {
    const key = itemVideoId(item);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    items.push({ ...item });
  });
  const playId = playUrl ? videoIdFromUrl(playUrl) : null;
  let idx = playId ? items.findIndex((item) => itemVideoId(item) === playId) : -1;
  if (idx < 0) {
    const cur = pl.items[pl.currentIndex];
    idx = cur ? items.findIndex((item) => itemVideoId(item) === itemVideoId(cur)) : -1;
  }
  if (idx < 0 && playUrl) {
    items.push({ title: playUrl, url: playUrl });
    idx = items.length - 1;
  }
  if (idx < 0) idx = Math.min(before, items.length - 1);
  setQueue(items, { index: idx });
  const added = items.length - before;
  if (added > 0) notify(added > 1 ? `Added ${added} videos to queue` : "Added to queue");
  playVideo(queue.items[idx].url);
}
// The latest queue position is kept when the player closes or reloads (never an empty queue:
// that could wipe a saved one before it has been restored).
window.addEventListener("pagehide", () => {
  if (queueHasItems()) saveQueue();
});

/* ---- The saved playlist behind the queue ----
 * A queue loaded from a saved playlist (or saved as one) is that playlist: reordering it or
 * removing from it changes the playlist too, a moment later (pushQueueToPlaylist), and changes
 * made to the playlist elsewhere (its page, a YouTube sync) show up in the queue
 * (queueFollowPlaylist). linkedPlaylistKey is what the playlist is known to hold, so nothing is
 * sent when nothing changed. */
let linkedPlaylistKey = null,
  linkedPlaylistTimer = 0,
  holdLinkedSync = false; // while a removal can still be undone
function playlistSyncKey(id, items) {
  return `${id}|${items.map((item) => itemVideoId(item) || item.url).join(",")}`;
}
/**
 * The queue is this saved playlist from now on (it was just saved as one, or linked on YouTube).
 * @param {string} playlistId The saved playlist's id.
 * @param {boolean} [synced=true] The playlist holds exactly the queue's videos. False (a link
 *   put back by Undo): the queue is sent to the playlist at the next saveQueue().
 */
function linkQueueToPlaylist(playlistId, synced = true) {
  queue.playlistId = playlistId;
  if (synced) linkedPlaylistKey = playlistSyncKey(playlistId, queue.items);
}
/** The queue goes on as a plain one (its playlist is gone); `playlistId`: only if it's that one. */
function unlinkQueue(playlistId) {
  if (!queue || !queue.playlistId || (playlistId && queue.playlistId !== playlistId)) return false;
  queue.playlistId = null;
  renderQueue();
  saveQueue();
  return true;
}
function syncLinkedPlaylist() {
  if (!queue || !queue.playlistId || holdLinkedSync) return;
  const id = queue.playlistId,
    items = queue.items.slice();
  clearTimeout(linkedPlaylistTimer);
  linkedPlaylistTimer = setTimeout(() => pushQueueToPlaylist(id, items), 400);
}
async function pushQueueToPlaylist(id, items) {
  const key = playlistSyncKey(id, items);
  if (key === linkedPlaylistKey) return;
  linkedPlaylistKey = key;
  try {
    const data = await api(`/playlists/${encodeURIComponent(id)}/items`, {
      method: "PUT",
      body: {
        items: items.map((item) => ({
          id: itemVideoId(item) || null,
          title: item.title,
          url: item.url,
          duration: item.duration,
        })),
      },
    });
    applySavedPlaylist(data.playlist, false);
    renderPlaylistCards();
  } catch (err) {
    linkedPlaylistKey = null;
    if (err.message === "unknown playlist") return void unlinkQueue(id); // it was deleted
    notify(`Couldn't update the playlist: ${firstLine(err.message)}`, true, 4000);
  }
}
function queueFollowPlaylist(pl) {
  if (!pl || !queue || queue.playlistId !== pl.id || holdLinkedSync) return;
  const plItems = pl.items || [];
  if (!plItems.length) return clearQueue();
  const byVid = new Map(queue.items.map((item) => [itemVideoId(item), item])),
    current = queueIndex >= 0 ? queue.items[queueIndex] : null,
    oldIndex = queueIndex;
  queue.items = plItems.map(
    (entry) => byVid.get(entry.id) || { id: entry.id, title: entry.title || entry.url, url: entry.url },
  );
  queueIndex = current ? queue.items.indexOf(current) : -1;
  if (queueIndex < 0 && oldIndex >= 0) queueIndex = Math.min(oldIndex, queue.items.length) - 1;
  linkedPlaylistKey = playlistSyncKey(pl.id, queue.items);
  queueChanged();
}

/* ---- "Download all" ---- */
const DOWNLOAD_ALL_LABEL = "⬇ Download all";
let downloadAllResetTimer = null;
function resetDownloadAllButton() {
  clearTimeout(downloadAllResetTimer);
  downloadAllBtn.disabled = false;
  downloadAllBtn.textContent = DOWNLOAD_ALL_LABEL;
}
function flashDownloadAllButton(label) {
  downloadAllBtn.textContent = label;
  clearTimeout(downloadAllResetTimer);
  downloadAllResetTimer = setTimeout(resetDownloadAllButton, 2500);
}
async function queueEveryDownload() {
  if (!queue) return;
  // from the playing item on, then the ones before it
  const startAt = Math.max(0, queueIndex),
    ids = [...queue.items.slice(startAt), ...queue.items.slice(0, startAt)].map(itemVideoId).filter(Boolean);
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = "Queuing…";
  try {
    const data = await requestDownloads(ids, queue.items);
    downloadAllBtn.disabled = false;
    flashDownloadAllButton(data.queued ? `✓ Queued ${data.queued}` : "Nothing to queue");
  } catch (err) {
    resetDownloadAllButton();
    notify(`Couldn't queue downloads: ${netMessage(firstLine(err.message))}`, true, 4000);
  }
}
downloadAllBtn.addEventListener("click", queueEveryDownload);
