/* MinimalTube background - the local server: where it is, starting it through the native host
 * when it isn't running, and talking to it.
 * Loaded by background.js (importScripts: one scope with the other background files). */

const NATIVE_HOST = "com.minimaltube.host";

// The server runs on SERVER_PORT, or on the next free one of SERVER_PORTS when another program
// has that; wherever it was last found is remembered as "serverBase" (the player reads it too).
async function getServerBase() {
  const { serverBase } = await chrome.storage.local.get(["serverBase"]);
  return (serverBase || DEFAULT_SERVER).replace(/\/$/, "");
}

// Only MinimalTube's server says "app": "minimaltube", so another program's server on one of
// these ports is never taken for it.
async function isHealthy(base, ms = 1500) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(`${base}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok && (await res.json()).app === "minimaltube";
  } catch {
    return false;
  }
}

// A MinimalTube server already running on any of its ports (asked all at once).
async function findServer() {
  const bases = Array.from({ length: SERVER_PORTS }, (_, i) => `http://127.0.0.1:${SERVER_PORT + i}`);
  try {
    return await Promise.any(
      bases.map(async (base) => {
        if (await isHealthy(base, 800)) return base;
        throw new Error("not here");
      }),
    );
  } catch {
    return null;
  }
}

// Native messaging as a promise that never rejects: {ok: false, error} instead.
function nativeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          const m = err.message || "";
          let error = m;
          if (/not found/i.test(m))
            error = `Native host not installed. Run MinimalTube's installer (${INSTALLER}) once, then try again.`;
          else if (/forbidden/i.test(m))
            error = `This extension isn't allowed to use the native host. Run MinimalTube's installer (${INSTALLER}) again.`;
          return resolve({ ok: false, error });
        }
        resolve(response && response.ok !== undefined ? response : { ok: false, error: "No response from native host" });
      });
    } catch (e) {
      resolve({ ok: false, error: errorText(e) });
    }
  });
}

// The native host starts the server on the first free port from SERVER_PORT and says which one.
async function startServer() {
  const res = await nativeMessage({ action: "start-server", port: SERVER_PORT });
  if (!res.ok)
    return { ok: false, serverBase: DEFAULT_SERVER, error: `Couldn't start the MinimalTube server: ${res.error}` };
  const base = `http://127.0.0.1:${res.port || SERVER_PORT}`;

  // Flask + yt-dlp take a moment to come up.
  for (let i = 0; i < 40; i++) {
    if (await isHealthy(base)) {
      await chrome.storage.local.set({ serverBase: base });
      return { ok: true, serverBase: base, started: true };
    }
    await sleep(250);
  }
  return {
    ok: false,
    serverBase: base,
    // the native host says where the log is: the cache folder differs per OS
    error: `Started the server but it didn't respond. Its log: ${res.log || "server.log in MinimalTube's cache folder"}`,
  };
}

let startingServer = null;

/**
 * Makes sure the server runs: where it was last found, else on whichever of its ports it runs
 * now, else started through the native host.
 * @returns {Promise<{ok: boolean, serverBase: string, started?: boolean, error?: string}>}
 */
async function ensureServer() {
  const base = await getServerBase();
  if (await isHealthy(base)) return { ok: true, serverBase: base };
  const found = await findServer();
  if (found) {
    await chrome.storage.local.set({ serverBase: found });
    return { ok: true, serverBase: found };
  }
  if (!startingServer)
    startingServer = startServer().finally(() => {
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

/** ensureServer(), with a desktop notification when the server can't be reached or started. */
async function ensureServerOrNotify() {
  const res = await ensureServer();
  if (!res.ok) notifyServerProblem(res);
  return res;
}

/**
 * A request to the server, answered as JSON.
 * @param {string} path The endpoint, e.g. "/playlists".
 * @param {{method?: string, body?: object}} [options] `body` is sent as JSON.
 * @returns {Promise<object>} The answer.
 * @throws {Error} The server said so ({"error": ...}) or answered with an error status.
 */
async function serverJson(path, { method = "GET", body } = {}) {
  const res = await fetch(`${await getServerBase()}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `server returned ${res.status}`);
  return data;
}
