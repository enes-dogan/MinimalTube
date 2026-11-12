/* MinimalTube - what every part of the extension shares. The player page, the background service
 * worker, the toolbar popup and the script on youtube.com all load this file first, so nothing
 * here touches a page: plain values and functions only. */

// The server listens on SERVER_PORT, or on the next free one of SERVER_PORTS when another
// program has that (minimaltube/system.py has the same two numbers).
const SERVER_PORT = 7860,
  SERVER_PORTS = 10,
  DEFAULT_SERVER = `http://127.0.0.1:${SERVER_PORT}`;

// What to run to (re)install MinimalTube on this OS, for messages.
const INSTALLER = /Windows/.test(navigator.userAgent)
  ? "install-windows.cmd"
  : /Mac OS X|Macintosh/.test(navigator.userAgent)
    ? "install-macos.command"
    : "./install-linux.sh";

// How "paste" is pressed here, for the texts that name it.
const PASTE_KEYS = /Mac OS X|Macintosh/.test(navigator.userAgent) ? ["⌘", "V"] : ["Ctrl", "V"];

const YT_ORIGIN = "https://www.youtube.com",
  VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/,
  YT_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error as text: its message when it has one. */
const errorText = (err) => String((err && err.message) || err);

// Errors that don't break anything go to the console (right-click → Inspect on the player;
// chrome://extensions → MinimalTube → "service worker" for the background), at most once a
// minute per place, so an offline spell doesn't flood it.
const quietLogged = new Map();
function logQuiet(where, err) {
  if (err && err.name === "AbortError") return;
  const now = Date.now();
  if (now - (quietLogged.get(where) || 0) < 60000) return;
  quietLogged.set(where, now);
  console.warn(`MinimalTube (${where}):`, err);
}

/**
 * The video and the playlist a YouTube link points at: the one reader of YouTube links.
 * @param {string} raw A link on youtube.com (any subdomain: www., m., music.), youtu.be or
 *   youtube-nocookie.com, with or without "https://". Watch, /shorts/, /live/, /embed/ and /v/
 *   links all count; so does a bare 11-character video id.
 * @returns {{videoId: string|null, listId: string|null}} Both null for anything else.
 */
function youTubeIds(raw) {
  const none = { videoId: null, listId: null },
    text = String(raw || "").trim();
  if (VIDEO_ID_RE.test(text)) return { videoId: text, listId: null };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return none;
  }
  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || !YT_HOST_RE.test(host)) return none;
  const inPath = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/),
    videoId = /(^|\.)youtu\.be$/.test(host) ? url.pathname.split("/")[1] : inPath ? inPath[1] : url.searchParams.get("v"),
    listId = url.searchParams.get("list");
  return {
    videoId: VIDEO_ID_RE.test(videoId || "") ? videoId : null,
    listId: /^[A-Za-z0-9_-]{2,64}$/.test(listId || "") ? listId : null,
  };
}
const videoIdFromUrl = (raw) => youTubeIds(raw).videoId;
const playlistIdFromUrl = (raw) => youTubeIds(raw).listId;

/** The link of a video, in the one form the app keeps. */
const watchUrl = (videoId) => `${YT_ORIGIN}/watch?v=${videoId}`;

/**
 * A YouTube link the app can open, written out in full.
 * @param {string} raw What was pasted, typed or clicked.
 * @returns {string|null} The link (with "https://"; a bare video id becomes its watch link), or
 *   null when it names neither a video nor a playlist.
 */
function youTubeLink(raw) {
  const text = String(raw || "").trim(),
    { videoId, listId } = youTubeIds(text);
  if (!videoId && !listId) return null;
  if (VIDEO_ID_RE.test(text)) return watchUrl(text);
  return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).href;
}

/**
 * The video a YouTube link plays, as its watch link.
 * @param {string} raw Any link.
 * @returns {string|null} The video's watch link (its playlist and start time are dropped), or
 *   null for anything that isn't a single video: playlists, channels, other sites.
 */
function youTubeVideoLink(raw) {
  const { videoId } = youTubeIds(raw);
  return videoId ? watchUrl(videoId) : null;
}

// A video opened from a playlist page or a mix carries that list along: the app takes the
// video alone, and keeps the list only on a link to the playlist itself.
function stripPlaylistParams(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.pathname !== "/playlist")
      ["list", "index", "start_radio"].forEach((name) => url.searchParams.delete(name));
    return url.toString();
  } catch {
    return rawUrl;
  }
}
