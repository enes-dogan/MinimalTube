/* MinimalTube background service worker. It keeps the things that outlive the player page and
 * the ones only it may do, each in a file of its own under background/:
 *
 *   server.js          finding the local server, starting it through the native host
 *   player-window.js   the one player: as a window or a tab, opened, moved, handed things
 *   links.js           YouTube links into the player: right-click entries, "Open YouTube
 *                      videos in MinimalTube", the buttons on YouTube's pages
 *   youtube.js         everything that talks to youtube.com
 *   history.js         finished videos to the YouTube watch history
 *   playlist-sync.js   saved playlists kept in sync with the YouTube account's
 *   subscriptions.js   importing the account's subscriptions; collabs from its feed
 *
 * js/common.js is shared with the player, the popup and the content script. All of these share
 * this worker's one scope (importScripts), so a name can be declared only once among them.
 * This file answers the messages the other parts of the extension send. */

importScripts(
  "js/common.js",
  "background/youtube.js",
  "background/server.js",
  "background/player-window.js",
  "background/links.js",
  "background/history.js",
  "background/playlist-sync.js",
  "background/subscriptions.js",
);

// What earlier versions left in storage and nothing reads any more: removed once, when the
// extension is installed, updated or reloaded.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(["minimaltubeWindowId", "windowSizeApplied", "feedSnapshot", "feedChannels"]);
});

/* --------------------------------------------------------------- messages
 * From the player (js/), the popup, open.html and the content script on youtube.com. Each
 * handler returns its answer, or a promise of it; one that throws answers {ok: false, error}.
 * IGNORED: the message wasn't a valid one of its kind, and gets no answer. */
const IGNORED = Symbol("ignored");

// The YouTube tab a button was pressed in has done its job once the player has taken over: it
// closes, after the answer is on its way.
function closeSenderTab(sender) {
  const tabId = sender.tab?.id;
  if (tabId != null) setTimeout(() => chrome.tabs.remove(tabId, () => chrome.runtime.lastError), 0);
}

const MESSAGES = {
  // ---- from the player
  "minimaltube-ensure-server": () => ensureServerOrNotify(),
  "minimaltube-player-opened": (msg, sender) =>
    sender.tab ? playerOpened(sender.tab, !!msg.bare).catch(() => ({ duplicate: false })) : IGNORED,
  "minimaltube-switch-view": (msg, sender) =>
    sender.tab
      ? chrome.windows
          .get(sender.tab.windowId)
          .then((win) => movePlayer(sender.tab, styleOf(win) === "tab" ? "window" : "tab"))
          .then((style) => ({ ok: true, style }))
      : IGNORED,
  "minimaltube-online": () => {
    // the connection is back: what didn't reach YouTube is sent again
    flushHistoryPending();
    flushYtSyncPending();
  },
  "minimaltube-mark-watched": (msg) => (msg.id ? syncWatchedToYouTube(msg.id) : IGNORED),
  "minimaltube-yt-link": (msg) =>
    PLAYLIST_ID_RE.test(msg.playlistId) && msg.listId
      ? runYtPlaylistTask(() => linkPlaylistToYouTube(msg.playlistId, String(msg.listId)))
      : IGNORED,
  "minimaltube-yt-sync": (msg) => (PLAYLIST_ID_RE.test(msg.playlistId) ? syncPlaylistTask(msg.playlistId) : IGNORED),
  "minimaltube-import-subscriptions": () => importSubscriptions(),
  "minimaltube-read-collabs": (msg) => readCollabsOnce(!!msg.force),

  // ---- from the popup
  "minimaltube-open-window": (msg) =>
    msg.playerUrl
      ? ensureServerOrNotify() // the window opens either way
          .then(() => openPlayerWindow(msg.playerUrl, msg.style === "tab" ? "tab" : "window"))
          .then(() => ({ ok: true }))
      : IGNORED,
  "minimaltube-queue-add": (msg) => (msg.url ? addToQueue(msg.url) : IGNORED),

  // ---- from open.html and the content script on youtube.com
  "minimaltube-open-link": (msg) => (msg.url ? openYouTubeLink(String(msg.url)) : IGNORED),
  "minimaltube-open": (msg, sender) =>
    msg.url
      ? openInPlayer(msg.url, msg.playlist).then((res) => {
          if (res.ok) closeSenderTab(sender);
          return res;
        })
      : IGNORED,
  "minimaltube-open-playlist": (msg, sender) =>
    /^[A-Za-z0-9_-]{2,64}$/.test(msg.listId || "")
      ? openYouTubePlaylist(String(msg.listId), msg.name).then(
          (res) => {
            if (res.ok) closeSenderTab(sender);
            return res;
          },
          // readFailed: YouTube's answer couldn't be read; the page then reads the list itself
          (err) => ({ ok: false, readFailed: true, error: errorText(err) }),
        )
      : IGNORED,
  "minimaltube-import-channels": (msg, sender) =>
    Array.isArray(msg.channels)
      ? importChannelsFromPage(msg.channels).then((res) => {
          if (res.ok) closeSenderTab(sender);
          return res;
        })
      : IGNORED,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handle = MESSAGES[msg?.type];
  if (!handle) return;
  let answer;
  try {
    answer = handle(msg, sender);
  } catch (err) {
    answer = Promise.reject(err);
  }
  if (answer === IGNORED) return;
  Promise.resolve(answer)
    .catch((err) => ({ ok: false, error: errorText(err) }))
    .then(sendResponse);
  return true;
});
