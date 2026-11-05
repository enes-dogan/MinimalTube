/* MinimalTube player - Playing a video: /prepare, streaming (stream.js) and the handover to the downloaded file,
 * captions, adding to the queue, seek / volume / speed / fullscreen basics.
 * Loaded in order by player.html (classic scripts sharing one scope). */

const isDownloadedId = (id) =>
  !!id && library.some((entry) => entry.id === id && !isActiveEntry(entry));
// A video that couldn't start because the connection was gone; it starts once it's back
// (unless something else was played meanwhile).
let pendingPlay = null;
whenNetChanges((offline) => {
  const pending = pendingPlay;
  if (offline || !pending || pending.token !== loadToken) return;
  pendingPlay = null;
  playVideo(pending.url, { gentle: false });
});
async function playVideo(rawUrl, { gentle = true } = {}) {
  // Offline, a video that isn't downloaded can't play: keep the one being watched (and the
  // queue pointing at it).
  if (isOffline() && isWatching() && !isDownloadedId(videoIdFromUrl(rawUrl))) {
    const idx = libraryIndexOfId(currentVideoId);
    if (idx >= 0 && idx !== queueIndex) {
      queueIndex = idx;
      markActiveQueueRow();
    }
    notify(`${OFFLINE_TEXT}: only downloaded videos can play right now.`, true, 3500);
    return;
  }
  // Already watching something: a video that still has to be downloaded must not take over
  // the player. It downloads in the background and plays when this one ends.
  if (gentle && isWatching() && (await deferSwitch(rawUrl))) return;
  pendingPlay = null;
  pendingSwitch = null;
  pendingToken++;
  playerFrame.classList.remove("empty");
  const token = ++loadToken,
    stale = () => token !== loadToken;
  stopLiveStream();
  streamFallbackAt = null;
  resetStrayScroll();
  cancelUpNext();
  closeDesc();
  clearError();
  setLoadFailed(false);
  placeholder.style.display = "none";
  loadingBox.style.display = "flex";
  setLoadingText("Resolving video…");
  controls.style.display = "flex";
  setDlWait(true);
  titleOverlay.classList.remove("visible");
  sponsorSegments = [];
  clearSeekExtras();
  hasSubtitles = false;
  captionsBtn.style.display = "none";
  captionsBtn.classList.remove("active");
  clearSubtitles();
  try {
    let job = await api(preparePath(rawUrl));
    if (stale()) return;
    const videoId = job.video_id;
    currentVideoId = videoId;
    if (job.status !== "ready" && job.status !== "streaming") pollDownloadsSoon();
    markActiveLibraryRow();
    document.title = job.title ? `${job.title} — MinimalTube` : "MinimalTube";
    titleOverlay.textContent = job.title || "";
    titleOverlay.classList.toggle("visible", !!job.title);
    syncQueueTitle(rawUrl, job.title);
    setMediaSession(videoId, job.title);
    loadSponsorSegments(videoId);
    loadChapters(videoId);
    if (job.status === "streaming") {
      // stream only: nothing downloads, unless this browser can't play the stream
      const picks = LiveStream.pick(job.stream, { adaptive: true });
      if (picks && (await startLiveStream(videoId, picks, job, stale))) return;
      if (stale()) return;
      notify("This video can't be streamed here, so it's downloading instead.", true, 4000);
      job = await api(preparePath(rawUrl, false));
      if (stale()) return;
      job.stream = null;
    }
    if (job.status !== "ready" && streamWhileDownloading) {
      const picks = LiveStream.pick(job.stream);
      if (picks && (await startLiveStream(videoId, picks, job, stale))) {
        followDownload(videoId, token);
        return;
      }
      if (stale()) return;
    }
    while (job.status !== "ready") {
      if (job.status === "error")
        throw new Error(job.error || "Download failed");
      showLoadingStatus(job);
      await new Promise((resolve) => setTimeout(resolve, 1e3));
      if (stale()) return;
      job = await fetchJobStatus(videoId);
      if (stale()) return;
    }
    video.src = `${serverBase}/stream/${videoId}`;
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (stale() || videoId !== currentVideoId) return;
        const at = resumePoint(videoId, video.duration);
        if (at) video.currentTime = at;
      },
      { once: true },
    );
    video.playbackRate = playbackRate;
    await video.play().catch(() => {});
    setDlWait(false);
    controls.style.display = "flex";
    refreshLibrary();
    if (job.has_subtitles) attachSubtitleTrack(videoId);
    else waitForSubtitles(videoId);
  } catch (err) {
    if (stale()) return;
    setDlWait(false);
    setLoadFailed(true);
    controls.style.display = "flex";
    if (isOffline()) {
      pendingPlay = { url: rawUrl, token };
      showError(
        `${OFFLINE_TEXT}.\nThis video isn't downloaded yet; it will start when you're back online.`,
      );
    } else
      showError(
        `Could not load this video.\n${err.message}\n\nMake sure the MinimalTube server is reachable at ${serverBase}.`,
      );
  } finally {
    if (!stale()) loadingBox.style.display = "none";
  }
}
async function startLiveStream(videoId, picks, job, stale, startAt) {
  const stream = new LiveStream(video, {
    base: serverBase,
    videoId,
    picks,
    duration: job.duration,
    startAt: startAt ?? resumePoint(videoId, job.duration || 0),
    onquality: (format) => flashText(`${format.height}p`),
    onfail: (err) => liveStreamFailed(videoId, stream, err),
  });
  liveStream = stream;
  stream.streamOnly = job.status === "streaming";
  setLoadingText("Starting stream…");
  try {
    await stream.start();
    if (stale() || liveStream !== stream) {
      stream.destroy();
      return false;
    }
    video.playbackRate = playbackRate;
    await video.play().catch(() => {});
    setDlWait(false);
    if (job.has_subtitles) attachSubtitleTrack(videoId);
    else waitForSubtitles(videoId);
    return true;
  } catch (err) {
    console.warn("MinimalTube: couldn't start the stream:", err);
    stream.destroy();
    if (liveStream === stream) {
      liveStream = null;
      video.removeAttribute("src");
      video.load();
    }
    return false;
  }
}
function stopLiveStream() {
  if (!liveStream) return;
  liveStream.destroy();
  liveStream = null;
  renderBuffered();
}
let streamFallbackAt = null;
function liveStreamFailed(videoId, stream, err) {
  if (liveStream !== stream) return;
  if (stream.streamOnly) return restartStream(videoId, stream, err);
  console.warn("MinimalTube: stream stopped, waiting for the download:", err);
  streamFallbackAt = video.currentTime;
  stopLiveStream();
  video.removeAttribute("src");
  video.load();
  if (videoId !== currentVideoId) return;
  loadingBox.style.display = "flex";
  setLoadingText("Downloading…");
  setDlWait(true);
}
// Stream only: there's no download to fall back on, so the stream starts again from the same
// second (with fresh links); if that fails too, the player says so.
let lastStreamRestart = { id: null, at: 0 };
async function restartStream(videoId, stream, err) {
  console.warn("MinimalTube: stream stopped, starting it again:", err);
  // a stream that fails again right after a restart isn't going to work: say so instead
  const again = lastStreamRestart.id === videoId && Date.now() - lastStreamRestart.at < 15000;
  lastStreamRestart = { id: videoId, at: Date.now() };
  const at = video.currentTime,
    wasPaused = video.paused,
    token = loadToken,
    stale = () => token !== loadToken || videoId !== currentVideoId;
  stopLiveStream();
  loadingBox.style.display = "flex";
  setLoadingText("Reconnecting the stream…");
  setDlWait(true);
  try {
    if (again) throw new Error(firstLine(String((err && err.message) || err)));
    const job = await api(preparePath(`https://www.youtube.com/watch?v=${videoId}`, true));
    if (stale()) return;
    const picks = job.status === "streaming" && LiveStream.pick(job.stream, { adaptive: true });
    if (!picks || !(await startLiveStream(videoId, picks, job, stale, at)))
      throw new Error(firstLine(String((err && err.message) || err)));
    if (wasPaused) video.pause();
  } catch (failure) {
    if (stale()) return;
    setDlWait(false);
    setLoadFailed(true);
    showError(
      isOffline()
        ? `${OFFLINE_TEXT}.\nThe stream stopped; it continues when you're back online.`
        : `The stream stopped.\n${failure.message}`,
    );
    if (isOffline()) pendingPlay = { url: `https://www.youtube.com/watch?v=${videoId}`, token };
  } finally {
    if (!stale()) loadingBox.style.display = "none";
  }
}
async function followDownload(videoId, token) {
  while (token === loadToken && videoId === currentVideoId) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (token !== loadToken) return;
    let job;
    try {
      job = await fetchJobStatus(videoId);
    } catch (err) {
      logQuiet("download progress", err);
      continue;
    }
    if (token !== loadToken) return;
    if (job.status === "error") {
      if (!liveStream) {
        loadingBox.style.display = "none";
        setLoadFailed(true);
        showError(`Could not load this video.\n${job.error || "Download failed"}`);
      }
      return;
    }
    if (job.status === "ready") {
      if (liveStream) handoverToFile(videoId);
      else if (streamFallbackAt !== null) playFileAt(videoId, streamFallbackAt, true);
      refreshLibrary();
      return;
    }
    if (!liveStream) showLoadingStatus(job);
  }
}
function handoverToFile(videoId) {
  if (!liveStream || videoId !== currentVideoId || video.ended) return;
  if (video.seeking) {
    video.addEventListener("seeked", () => handoverToFile(videoId), {
      once: true,
    });
    return;
  }
  playFileAt(videoId, video.currentTime, !video.paused);
}
function playFileAt(videoId, at, play) {
  const started = performance.now();
  stopLiveStream();
  streamFallbackAt = null;
  video.src = `${serverBase}/stream/${videoId}`;
  video.addEventListener(
    "loadedmetadata",
    () => {
      if (videoId !== currentVideoId) return;
      const elapsed = play ? (performance.now() - started) / 1000 : 0;
      video.currentTime = Math.min(at + elapsed, Math.max(0, video.duration - 0.1));
      video.playbackRate = playbackRate;
      loadingBox.style.display = "none";
      setDlWait(false);
      if (play) video.play().catch(() => {});
    },
    { once: true },
  );
}
function renderBuffered() {
  const duration = video.duration,
    ranges = video.buffered;
  if (!liveStream || !(duration > 0) || !isFinite(duration) || !ranges.length) {
    seekBuffered.innerHTML = "";
    return;
  }
  let html = "";
  for (let i = 0; i < ranges.length; i++)
    html += `<i style="left:${(ranges.start(i) / duration) * 100}%;width:${((ranges.end(i) - ranges.start(i)) / duration) * 100}%"></i>`;
  seekBuffered.innerHTML = html;
}
["progress", "timeupdate", "durationchange", "emptied", "seeked"].forEach(
  (type) => video.addEventListener(type, renderBuffered),
);
function normalizeCue(cue) {
  cue.snapToLines = true;
  cue.line = -1;
  cue.position = "auto";
  cue.size = 100;
  cue.align = "center";
}
function clearSubtitles() {
  Array.from(video.textTracks).forEach((track) => (track.mode = "disabled"));
  video.querySelectorAll("track").forEach((el) => el.remove());
}
function attachSubtitleTrack(videoId, token = loadToken) {
  if (videoId !== currentVideoId || token !== loadToken) return;
  clearSubtitles();
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.srclang = "en";
  track.label = "Subtitles";
  track.src = `${serverBase}/subtitles/${videoId}`;
  const apply = () => {
    const firstTrack = video.textTracks[0];
    if (firstTrack) {
      firstTrack.mode = captionsWanted ? "showing" : "hidden";
      (() => {
        const textTrack = video.textTracks[0];
        if (textTrack && textTrack.cues)
          Array.from(textTrack.cues).forEach((cue) => {
            normalizeCue(cue);
            if (!cue._minimaltubeNormalized) {
              cue._minimaltubeNormalized = true;
              cue.addEventListener("enter", () => normalizeCue(cue));
            }
          });
      })();
    }
  };
  track.addEventListener("load", apply);
  video.appendChild(track);
  apply();
  hasSubtitles = true;
  captionsBtn.style.display = "flex";
  captionsBtn.classList.toggle("active", captionsWanted);
}
// Captions that arrive after the video started (fetched alongside the download, or for a
// stream) are attached the moment they're there; the video keeps playing where it is.
async function waitForSubtitles(
  videoId,
  triesLeft = 120,
  delayMs = 1500,
  token = loadToken,
) {
  if (triesLeft <= 0 || videoId !== currentVideoId || token !== loadToken) return;
  try {
    const state = await api(`/subtitles/${videoId}/state`);
    if (videoId !== currentVideoId || token !== loadToken) return;
    if (state.has) return attachSubtitleTrack(videoId, token);
    if (state.decided) return; // this video has no captions we'd show
  } catch (err) {
    logQuiet("captions state", err);
  }
  setTimeout(
    () => waitForSubtitles(videoId, triesLeft - 1, delayMs, token),
    delayMs,
  );
}
function setCaptionsEnabled(enabled) {
  captionsWanted = enabled;
  captionsBtn.classList.toggle("active", enabled);
  if (video.textTracks[0])
    video.textTracks[0].mode = enabled ? "showing" : "hidden";
  chrome.storage.local.set({
    captionsEnabled: captionsWanted,
  });
}
function toggleCaptions() {
  if (hasSubtitles) setCaptionsEnabled(!captionsWanted);
}
function appendToQueue(newItems, { autoPlayIfEmpty = true } = {}) {
  if (!newItems || !newItems.length) return -1;
  const wasEmpty = !queue || !queue.items.length;
  if (!queue)
    queue = {
      items: [],
      currentIndex: -1,
    };
  const firstIndex = queue.items.length;
  return (
    newItems.forEach((item) =>
      queue.items.push({
        ...item,
      }),
    ),
    queue.items.forEach((item, index) => (item.index = index + 1)),
    resetDownloadAllButton(),
    renderQueue(),
    refreshLibrary(),
    startQueuePolling(),
    saveQueue(),
    wasEmpty && autoPlayIfEmpty
      ? ((playSource = "queue"),
        (queueIndex = firstIndex),
        markActiveQueueRow(),
        scrollActiveQueueRowIntoView(),
        prefetchNextInQueue(),
        playVideo(queue.items[queueIndex].url))
      : wasEmpty ||
        notify(
          newItems.length > 1
            ? `Added ${newItems.length} to queue`
            : "Added to queue",
        ),
    firstIndex
  );
}
function stripPlaylistParams(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.pathname !== "/playlist" &&
        (url.searchParams.delete("list"),
        url.searchParams.delete("index"),
        url.searchParams.delete("start_radio")),
      url.toString()
    );
  } catch {
    return rawUrl;
  }
}
async function addUrlToQueue(rawUrl) {
  const locked = queueLockedReason();
  if (locked) return notify(locked, true, 5000);
  rawUrl = stripPlaylistParams(rawUrl);
  const token = ++queueAddToken,
    listId = playlistIdFromUrl(rawUrl),
    videoId = videoIdFromUrl(rawUrl),
    wasEmpty = !queue || !queue.items.length;
  if (!listId) {
    const t = appendToQueue([
      {
        title: rawUrl,
        url: rawUrl,
      },
    ]);
    try {
      const data = await api(preparePath(rawUrl, false)),
        item = queue && queue.items[t];
      if (item && item.url === rawUrl) {
        item.id = data.video_id;
        item.title = data.title || item.title;
        renderQueue();
        saveQueue();
      }
    } catch (err) {
      logQuiet("queue a link", err);
    }
    return;
  }
  if (videoId && wasEmpty) {
    appendToQueue([
      {
        title: rawUrl,
        url: rawUrl,
      },
    ]);
    try {
      const pl = await fetchPlaylist(rawUrl);
      if (token !== queueAddToken) return;
      if (pl.items && pl.items.length) {
        queue = {
          items: pl.items,
          currentIndex: pl.currentIndex,
        };
        queue.items.forEach((item, index) => (item.index = index + 1));
        queueIndex = pl.currentIndex;
        resetDownloadAllButton();
        renderQueue();
        markActiveQueueRow();
        scrollActiveQueueRowIntoView();
        prefetchNextInQueue();
        saveQueue();
      }
    } catch (err) {
      notify(`Couldn't load playlist: ${firstLine(err.message)}`, true, 4e3);
    }
    return;
  }
  let playlist;
  notify("Loading playlist…");
  try {
    playlist = await fetchPlaylist(rawUrl);
    if (!playlist.items || !playlist.items.length)
      throw new Error("This playlist is empty.");
  } catch (err) {
    if (token !== queueAddToken) return;
    notify(`Couldn't load playlist: ${firstLine(err.message)}`, true, 4e3);
    return;
  }
  if (token === queueAddToken) appendToQueue(playlist.items);
}
function firstLine(message) {
  return String(message).split("\n")[0].slice(0, 200);
}
function togglePlayPause() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}
function flashPlayPause(paused) {
  centerFlash.classList.remove("show-text");
  centerFlash.classList.toggle("show-pause", paused);
  restartAnimation(centerFlash, "flash");
}
captionsBtn.addEventListener("click", toggleCaptions);
chrome.runtime.onMessage.addListener((item, t, fn) => {
  if (item?.type === "minimaltube-queue-add" && item.url) {
    addUrlToQueue(item.url);
    fn({
      ok: true,
    });
  } else if (item?.type === "minimaltube-take-playlist" && item.playlist) {
    whenLoaded(() => takeYouTubePlaylist(item.playlist));
    fn({ ok: true });
  } else if (item?.type === "minimaltube-subscriptions-imported") {
    whenLoaded(() => subscriptionsImported(item.result));
    fn({ ok: true });
  }
});
playPauseBtn.addEventListener("click", togglePlayPause);
const DOUBLE_CLICK_MS = 250;
let singleClickTimer = null;
function setSeekPosition(percent) {
  seekInput.value = percent;
  seekProgress.style.width = `${percent}%`;
}
function animateSeekTo(percent) {
  seekProgress.classList.add("jump");
  setSeekPosition(percent);
  clearTimeout(animateSeekTo._t);
  animateSeekTo._t = setTimeout(
    () => seekProgress.classList.remove("jump"),
    240,
  );
}
function toggleMute() {
  video.muted = !video.muted;
}
function setVolume(level) {
  const clamped = Math.min(1, Math.max(0, Math.round(100 * level) / 100));
  video.volume = clamped;
  volumeInput.value = clamped;
}
function setPlaybackRate(rate) {
  playbackRate = Math.min(5, Math.max(0.25, Math.round(10 * rate) / 10));
  video.playbackRate = playbackRate;
  speedBadge.textContent = `${playbackRate.toFixed(2)}x`;
  savePlaybackPrefs();
}
// Speed and volume stay as they were left, across videos and restarts.
const PLAYBACK_PREFS_KEY = "mt_playback";
function savePlaybackPrefs() {
  try {
    localStorage.setItem(
      PLAYBACK_PREFS_KEY,
      JSON.stringify({ rate: playbackRate, volume: video.volume, muted: video.muted }),
    );
  } catch (err) {
    logQuiet("playback prefs (save)", err);
  }
}
try {
  const prefs = JSON.parse(localStorage.getItem(PLAYBACK_PREFS_KEY) || "null");
  if (prefs) {
    if (prefs.rate > 0) setPlaybackRate(prefs.rate);
    if (prefs.volume >= 0) setVolume(prefs.volume);
    video.muted = !!prefs.muted;
  }
} catch (err) {
  logQuiet("playback prefs (read)", err);
}
video.addEventListener("click", () => {
  if (singleClickTimer)
    return (clearTimeout(singleClickTimer), void (singleClickTimer = null));
  singleClickTimer = setTimeout(() => {
    singleClickTimer = null;
    togglePlayPause();
  }, DOUBLE_CLICK_MS);
});
video.addEventListener("dblclick", toggleFullscreen);
video.addEventListener("play", () => {
  playPauseBtn.classList.add("is-playing");
  flashPlayPause(true);
});
video.addEventListener("pause", () => {
  playPauseBtn.classList.remove("is-playing");
  flashPlayPause(false);
});
video.addEventListener("timeupdate", () => {
  if (isFinite(video.duration)) {
    setSeekPosition((video.currentTime / video.duration) * 100);
    timeLabel.textContent = `${formatTime(video.currentTime, video.duration >= 3600)} / ${formatTime(video.duration, video.duration >= 3600)}`;
    skipSponsorSegmentIfInside();
    updateChapterLabel();
  }
});
seekInput.addEventListener("input", () => {
  animateSeekTo(seekInput.value);
  if (isFinite(video.duration))
    video.currentTime = (seekInput.value / 100) * video.duration;
});
volumeInput.addEventListener("input", () => {
  video.volume = parseFloat(volumeInput.value);
  if (video.muted && video.volume > 0) video.muted = false;
});
volumeIcon.addEventListener("click", toggleMute);
video.addEventListener("volumechange", () => {
  volumeInput.value = video.muted ? 0 : video.volume;
  volumeIcon.classList.toggle("is-muted", video.muted);
  savePlaybackPrefs();
});
volumeInput.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    setVolume(video.volume + (event.deltaY < 0 ? 0.05 : -0.05));
  },
  {
    passive: false,
  },
);
speedBadge.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    setPlaybackRate(playbackRate + (event.deltaY < 0 ? 0.1 : -0.1));
  },
  {
    passive: false,
  },
);
speedBadge.addEventListener("click", () => setPlaybackRate(1));
function isTypingTarget(el) {
  return (
    !!el &&
    (!!el.isContentEditable ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      (el.tagName === "INPUT" &&
        !["range", "checkbox", "radio", "button"].includes(el.type)))
  );
}
function hasVideoLoaded() {
  return !!video.getAttribute("src");
}
function toggleFullscreen() {
  if (playerFrame.classList.contains("mini")) return exitBrowse();
  if (controls.classList.contains("loadFailed")) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else playerFrame.requestFullscreen();
}
function setMediaSession(videoId, title) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: title || "MinimalTube",
    artwork: [{ src: `${serverBase}/thumb/${videoId}`, sizes: "320x180", type: "image/jpeg" }],
  });
  api(`/channel-of/${encodeURIComponent(videoId)}`)
    .then((meta) => {
      const metadata = navigator.mediaSession.metadata;
      if (videoId === currentVideoId && meta.channel && metadata) metadata.artist = meta.channel;
    })
    .catch((err) => logQuiet("media session", err));
}
const mediaSeek = (seconds) => {
  video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), video.duration || Infinity);
};
navigator.mediaSession.setActionHandler("previoustrack", () => skipVideo(-1));
navigator.mediaSession.setActionHandler("nexttrack", () => skipVideo(1));
// 5 s steps, as the arrow keys take, when the system doesn't say how far
navigator.mediaSession.setActionHandler("seekbackward", (details) => mediaSeek(-(details.seekOffset || 5)));
navigator.mediaSession.setActionHandler("seekforward", (details) => mediaSeek(details.seekOffset || 5));
navigator.mediaSession.setActionHandler("seekto", (details) => {
  video.currentTime = details.seekTime;
});
