/* MinimalTube player - Watch progress: where each video was stopped, the red bar on thumbnails, and sending finished
 * videos to YouTube history.
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
    bar = thumb.appendChild(el("div", "watchBar"));
    bar.appendChild(el("i"));
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
