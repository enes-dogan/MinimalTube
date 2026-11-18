/* MinimalTube background - finished videos go to the YouTube account's watch history. What
 * couldn't be sent (no connection, not signed in) is kept and sent again later.
 * Loaded by background.js (importScripts: one scope with the other background files). */

const HISTORY_PENDING_KEY = "ytHistoryPending";

async function getHistoryPending() {
  const stored = await chrome.storage.local.get([HISTORY_PENDING_KEY]);
  return Array.isArray(stored[HISTORY_PENDING_KEY]) ? stored[HISTORY_PENDING_KEY] : [];
}

let historyFlushing = false;
async function flushHistoryPending() {
  if (historyFlushing) return;
  historyFlushing = true;
  try {
    const { ytHistorySyncEnabled } = await chrome.storage.local.get(["ytHistorySyncEnabled"]);
    if (ytHistorySyncEnabled === false) return; // on unless switched off (the player's default)
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
  if (!VIDEO_ID_RE.test(id)) return { error: "not a video id" };
  try {
    await markWatchedOnYouTube(id);
  } catch (err) {
    console.warn(`MinimalTube: couldn't sync ${id} to YouTube history:`, err);
    const pending = await getHistoryPending();
    if (!pending.includes(id)) pending.push(id);
    await chrome.storage.local.set({ [HISTORY_PENDING_KEY]: pending.slice(-200) });
    return { error: errorText(err) };
  }
  flushHistoryPending();
  return { ok: true };
}

chrome.runtime.onStartup.addListener(() => flushHistoryPending());

/* ----------------------------------------- watch progress from the YouTube account */

// The other way round: how far videos were watched on YouTube (another device, the phone) comes
// from the account's history, so the app's progress bars and "watched" follow. Read when the
// player asks (its start, coming back to the window, the feed's refresh button), at most every
// PROGRESS_EVERY_MS. Signed out, nothing is asked of YouTube.
const PROGRESS_EVERY_MS = 15 * 60 * 1000,
  PROGRESS_RETRY_MS = 60 * 1000,
  PROGRESS_PAGES = 2;
let progressReading = null;
async function readWatchProgress(force) {
  const none = { ok: true, videos: [] };
  if (!(await ytAccountCookie())) return none;
  const now = Date.now(),
    { progressReadAt = 0, progressTriedAt = 0 } = await chrome.storage.session.get(["progressReadAt", "progressTriedAt"]);
  if (now - progressTriedAt < PROGRESS_RETRY_MS || (!force && now - progressReadAt < PROGRESS_EVERY_MS)) return none;
  await chrome.storage.session.set({ progressTriedAt: now });
  const videos = await ytFetchWatchProgress(PROGRESS_PAGES);
  if (!videos) return none;
  await chrome.storage.session.set({ progressReadAt: now });
  return { ok: true, videos };
}
function readWatchProgressOnce(force) {
  progressReading ??= readWatchProgress(force)
    .catch((err) => {
      logQuiet("watch progress from YouTube", err);
      return { ok: false, videos: [] };
    })
    .finally(() => (progressReading = null));
  return progressReading;
}
