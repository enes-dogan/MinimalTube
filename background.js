// MinimalTube background service worker
// - "Add to MinimalTube queue" right-click entries on YouTube, and opening the player window
// - makes sure the local MinimalTube server is running (starting it through the
//   native host if it isn't) before anything needs it
// - YouTube watch history and two-way playlist sync (through youtube.js), retried when the
//   connection is back

importScripts("youtube.js");

const MENU_QUEUE = "minimaltube-play";
const MENU_QUEUE_PAGE = "minimaltube-play-page";

const NATIVE_HOST = "com.minimaltube.host";
const DEFAULT_SERVER = "http://127.0.0.1:7860";

const QUEUE_PAGE_PATTERNS = [
  "*://*.youtube.com/watch*",
  "*://*.youtube.com/shorts/*",
  "*://*.youtube.com/live/*",
];
const QUEUE_LINK_PATTERNS = [
  "*://*.youtube.com/watch*",
  "*://*.youtube.com/shorts/*",
  "*://*.youtube.com/playlist*",
  "*://youtu.be/*",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors that don't break anything go to this service worker's console (chrome://extensions →
// MinimalTube → "service worker"), at most once a minute per place.
const quietLogged = new Map();
function logQuiet(where, err) {
  const now = Date.now();
  if (now - (quietLogged.get(where) || 0) < 60000) return;
  quietLogged.set(where, now);
  console.warn(`MinimalTube (${where}):`, err);
}

// Default window size: 2/3 of the screen width x 5/6 of its height (1280x900 on 1920x1080).
// The player (js/downloads-tab.js) works that out from the real screen and stores it under "windowSize"; this
// fixed value is only the fallback until the player has run once.
const DEFAULT_WINDOW = { width: 1280, height: 900 };

async function getWindowSize() {
  try {
    const { windowSize } = await chrome.storage.local.get(["windowSize"]);
    const w = Math.round(Number(windowSize && windowSize.width));
    const h = Math.round(Number(windowSize && windowSize.height));
    if (w >= 400 && h >= 300) return { width: w, height: h };
  } catch (err) {
    logQuiet("window size", err);
  }
  return DEFAULT_WINDOW;
}

/* ------------------------------------------------------------------ URLs */

// Keep playlist params only for real playlist pages.
function stripPlaylistParams(url) {
  try {
    const u = new URL(url);
    if (u.pathname !== "/playlist") {
      u.searchParams.delete("list");
      u.searchParams.delete("index");
      u.searchParams.delete("start_radio");
    }
    return u.toString();
  } catch {
    return url;
  }
}

/* ---------------------------------------------------------- player window */

async function findPlayerTab() {
  try {
    const tabs = await chrome.tabs.query({
      url: chrome.runtime.getURL("player.html") + "*",
    });
    if (tabs.length) return tabs[0];
  } catch (err) {
    logQuiet("find the player", err);
  }
  return null;
}

async function openPlayerWindow(url) {
  const existing = await findPlayerTab();
  if (existing) {
    try {
      // A bare "open the player" request must not reload a player that's already running.
      if (url.includes("?")) await chrome.tabs.update(existing.id, { url });
      await chrome.windows.update(existing.windowId, { focused: true });
      return;
    } catch {} // it was just closed: open a new one below
  }
  const { minimaltubeWindowId: id } = await chrome.storage.local.get([
    "minimaltubeWindowId",
  ]);
  if (id != null) {
    try {
      const win = await chrome.windows.get(id, { populate: true });
      const tab = win.tabs && win.tabs[0];
      if (tab) {
        await chrome.tabs.update(tab.id, { url });
        await chrome.windows.update(id, { focused: true });
        return;
      }
    } catch {} // that window is gone: open a new one below
  }
  const size = await getWindowSize();
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: size.width,
    height: size.height,
  });
  await chrome.storage.local.set({ minimaltubeWindowId: win.id });
}

/* ----------------------------------------------------------------- server */

async function getServerBase() {
  const { serverBase } = await chrome.storage.local.get(["serverBase"]);
  return (serverBase || DEFAULT_SERVER).replace(/\/$/, "");
}

async function isHealthy(base) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${base}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// Promise wrapper around native messaging that never rejects.
function nativeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          const m = err.message || "";
          let error = m;
          if (/not found/i.test(m))
            error = `Native host not installed. Run ./install.sh ${chrome.runtime.id} once, then try again.`;
          else if (/forbidden/i.test(m))
            error = `This extension isn't allowed to use the native host. Run ./install.sh ${chrome.runtime.id} again.`;
          return resolve({ ok: false, error });
        }
        resolve(response && response.ok !== undefined ? response : { ok: false, error: "No response from native host" });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

async function startServer(base) {
  let port = 7860;
  try {
    const u = new URL(base);
    if (!["127.0.0.1", "localhost"].includes(u.hostname))
      return {
        ok: false,
        serverBase: base,
        error: `Can't auto-start a server on another machine (${base}).`,
      };
    port = Number(u.port) || 80;
  } catch (err) {
    logQuiet("server address", err); // not a URL: try the default port
  }

  const res = await nativeMessage({ action: "start-server", port });
  if (!res.ok)
    return {
      ok: false,
      serverBase: base,
      error: `Couldn't start the MinimalTube server: ${res.error}`,
    };

  // Flask + yt-dlp take a moment to come up.
  for (let i = 0; i < 40; i++) {
    if (await isHealthy(base)) return { ok: true, serverBase: base, started: true };
    await sleep(250);
  }
  return {
    ok: false,
    serverBase: base,
    error: "Started the server but it didn't respond. Check ~/.cache/minimaltube/server.log",
  };
}

let startingServer = null;

// Resolves to { ok, serverBase, error? }. Starts the server if it isn't running.
async function ensureServer() {
  const base = await getServerBase();
  if (await isHealthy(base)) return { ok: true, serverBase: base };
  if (!startingServer)
    startingServer = startServer(base).finally(() => {
      startingServer = null;
    });
  return startingServer;
}

function notifyServerProblem(res) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "MinimalTube server isn't running",
    message: res.error || `Couldn't reach ${res.serverBase}.`,
  });
}

async function ensureServerOrNotify() {
  const res = await ensureServer();
  if (!res.ok) notifyServerProblem(res);
  return res;
}

/* ------------------------------------------------------------ MinimalTube */

async function addToQueue(rawUrl) {
  const url = stripPlaylistParams(rawUrl);
  const server = await ensureServerOrNotify();
  if (!server.ok) return server;

  const found = await findPlayerTab();
  if (found) {
    try {
      await chrome.tabs.sendMessage(found.id, {
        type: "minimaltube-queue-add",
        url,
      });
      await chrome.windows.update(found.windowId, { focused: true });
      return { ok: true, serverBase: server.serverBase };
    } catch {} // the player is still loading or was closed: open it with the URL below
  }

  const { minimaltubeWindowId: id } = await chrome.storage.local.get([
    "minimaltubeWindowId",
  ]);
  if (id != null) {
    try {
      const win = await chrome.windows.get(id, { populate: true });
      const tab = win.tabs && win.tabs[0];
      if (tab) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: "minimaltube-queue-add",
            url,
          });
          await chrome.windows.update(id, { focused: true });
          return { ok: true, serverBase: server.serverBase };
        } catch {} // not ready to take messages: open it with the URL below
      }
    } catch {} // that window is gone
  }
  await openPlayerWindow(
    chrome.runtime.getURL("player.html") + "?url=" + encodeURIComponent(url),
  );
  return { ok: true, serverBase: server.serverBase };
}

// A playlist goes to the new player through storage (too big for its URL).
async function stashPlaylist(playlist) {
  const key = "pl_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  await chrome.storage.local.set({ [key]: playlist });
  return key;
}

async function openInPlayer(url, playlist) {
  const hasList = playlist && Array.isArray(playlist.items) && playlist.items.length;
  if (hasList && playlist.savePrompt) return openPlaylistToSave(playlist);
  const server = await ensureServerOrNotify();
  if (!server.ok) return server;

  let playerUrl =
    chrome.runtime.getURL("player.html") + "?url=" + encodeURIComponent(url);
  if (hasList) playerUrl += "&pid=" + encodeURIComponent(await stashPlaylist(playlist));
  await openPlayerWindow(playerUrl);
  return { ok: true, serverBase: server.serverBase };
}

// The playlist-page button: an open player takes the playlist as its queue (nothing starts
// playing) and offers to save it; without one, a new player does the same.
async function openPlaylistToSave(playlist) {
  const server = await ensureServerOrNotify();
  if (!server.ok) return server;
  const found = await findPlayerTab();
  if (found) {
    try {
      await chrome.tabs.sendMessage(found.id, { type: "minimaltube-take-playlist", playlist });
      await chrome.windows.update(found.windowId, { focused: true });
      return { ok: true, serverBase: server.serverBase };
    } catch {} // still loading or just closed: open it below
  }
  await openPlayerWindow(
    chrome.runtime.getURL("player.html") + "?pid=" + encodeURIComponent(await stashPlaylist(playlist)),
  );
  return { ok: true, serverBase: server.serverBase };
}

/* ----------------------------------------------------------- context menu */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_QUEUE,
      title: "Add to MinimalTube queue",
      contexts: ["link"],
      targetUrlPatterns: QUEUE_LINK_PATTERNS,
    });
    chrome.contextMenus.create({
      id: MENU_QUEUE_PAGE,
      title: "Add this video to MinimalTube queue",
      contexts: ["page", "video"],
      documentUrlPatterns: QUEUE_PAGE_PATTERNS,
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_QUEUE && info.linkUrl) addToQueue(info.linkUrl);
  else if (info.menuItemId === MENU_QUEUE_PAGE && info.pageUrl)
    addToQueue(info.pageUrl);
});

/* --------------------------------------------------------------- messages */

/* ------------------------------------------------- YouTube watch history */

const HISTORY_PENDING_KEY = "ytHistoryPending";

async function getHistoryPending() {
  const stored = await chrome.storage.local.get([HISTORY_PENDING_KEY]);
  return Array.isArray(stored[HISTORY_PENDING_KEY])
    ? stored[HISTORY_PENDING_KEY]
    : [];
}

let historyFlushing = false;
async function flushHistoryPending() {
  if (historyFlushing) return;
  historyFlushing = true;
  try {
    const { ytHistorySyncEnabled } = await chrome.storage.local.get([
      "ytHistorySyncEnabled",
    ]);
    if (!ytHistorySyncEnabled) return;
    for (const id of await getHistoryPending()) {
      try {
        await markWatchedOnYouTube(id);
        const left = (await getHistoryPending()).filter((other) => other !== id);
        await chrome.storage.local.set({ [HISTORY_PENDING_KEY]: left });
      } catch (err) {
        console.warn(`MinimalTube: couldn't sync ${id} to YouTube history:`, err);
        break;
      }
      await sleep(1500);
    }
  } finally {
    historyFlushing = false;
  }
}

// Failures are kept and sent again later (back online, next start); the player is told why.
async function syncWatchedToYouTube(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return { error: "not a video id" };
  try {
    await markWatchedOnYouTube(id);
  } catch (err) {
    console.warn(`MinimalTube: couldn't sync ${id} to YouTube history:`, err);
    const pending = await getHistoryPending();
    if (!pending.includes(id)) pending.push(id);
    await chrome.storage.local.set({
      [HISTORY_PENDING_KEY]: pending.slice(-200),
    });
    return { error: err.message || String(err) };
  }
  flushHistoryPending();
  return { ok: true };
}

chrome.runtime.onStartup.addListener(() => flushHistoryPending());

/* ------------------------------------------------- YouTube playlist sync */

const YT_SYNC_LIST_RE = /^(?!LL$)[A-Za-z0-9_-]{2,64}$/;
const PLAYLIST_ID_RE = /^[0-9a-f]{12}$/;

async function serverJson(path, options) {
  const res = await fetch(`${await getServerBase()}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error)
    throw new Error(data.error || `server returned ${res.status}`);
  return data;
}

function putServerJson(path, body) {
  return serverJson(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getSavedPlaylist(id) {
  const data = await serverJson("/playlists");
  return (data.playlists || []).find((playlist) => playlist.id === id) || null;
}

function syncableItems(items) {
  const seen = new Set();
  return items.filter(
    (item) =>
      item.playable && !seen.has(item.videoId) && seen.add(item.videoId),
  );
}

function ytItemToEntry(item) {
  return {
    id: item.videoId,
    title: item.title,
    url: `https://www.youtube.com/watch?v=${item.videoId}`,
    duration: item.duration,
  };
}

function mergePlaylist(base, local, remote) {
  const localSet = new Set(local),
    remoteSet = new Set(remote);
  const removed = new Set(
    base.filter((id) => !localSet.has(id) || !remoteSet.has(id)),
  );
  const common = base.filter((id) => !removed.has(id));
  const commonSet = new Set(common);
  const sameOrder = (list) =>
    list.filter((id) => commonSet.has(id)).join() === common.join();
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

async function linkPlaylistToYouTube(playlistId, listId) {
  if (!YT_SYNC_LIST_RE.test(listId))
    return { ok: false, error: "this list can't be synced" };
  const remote = await ytFetchPlaylist(listId);
  if (!remote.editable) return { ok: false, error: "not your playlist" };
  const saved = await putServerJson(`/playlists/${playlistId}/items`, {
    items: syncableItems(remote.items).map(ytItemToEntry),
  });
  await putServerJson(`/playlists/${playlistId}/yt`, {
    yt: {
      list_id: listId,
      base: saved.playlist.items.map((item) => item.id),
    },
  });
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
  if (!remote.editable)
    throw new Error("this account can't edit the YouTube playlist");
  const local = pl.items.map((item) => item.id);
  const remoteItems = syncableItems(remote.items);
  const remoteIds = remoteItems.map((item) => item.videoId);
  const base = pl.yt.base || [];
  if (!remoteIds.length && base.length > 1)
    throw new Error("YouTube returned an empty playlist, skipped");
  const target = mergePlaylist(base, local, remoteIds);
  const targetSet = new Set(target),
    remoteSet = new Set(remoteIds);
  const edits = [
    ...remote.items
      .filter(
        (item) =>
          item.setVideoId &&
          remoteSet.has(item.videoId) &&
          !targetSet.has(item.videoId),
      )
      .map((item) => ({
        action: "ACTION_REMOVE_VIDEO",
        setVideoId: item.setVideoId,
      })),
    ...target
      .filter((id) => !remoteSet.has(id))
      .map((id) => ({ action: "ACTION_ADD_VIDEO", addedVideoId: id })),
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
    const fresh = await getSavedPlaylist(playlistId);
    if (!fresh || fresh.items.map((item) => item.id).join() !== local.join())
      return { ok: false, retry: true };
    const own = new Map(pl.items.map((item) => [item.id, item]));
    const fromYt = new Map(remoteItems.map((item) => [item.videoId, item]));
    const saved = await putServerJson(`/playlists/${playlistId}/items`, {
      items: target.map((id) =>
        own.has(id)
          ? {
              id,
              title: own.get(id).title,
              url: own.get(id).url,
              duration: own.get(id).duration,
            }
          : ytItemToEntry(fromYt.get(id)),
      ),
    });
    newBase = saved.playlist.items.map((item) => item.id);
    changed = true;
  }
  await putServerJson(`/playlists/${playlistId}/yt`, {
    yt: { list_id: listId, base: newBase },
  });
  return { ok: true, changed };
}

let ytSyncChain = Promise.resolve();
function runYtPlaylistTask(task) {
  const run = ytSyncChain.then(task, task).catch((err) => {
    console.warn("MinimalTube: YouTube playlist sync failed:", err);
    return { ok: false, error: String((err && err.message) || err) };
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

/* -------------------------------------------- importing YouTube subscriptions */

// The account's subscriptions go to the server as one import. They're read through YouTube's API
// (youtube.js); failing that, youtube.com/feed/channels opens in a tab whose content script reads
// the page and sends them back ("minimaltube-import-channels").
async function importSubscriptions() {
  let channels;
  try {
    channels = await ytFetchSubscriptions();
  } catch (err) {
    if (/not signed in/.test(err.message))
      return { ok: false, error: "sign in to YouTube in this browser first" };
    console.warn("MinimalTube: reading the subscriptions through YouTube's API failed, reading the page instead:", err);
    await chrome.tabs.create({ url: `${YT_ORIGIN}/feed/channels#minimaltube-import` });
    return { ok: true, fromPage: true };
  }
  return sendImport(channels);
}
async function sendImport(channels) {
  const server = await ensureServerOrNotify();
  if (!server.ok) return server;
  try {
    const data = await serverJson("/subscriptions/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels }),
    });
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "minimaltube-import-subscriptions") {
    importSubscriptions().then(sendResponse);
    return true;
  }
  if (msg?.type === "minimaltube-import-channels" && Array.isArray(msg.channels)) {
    const tabId = sender.tab?.id;
    sendImport(msg.channels.slice(0, 5000)).then(async (res) => {
      sendResponse(res);
      if (!res.ok) return;
      const player = await findPlayerTab();
      if (player) {
        chrome.tabs.sendMessage(player.id, { type: "minimaltube-subscriptions-imported", result: res }, () => {
          chrome.runtime.lastError;
        });
        chrome.windows.update(player.windowId, { focused: true });
      }
      if (tabId != null)
        chrome.tabs.remove(tabId, () => {
          chrome.runtime.lastError;
        });
    });
    return true;
  }
  if (
    msg?.type === "minimaltube-yt-link" &&
    PLAYLIST_ID_RE.test(msg.playlistId) &&
    msg.listId
  ) {
    runYtPlaylistTask(() =>
      linkPlaylistToYouTube(msg.playlistId, String(msg.listId)),
    ).then(sendResponse);
    return true;
  }
  if (msg?.type === "minimaltube-yt-sync" && PLAYLIST_ID_RE.test(msg.playlistId)) {
    syncPlaylistTask(msg.playlistId).then(sendResponse);
    return true;
  }
  if (msg?.type === "minimaltube-online") {
    flushHistoryPending();
    flushYtSyncPending();
    return;
  }
  if (msg?.type === "minimaltube-mark-watched" && msg.id) {
    syncWatchedToYouTube(msg.id).then(sendResponse);
    return true;
  }
  if (msg?.type === "minimaltube-ensure-server") {
    ensureServerOrNotify().then(sendResponse);
    return true;
  }
  if (msg?.type === "minimaltube-open-window" && msg.playerUrl) {
    // Make sure the server is up, but open the window either way.
    ensureServerOrNotify()
      .then(() => openPlayerWindow(msg.playerUrl))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "minimaltube-queue-add" && msg.url) {
    addToQueue(msg.url).then(sendResponse);
    return true;
  }
  if (msg?.type === "minimaltube-open-playlist" && /^[A-Za-z0-9_-]{2,64}$/.test(msg.listId || "")) {
    const tabId = sender.tab?.id;
    openYouTubePlaylist(String(msg.listId), msg.name)
      // readFailed: YouTube's answer couldn't be read; the page then reads the list itself
      .catch((err) => ({ ok: false, readFailed: true, error: String((err && err.message) || err) }))
      .then((res) => {
        sendResponse(res);
        if (res.ok && tabId != null)
          chrome.tabs.remove(tabId, () => {
            chrome.runtime.lastError;
          });
      });
    return true;
  }
  if (msg?.type === "minimaltube-open" && msg.url) {
    const tabId = sender.tab?.id;
    openInPlayer(msg.url, msg.playlist).then((res) => {
      sendResponse(res);
      if (res.ok && tabId != null)
        chrome.tabs.remove(tabId, () => {
          chrome.runtime.lastError;
        });
    });
    return true;
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { minimaltubeWindowId: id } = await chrome.storage.local.get([
    "minimaltubeWindowId",
  ]);
  if (windowId === id) chrome.storage.local.remove("minimaltubeWindowId");
});
