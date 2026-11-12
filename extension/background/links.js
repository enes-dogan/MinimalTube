/* MinimalTube background - getting YouTube links into the player: the right-click entries on
 * youtube.com, "Open YouTube videos in MinimalTube" (the redirect rules), and the buttons the
 * content script adds to YouTube's pages.
 * Loaded by background.js (importScripts: one scope with the other background files). */

/* ------------------------------------------------------------ into the queue */

const MENU_QUEUE = "minimaltube-play",
  MENU_QUEUE_PAGE = "minimaltube-play-page";

// "Add to MinimalTube queue": the link (or the page's own video) goes into the queue of the
// running player, or a new player opens with it.
async function addToQueue(rawUrl) {
  const url = stripPlaylistParams(rawUrl);
  const server = await ensureServerOrNotify();
  if (!server.ok) return server;
  await tellPlayerOrOpen({ type: "minimaltube-queue-add", url }, `${PLAYER_URL}?url=${encodeURIComponent(url)}`);
  return { ok: true, serverBase: server.serverBase };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_QUEUE,
      title: "Add to MinimalTube queue",
      contexts: ["link"],
      targetUrlPatterns: ["*://*.youtube.com/watch*", "*://*.youtube.com/shorts/*", "*://*.youtube.com/playlist*", "*://youtu.be/*"],
    });
    chrome.contextMenus.create({
      id: MENU_QUEUE_PAGE,
      title: "Add this video to MinimalTube queue",
      contexts: ["page", "video"],
      documentUrlPatterns: ["*://*.youtube.com/watch*", "*://*.youtube.com/shorts/*", "*://*.youtube.com/live/*"],
    });
  });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_QUEUE && info.linkUrl) addToQueue(info.linkUrl);
  else if (info.menuItemId === MENU_QUEUE_PAGE && info.pageUrl) addToQueue(info.pageUrl);
});

/* ---------------------------------------------- the content script's buttons */

// A playlist goes to a new player through storage (too big for its URL): player.html?pid=<key>.
async function stashPlaylist(playlist) {
  const key = "pl_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  await chrome.storage.local.set({ [key]: playlist });
  return key;
}

// The watch page's button: the video opens in a new player, with the playlist shown next to it
// on YouTube (if any) as its queue.
async function openInPlayer(url, playlist) {
  const hasList = playlist && Array.isArray(playlist.items) && playlist.items.length;
  if (hasList && playlist.savePrompt) return openPlaylistToSave(playlist);
  const server = await ensureServerOrNotify();
  if (!server.ok) return server;
  let playerUrl = `${PLAYER_URL}?url=${encodeURIComponent(url)}`;
  if (hasList) playerUrl += `&pid=${encodeURIComponent(await stashPlaylist(playlist))}`;
  await openPlayerWindow(playerUrl);
  return { ok: true, serverBase: server.serverBase };
}

// The playlist page's button: the player takes the playlist as its queue (nothing starts
// playing) and offers to save it.
async function openPlaylistToSave(playlist) {
  const server = await ensureServerOrNotify();
  if (!server.ok) return server;
  await tellPlayerOrOpen(
    { type: "minimaltube-take-playlist", playlist },
    `${PLAYER_URL}?pid=${encodeURIComponent(await stashPlaylist(playlist))}`,
  );
  return { ok: true, serverBase: server.serverBase };
}

/* ---------------------------------------------------- YouTube videos open here */

// With "Open YouTube videos in MinimalTube" on (off by default), a tab going to a YouTube video
// lands on open.html instead, before YouTube loads, and open.html hands the link to
// openYouTubeLink. Playlists, channels and the rest of YouTube stay on YouTube. A link with
// LINK_SKIP in it goes through to YouTube (the player's "Open on YouTube", and open.html's
// fallback when the app can't take it). Clicks on youtube.com itself never load a page, so
// content-youtube.js catches those.
const LINK_SKIP = "minimaltube=skip",
  // 103 and 104 (playlists, channels) are gone but still removed, for installs that have them
  LINK_RULE_IDS = [101, 102, 103, 104, 105, 106];

// Chromium gives each pattern 2 KB once compiled, so they only tell the kind of link apart (no
// exact id lengths: those alone go over); youTubeVideoLink (js/common.js) checks the rest, and
// open.html sends what the app doesn't take on to YouTube.
function linkRules() {
  const to = `chrome-extension://${chrome.runtime.id}/open.html#\\0`,
    redirect = (id, regexFilter) => ({
      id,
      priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: to } },
      condition: { regexFilter, resourceTypes: ["main_frame"] },
    });
  return [
    { id: 101, priority: 2, action: { type: "allow" }, condition: { urlFilter: LINK_SKIP, resourceTypes: ["main_frame"] } },
    redirect(102, String.raw`^https?://(?:www\.|m\.|music\.)?youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/|embed/|v/).*`),
    redirect(105, String.raw`^https?://youtu\.be/.+`),
    redirect(106, String.raw`^https?://(?:www\.)?youtube-nocookie\.com/embed/.*`),
  ];
}

// One rule at a time: Chromium refuses a whole batch over one rule it doesn't take.
async function syncLinkRules() {
  try {
    const { openYouTubeLinks } = await chrome.storage.local.get(["openYouTubeLinks"]);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: LINK_RULE_IDS });
    if (openYouTubeLinks !== true) return;
    for (const rule of linkRules())
      await chrome.declarativeNetRequest
        .updateDynamicRules({ addRules: [rule] })
        .catch((err) => console.warn(`MinimalTube: link rule ${rule.id} wasn't taken:`, err));
  } catch (err) {
    console.warn("MinimalTube: couldn't set up opening YouTube videos here:", err);
  }
}
chrome.runtime.onInstalled.addListener(syncLinkRules);
chrome.runtime.onStartup.addListener(syncLinkRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.openYouTubeLinks) syncLinkRules();
});

// A YouTube video opened anywhere in the browser (open.html, or a click on youtube.com) plays
// now; an open player keeps its queue and carries on after it.
async function openYouTubeLink(raw) {
  const url = youTubeVideoLink(raw);
  if (!url) return { ok: false, notLink: true }; // open.html sends it on to YouTube
  const server = await ensureServerOrNotify();
  if (!server.ok) return server;
  await tellPlayerOrOpen({ type: "minimaltube-play-now", url }, `${PLAYER_URL}?${new URLSearchParams({ url })}`);
  return { ok: true };
}
