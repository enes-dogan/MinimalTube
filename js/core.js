/* MinimalTube player - The player page's shared pieces: its elements, the connection state, notices, the server API
 * (api, prepareVideo), small DOM helpers and the layer stack (Esc / click outside).
 * Loaded in order by player.html (classic scripts sharing one scope). */

// One player at a time: opened with nothing to open while another runs, this one hands over to
// it and is closed (background.js, playerOpened)
chrome.runtime.sendMessage({ type: "minimaltube-player-opened", bare: !location.search }, () => chrome.runtime.lastError);

// Opened straight from the app menu, the server may not be running yet: the extension starts it
// (native host) and says where it is. Nothing is asked of the server before that answer, so a
// fresh start doesn't begin with refused requests; api() waits for it. Without an answer (the
// extension was just reloaded) the wait ends by itself.
const serverReady = new Promise((resolve) => {
  setTimeout(resolve, 15000);
  chrome.runtime.sendMessage({ type: "minimaltube-ensure-server" }, (res) => {
    if (!chrome.runtime.lastError && res && res.ok && res.serverBase) serverBase = res.serverBase;
    resolve();
  });
});

const video = document.getElementById("video"),
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
  queuePasteInput = document.getElementById("queuePaste"),
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
  toastEl = document.getElementById("toast");
/* ---- Connection state. The server owns it: whenever something of its fails it checks whether
 * YouTube answers (and keeps checking while it doesn't), and every response carries the result
 * (X-MinimalTube-Net), the state loop's among them (jobs.js). A browser network error on an
 * internet URL, or the browser's offline / online events, ask it directly. The parts of the app
 * registered with whenNetChanges() resume when the connection is back. ---- */
const OFFLINE_TEXT = "No internet connection";
const offlineBadge = document.createElement("span");
offlineBadge.id = "offlineBadge";
offlineBadge.textContent = "OFFLINE";
offlineBadge.title = `${OFFLINE_TEXT}: YouTube can't be reached`;
document.getElementById("browseBrand").appendChild(offlineBadge);
const nativeFetch = window.fetch.bind(window);
const netListeners = [];
let netProbe = null;
const isOffline = () => offlineBadge.classList.contains("show");
const whenNetChanges = (fn) => netListeners.push(fn);
const netMessage = (fallback) => (isOffline() ? OFFLINE_TEXT : fallback);
function setOffline(off) {
  const changed = off !== isOffline();
  offlineBadge.classList.toggle("show", off);
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
  loadToken = 0; // bumped when another video starts loading: what was under way for the last one stops
// The one way to tell the user something: a toast at the bottom of the window (over the
// controls in the player, at the bottom edge while browsing, inside the player in fullscreen).
function notify(message, isError = false, ms = 2500) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", isError);
  toastEl.classList.add("show");
  clearTimeout(notify._t);
  notify._t = setTimeout(() => toastEl.classList.remove("show"), ms);
}
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
  await serverReady;
  const json = body !== undefined;
  const res = await fetch(`${serverBase}${path}`, {
    method,
    keepalive,
    headers: json ? { "Content-Type": "application/json" } : undefined,
    body: json ? JSON.stringify(body) : undefined,
  });
  return readServerJson(res);
}
/**
 * Asks the server to get a video ready to play (POST /prepare), with the settings the server acts
 * on: Stream only, and SponsorBlock (a download then keeps the video's sponsor segments for
 * offline playback). A video that isn't downloaded starts downloading, unless Stream only.
 * @param {string} url The video's YouTube link.
 * @param {boolean} [streamOnly] Stream without downloading; defaults to the Stream only setting.
 * @returns {Promise<object>} The video's job: {status, video_id, title, has_subtitles}, plus
 *   {stream, duration} while it isn't downloaded. `status` is "ready", "streaming" (Stream only)
 *   or a download's ("downloading", "merging", ...).
 */
function prepareVideo(url, streamOnly = streamOnlyMode()) {
  return api("/prepare", {
    method: "POST",
    body: { url, stream_only: streamOnly, sponsorblock: sponsorBlockEnabled },
  });
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
// How long a card over the app (settings, welcome, shortcuts) takes to leave: css "cardOut".
const CARD_OUT_MS = 200;
/**
 * Plays an overlay's leaving animation (class "leaving": the backdrop fades, its card slides
 * down), then takes it out of the page. It stops taking clicks right away.
 * @param {HTMLElement} el The overlay to remove.
 */
function removeAnimated(el) {
  el.classList.add("leaving");
  setTimeout(() => el.remove(), CARD_OUT_MS);
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
const byId = (id) => document.getElementById(id);
// The player's files run one after another, and a storage read or fetch started by one of them
// can finish before the later files have run; work that may call into them waits for all of them.
function whenLoaded(fn) {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => fn(), { once: true });
  else fn();
}
function resetStrayScroll() {
  ["app", "playerFrame", "mainArea", "stage"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.scrollLeft) el.scrollLeft = 0;
  });
  if (document.scrollingElement.scrollLeft) document.scrollingElement.scrollLeft = 0;
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
