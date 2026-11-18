/* MinimalTube background - what the signed-in YouTube account knows about subscriptions: keeping
 * them in sync with the ones here, and the collabs in its subscriptions feed.
 * Loaded by background.js (importScripts: one scope with the other background files). */

/* ------------------------------------- subscriptions kept in sync with YouTube */

// The subscriptions here and the signed-in YouTube account's become the same: a three-way merge
// of what both held at the last sync (`base`, kept by the server per account), what is here now
// and what is on YouTube now. A channel added on one side is added on the other, one removed on
// one side is removed on the other. The first sync of an account has no base: channels only on
// YouTube are added here, and for channels only here the user chooses (subscribe on YouTube, or
// remove here). A sync that would remove more than SYNC_ASK_ABOVE channels on a side asks first,
// so a misread YouTube page can't empty the list. When YouTube's API can't be read, its page is
// read in a tab instead and only adds (the import of earlier versions).
const SYNC_ASK_ABOVE = 5,
  SYNC_YT_CHANGES_MAX = 50, // a few seconds of requests; what's left is done by the next sync
  SYNC_YT_GAP_MS = 300,
  SYNC_SETTLE_MS = 1500; // YouTube's list may take a moment to show a change

/**
 * The three-way merge of subscriptions.
 * @param {?string[]} base Channel ids both sides held at the last sync; null before the first.
 * @param {string[]} local Channel ids subscribed here now.
 * @param {string[]} remote Channel ids the YouTube account is subscribed to now.
 * @returns {{addHere: string[], removeHere: string[], subscribe: string[], unsubscribe: string[],
 *   onlyHere: string[]}} What to change here and on YouTube. `onlyHere` is filled only for a
 *   first sync (no base): the channels here and not on YouTube, which need the user's choice.
 */
function planSubscriptionSync(base, local, remote) {
  const here = new Set(local),
    there = new Set(remote);
  if (!base)
    return {
      addHere: remote.filter((id) => !here.has(id)),
      removeHere: [],
      subscribe: [],
      unsubscribe: [],
      onlyHere: local.filter((id) => !there.has(id)),
    };
  const before = new Set(base);
  return {
    addHere: remote.filter((id) => !here.has(id) && !before.has(id)),
    removeHere: local.filter((id) => !there.has(id) && before.has(id)),
    subscribe: local.filter((id) => !there.has(id) && !before.has(id)),
    unsubscribe: remote.filter((id) => !here.has(id) && before.has(id)),
    onlyHere: [],
  };
}

const syncNames = (ids, byId) => ids.map((id) => (byId.get(id) || {}).name || id);

/**
 * Syncs the subscriptions here with the YouTube account signed in to this browser profile.
 * @param {?string} choice The user's answer to a question an earlier call returned: "subscribe"
 *   or "remove" (first sync: the channels only here), "confirm" (a sync that removes many).
 * @returns {Promise<object>} {ok: false, error}; {ok: true, fromPage: true} (YouTube's page is
 *   read in a tab; the result comes later as "minimaltube-subscriptions-imported"); {ok: true,
 *   ask: "first", onlyHere: [names]} or {ok: true, ask: "many", removeHere: [names],
 *   unsubscribe: [names]} (nothing changed yet: ask, then call again with the choice); or
 *   {ok: true, addedHere, removedHere, removedIds, subscribed, unsubscribed, failed: [names]}.
 */
async function syncSubscriptions(choice) {
  let yt;
  try {
    yt = await ytFetchSubscriptions();
  } catch (err) {
    if (/not signed in/.test(err.message)) return { ok: false, error: "sign in to YouTube in this browser first" };
    console.warn("MinimalTube: reading the subscriptions through YouTube's API failed, reading the page instead:", err);
    await chrome.tabs.create({ url: `${YT_ORIGIN}/feed/channels#minimaltube-import` });
    return { ok: true, fromPage: true };
  }
  const server = await ensureServerOrNotify();
  if (!server.ok) return server;
  const account = encodeURIComponent(yt.account);
  const [{ subscriptions = [] }, { base = null }] = await Promise.all([
    serverJson("/subscriptions"),
    serverJson(`/subscriptions/youtube-sync?account=${account}`),
  ]);
  const byId = new Map([...subscriptions, ...yt.channels].map((ch) => [ch.id, ch])),
    remote = yt.channels.map((ch) => ch.id),
    plan = planSubscriptionSync(base, subscriptions.map((ch) => ch.id), remote);
  if (plan.onlyHere.length) {
    if (choice === "subscribe") plan.subscribe = plan.onlyHere;
    else if (choice === "remove") plan.removeHere = plan.onlyHere;
    else return { ok: true, ask: "first", onlyHere: syncNames(plan.onlyHere, byId) };
  } else if (plan.removeHere.length + plan.unsubscribe.length > SYNC_ASK_ABOVE && !choice)
    return { ok: true, ask: "many", removeHere: syncNames(plan.removeHere, byId), unsubscribe: syncNames(plan.unsubscribe, byId) };

  // here
  if (plan.addHere.length)
    await serverJson("/subscriptions/import", {
      method: "POST",
      body: { channels: yt.channels.filter((ch) => plan.addHere.includes(ch.id)) },
    });
  const removedIds = [];
  for (const id of plan.removeHere)
    try {
      await serverJson(`/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
      removedIds.push(id);
    } catch (err) {
      logQuiet("removing a channel unsubscribed on YouTube", err);
    }

  // on YouTube
  const changes = [
    ...plan.unsubscribe.map((id) => ["unsubscribe", id]),
    ...plan.subscribe.map((id) => ["subscribe", id]),
  ].slice(0, SYNC_YT_CHANGES_MAX);
  const confirmed = new Map();
  for (const [kind, id] of changes) {
    try {
      confirmed.set(id, await ytSetSubscription(yt.cfg, kind, id, kind === "unsubscribe" ? yt.unsubscribe.get(id) : null));
    } catch (err) {
      logQuiet(`${kind} on YouTube`, err);
      confirmed.set(id, false);
    }
    await sleep(SYNC_YT_GAP_MS);
  }
  // What YouTube really holds now decides the new base (an answer could be wrong): a channel
  // whose unsubscribe didn't take stays in the base, so the next sync tries again instead of
  // adding it back here; one whose subscribe didn't take stays out, so it's tried again too.
  let now = new Set(remote);
  if (changes.length) {
    await sleep(SYNC_SETTLE_MS);
    try {
      now = new Set((await ytFetchSubscriptions()).channels.map((ch) => ch.id));
    } catch (err) {
      logQuiet("reading the subscriptions again", err);
      now = null;
    }
  }
  const done = (kind, id) =>
    confirmed.get(id) === true || (now ? now.has(id) === (kind === "subscribe") : false);
  const subscribed = plan.subscribe.filter((id) => done("subscribe", id)),
    unsubscribed = plan.unsubscribe.filter((id) => done("unsubscribe", id)),
    failed = changes.filter(([kind, id]) => !done(kind, id)).map(([, id]) => id);
  if (now) {
    const after = (await serverJson("/subscriptions")).subscriptions || [];
    const baseNow = [
      ...after.map((ch) => ch.id).filter((id) => now.has(id)),
      ...plan.unsubscribe.filter((id) => now.has(id)),
    ];
    await serverJson("/subscriptions/youtube-sync", { method: "PUT", body: { account: yt.account, base: baseNow } });
  }
  return {
    ok: true,
    addedHere: plan.addHere.length,
    removedHere: removedIds.length,
    removedIds,
    subscribed: subscribed.length,
    unsubscribed: unsubscribed.length,
    failed: syncNames(failed, byId),
    later: plan.subscribe.length + plan.unsubscribe.length - changes.length,
  };
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
