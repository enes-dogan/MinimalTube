/* MinimalTube player - Playing a video: preparing it, streaming (stream.js) and the handover to the downloaded
 * file, SponsorBlock, captions, the basic controls (seek, volume, speed, fullscreen) and the
 * system's media controls.
 * Loaded in order by player.html (classic scripts sharing one scope). */

function showError(message) {
  errorBox.textContent = message;
  errorBox.style.display = "block";
}
// While a video is still downloading its control bar is shown, but play / seek / captions /
// speed are switched off until it can actually play.
function setDlWait(on) {
  controls.classList.toggle("dlWait", on);
  [playPauseBtn, seekWrap, captionsBtn, speedBadge].forEach((el) => {
    if (el) el.inert = on;
  });
}
function setLoadFailed(on) {
  controls.classList.toggle("loadFailed", on);
  [playPauseBtn, seekWrap, captionsBtn, speedBadge, fullscreenBtn].forEach(
    (el) => {
      if (el) el.inert = on;
    },
  );
  if (on) captionsBtn.style.display = "flex";
}
function clearError() {
  errorBox.style.display = "none";
  errorBox.textContent = "";
}
function setLoadingText(message) {
  loadingText.textContent = message;
}
function showLoadingStatus(job) {
  if (job.status === "waiting") setLoadingText(`${OFFLINE_TEXT}: waiting to continue…`);
  else if (job.status === "downloading")
    setLoadingText(`Downloading… ${job.percent ?? 0}%`);
  else if (job.status === "merging") setLoadingText("Merging audio + video…");
  else setLoadingText("Resolving video…");
}
// A video that couldn't start because the connection was gone; it starts once it's back
// (unless something else was played meanwhile).
let pendingPlay = null;
whenNetChanges((offline) => {
  const pending = pendingPlay;
  if (offline || !pending || pending.token !== loadToken) return;
  pendingPlay = null;
  playVideo(pending.url, { gentle: false, autoplay: pending.autoplay });
});
// `autoplay: false` loads the video and stops at its resume point (the app's start bringing back
// the last video of a remembered queue).
async function playVideo(rawUrl, { gentle = true, autoplay = true } = {}) {
  // Offline, a video that isn't downloaded can't play: keep the one being watched (and the
  // queue pointing at it).
  if (isOffline() && isWatching() && !isDownloadedId(videoIdFromUrl(rawUrl))) {
    const idx = queueIndexOfId(currentVideoId);
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
    let job = await prepareVideo(rawUrl);
    if (stale()) return;
    const videoId = job.video_id;
    currentVideoId = videoId;
    if (job.status !== "ready" && job.status !== "streaming") pollStateSoon();
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
      if (picks && (await startLiveStream(videoId, picks, job, stale, undefined, autoplay))) return;
      if (stale()) return;
      notify("This video can't be streamed here, so it's downloading instead.", true, 4000);
      job = await prepareVideo(rawUrl, false);
      if (stale()) return;
      job.stream = null;
    }
    if (job.status !== "ready" && streamWhileDownloading) {
      const picks = LiveStream.pick(job.stream);
      if (picks && (await startLiveStream(videoId, picks, job, stale, undefined, autoplay))) {
        followDownload(videoId, token);
        return;
      }
      if (stale()) return;
    }
    if (job.status !== "ready") {
      // it has to download first: the state loop (jobs.js) says when it's done
      showLoadingStatus(job);
      job = await untilDownloaded(videoId, stale, { onProgress: showLoadingStatus });
      if (!job) return;
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
    if (autoplay) await video.play().catch(() => {});
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
      pendingPlay = { url: rawUrl, token, autoplay };
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
async function startLiveStream(videoId, picks, job, stale, startAt, autoplay = true) {
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
    if (autoplay) await video.play().catch(() => {});
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
    const job = await prepareVideo(watchUrl(videoId), true);
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
    if (isOffline()) pendingPlay = { url: watchUrl(videoId), token };
  } finally {
    if (!stale()) loadingBox.style.display = "none";
  }
}
// A video that streams while it downloads: once the download is done, playback moves over to
// the file (or starts from it, when the stream had stopped meanwhile).
async function followDownload(videoId, token) {
  const stale = () => token !== loadToken || videoId !== currentVideoId;
  try {
    const job = await untilDownloaded(videoId, stale, {
      patient: true,
      onProgress: (progress) => liveStream || showLoadingStatus(progress),
    });
    if (!job) return;
    if (liveStream) handoverToFile(videoId);
    else if (streamFallbackAt !== null) playFileAt(videoId, streamFallbackAt, true);
  } catch (err) {
    if (stale() || liveStream) return; // the stream plays on without the file
    loadingBox.style.display = "none";
    setLoadFailed(true);
    showError(`Could not load this video.\n${err.message}`);
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
  playerFrame.classList.remove("tucked");
  clearSeekExtras();
  markActiveLibraryRow();
}

/* ---- SponsorBlock ---- */
async function loadSponsorSegments(videoId) {
  sponsorSegments = [];
  if (videoId && sponsorBlockEnabled)
    try {
      // through the server: it keeps a download's segments, so they're there offline too
      const { segments } = await api(`/sponsorblock/${encodeURIComponent(videoId)}`);
      if (videoId !== currentVideoId || !Array.isArray(segments)) return;
      sponsorSegments = segments;
      renderSeekMarks();
    } catch (err) {
      logQuiet("SponsorBlock", err);
    }
}
function skipSponsorSegmentIfInside() {
  if (!sponsorBlockEnabled || sponsorSegments.length === 0) return;
  const at = video.currentTime;
  for (const segment of sponsorSegments)
    if (at >= segment.start && at < segment.end - 0.05) {
      const skipped = Math.round(segment.end - at);
      video.currentTime = segment.end;
      notify(`Skipped sponsor segment (${skipped}s)`);
      break;
    }
}

/* ---- Captions ---- */
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
    const textTrack = video.textTracks[0];
    if (!textTrack) return;
    textTrack.mode = captionsWanted ? "showing" : "hidden";
    Array.from(textTrack.cues || []).forEach((cue) => {
      normalizeCue(cue);
      if (cue._minimaltubeNormalized) return;
      cue._minimaltubeNormalized = true;
      cue.addEventListener("enter", () => normalizeCue(cue));
    });
  };
  track.addEventListener("load", apply);
  video.appendChild(track);
  apply();
  hasSubtitles = true;
  captionsBtn.style.display = "flex";
  captionsBtn.classList.toggle("active", captionsWanted);
}
// Captions that arrive after the video started (fetched alongside the download, or for a
// stream) are attached the moment they're there; the video keeps playing where it is. The state
// loop (jobs.js) asks about them along with everything else, for up to CAPTIONS_WAIT_MS.
const CAPTIONS_WAIT_MS = 180000;
let captionsWait = null; // {id, token, until} while they're waited for
function waitForSubtitles(videoId, token = loadToken) {
  captionsWait = { id: videoId, token, until: Date.now() + CAPTIONS_WAIT_MS };
  captionsAwaited = videoId;
  pollStateSoon();
}
whenStateChanges((state) => {
  const wait = captionsWait;
  if (!wait) return;
  const answer = state.captions && state.captions.id === wait.id ? state.captions : null,
    over = wait.id !== currentVideoId || wait.token !== loadToken || Date.now() > wait.until;
  if (!over && answer && answer.has) attachSubtitleTrack(wait.id, wait.token);
  // "decided" without captions: this video has none we'd show
  if (over || (answer && (answer.has || answer.decided))) captionsWait = captionsAwaited = null;
});
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
function flashSpeed() {
  flashText(`${playbackRate.toFixed(2)}x`);
}
function flashText(text) {
  centerFlash.querySelector(".txt").textContent = text;
  centerFlash.classList.remove("show-pause");
  centerFlash.classList.add("show-text");
  restartAnimation(centerFlash, "flash");
}
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
  if (singleClickTimer) {
    // the second click of a double click: that one is fullscreen's
    clearTimeout(singleClickTimer);
    singleClickTimer = null;
    return;
  }
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
function paintVolumeIcon() {
  const v = video.muted ? 0 : video.volume;
  volumeIcon.dataset.level = v <= 0 ? "0" : v > 0.66 ? "3" : v > 0.33 ? "2" : "1";
}
video.addEventListener("volumechange", () => {
  volumeInput.value = video.muted ? 0 : video.volume;
  paintVolumeIcon();
  savePlaybackPrefs();
});
// the wheel over the button or its slider: up louder (and unmuted, as ↑ does), down quieter
document.getElementById("volumeWrap").addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const up = event.deltaY < 0;
    if (up && video.muted) video.muted = false;
    setVolume(video.volume + (up ? 0.05 : -0.05));
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
fullscreenBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  fullscreenBtn.classList.toggle("is-fullscreen", !!document.fullscreenElement);
  const host = document.fullscreenElement || document.body;
  host.append(undoBar, toastEl, settingsPanel);
});
