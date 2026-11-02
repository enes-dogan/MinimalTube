/* MinimalTube player - Watch progress, and the side panel's rows: queue and Downloads lists, their statuses and sizes.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* ---- Watch progress (YouTube-style red bar on thumbnails) ----
 * id -> {p: seconds watched, d: video length in seconds, t: last updated,
 * s: 1 once the finish was sent to YouTube history}. */
const WATCH_KEY = "mt_watch_v2",
  WATCH_DONE_LEFT = 0.05,
  RESUME_MIN_SEC = 5;
let watchMap = {};
try {
  watchMap = JSON.parse(localStorage.getItem(WATCH_KEY) || "null") || {};
} catch (err) {
  logQuiet("watch progress (read)", err);
}
function watchFrac(id) {
  const entry = watchMap[id];
  return entry && entry.d > 0
    ? Math.min(1, Math.max(0, entry.p / entry.d))
    : 0;
}
function watchDone(id) {
  const entry = watchMap[id];
  return (
    !!entry && entry.d > 0 && (entry.d - entry.p) / entry.d <= WATCH_DONE_LEFT
  );
}
function resumePoint(id, duration) {
  const entry = watchMap[id];
  if (!entry || watchDone(id) || !(duration > 0)) return 0;
  return entry.p >= RESUME_MIN_SEC && entry.p < duration - RESUME_MIN_SEC
    ? entry.p
    : 0;
}
function saveWatchMap() {
  try {
    const ids = Object.keys(watchMap);
    if (ids.length > 4000) {
      ids
        .sort((a, b) => watchMap[a].t - watchMap[b].t)
        .slice(0, ids.length - 3000)
        .forEach((id) => delete watchMap[id]);
    }
    localStorage.setItem(WATCH_KEY, JSON.stringify(watchMap));
  } catch (err) {
    logQuiet("watch progress (save)", err);
  }
}
function paintWatch(thumb) {
  const id = thumb.dataset.vid,
    frac = watchFrac(id);
  let bar = thumb.querySelector(":scope > .watchBar");
  if (!(frac > 0)) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "watchBar";
    bar.appendChild(document.createElement("i"));
    thumb.appendChild(bar);
  }
  const done = watchDone(id);
  bar.firstChild.style.width = `${done ? 100 : Math.max(3, frac * 100)}%`;
  bar.classList.toggle("done", done);
}
function refreshWatchBars() {
  document
    .querySelectorAll(".vThumb[data-vid], .plThumb[data-vid]")
    .forEach(paintWatch);
}
function recordWatch(id, position, duration) {
  if (!id || !(duration > 0) || !(position >= 0)) return;
  position = Math.min(duration, position);
  const prev = watchMap[id];
  if (prev && prev.d > 0 && Math.abs(prev.p - position) < 1) return;
  const entry = {
    p: Math.round(position * 10) / 10,
    d: Math.round(duration * 10) / 10,
    t: Date.now(),
  };
  if (prev && prev.s && position / duration >= 0.5) entry.s = 1;
  watchMap[id] = entry;
  if (!entry.s && watchDone(id)) {
    entry.s = 1;
    if (ytHistorySync) sendToYouTubeHistory(id);
  }
  saveWatchMap();
  refreshWatchBars();
}
// Offline it's simply sent later (the OFFLINE badge already says so); anything else, like not
// being signed in to YouTube in this browser, is worth knowing.
function sendToYouTubeHistory(id) {
  chrome.runtime.sendMessage({ type: "minimaltube-mark-watched", id }, (res) => {
    if (chrome.runtime.lastError) return logQuiet("YouTube history", chrome.runtime.lastError);
    if (res && res.error && !isOffline())
      notify(`Couldn't add this video to your YouTube history: ${res.error}`, true, 6000);
  });
}
function noteWatchProgress() {
  if (!currentVideoId || !(video.duration > 0) || !isFinite(video.duration))
    return;
  const streaming = liveStream && liveStream.videoId === currentVideoId;
  if (!streaming && !(video.currentSrc || "").includes(`/stream/${currentVideoId}`))
    return; // still showing a previous video
  if (video.currentTime < 1 && !video.ended) return;
  recordWatch(
    currentVideoId,
    video.ended ? video.duration : video.currentTime,
    video.duration,
  );
}
let lastWatchNote = 0;
video.addEventListener("timeupdate", () => {
  const now = Date.now();
  if (now - lastWatchNote < 4000) return;
  lastWatchNote = now;
  noteWatchProgress();
});
video.addEventListener("pause", () => noteWatchProgress());
video.addEventListener("ended", () => noteWatchProgress());
window.addEventListener("pagehide", () => noteWatchProgress());

// Video lengths for the side panel rows: from the item itself, else asked from the server
// (it knows the length of anything prepared / downloaded before).
const durCache = new Map(),
  durAsked = new Map();
function rowDuration(item) {
  return item.duration || durCache.get(item.id || itemVideoId(item)) || 0;
}
function wantDurations(items) {
  const now = Date.now(),
    ids = [];
  items.forEach((item) => {
    const id = item.id || itemVideoId(item);
    if (!id || item.duration || durCache.has(id)) return;
    if (now - (durAsked.get(id) || 0) < 3000) return;
    durAsked.set(id, now);
    ids.push(id);
  });
  if (!ids.length) return;
  api(`/durations?ids=${ids.slice(0, 200).join(",")}`)
    .then((response) => {
      let found = false;
      Object.entries((response && response.durations) || {}).forEach(
        ([id, sec]) => {
          if (sec > 0) {
            durCache.set(id, sec);
            found = true;
          }
        },
      );
      if (response && response.pending)
        setTimeout(() => {
          if (queue) wantDurations(queue.items);
        }, 4000); // still being looked up
      if (found) {
        // refresh the labels in place (no re-render, so open menus / drags are left alone)
        document.querySelectorAll(".plItem").forEach((row) => {
          const it = row._item || row._entry,
            el = row.querySelector(".plDur");
          if (it && el && !el.textContent) paintDur(el, rowDuration(it));
        });
      }
    })
    .catch((err) => logQuiet("durations", err));
}
function paintDur(el, sec) {
  el.textContent = sec > 0 ? fmtDur(sec) : "";
}
function makePlBadges(item) {
  const box = document.createElement("div");
  box.className = "plBadges";
  const dur = document.createElement("div");
  dur.className = "plDur";
  paintDur(dur, rowDuration(item));
  box.appendChild(dur);
  return box;
}
function makeRow({ videoId, index, badges, title, pending, sub, active, className, menu, onClick }) {
  const row = el("div", "plItem" + (className ? ` ${className}` : "") + (active ? " active" : ""));
  const thumb = makePlThumb(videoId);
  thumb.append(el("div", "plIndex", index), badges);
  const titleEl = el("div", "plTitle" + (pending ? " pending" : ""), title);
  titleEl.title = title;
  const text = el("div", "plText");
  text.appendChild(titleEl);
  if (sub != null) text.appendChild(el("div", "plSub", sub));
  row.append(thumb, text, makeKebab(menu, row), makeGrip());
  row.addEventListener("click", onClick);
  return row;
}
function makePlThumb(id) {
  const thumb = el("div", "plThumb");
  if (id) {
    thumb.dataset.vid = id;
    paintWatch(thumb);
    thumb.appendChild(makeThumbImg(`${serverBase}/thumb/${id}`, `https://i.ytimg.com/vi/${id}/mqdefault.jpg`));
  }
  return thumb;
}
function renderQueue() {
  // something new in the queue makes "Queue cleared" final (an Undo would have to mix the two)
  if (queue && queue.items.length && pendingUndo && pendingUndo.kind === "queue-clear") flushUndo();
  updateSkipButtons();
  const linked =
    queue && queue.playlistId
      ? savedPlaylists.find((playlist) => playlist.id === queue.playlistId)
      : null;
  queuePlName.textContent = linked ? linked.name : "";
  queuePlName.title = linked ? `Playing the playlist "${linked.name}"` : "";
  if (!queue || !queue.items.length)
    return (
      (queueSection.style.display = "none"),
      void (queueList.innerHTML = "")
    );
  queueSection.style.display = "flex";
  closeRowMenu();
  queueList.innerHTML = "";
  queue.items.forEach((item, idx) => {
    const status = el("div", "plStatus");
    paintStatus(status, item._st);
    const badges = makePlBadges(item);
    badges.appendChild(status); // the tick / percent sits right of the length
    const row = makeRow({
      videoId: itemVideoId(item),
      index: item.index,
      badges,
      title: item.title,
      active: idx === queueIndex,
      menu: (btn) => queueMenuEntries(item, btn),
      onClick: () => {
        playSource = "queue";
        queueIndex = idx;
        markActiveQueueRow();
        playVideo(item.url);
        prefetchNextInQueue();
        saveQueue();
      },
    });
    row._item = item;
    queueList.appendChild(row);
  });
  wantDurations(queue.items);
  pollQueueStatuses();
}
function paintStatus(el, job) {
  el.classList.remove("ready", "downloading");
  if (job) {
    if (job.status === "ready") {
      el.textContent = "✓";
      el.classList.add("ready");
    } else if (job.status === "downloading") {
      el.textContent = `${Math.round(job.percent ?? 0)}%`;
      el.classList.add("downloading");
    } else if (job.status === "merging") {
      el.textContent = "⏳";
      el.classList.add("downloading");
    } else if (job.status === "queued") el.textContent = "…";
    else if (job.status === "waiting") el.textContent = "⏸";
    else el.textContent = "";
  } else el.textContent = "";
}
// Status is keyed by the queue item itself (not its index) so it stays correct
// while the list is being reordered.
function setQueueItemStatus(item, job) {
  item._st = job || null;
  const row = Array.from(queueList.children).find(
    (candidate) => candidate._item === item,
  );
  const el = row && row.querySelector(".plStatus");
  if (el) paintStatus(el, item._st);
}
// All the queue's videos in one request (/statuses), not one each.
const STATUSES_CHUNK = 150;
async function pollQueueStatuses() {
  const snapshot = queue;
  if (!snapshot) return;
  const asking = [];
  snapshot.items.forEach((item) => {
    if (item._cachedReady) setQueueItemStatus(item, { status: "ready" });
    else if (itemVideoId(item)) asking.push(item);
  });
  const ids = [...new Set(asking.map(itemVideoId))];
  const states = {};
  try {
    for (let i = 0; i < ids.length; i += STATUSES_CHUNK) {
      const chunk = ids.slice(i, i + STATUSES_CHUNK).join(",");
      Object.assign(states, (await api(`/statuses?ids=${chunk}`)).statuses);
    }
  } catch (err) {
    return logQuiet("queue statuses", err);
  }
  if (snapshot !== queue) return;
  asking.forEach((item) => {
    const videoId = itemVideoId(item);
    const job = hiddenDeletes.has(videoId) ? null : states[videoId] || null;
    if (job && job.status === "ready") item._cachedReady = true;
    setQueueItemStatus(item, job);
  });
}
downloadAllBtn.addEventListener("click", queueEveryDownload);
let queuePollTimer = null;
function startQueuePolling() {
  clearInterval(queuePollTimer);
  queuePollTimer = setInterval(pollQueueStatuses, 5e3);
}
function closeQueuePanel() {
  closeSaveToMenu();
  queuePanel.classList.remove("open");
  queueToggleBtn.classList.remove("active");
}
queueToggleBtn.addEventListener("click", () => {
  if (queuePanel.classList.contains("open")) closeQueuePanel();
  else {
    queuePanel.classList.add("open");
    queueToggleBtn.classList.add("active");
    refreshLibrary();
  }
});
addLayer({
  el: queuePanel,
  isOpen: () => queuePanel.classList.contains("open"),
  close: closeQueuePanel,
  inside: [queueToggleBtn, "#bpQueueBtn", "#savePlModal"],
});
let library = [],
  libraryKey = null;
let libEpoch = 0;
function libKey(list) {
  return list
    .map(
      (entry) =>
        `${entry.id}\t${entry.title || ""}\t${entry.status || ""}\t${entry.duration || ""}`,
    )
    .join("\n");
}
const isActiveEntry = (response) =>
  !!response.status && response.status !== "ready";
const activeEntryText = (entry) =>
  entry.status === "queued"
    ? "Waiting to download"
    : entry.status === "waiting"
      ? "Waiting for internet connection"
      : "Downloading…";

// Titles the player already knows, so the server can name queued downloads right away.
function titlesFor(items) {
  const out = {};
  items.forEach((item) => {
    const id = itemVideoId(item);
    if (id && item.title && !/^https?:\/\//i.test(item.title))
      out[id] = item.title;
  });
  return out;
}

// Called every second with /downloads: keeps progress live and notices downloads that
// started (or finished) since the Downloads list was last fetched.
let lastLibSync = 0;
function syncLibraryDownloads(items) {
  const active = new Map(items.map((item) => [item.id, item]));
  const known = new Set(library.map((item) => item.id));
  let stale = items.some((item) => !known.has(item.id));
  libraryList.querySelectorAll(".libItem").forEach((row) => {
    const response = row._entry;
    if (!response || !isActiveEntry(response)) return;
    const live = active.get(response.id);
    if (!live) {
      stale = true;
      return;
    } // finished (or was cancelled): redraw the row
    response.status = live.status;
    response.percent = live.percent;
    const el = row.querySelector(".plStatus");
    if (el) paintStatus(el, response);
  });
  try {
    refreshDownloadBadges();
  } catch (err) {
    logQuiet("download badges", err);
  }
  if (stale && Date.now() - lastLibSync > 1500) {
    lastLibSync = Date.now();
    refreshLibrary();
  }
}
async function refreshLibrary() {
  if (sortDragging || rowMenu.classList.contains("open")) return;
  const epoch = libEpoch;
  try {
    const response = await fetch(`${serverBase}/library`);
    if (!response.ok) return;
    const data = await response.json(),
      items = (Array.isArray(data.items) ? data.items : []).filter(
        (item) => !hiddenDeletes.has(item.id),
      ),
      key = libKey(items);
    if (
      epoch !== libEpoch ||
      sortDragging ||
      rowMenu.classList.contains("open")
    )
      return;
    if (key === libraryKey) return;
    libraryKey = key;
    library = items;
    renderLibrary();
  } catch (err) {
    logQuiet("Downloads list", err);
  }
}
function renderLibrary() {
  renderLibraryPanel();
  try {
    renderDownloadCards();
  } catch (err) {
    logQuiet("Downloads tab", err);
  }
  try {
    refreshFeedDownloadedFlags();
  } catch (err) {
    logQuiet("downloaded badges in the feed", err);
  }
}
function renderLibraryPanel() {
  closeRowMenu();
  libraryCount.textContent = library.length ? String(library.length) : "";
  libraryList.innerHTML = "";
  if (!library.length) {
    const el = document.createElement("div");
    el.className = "libEmpty";
    el.textContent = "No downloads yet.";
    libraryList.appendChild(el);
    return;
  }
  library.forEach((entry, item) => {
    const badges = makePlBadges(entry);
    if (isActiveEntry(entry)) {
      const prog = el("div", "plStatus");
      paintStatus(prog, entry);
      badges.appendChild(prog);
    }
    const row = makeRow({
      videoId: entry.id,
      index: String(item + 1),
      badges,
      title: entry.title || `${entry.id} (looking up title…)`,
      pending: !entry.title,
      sub: isActiveEntry(entry) ? activeEntryText(entry) : fmtSize(entry.size),
      active: entry.id === currentVideoId,
      className: "libItem",
      menu: (btn) => libraryMenuEntries(entry, btn),
      onClick: () => playLibraryEntry(entry),
    });
    row.dataset.vid = entry.id;
    row._entry = entry;
    libraryList.appendChild(row);
  });
}
function markActiveLibraryRow() {
  updateSkipButtons();
  libraryList.querySelectorAll(".libItem").forEach((el) => {
    el.classList.toggle("active", el.dataset.vid === currentVideoId);
  });
}
function playLibraryEntry(entry) {
  playSource = "library";
  queueIndex = libraryIndexOfId(entry.id);
  markActiveQueueRow();
  prefetchNextInQueue();
  playVideo(entry.url || `https://www.youtube.com/watch?v=${entry.id}`);
  saveQueue();
}
