/* MinimalTube player - The player page's shared pieces: its elements, the connection state, notices, SponsorBlock lookups,
 * the server API (api, requestDownloads), small DOM helpers and the layer stack (Esc / click outside).
 * Loaded in order by player.html (classic scripts sharing one scope). */

const DEFAULT_SERVER = "http://127.0.0.1:7860",
  video = document.getElementById("video"),
  placeholder = document.getElementById("placeholder"),
  loadingBox = document.getElementById("loading"),
  loadingText = document.getElementById("loadingText"),
  titleOverlay = document.getElementById("videoTitleOverlay"),
  seekWrap = document.getElementById("seekWrap"),
  seekProgress = document.getElementById("seekProgress"),
  centerFlash = document.getElementById("centerFlash"),
  floatBtns = document.getElementById("floatBtns"),
  controls = document.getElementById("controls"),
  playPauseBtn = document.getElementById("playPause"),
  seekInput = document.getElementById("seek"),
  timeLabel = document.getElementById("time"),
  speedBadge = document.getElementById("speedBadge"),
  volumeInput = document.getElementById("volume"),
  volumeIcon = document.getElementById("volumeIcon"),
  captionsBtn = document.getElementById("captionsBtn"),
  fullscreenBtn = document.getElementById("fullscreen"),
  playerFrame = document.getElementById("playerFrame"),
  openFolderBtn = document.getElementById("openFolderBtn"),
  restartServerBtn = document.getElementById("restartServerBtn"),
  updateYtdlpBtn = document.getElementById("updateYtdlpBtn"),
  queueToggleBtn = document.getElementById("plToggle"),
  prevBtn = document.getElementById("prevBtn"),
  nextBtn = document.getElementById("nextBtn"),
  downloadAllBtn = document.getElementById("dlAllBtn"),
  queuePlName = document.getElementById("queuePlName"),
  queueSection = document.getElementById("playlistSection"),
  libraryList = document.getElementById("libList"),
  libraryCount = document.getElementById("libCount"),
  queuePanel = document.getElementById("playlistPanel"),
  queueList = document.getElementById("plList"),
  urlInput = document.getElementById("urlinput"),
  addUrlBtn = document.getElementById("playBtn"),
  errorBox = document.getElementById("errorBox"),
  gearBtn = document.getElementById("gear"),
  settingsPanel = document.getElementById("settingsPanel"),
  sponsorToggle = document.getElementById("sbToggle"),
  queuePersistToggle = document.getElementById("queuePersistToggle"),
  ytHistoryToggle = document.getElementById("ytHistoryToggle"),
  ytLinksToggle = document.getElementById("ytLinksToggle"),
  streamToggle = document.getElementById("streamToggle"),
  streamOnlyToggle = document.getElementById("streamOnlyToggle"),
  seekBuffered = document.getElementById("seekBuffered"),
  saveSettingsBtn = document.getElementById("saveSettings"),
  toastEl = document.getElementById("toast");
/* ---- Connection state. The server owns it: whenever something of its fails it checks whether
 * YouTube answers, and every response carries the result (X-MinimalTube-Net). A browser network
 * error on an internet URL, or the browser's offline / online events, ask it directly. While
 * offline it's asked every 10 s; the parts of the app registered with whenNetChanges() resume
 * when the connection is back. ---- */
const OFFLINE_TEXT = "No internet connection";
const offlineBadge = document.createElement("span");
offlineBadge.id = "offlineBadge";
offlineBadge.textContent = "OFFLINE";
offlineBadge.title = `${OFFLINE_TEXT}: YouTube can't be reached`;
document.getElementById("browseBrand").appendChild(offlineBadge);
const nativeFetch = window.fetch.bind(window);
const netListeners = [];
let netProbe = null,
  netTimer = 0;
const isOffline = () => offlineBadge.classList.contains("show");
const whenNetChanges = (fn) => netListeners.push(fn);
const netMessage = (fallback) => (isOffline() ? OFFLINE_TEXT : fallback);
function setOffline(off) {
  const changed = off !== isOffline();
  offlineBadge.classList.toggle("show", off);
  clearTimeout(netTimer);
  if (off) netTimer = setTimeout(checkNet, 10000);
  if (!changed) return;
  netListeners.forEach((fn) => {
    try {
      fn(off);
    } catch (err) {
      console.warn("MinimalTube: connection listener failed:", err);
    }
  });
  if (!off) sendOnline();
}
// The background resends what didn't reach YouTube (history pings, playlist syncs); also once
// at start, for anything left from a time the player was closed.
function sendOnline() {
  chrome.runtime.sendMessage({ type: "minimaltube-online" }, () => void chrome.runtime.lastError);
}
setTimeout(() => isOffline() || sendOnline(), 5000);
function checkNet() {
  if (netProbe) return netProbe;
  netProbe = nativeFetch(`${serverBase}/net`)
    .then((res) => res.json())
    .then((data) => setOffline(data.online === false))
    .catch((err) => logQuiet("connection check", err))
    .finally(() => setTimeout(() => (netProbe = null), 3000));
  return netProbe;
}
window.fetch = async (input, init) => {
  const url = String((input && input.url) || input);
  const local = url.startsWith(serverBase) || !/^https?:/.test(url);
  try {
    const res = await nativeFetch(input, init);
    const state = local && res.headers.get("X-MinimalTube-Net");
    if (state) setOffline(state === "offline");
    return res;
  } catch (err) {
    if (!local && err.name !== "AbortError") checkNet();
    throw err;
  }
};
window.addEventListener("offline", checkNet);
window.addEventListener("online", checkNet);
if (!navigator.onLine) setTimeout(checkNet, 0);
let serverBase = DEFAULT_SERVER,
  sponsorBlockEnabled = true,
  sponsorSegments = [],
  currentVideoId = null,
  playbackRate = 1,
  captionsWanted = false,
  rememberQueue = false,
  ytHistorySync = false,
  streamWhileDownloading = false,
  streamOnly = false, // stream without downloading (only with streamWhileDownloading)
  liveStream = null,
  hasSubtitles = false,
  queue = null,
  queueIndex = -1,
  queueAddToken = 0,
  loadToken = 0;
// "queue" | "library": which list the current video came from; "detour": played on the side of a
// queue that is a saved playlist (playVideoNow), which carries on after it
let playSource = "queue";
function formatTime(seconds, long = false) {
  const total = isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0,
    pad = (v) => String(v).padStart(2, "0"),
    hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    sec = total % 60;
  return long
    ? `${pad(hours)}:${pad(minutes)}:${pad(sec)}`
    : `${pad(minutes)}:${pad(sec)}`;
}
// The one way to tell the user something: a toast at the bottom of the window (over the
// controls in the player, at the bottom edge while browsing, inside the player in fullscreen).
function notify(message, isError = false, ms = 2500) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", isError);
  toastEl.classList.add("show");
  clearTimeout(notify._t);
  notify._t = setTimeout(() => toastEl.classList.remove("show"), ms);
}
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
function videoIdFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.includes("youtu.be")
      ? url.pathname.slice(1).split("/")[0] || null
      : url.searchParams.get("v");
  } catch {
    return null;
  }
}
function playlistIdFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get("list");
  } catch {
    return null;
  }
}
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
function announceSponsorSkip(seconds) {
  notify(`Skipped sponsor segment (${seconds}s)`);
}
function skipSponsorSegmentIfInside() {
  if (!sponsorBlockEnabled || sponsorSegments.length === 0) return;
  const at = video.currentTime;
  for (const segment of sponsorSegments)
    if (at >= segment.start && at < segment.end - 0.05) {
      const skipped = Math.round(segment.end - at);
      video.currentTime = segment.end;
      announceSponsorSkip(skipped);
      break;
    }
}
// Errors that don't break anything go to the extension console (right-click → Inspect on the
// player), at most once a minute per place, so an offline spell doesn't flood it.
const quietLogged = new Map();
function logQuiet(where, err) {
  if (err && err.name === "AbortError") return;
  const now = Date.now();
  if (now - (quietLogged.get(where) || 0) < 60000) return;
  quietLogged.set(where, now);
  console.warn(`MinimalTube (${where}):`, err);
}
async function readServerJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error)
    throw new Error(
      data.error ||
        (res.status === 404 || res.status === 405
          ? "the running server is outdated - restart it (Settings → Restart server)"
          : `Server returned ${res.status}`),
    );
  return data;
}
async function api(path, { method = "GET", body, keepalive } = {}) {
  const json = body !== undefined;
  const res = await fetch(`${serverBase}${path}`, {
    method,
    keepalive,
    headers: json ? { "Content-Type": "application/json" } : undefined,
    body: json ? JSON.stringify(body) : undefined,
  });
  return readServerJson(res);
}
async function requestDownloads(ids, items) {
  const data = await api("/queue", {
    method: "POST",
    body: { ids, titles: titlesFor(items), sponsorblock: sponsorBlockEnabled },
  });
  pollDownloadsSoon();
  return data;
}
/**
 * The /prepare request for a video, carrying the settings the server acts on: Stream only, and
 * SponsorBlock (a download then keeps the video's sponsor segments for offline playback).
 * @param {string} url The video's YouTube URL.
 * @param {boolean} [streamOnly] Stream without downloading; defaults to the Stream only setting.
 * @returns {string} The path to pass to api().
 */
function preparePath(url, streamOnly = streamOnlyMode()) {
  return `/prepare?url=${encodeURIComponent(url)}${streamOnly ? "&stream_only=1" : ""}${
    sponsorBlockEnabled ? "&sponsorblock=1" : ""
  }`;
}
/**
 * Letter keys for a dialog's buttons while it shows, the ones its key hints name. They're caught
 * before the player's own letter keys (C is captions), and left alone while typing in a field.
 * @param {HTMLElement} dialog Open while it has the class "show".
 * @param {Object<string, HTMLButtonElement>} buttons KeyboardEvent.code → the button it clicks,
 *   e.g. {KeyC: cancelButton}.
 */
function dialogKeys(dialog, buttons) {
  document.addEventListener(
    "keydown",
    (event) => {
      if (!dialog.classList.contains("show") || event.ctrlKey || event.metaKey || event.altKey ||
          event.repeat || isTypingTarget(event.target))
        return;
      const button = buttons[event.code];
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      button.click();
    },
    true,
  );
}
function restartAnimation(node, ...classes) {
  node.classList.remove(...classes);
  void node.offsetWidth;
  node.classList.add(...classes);
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
// The player's files run one after another, and a storage read or fetch started by one of them
// can finish before the later files have run; work that may call into them waits for all of them.
function whenLoaded(fn) {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => fn(), { once: true });
  else fn();
}

/* ---- Layers: everything that opens over the app (panels, menus, dialogs) registers once.
 * Esc closes the topmost open one (highest `level`); a press outside closes any open one it's
 * outside of (`inside`: the buttons that toggle it). Layers with `items` (the ⋮ menus) also
 * get the keyboard: see "Keyboard in lists" (↑ ↓, ".", focus going back to the list). ---- */
const layers = [];
function addLayer(layer) {
  layers.push({ level: 1, inside: [], outside: true, ...layer });
}
const openLayers = () => layers.filter((layer) => layer.isOpen());
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const open = openLayers();
  if (!open.length) return;
  const top = open.reduce((a, b) => (b.level >= a.level ? b : a));
  event.preventDefault();
  top.close();
});
document.addEventListener(
  "mousedown",
  (event) => {
    const target = event.target;
    const within = (spot) =>
      typeof spot === "string"
        ? !!(target.closest && target.closest(spot))
        : !!(spot && spot.contains(target));
    openLayers().forEach((layer) => {
      if (layer.outside && !within(layer.el) && !layer.inside.some(within)) layer.close();
    });
  },
  true,
);

function fetchJobStatus(videoId) {
  return api(`/status/${videoId}`);
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
