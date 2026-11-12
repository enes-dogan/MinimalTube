/* MinimalTube player - The browse page's cards: thumbnails (kept by the server, sharp ones for big cards), the card
 * itself, the lines under a video's title.
 * Loaded in order by player.html (classic scripts sharing one scope). */

// A thumbnail that couldn't load is hidden, not removed, until the connection has been checked:
// if it was lost, the image is tried again once it's back.
const failedThumbs = new Set();
whenNetChanges((offline) => {
  if (offline) return;
  failedThumbs.forEach((img) => {
    failedThumbs.delete(img);
    if (!img.isConnected) return;
    img._retried = true;
    img.src = img._first;
  });
});
// A card's width at each window width (the grid's columns, see browse.css): the browser picks the
// server's 1280 x 720 thumbnail for anything bigger than the 320 x 180 one
const CARD_SIZES = "(max-width: 575px) 100vw, (max-width: 883px) 50vw, (max-width: 1695px) 34vw, 25vw";
function makeThumbImg(url, fallback, large = false) {
  const img = el("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  if (large && url.startsWith(`${serverBase}/thumb/`)) {
    img.srcset = `${url} 320w, ${url}?size=720 1280w`;
    img.sizes = CARD_SIZES;
  }
  img.src = img._first = url;
  img.addEventListener("load", () => img.classList.remove("failed"));
  img.addEventListener("error", () => {
    // the large one isn't there (offline, never fetched): the 320 x 180 one, then YouTube's
    if (img.hasAttribute("srcset")) {
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      return;
    }
    if (fallback && img.src !== fallback) {
      img.src = fallback;
    } else if (img._retried && !isOffline()) img.remove();
    else {
      img.classList.add("failed");
      failedThumbs.add(img);
      if (!img.src.startsWith(serverBase)) checkNet();
    }
  });
  return img;
}
function makeThumb(url, fallback) {
  const thumb = el("div", "vThumb");
  if (url) thumb.appendChild(makeThumbImg(url, fallback, true));
  return thumb;
}
function paintFeedDownloaded(card) {
  const ok = card._thumb.querySelector(".vBadge.ok");
  if (card._video.downloaded && !ok) {
    card._thumb.appendChild(el("span", "vBadge ok", "✓ Downloaded"));
  } else if (!card._video.downloaded && ok) ok.remove();
}

function refreshFeedDownloadedFlags() {
  if (libraryKey === null) return; // the Downloads list isn't loaded yet
  feedGrid.querySelectorAll(".vCard").forEach((card) => {
    const item = card._video;
    if (!item || item.downloaded === downloadedIds.has(item.id)) return;
    item.downloaded = !item.downloaded;
    paintFeedDownloaded(card);
  });
}
// A card on the browse page (the feed, playlists, a playlist's videos, Downloads): thumbnail with
// a badge, title, lines under it and a ⋮ menu. The thumbnail and the title both run `open`.
function makeCard({ thumb, fallback, videoId, badge, video, title, lines = [], open, menu, className }) {
  const card = el("div", "vCard" + (className ? ` ${className}` : ""));
  const thumbEl = makeThumb(thumb, fallback);
  if (videoId) {
    thumbEl.dataset.vid = videoId;
    paintWatch(thumbEl);
  }
  if (badge != null) {
    card._badge = el("span", "vBadge", badge);
    thumbEl.appendChild(card._badge);
  }
  card._thumb = thumbEl;
  if (video) {
    card._video = video;
    paintFeedDownloaded(card);
  }
  thumbEl.addEventListener("click", open);
  const titleEl = el("div", "vTitle", title);
  titleEl.title = title;
  titleEl.addEventListener("click", open);
  const text = el("div", "vText");
  text.append(titleEl, ...lines.map((line) => (typeof line === "string" ? el("div", "vSub", line) : line)));
  const meta = el("div", "vMeta");
  meta.append(text, menuButton(bpMenu, "vMenuBtn", menu));
  card.append(thumbEl, meta);
  return card;
}
/**
 * The lines under a video card's title: its channel (a click opens the channel's page) and
 * "views · age". Missing parts are left out. A collab names each of its channels, each a link.
 * @param {{channel?: string, channel_id?: string, channels?: Array<{id: string, name: string}>,
 *   views?: number, timestamp?: number}} v
 * @returns {HTMLElement[]} For makeCard's `lines`.
 */
function videoCardLines(v) {
  const chan = el("div", "vSub", v.channel || "");
  if (Array.isArray(v.channels) && v.channels.length > 1) {
    chan.textContent = "";
    v.channels.forEach((ch, i) => {
      if (i) chan.append(i === v.channels.length - 1 ? " and " : ", ");
      const link = el("span", "vChanLink", ch.name);
      link.title = `Latest uploads from ${ch.name}`;
      link.addEventListener("click", () => selectedChannel !== ch.id && openChannel({ id: ch.id, name: ch.name }));
      chan.append(link);
    });
  } else if (v.channel_id) {
    chan.classList.add("vChan");
    chan.title = `Latest uploads from ${v.channel}`;
    chan.addEventListener("click", () => selectedChannel !== v.channel_id && openChannel({ id: v.channel_id, name: v.channel }));
  }
  return [chan, el("div", "vSub", [fmtCount(v.views, "view"), timeAgo(v.timestamp)].filter(Boolean).join(" · "))];
}
function makeVideoCard(v) {
  const card = makeCard({
    thumb: `${serverBase}/thumb/${v.id}`, // kept by the server, so it also shows offline
    fallback: v.thumbnail,
    videoId: v.id,
    badge: v.duration ? fmtDur(v.duration) : null, // Shorts too: the badge is the length
    video: v,
    title: v.title,
    lines: videoCardLines(v),
    open: () => playVideoNow(v),
    menu: () => videoMenuEntries(v),
  });
  if (v.members_only) {
    const badge = el("span", "vBadge members", "Members only");
    badge.title = "Only the channel's members can watch this";
    card._thumb.appendChild(badge);
  }
  return card;
}
