/* MinimalTube player - The Settings card: its switches (the SETTINGS table, saved as they're flipped), the
 * window / tab switch, the downloads' size cap, and the server's buttons (videos folder, restart,
 * update yt-dlp).
 * Loaded in order by player.html (classic scripts sharing one scope). */

const streamOnlyMode = () => streamWhileDownloading && streamOnly;
// The switches in Settings: storage key, checkbox, default, and the variable it sets. Read at
// start (loadSettings), saved the moment one is flipped. One with `needs` can only be switched
// on together with that other switch (its row is dimmed otherwise).
const SETTINGS = [
  { key: "sponsorBlockEnabled", input: sponsorToggle, def: true, set: (on) => (sponsorBlockEnabled = on) },
  { key: "queuePersistEnabled", input: queuePersistToggle, def: false, set: (on) => (rememberQueue = on) },
  { key: "openYouTubeLinks", input: ytLinksToggle, def: false, set: () => {} }, // read by background.js, content-youtube.js
  { key: "ytHistorySyncEnabled", input: ytHistoryToggle, def: true, set: (on) => (ytHistorySync = on) },
  { key: "streamWhileDownloading", input: streamToggle, def: true, set: (on) => (streamWhileDownloading = on) },
  { key: "streamOnly", input: streamOnlyToggle, def: true, set: (on) => (streamOnly = on), needs: streamToggle },
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
SETTINGS.forEach(({ key, input, set }) =>
  input.addEventListener("change", () => {
    set(input.checked);
    chrome.storage.local.set({ [key]: input.checked });
    if (key === "sponsorBlockEnabled" && !input.checked) {
      sponsorSegments = [];
      renderSeekMarks();
    }
    if (key === "queuePersistEnabled") {
      if (input.checked) saveQueue();
      else chrome.storage.local.remove("savedQueue");
    }
  }),
);
// Settings is a card over the whole app: it comes in from above and leaves downwards.
let settingsLeaveTimer = 0,
  settingsReturnFocus = null;
function openSettings() {
  clearTimeout(settingsLeaveTimer);
  closeQueuePanel();
  settingsReturnFocus = document.activeElement;
  settingsPanel.classList.remove("leaving");
  settingsPanel.classList.add("open");
  gearBtn.classList.add("active");
  settingsPanel.querySelector(".settingsCard").focus({ preventScroll: true });
  showServerState();
  loadCacheLimit();
  paintViewSwitch();
}
// Its own window <-> a browser tab: the page itself moves (background.js, movePlayer), so a video
// keeps playing and the queue, the page and everything else stay as they are.
const viewSwitchBtn = document.getElementById("viewSwitchBtn");
async function paintViewSwitch() {
  const win = await chrome.windows.getCurrent().catch(() => null),
    inTab = !!win && win.type === "normal",
    label = inTab ? "Move to its own window" : "Move into a browser tab";
  viewSwitchBtn.innerHTML = inTab ? ICON_TO_WINDOW : ICON_TO_TAB;
  viewSwitchBtn.title = label;
  viewSwitchBtn.setAttribute("aria-label", label);
}
viewSwitchBtn.addEventListener("click", async () => {
  closeSettings();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  const res = await chrome.runtime.sendMessage({ type: "minimaltube-switch-view" }).catch(() => null);
  if (!res || !res.ok) notify(`Couldn't move MinimalTube: ${firstLine((res && res.error) || "no answer")}`, true, 5000);
});
// The downloads' size cap (16 to 1024 GB, the server keeps it). One below what the downloads
// already take is refused: the folder opens so some can be deleted by hand.
const cacheLimitInput = document.getElementById("cacheLimitInput"),
  cacheLimitMsg = document.getElementById("cacheLimitMsg");
let cacheLimitGb = null,
  cacheLimitRange = [16, 1024]; // the server says which sizes it takes
function showCacheLimitMsg(text) {
  cacheLimitMsg.textContent = text || "";
  cacheLimitMsg.hidden = !text;
}
async function loadCacheLimit() {
  showCacheLimitMsg("");
  try {
    const limit = await api("/cache-limit");
    cacheLimitGb = limit.gb;
    cacheLimitRange = [limit.min, limit.max];
    [cacheLimitInput.min, cacheLimitInput.max] = cacheLimitRange;
    cacheLimitInput.value = cacheLimitGb;
  } catch (err) {
    logQuiet("downloads size cap", err);
  }
}
async function saveCacheLimit() {
  const gb = Number(cacheLimitInput.value),
    [min, max] = cacheLimitRange;
  if (!Number.isInteger(gb) || gb < min || gb > max) {
    showCacheLimitMsg(`Choose a size from ${min} to ${max} GB.`);
    cacheLimitInput.value = cacheLimitGb ?? "";
    return;
  }
  if (gb === cacheLimitGb) return showCacheLimitMsg("");
  try {
    cacheLimitGb = (await api("/cache-limit", { method: "PUT", body: { gb } })).gb;
    cacheLimitInput.value = cacheLimitGb;
    showCacheLimitMsg("");
  } catch (err) {
    cacheLimitInput.value = cacheLimitGb ?? "";
    showCacheLimitMsg(firstLine(err.message));
    // the downloads already take more: the folder opens, so some can be deleted by hand
    if (/already take/.test(err.message))
      api("/open-folder", { method: "POST" }).catch((e) => logQuiet("open the videos folder", e));
  }
}
cacheLimitInput.addEventListener("change", saveCacheLimit);
cacheLimitInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  saveCacheLimit();
});
function closeSettings() {
  if (!settingsPanel.classList.contains("open")) return;
  settingsPanel.classList.remove("open");
  settingsPanel.classList.add("leaving");
  gearBtn.classList.remove("active");
  settingsLeaveTimer = setTimeout(() => settingsPanel.classList.remove("leaving"), CARD_OUT_MS);
  if (settingsPanel.contains(document.activeElement) && settingsReturnFocus?.isConnected)
    settingsReturnFocus.focus({ preventScroll: true });
}
openFolderBtn.addEventListener("click", async () => {
  closeSettings();
  try {
    await api("/open-folder", { method: "POST" });
  } catch (err) {
    notify(`Couldn't open videos location: ${firstLine(err.message)}`, true, 4000);
  }
});
// A restarting server runs itself again in place; it's back once /health reports a start time
// other than `old`. One that isn't running (old undefined), or doesn't come back, is started by
// the extension (native host). Resolves to whether a server answers now.
async function serverBack(old) {
  for (let i = 0; old !== undefined && i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const started = await api("/health").then((data) => data.started, () => undefined);
    if (started !== undefined && started !== old) {
      reloadFromServer();
      return true;
    }
  }
  const reply = await chrome.runtime.sendMessage({ type: "minimaltube-ensure-server" }).catch(() => null);
  if (!reply || !reply.ok) {
    notify(firstLine((reply && reply.error) || "Couldn't restart the server"), true, 6000);
    return false;
  }
  reloadFromServer();
  return true;
}
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
      6000,
    );
  }
  const old = res ? (await res.json().catch(() => ({}))).started : undefined;
  if (await serverBack(old)) notify(old === undefined ? "Server started" : "Server restarted");
}
async function updateYtdlp() {
  let data;
  try {
    data = await api("/ytdlp/update", { method: "POST", body: {} });
  } catch (err) {
    return notify(`Couldn't update yt-dlp: ${firstLine(err.message)}`, true, 8000);
  }
  if (data.status === "current") return notify(`yt-dlp is up to date (${data.version})`, false, 4000);
  notify(`yt-dlp ${data.version} installed, restarting the server…`, false, 15000);
  if (await serverBack(data.started)) notify(`yt-dlp updated to ${data.version}`, false, 4000);
}
let serverTaskRunning = false;
async function runServerTask(task, text) {
  closeSettings();
  if (serverTaskRunning) return;
  serverTaskRunning = true;
  notify(text, false, 120000);
  try {
    await task();
  } finally {
    serverTaskRunning = false;
  }
}
restartServerBtn.addEventListener("click", () => runServerTask(restartServer, "Restarting the server…"));
updateYtdlpBtn.addEventListener("click", () => runServerTask(updateYtdlp, "Updating yt-dlp…"));
/**
 * Loads again what the page shows from the server (saved playlists, Downloads, download
 * progress, the Subscriptions feed when it's open): for a server that has just (re)started.
 */
function reloadFromServer() {
  loadSavedPlaylists();
  refreshLibrary();
  pollStateSoon();
  if (document.body.classList.contains("browsing") && browseTab === "subs")
    loadSubscriptions().then(() => showFeed());
}
gearBtn.addEventListener("click", () => {
  if (settingsPanel.classList.contains("open")) closeSettings();
  else openSettings();
});
document.getElementById("settingsClose").addEventListener("click", closeSettings);
// Tab goes round the card's buttons and switches (not out to the page behind it); Enter flips a
// switch, like Space
settingsPanel.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.matches(".switch input")) {
    event.preventDefault();
    event.target.click();
  }
  if (event.key !== "Tab") return;
  const stops = [...settingsPanel.querySelectorAll("button, input")].filter((el) => !el.disabled);
  const at = stops.indexOf(event.target),
    next = at < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
  event.preventDefault();
  stops[next].focus();
});
// a click on the blurred page around the card closes it (one that started in the card doesn't)
let settingsDownOnBackdrop = false;
settingsPanel.addEventListener("pointerdown", (event) => (settingsDownOnBackdrop = event.target === settingsPanel));
settingsPanel.addEventListener("click", (event) => {
  if (settingsDownOnBackdrop && event.target === settingsPanel) closeSettings();
});
// The port this player talks to its server on (7860, or the next free one when that was taken)
const serverState = document.getElementById("serverState");
async function showServerState() {
  let port;
  try {
    port = new URL(serverBase).port || "80";
  } catch {
    port = "?";
  }
  const up = await api("/health").then(() => true, () => false);
  serverState.textContent = up ? `server on localhost:${port}` : `server not reachable (:${port})`;
  serverState.title = serverBase;
  serverState.classList.toggle("down", !up);
}
addLayer({
  el: settingsPanel,
  isOpen: () => settingsPanel.classList.contains("open"),
  close: closeSettings,
  inside: [gearBtn, "#bpSettingsBtn"],
});
