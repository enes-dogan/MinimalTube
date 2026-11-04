/* MinimalTube player - Settings (the SETTINGS table) and the queue's state: saving, restoring, the link to a saved
 * playlist, Back / Next, Download all.
 * Loaded in order by player.html (classic scripts sharing one scope). */

const streamOnlyMode = () => streamWhileDownloading && streamOnly;
// The switches in Settings: storage key, checkbox, default, and the variable it sets. Read at
// start (loadSettings), written on Save (saveSettings). One with `needs` can only be switched
// on together with that other switch (its row is dimmed otherwise).
const SETTINGS = [
  { key: "sponsorBlockEnabled", input: sponsorToggle, def: true, set: (on) => (sponsorBlockEnabled = on) },
  { key: "queuePersistEnabled", input: queuePersistToggle, def: false, set: (on) => (rememberQueue = on) },
  { key: "ytHistorySyncEnabled", input: ytHistoryToggle, def: false, set: (on) => (ytHistorySync = on) },
  { key: "streamWhileDownloading", input: streamToggle, def: false, set: (on) => (streamWhileDownloading = on) },
  { key: "streamOnly", input: streamOnlyToggle, def: false, set: (on) => (streamOnly = on), needs: streamToggle },
];
function paintSettingDependencies() {
  SETTINGS.forEach(({ input, needs }) => {
    if (!needs) return;
    input.disabled = !needs.checked;
    input.closest(".checkrow").classList.toggle("off", !needs.checked);
  });
}
SETTINGS.forEach(({ needs }) => needs && needs.addEventListener("change", paintSettingDependencies));
function loadSettings(stored) {
  SETTINGS.forEach(({ key, input, def, set }) => {
    const on = stored[key] === undefined ? def : !!stored[key];
    set(on);
    input.checked = on;
  });
  paintSettingDependencies();
}
function saveSettings() {
  const values = {};
  SETTINGS.forEach(({ key, input, set }) => {
    set(input.checked);
    values[key] = input.checked;
  });
  return values;
}
function closeSettings() {
  settingsPanel.classList.remove("open");
  gearBtn.classList.remove("active");
}
function saveQueue() {
  syncLinkedPlaylist();
  if (!rememberQueue) return;
  const snapshot =
    queue && queue.items.length
      ? {
          items: queue.items,
          currentIndex: queueIndex,
          playlistId: queue.playlistId || null,
        }
      : {
          items: [],
          currentIndex: -1,
        };
  chrome.storage.local.set({
    savedQueue: snapshot,
  });
}
function loadSavedQueue() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["savedQueue"], (stored) =>
      resolve(stored.savedQueue || null),
    );
  });
}
// The server's title comes from a full lookup of the video (its own language); the title a
// queue row was created with may be a translated one from a channel listing: keep the real one.
function syncQueueTitle(url, title) {
  if (!title || !queue) return;
  const item = queue.items.find((candidate) => candidate.url === url);
  if (!item || item.title === title) return;
  item.title = title;
  const row = Array.from(queueList.children).find(
    (candidate) => candidate._item === item,
  );
  const el = row && row.querySelector(".plTitle");
  if (el) {
    el.textContent = title;
    el.title = title;
  }
  saveQueue();
}
function prefetchNextInQueue() {
  if (!queue || queueIndex < 0) return;
  const next = queue.items[queueIndex + 1];
  if (!next) return;
  // stream only: just its title and stream links, no download
  api(preparePath(next.url))
    .then((response) => {
      if (response && response.status && response.status !== "ready" && response.status !== "streaming")
        pollDownloadsSoon();
      if (!response || response.error || !response.title) return;
      if (next.title === response.title) return;
      next.title = response.title;
      if (!next.id && response.video_id) next.id = response.video_id;
      const row = Array.from(queueList.children).find(
        (item) => item._item === next,
      );
      const titleEl = row && row.querySelector(".plTitle");
      if (titleEl) titleEl.textContent = next.title;
    })
    .catch((err) => logQuiet("prefetch the next video", err));
}
function fetchPlaylist(rawUrl) {
  return api(`/playlist?url=${encodeURIComponent(rawUrl)}`);
}
function setQueueFromPlaylist(playlist) {
  if (playlist && Array.isArray(playlist.items) && playlist.items.length) {
    playSource = "queue";
    queue = {
      items: playlist.items,
      currentIndex: playlist.currentIndex,
    };
    queueIndex = playlist.currentIndex;
    resetDownloadAllButton();
    renderQueue();
    refreshLibrary();
    scrollActiveQueueRowIntoView();
    prefetchNextInQueue();
    startQueuePolling();
    saveQueue();
  } else clearQueue();
}

function restoreSavedQueue(saved) {
  queue = {
    items: saved.items,
    currentIndex: saved.currentIndex,
    playlistId: saved.playlistId || null,
  };
  if (queue.playlistId) linkedPlaylistKey = playlistSyncKey(queue.playlistId, queue.items);
  queue.items.forEach((item, index) => (item.index = index + 1));
  queueIndex = Math.min(
    Math.max(saved.currentIndex, 0),
    saved.items.length - 1,
  );
  resetDownloadAllButton();
  renderQueue();
  markActiveQueueRow();
  scrollActiveQueueRowIntoView();
  startQueuePolling();
}

// A playlist scraped from YouTube (plus the video being watched) arrives while
// a saved queue exists: keep the old queue, append the new videos below it and
// start playing the video that was open on YouTube. Videos that are already in
// the queue are not added twice - the existing entry is played instead.
function appendToSavedQueue(saved, pl, playUrl) {
  const items = saved.items.map((item) => ({
      ...item,
    })),
    seen = new Set(items.map(itemVideoId).filter(Boolean)),
    before = items.length;
  pl.items.forEach((item) => {
    const key = itemVideoId(item);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    items.push({
      ...item,
    });
  });
  const playId = playUrl ? videoIdFromUrl(playUrl) : null;
  let idx = playId
    ? items.findIndex((item) => itemVideoId(item) === playId)
    : -1;
  if (idx < 0) {
    const cur = pl.items[pl.currentIndex];
    idx = cur
      ? items.findIndex((item) => itemVideoId(item) === itemVideoId(cur))
      : -1;
  }
  if (idx < 0 && playUrl) {
    items.push({
      title: playUrl,
      url: playUrl,
    });
    idx = items.length - 1;
  }
  if (idx < 0) idx = Math.min(before, items.length - 1);
  playSource = "queue";
  queue = {
    items,
    currentIndex: idx,
  };
  queue.items.forEach((item, index) => (item.index = index + 1));
  queueIndex = idx;
  resetDownloadAllButton();
  renderQueue();
  refreshLibrary();
  markActiveQueueRow();
  scrollActiveQueueRowIntoView();
  prefetchNextInQueue();
  startQueuePolling();
  saveQueue();
  const added = items.length - before;
  if (added > 0)
    notify(added > 1 ? `Added ${added} videos to queue` : "Added to queue");
  playVideo(items[idx].url);
}
function clearQueue() {
  queue = null;
  queueIndex = -1;
  clearInterval(queuePollTimer);
  renderQueue();
  saveQueue();
}
// Undo brings the same queue back (while nothing new has been put in it: see renderQueue).
document.getElementById("clearQueueBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  if (!queue || !queue.items.length) return;
  queueAddToken++;
  const old = queue,
    playing = queueIndex >= 0 ? old.items[queueIndex] : null;
  clearQueue();
  offerUndo("Queue cleared", {
    kind: "queue-clear",
    undo: () => {
      queue = old;
      queueIndex = playing && itemVideoId(playing) === currentVideoId ? old.items.indexOf(playing) : -1;
      renderQueue();
      markActiveQueueRow();
      startQueuePolling();
      prefetchNextInQueue();
      saveQueue();
    },
    commit: () => {},
  });
});

let linkedPlaylistKey = null,
  linkedPlaylistTimer = 0,
  holdLinkedSync = false;
function playlistSyncKey(id, items) {
  return `${id}|${items.map((item) => itemVideoId(item) || item.url).join(",")}`;
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
    const res = await fetch(
      `${serverBase}/playlists/${encodeURIComponent(id)}/items`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: items.map((item) => ({
            id: itemVideoId(item) || null,
            title: item.title,
            url: item.url,
            duration: item.duration,
          })),
        }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (res.status === 404 && data.error === "unknown playlist") {
      if (queue && queue.playlistId === id) {
        queue.playlistId = null;
        renderQueue();
        saveQueue();
      }
      return;
    }
    if (!res.ok || data.error)
      throw new Error(
        data.error ||
          (res.status === 405
            ? "the running server is outdated - restart server.py"
            : `Server returned ${res.status}`),
      );
    applySavedPlaylist(data.playlist, false);
    renderPlaylistCards();
  } catch (err) {
    linkedPlaylistKey = null;
    notify(`Couldn't update the playlist: ${firstLine(err.message)}`, true, 4000);
  }
}
function queueFollowPlaylist(pl) {
  if (!pl || !queue || queue.playlistId !== pl.id || holdLinkedSync) return;
  const plItems = pl.items || [];
  if (!plItems.length) {
    clearQueue();
    return;
  }
  const byVid = new Map(queue.items.map((item) => [itemVideoId(item), item])),
    current = queueIndex >= 0 ? queue.items[queueIndex] : null,
    oldIndex = queueIndex;
  queue.items = plItems.map(
    (entry) =>
      byVid.get(entry.id) || {
        id: entry.id,
        title: entry.title || entry.url,
        url: entry.url,
      },
  );
  queue.items.forEach((item, index) => (item.index = index + 1));
  queueIndex = current ? queue.items.indexOf(current) : -1;
  if (queueIndex < 0 && oldIndex >= 0)
    queueIndex = Math.min(oldIndex, queue.items.length) - 1;
  linkedPlaylistKey = playlistSyncKey(pl.id, queue.items);
  renderQueue();
  markActiveQueueRow();
  prefetchNextInQueue();
  startQueuePolling();
  saveQueue();
}
function itemVideoId(item) {
  return item.id || videoIdFromUrl(item.url);
}
function libraryIndexOfId(videoId) {
  return queue && videoId
    ? queue.items.findIndex((item) => itemVideoId(item) === videoId)
    : -1;
}
function updateSkipButtons() {
  const inQueue =
    playSource === "queue" && queue && queueIndex >= 0 && currentVideoId;
  prevBtn.style.display = inQueue && queueIndex > 0 ? "" : "none";
  nextBtn.style.display =
    inQueue && queueIndex < queue.items.length - 1 ? "" : "none";
}
function markActiveQueueRow() {
  updateSkipButtons();
  queueList.querySelectorAll(".plItem").forEach((el, index) => {
    el.classList.toggle("active", index === queueIndex);
  });
}
function scrollActiveQueueRowIntoView() {
  const row = queueList.children[queueIndex];
  if (!row) return;
  const list = queueList.getBoundingClientRect(),
    rect = row.getBoundingClientRect();
  if (rect.top < list.top) queueList.scrollTop += rect.top - list.top;
  else if (rect.bottom > list.bottom)
    queueList.scrollTop += rect.bottom - list.bottom;
}
function resetStrayScroll() {
  ["app", "playerFrame", "mainArea", "stage"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.scrollLeft) el.scrollLeft = 0;
  });
  if (document.scrollingElement.scrollLeft) document.scrollingElement.scrollLeft = 0;
}
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey || event.altKey))
    if (!isTypingTarget(event.target) && hasVideoLoaded())
      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) togglePlayPause();
      } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
        if (isFinite(video.duration))
          animateSeekTo((video.currentTime / video.duration) * 100);
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        video.currentTime = Math.min(
          video.duration || 1 / 0,
          video.currentTime + 5,
        );
        if (isFinite(video.duration))
          animateSeekTo((video.currentTime / video.duration) * 100);
      } else if (event.code === "KeyF") {
        event.preventDefault();
        if (!event.repeat) toggleFullscreen();
      } else if (event.code === "KeyM") {
        event.preventDefault();
        if (!event.repeat) toggleMute();
      } else if (event.code === "KeyC") {
        event.preventDefault();
        if (!event.repeat) toggleCaptions();
      } else if (/^(Digit|Numpad)[0-9]$/.test(event.code) && !event.shiftKey) {
        event.preventDefault();
        const tenth = Number(event.code.slice(-1));
        if (isFinite(video.duration) && video.duration > 0) {
          video.currentTime = tenth ? (video.duration * tenth) / 10 : video.duration;
          animateSeekTo(tenth ? tenth * 10 : 100);
        }
      } else if (
        (event.code === "ArrowUp" || event.code === "ArrowDown") &&
        !document.body.classList.contains("browsing")
      ) {
        event.preventDefault();
        const up = event.code === "ArrowUp";
        if (up && video.muted) video.muted = false;
        setVolume(video.volume + (up ? 0.05 : -0.05));
        flashText(`${Math.round(video.volume * 100)}%`);
      }
});
document.addEventListener("keyup", (event) => {
  if (
    event.code === "Space" &&
    !isTypingTarget(event.target) &&
    hasVideoLoaded()
  )
    event.preventDefault();
});
fullscreenBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  fullscreenBtn.classList.toggle("is-fullscreen", !!document.fullscreenElement);
  const host = document.fullscreenElement || document.body;
  host.append(undoBar, toastEl);
});
openFolderBtn.addEventListener("click", async () => {
  closeSettings();
  try {
    await api("/open-folder");
  } catch (err) {
    notify(
      `Couldn't open videos location: ${firstLine(err.message)}`,
      true,
      4e3,
    );
  }
});
// The server runs itself again in place; it's back once /health reports a new start time. One
// that isn't running, or doesn't come back, is started by the extension (native host).
async function restartServer() {
  let res = null;
  try {
    res = await fetch(`${serverBase}/restart`, { method: "POST" });
  } catch (err) {
    logQuiet("restart the server", err);
  }
  if (res && !res.ok) {
    const data = await res.json().catch(() => ({}));
    return notify(
      res.status === 404 || res.status === 405
        ? "This server is too old to restart itself: stop it once by hand (README → Updating)."
        : `Couldn't restart the server: ${data.error || `it returned ${res.status}`}`,
      true,
      6e3,
    );
  }
  const old = res ? (await res.json().catch(() => ({}))).started : undefined;
  for (let i = 0; old !== undefined && i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const started = await api("/health").then((data) => data.started, () => undefined);
    if (started !== undefined && started !== old) {
      notify("Server restarted");
      return reloadFromServer();
    }
  }
  const reply = await chrome.runtime.sendMessage({ type: "minimaltube-ensure-server" }).catch(() => null);
  if (!reply || !reply.ok)
    return notify(firstLine((reply && reply.error) || "Couldn't restart the server"), true, 6e3);
  notify(old === undefined ? "Server started" : "Server restarted");
  reloadFromServer();
}
restartServerBtn.addEventListener("click", async () => {
  closeSettings();
  if (restartServerBtn.disabled) return;
  restartServerBtn.disabled = true;
  notify("Restarting the server…", false, 15e3);
  try {
    await restartServer();
  } finally {
    restartServerBtn.disabled = false;
  }
});
addUrlBtn.addEventListener("click", () => {
  const typed = urlInput.value.trim();
  if (typed) {
    closeSettings();
    urlInput.value = "";
    addUrlToQueue(typed);
  }
});
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addUrlBtn.click();
});
gearBtn.addEventListener("click", () => {
  const e = !settingsPanel.classList.contains("open");
  settingsPanel.classList.toggle("open", e);
  gearBtn.classList.toggle("active", e);
  if (e) {
    urlInput.focus();
    urlInput.select();
  }
});
addLayer({
  el: settingsPanel,
  isOpen: () => settingsPanel.classList.contains("open"),
  close: closeSettings,
  inside: [gearBtn, "#bpSettingsBtn"],
});
saveSettingsBtn.addEventListener("click", () => {
  const typed = serverInput.value.trim();
  if (typed) serverBase = typed.replace(/\/$/, "");
  chrome.storage.local.set({ serverBase, ...saveSettings() });
  if (!sponsorBlockEnabled) {
    sponsorSegments = [];
    renderSeekMarks();
  }
  if (rememberQueue) saveQueue();
  else chrome.storage.local.remove("savedQueue");
  closeSettings();
});
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
  const startAt = Math.max(0, queueIndex),
    ids = [...queue.items.slice(startAt), ...queue.items.slice(0, startAt)]
      .map(itemVideoId)
      .filter(Boolean);
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = "Queuing…";
  try {
    const data = await requestDownloads(ids, queue.items);
    downloadAllBtn.disabled = false;
    flashDownloadAllButton(
      data.queued ? `✓ Queued ${data.queued}` : "Nothing to queue",
    );
    pollQueueStatuses();
  } catch (err) {
    resetDownloadAllButton();
    notify(`Couldn't queue downloads: ${netMessage(firstLine(err.message))}`, true, 4000);
  }
}
