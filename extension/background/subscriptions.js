/* MinimalTube background - what the signed-in YouTube account knows about subscriptions: the
 * one-time import of all of them, and the collabs in its subscriptions feed.
 * Loaded by background.js (importScripts: one scope with the other background files). */

/* -------------------------------------------- importing YouTube subscriptions */

// The account's subscriptions go to the server as one import. They're read through YouTube's API
// (youtube.js); failing that, youtube.com/feed/channels opens in a tab whose content script reads
// the page and sends them back ("minimaltube-import-channels").
async function importSubscriptions() {
  let channels;
  try {
    channels = await ytFetchSubscriptions();
  } catch (err) {
    if (/not signed in/.test(err.message)) return { ok: false, error: "sign in to YouTube in this browser first" };
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
    return { ok: true, ...(await serverJson("/subscriptions/import", { method: "POST", body: { channels } })) };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}
// The channels the content script read from YouTube's page: imported, and the player (if one
// runs) is told and comes forward.
async function importChannelsFromPage(channels) {
  const res = await sendImport(channels.slice(0, 5000));
  if (!res.ok) return res;
  const player = await findPlayerTab();
  if (player) {
    chrome.tabs.sendMessage(player.id, { type: "minimaltube-subscriptions-imported", result: res }, () => chrome.runtime.lastError);
    showPlayer(player).catch(() => {});
  }
  return res;
}

/* ------------------------------------------------- collabs from the YouTube feed */

// A collab video is uploaded by one of its channels only, so the other channels' uploads never
// list it; YouTube shows it to their subscribers in the subscriptions feed. While an account is
// signed in to YouTube in this profile, the player has that feed read and its collabs go to the
// server, which adds the ones of subscribed channels to the feed. A read waits for the server to
// answer (it's still starting when the app opens), and after one that worked the next waits
// COLLABS_EVERY_MS (COLLABS_RETRY_MS from the refresh button, or after one that didn't). The
// first read of a browser session goes further back. With nobody signed in nothing is asked of
// YouTube and nothing is reported: the app works the same without it.
const COLLABS_EVERY_MS = 15 * 60 * 1000,
  COLLABS_RETRY_MS = 60 * 1000,
  COLLAB_PAGES = 3,
  COLLAB_PAGES_FIRST = 10;
let collabsReading = null;

async function readCollabs(force) {
  const none = { ok: true, channels: [] };
  if (!(await ytAccountCookie()) || !(await isHealthy(await getServerBase()))) return none;
  const now = Date.now(),
    { collabsReadAt = 0, collabsTriedAt = 0 } = await chrome.storage.session.get(["collabsReadAt", "collabsTriedAt"]);
  if (now - collabsTriedAt < COLLABS_RETRY_MS || (!force && now - collabsReadAt < COLLABS_EVERY_MS)) return none;
  await chrome.storage.session.set({ collabsTriedAt: now });
  const videos = await ytFetchCollabs(collabsReadAt ? COLLAB_PAGES : COLLAB_PAGES_FIRST);
  if (!videos) return none; // signed out after all
  let channels = [];
  if (videos.length) {
    const data = await serverJson("/feed/collabs", { method: "POST", body: { videos } });
    channels = Array.isArray(data.channels) ? data.channels : [];
  }
  await chrome.storage.session.set({ collabsReadAt: now });
  return { ok: true, channels };
}
// One read at a time: a second request gets the answer of the one under way.
function readCollabsOnce(force) {
  collabsReading ??= readCollabs(force)
    .catch((err) => {
      logQuiet("collabs from the YouTube feed", err);
      return { ok: false, channels: [] };
    })
    .finally(() => (collabsReading = null));
  return collabsReading;
}
