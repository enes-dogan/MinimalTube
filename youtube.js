// MinimalTube - everything that talks to youtube.com from the background, in one place:
// page parsing, InnerTube calls, watch-history pings and playlist reads/edits. YouTube
// changes these shapes now and then; when something breaks, this is the only file to fix.

const YT_ORIGIN = "https://www.youtube.com";
const YT_PLAYLIST_MAX = 200; // two-way sync
const YT_PLAYLIST_READ_MAX = 5000; // just reading one (the playlist-page button)
const CPN_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

/* ------------------------------------------------------------- parsing */

function extractJsonAfter(html, marker) {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const i = html.indexOf("{", start);
  let depth = 0,
    inStr = false,
    esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(i, j + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseYtcfg(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1] : null;
  };
  return {
    loggedIn: /"LOGGED_IN":true/.test(html),
    clientVersion: pick(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/),
    visitorData: pick(/"VISITOR_DATA":"([^"]+)"/),
    sessionIndex: pick(/"SESSION_INDEX":"?(\d+)"?/) || "0",
    delegatedSessionId: pick(/"DELEGATED_SESSION_ID":"([^"]+)"/),
  };
}

function walkJson(node, visit) {
  if (Array.isArray(node)) node.forEach((child) => walkJson(child, visit));
  else if (node && typeof node === "object") {
    visit(node);
    Object.values(node).forEach((child) => walkJson(child, visit));
  }
}

function parseDuration(text) {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(text || "")) return undefined;
  return text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function lockupRemoveSetVideoId(lockup, listId) {
  let setVideoId = null;
  walkJson(lockup, (node) => {
    const edit = node.playlistEditEndpoint;
    if (setVideoId || !edit || (edit.playlistId && edit.playlistId !== listId))
      return;
    const remove = (edit.actions || []).find(
      (action) => action.action === "ACTION_REMOVE_VIDEO" && action.setVideoId,
    );
    if (remove) setVideoId = remove.setVideoId;
  });
  return setVideoId;
}

function lockupItem(lockup, listId) {
  let badge = null,
    watchSetVideoId = null;
  walkJson(lockup.contentImage, (node) => {
    badge ??= node.thumbnailBadgeViewModel?.text;
  });
  walkJson(lockup.rendererContext, (node) => {
    watchSetVideoId ??= node.watchEndpoint?.playlistSetVideoId;
  });
  const removeSetVideoId = lockupRemoveSetVideoId(lockup, listId);
  return {
    videoId: lockup.contentId,
    setVideoId: removeSetVideoId || watchSetVideoId || null,
    title: lockup.metadata?.lockupMetadataViewModel?.title?.content || "",
    duration: parseDuration(badge),
    playable: true,
    removable: !!removeSetVideoId,
  };
}

function parsePlaylistData(data, listId) {
  const items = [];
  let token = null,
    editable = false;
  walkJson(data, (node) => {
    const list = node.playlistVideoListRenderer;
    if (list && (list.isEditable || list.canReorder)) editable = true;
    const row = node.playlistVideoRenderer;
    if (row && row.videoId) {
      if (row.canReorder) editable = true;
      items.push({
        videoId: row.videoId,
        setVideoId: row.setVideoId || null,
        title:
          row.title?.runs?.map((run) => run.text).join("") ||
          row.title?.simpleText ||
          "",
        duration: Number(row.lengthSeconds) || undefined,
        playable: row.isPlayable !== false,
      });
    }
    const lockup = node.lockupViewModel;
    if (
      lockup &&
      lockup.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" &&
      lockup.contentId
    ) {
      const item = lockupItem(lockup, listId);
      if (item.removable) editable = true;
      delete item.removable;
      items.push(item);
    }
    for (const rows of [node.contents, node.continuationItems]) {
      if (!Array.isArray(rows) || !rows.some(isVideoRow)) continue;
      const more = rows.find(
        (row) => row?.continuationItemRenderer || row?.continuationItemViewModel,
      );
      if (more) token = continuationToken(more) || token;
    }
  });
  return { items, token, editable };
}

function isVideoRow(row) {
  return !!(
    row?.playlistVideoRenderer ||
    row?.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO"
  );
}

function continuationToken(more) {
  let token = null;
  walkJson(more, (node) => {
    const command = node.continuationCommand;
    if (
      !token &&
      command?.token &&
      (!command.request || command.request === "CONTINUATION_REQUEST_TYPE_BROWSE")
    )
      token = command.token;
  });
  return token;
}

/* ------------------------------------------------------------- InnerTube */

async function sha1Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function ytAuthorization() {
  let cookie = null;
  for (const name of ["SAPISID", "__Secure-3PAPISID"]) {
    cookie = await chrome.cookies.get({ url: YT_ORIGIN, name });
    if (cookie) break;
  }
  if (!cookie) throw new Error("not signed in to YouTube in this browser profile");
  const ts = Math.floor(Date.now() / 1000);
  return `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${cookie.value} ${YT_ORIGIN}`)}`;
}

// Extension requests carry a chrome-extension:// Origin; YouTube's API wants its own.
let ytOriginRule = null;
function ensureYtOriginRule() {
  ytOriginRule ??= chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "origin", operation: "set", value: YT_ORIGIN },
            { header: "referer", operation: "set", value: `${YT_ORIGIN}/` },
          ],
        },
        condition: {
          urlFilter: "||www.youtube.com/youtubei/",
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ["xmlhttprequest", "other"],
        },
      },
    ],
  });
  return ytOriginRule;
}

// Signed in (cfg.loggedIn), requests carry the account's SAPISIDHASH and must come back signed
// in; signed out, they're plain public requests (reading a public playlist).
async function innertube(endpoint, cfg, body) {
  await ensureYtOriginRule();
  const headers = {
    "Content-Type": "application/json",
    "X-Origin": YT_ORIGIN,
    "X-Goog-AuthUser": cfg.sessionIndex,
    "X-Youtube-Client-Name": "1",
    "X-Youtube-Client-Version": cfg.clientVersion,
  };
  if (cfg.loggedIn) headers.Authorization = await ytAuthorization();
  if (cfg.visitorData) headers["X-Goog-Visitor-Id"] = cfg.visitorData;
  if (cfg.delegatedSessionId) headers["X-Goog-PageId"] = cfg.delegatedSessionId;
  const context = {
    client: {
      clientName: "WEB",
      clientVersion: cfg.clientVersion,
      hl: "en",
      visitorData: cfg.visitorData || undefined,
    },
  };
  if (cfg.delegatedSessionId)
    context.user = { onBehalfOfUser: cfg.delegatedSessionId };
  const res = await fetch(`${YT_ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ context, ...body }),
  });
  if (!res.ok) throw new Error(`YouTube ${endpoint} returned ${res.status}`);
  const data = await res.json();
  const loggedIn = (data.responseContext?.serviceTrackingParams || [])
    .flatMap((service) => service.params || [])
    .find((param) => param.key === "logged_in");
  if (cfg.loggedIn && loggedIn && loggedIn.value === "0")
    throw new Error(`YouTube treated the ${endpoint} request as signed out`);
  return data;
}

/* ------------------------------------------------------------- watch history */

function makeCpn() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => CPN_ALPHABET[b & 63]).join("");
}

function statsUrl(baseUrl, cpn, length, full) {
  const u = new URL(baseUrl);
  const cmt = String(Math.max(0, length - 1));
  u.searchParams.set("ver", "2");
  u.searchParams.set("cpn", cpn);
  u.searchParams.set("cmt", cmt);
  u.searchParams.set("el", "detailpage");
  if (full) {
    u.searchParams.set("st", "0");
    u.searchParams.set("et", cmt);
  }
  return u.toString();
}

async function markWatchedOnYouTube(id) {
  const res = await fetch(`${YT_ORIGIN}/watch?v=${id}&hl=en`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`watch page returned ${res.status}`);
  const html = await res.text();
  if (!parseYtcfg(html).loggedIn)
    throw new Error("not signed in to YouTube in this browser profile");
  const player = extractJsonAfter(html, "ytInitialPlayerResponse = {");
  const tracking = player && player.playbackTracking;
  const playback = tracking?.videostatsPlaybackUrl?.baseUrl;
  const watchtime = tracking?.videostatsWatchtimeUrl?.baseUrl;
  if (!playback || !watchtime) throw new Error("no playback tracking URLs");
  const length =
    Number(new URL(playback).searchParams.get("len")) ||
    Number(player.videoDetails?.lengthSeconds) ||
    1.5;
  const cpn = makeCpn();
  for (const [url, full] of [
    [playback, false],
    [watchtime, true],
  ]) {
    const ping = await fetch(statsUrl(url, cpn, length, full), {
      credentials: "include",
    });
    if (!ping.ok) throw new Error(`stats ping returned ${ping.status}`);
  }
}

/* ------------------------------------------------------------- playlists */

// All videos of a playlist. Sync needs the account (signedIn) and stays within YT_PLAYLIST_MAX;
// just reading one also works signed out, up to YT_PLAYLIST_READ_MAX.
async function ytFetchPlaylist(listId, { signedIn = true, max = YT_PLAYLIST_MAX } = {}) {
  const res = await fetch(
    `${YT_ORIGIN}/playlist?list=${encodeURIComponent(listId)}&hl=en`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(`playlist page returned ${res.status}`);
  const html = await res.text();
  const cfg = parseYtcfg(html);
  if (signedIn && !cfg.loggedIn)
    throw new Error("not signed in to YouTube in this browser profile");
  if (!cfg.clientVersion) throw new Error("couldn't read YouTube's client version");
  const data = extractJsonAfter(html, "ytInitialData = {");
  if (!data) throw new Error("couldn't read the playlist page");
  const first = parsePlaylistData(data, listId);
  const items = first.items;
  let token = first.token;
  while (token && items.length < max) {
    const page = parsePlaylistData(
      await innertube("browse", cfg, { continuation: token }),
      listId,
    );
    if (!page.items.length)
      throw new Error(`couldn't load the videos after the first ${items.length}`);
    items.push(...page.items);
    token = page.token;
  }
  if (token || items.length > max) throw new Error(`playlist has more than ${max} videos`);
  return { cfg, editable: first.editable, items };
}

async function ytEditPlaylist(listId, cfg, actions) {
  for (let i = 0; i < actions.length; i += 25) {
    const res = await innertube("browse/edit_playlist", cfg, {
      playlistId: listId,
      actions: actions.slice(i, i + 25),
    });
    if (res.status && res.status !== "STATUS_SUCCEEDED")
      throw new Error(`YouTube refused the playlist edit (${res.status})`);
  }
}

/* ------------------------------------------------------------- subscriptions */

// One page of youtube.com/feed/channels (or a continuation of it): its channels and the token for
// the next page. There a channel's "subscriberCountText" is its @handle, not a count.
function parseChannelList(data) {
  const channels = [];
  let token = null;
  walkJson(data, (node) => {
    const ch = node.channelRenderer;
    if (ch && /^UC[\w-]{22}$/.test(ch.channelId || "")) {
      const shown = ch.subscriberCountText?.simpleText || "",
        path = ch.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "";
      let handle = shown.startsWith("@") ? shown : null;
      if (!handle && path.startsWith("/@"))
        try {
          handle = decodeURIComponent(path.slice(1));
        } catch {}
      channels.push({
        id: ch.channelId,
        name: ch.title?.simpleText || ch.title?.runs?.map((run) => run.text).join("") || "",
        handle,
      });
    }
    if (node.continuationItemRenderer)
      token = continuationToken(node.continuationItemRenderer) || token;
  });
  return { channels, token };
}

// Every channel the signed-in account is subscribed to: [{id, name, handle}].
async function ytFetchSubscriptions() {
  const res = await fetch(`${YT_ORIGIN}/feed/channels?hl=en`, { credentials: "include" });
  if (!res.ok) throw new Error(`subscriptions page returned ${res.status}`);
  const html = await res.text();
  const cfg = parseYtcfg(html);
  if (!cfg.loggedIn) throw new Error("not signed in to YouTube in this browser profile");
  const data = extractJsonAfter(html, "ytInitialData = {");
  if (!data) throw new Error("couldn't read the subscriptions page");
  const found = new Map();
  let page = parseChannelList(data);
  for (let pages = 1; ; pages++) {
    page.channels.forEach((ch) => found.has(ch.id) || found.set(ch.id, ch));
    if (!page.token || pages >= 100) break;
    page = parseChannelList(await innertube("browse", cfg, { continuation: page.token }));
  }
  if (!found.size) throw new Error("no channels found on the subscriptions page");
  return [...found.values()];
}
