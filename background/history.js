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
