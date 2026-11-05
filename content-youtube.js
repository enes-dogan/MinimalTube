// MinimalTube content script (runs on youtube.com)
//  - watch page: a small button on the player that opens the video (and the playlist shown in
//    the side panel, if any) in MinimalTube
//  - playlist page: a button in the playlist header that opens every video of the playlist as the
//    MinimalTube queue (read through YouTube's own API by the background; scrolling the page so
//    YouTube renders all of them is the fallback) and offers to save them as a MinimalTube playlist
(function () {
  if (window.__minimaltubeContentLoaded) return;
  window.__minimaltubeContentLoaded = true;

  const PLAYER_BTN_ID = "minimaltube-overlay-btn";
  const PLAYLIST_BTN_ID = "minimaltube-playlist-btn";
  const NOTICE_ID = "minimaltube-notice";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let busy = false;

  /* ---------------------------------------------------------------- notice */

  function notice(text, { error = true, ms = 6000 } = {}) {
    let el = document.getElementById(NOTICE_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = NOTICE_ID;
      Object.assign(el.style, {
        position: "fixed",
        top: "16px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "999999",
        color: "#fff",
        padding: "10px 16px",
        borderRadius: "6px",
        fontSize: "13px",
        fontFamily: "Arial, sans-serif",
        boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
      });
      document.body.appendChild(el);
    }
    el.style.background = error ? "#a11" : "#2b2b33";
    el.textContent = text;
    clearTimeout(el._timer);
    if (ms) el._timer = setTimeout(() => el.remove(), ms);
  }

  function clearNotice() {
    const el = document.getElementById(NOTICE_ID);
    if (el) el.remove();
  }

  /* ------------------------------------------------- reading the playlist */

  function currentVideoId() {
    try {
      return new URL(location.href).searchParams.get("v");
    } catch {
      return null;
    }
  }

  function isPlaylistPage() {
    return location.pathname === "/playlist";
  }

  // true when the element is actually shown (YouTube keeps hidden copies of other pages in the DOM)
  function isVisible(el) {
    return !!el && !el.hidden && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // The playlist page itself. YouTube keeps the watch page's (hidden, empty) playlist panel and a
  // second hidden <ytd-browse> around, so everything on a playlist page is scoped to the visible one.
  function playlistPageRoot() {
    const browses = Array.from(document.querySelectorAll('ytd-browse[page-subtype="playlist"]'));
    return browses.find(isVisible) || browses[0] || document;
  }

  function findPlaylistItemNodes() {
    if (isPlaylistPage()) {
      const root = playlistPageRoot();
      // user playlists / Watch later: ytd-playlist-video-renderer; other people's (public) playlists:
      // yt-lockup-view-model rows; older layouts: ytd-video-renderer
      for (const sel of [
        "ytd-playlist-video-renderer",
        "yt-lockup-view-model",
        "ytd-video-renderer",
      ]) {
        const nodes = Array.from(root.querySelectorAll(sel)).filter((n) => n.querySelector('a[href*="/watch"]'));
        if (nodes.length) return nodes;
      }
      return [];
    }
    // watch page: the side panel next to the playing video
    const panels = Array.from(document.querySelectorAll("ytd-playlist-panel-renderer"));
    const root = panels.find(isVisible) || panels[0] || document;
    for (const sel of ["ytd-playlist-panel-video-renderer", "ytd-playlist-video-renderer"]) {
      const nodes = root.querySelectorAll(sel);
      if (nodes.length) return nodes;
    }
    return [];
  }

  function readPlaylistItems() {
    const nodes = findPlaylistItemNodes();
    if (!nodes.length) {
      console.warn(
        "[MinimalTube] No playlist items found in the DOM (not a playlist, or YouTube's markup changed - see findPlaylistItemNodes() in content-youtube.js).",
      );
      return null;
    }
    const playing = currentVideoId();
    const items = [];
    const seen = new Set();
    let currentIndex = -1;
    nodes.forEach((node, i) => {
      const link =
        node.querySelector('a#wc-endpoint[href*="watch"]') ||
        node.querySelector('a#video-title[href*="watch"]') ||
        node.querySelector('a.ytLockupMetadataViewModelTitle[href*="watch"]') ||
        node.querySelector('a.yt-simple-endpoint[href*="watch"]') ||
        node.querySelector('a[href*="watch"]');
      if (!link) return;
      const href = link.getAttribute("href") || link.href || "";
      if (!href) return;
      let url = href.startsWith("http") ? href : `https://www.youtube.com${href}`;
      try {
        // "t" is the resume position of a half-watched video; a queue entry should start from 0
        const u = new URL(url);
        u.searchParams.delete("t");
        url = u.toString();
      } catch {}
      const titleEl =
        node.querySelector("#video-title") ||
        node.querySelector(".ytLockupMetadataViewModelTitle") ||
        node.querySelector("[title]");
      const title = (
        (titleEl && (titleEl.textContent || titleEl.getAttribute("title"))) ||
        link.getAttribute("aria-label") ||
        `Video ${i + 1}`
      ).trim();
      let id = null;
      try {
        const q = new URL(url).searchParams;
        id = q.get("v");
        const pageList = new URLSearchParams(location.search).get("list");
        if (isPlaylistPage() && pageList && q.get("list") !== pageList) return;
      } catch {}
      const selected =
        node.hasAttribute("selected") ||
        node.getAttribute("aria-selected") === "true" ||
        node.classList.contains("playlist-item-selected");
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      items.push({ index: items.length + 1, title, url });
      if (selected || (playing && id === playing)) currentIndex = items.length - 1;
    });
    if (!items.length) {
      console.warn(
        "[MinimalTube] Playlist nodes were found, but none had an extractable link/title (YouTube's inner markup may have changed).",
      );
      return null;
    }
    return { items, currentIndex: currentIndex >= 0 ? currentIndex : 0 };
  }

  function playlistName() {
    const root = playlistPageRoot();
    // only headings that are actually shown: hidden copies of other pages' headers stay in the DOM
    for (const sel of [
      "ytd-playlist-header-renderer #title-display",
      "yt-page-header-renderer.page-header-sidebar h1",
      "yt-page-header-renderer h1",
      "ytd-playlist-sidebar-primary-info-renderer #title",
      "h1",
    ]) {
      for (const el of root.querySelectorAll(sel)) {
        const text = isVisible(el) ? (el.textContent || "").trim().replace(/\s+/g, " ") : "";
        if (text) return text.slice(0, 80);
      }
    }
    return document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim().slice(0, 80);
  }

  // YouTube only renders the first ~100 rows of a long playlist and loads the rest while the
  // page is scrolled: scroll to the bottom until no more rows appear, then scroll back.
  async function loadWholePlaylist() {
    const startY = window.scrollY;
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 120 && stable < 4; i++) {
      const count = findPlaylistItemNodes().length;
      if (count === last) stable++;
      else {
        stable = 0;
        last = count;
        notice(`Collecting playlist videos… ${count}`, { error: false, ms: 0 });
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(450);
    }
    window.scrollTo(0, startY);
  }

  /* -------------------------------------------------------- sending it off */

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) return resolve({ lost: true });
          resolve(res || {});
        });
      } catch {
        resolve({ reloaded: true });
      }
    });
  }

  function reportFailure(res) {
    if (res.lost) notice("Couldn't reach the MinimalTube extension. Refresh this page and try again.");
    else if (res.reloaded) notice("MinimalTube was reloaded. Refresh this page and try again.");
    else if (res.ok === false)
      notice(
        res.error ||
          `MinimalTube server isn't running (${res.serverBase}) and couldn't be started. Run ./install.sh again.`,
      );
    else return false;
    return true;
  }

  async function openFromWatchPage() {
    if (busy) return;
    busy = true;
    try {
      const playlist = readPlaylistItems();
      const res = await send({ type: "minimaltube-open", url: location.href, playlist });
      reportFailure(res);
    } finally {
      busy = false;
    }
  }

  async function openFromPlaylistPage() {
    if (busy) return;
    busy = true;
    try {
      // The background reads the playlist through YouTube's own API (youtube.js): no scrolling.
      const listId = new URL(location.href).searchParams.get("list");
      const viaApi = await send({ type: "minimaltube-open-playlist", listId, name: playlistName() });
      if (!viaApi.readFailed) return reportFailure(viaApi);
      console.warn("[MinimalTube] reading the playlist through YouTube's API failed, reading the page instead:", viaApi.error);
      // Fallback: scroll so YouTube renders every video, then read them from the page.
      await loadWholePlaylist();
      const playlist = readPlaylistItems();
      if (!playlist) {
        notice("No videos found on this playlist page.");
        return;
      }
      clearNotice();
      const res = await send({
        type: "minimaltube-open",
        url: playlist.items[0].url,
        playlist: {
          items: playlist.items,
          currentIndex: 0,
          savePrompt: true,
          name: playlistName(),
          listId: new URL(location.href).searchParams.get("list"),
        },
      });
      reportFailure(res);
    } finally {
      busy = false;
    }
  }

  /* --------------------------------------------------------------- buttons */

  function ensurePlayerButton(tries = 10) {
    if (!document.getElementById(PLAYER_BTN_ID)) {
      const player = document.querySelector("#movie_player, .html5-video-player");
      if (player) {
        const btn = document.createElement("button");
        btn.id = PLAYER_BTN_ID;
        btn.title = "Open in MinimalTube";
        btn.textContent = "\u21F1";
        Object.assign(btn.style, {
          position: "absolute",
          left: "12px",
          bottom: "56px",
          zIndex: "60",
          width: "34px",
          height: "34px",
          lineHeight: "34px",
          textAlign: "center",
          padding: "0",
          borderRadius: "6px",
          background: "rgba(20,20,20,0.75)",
          color: "#fff",
          border: "none",
          fontSize: "16px",
          cursor: "pointer",
          boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
          fontFamily: "Arial, sans-serif",
          opacity: "0.85",
        });
        btn.addEventListener("mouseenter", () => (btn.style.opacity = "1"));
        btn.addEventListener("mouseleave", () => (btn.style.opacity = "0.85"));
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          openFromWatchPage();
        });
        player.appendChild(btn);
      }
    }
    if (!document.getElementById(PLAYER_BTN_ID) && tries > 0) setTimeout(() => ensurePlayerButton(tries - 1), 500);
  }

  function buildPlaylistButton(floating) {
    const btn = document.createElement("button");
    btn.id = PLAYLIST_BTN_ID;
    btn.type = "button";
    btn.title = "Open every video of this playlist in MinimalTube and save it as a MinimalTube playlist";
    btn.textContent = "\u21F1  Open in MinimalTube";
    Object.assign(btn.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      height: "36px",
      padding: "0 16px",
      borderRadius: "18px",
      border: "none",
      background: "rgba(255,255,255,0.14)",
      color: "#fff",
      fontSize: "14px",
      fontWeight: "500",
      fontFamily: "Roboto, Arial, sans-serif",
      cursor: "pointer",
      whiteSpace: "pre",
      ...(floating
        ? { position: "fixed", left: "16px", bottom: "16px", zIndex: "2000", background: "rgba(20,20,20,0.9)" }
        : { marginTop: "14px" }),
    });
    btn.addEventListener("mouseenter", () => (btn.style.background = floating ? "rgba(50,50,50,0.95)" : "rgba(255,255,255,0.24)"));
    btn.addEventListener("mouseleave", () => (btn.style.background = floating ? "rgba(20,20,20,0.9)" : "rgba(255,255,255,0.14)"));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      openFromPlaylistPage();
    });
    return btn;
  }

  // Where to put the button. YouTube has two playlist headers and keeps the unused one in the DOM
  // (hidden): the old <ytd-playlist-header-renderer> (Watch later, public playlists) and the new
  // <yt-page-header-renderer> (your own playlists). Only a header that is really visible counts.
  function placePlaylistButton(btn) {
    const root = playlistPageRoot();

    // new header: below the "Play all / Shuffle ..." row
    for (const header of root.querySelectorAll("yt-page-header-renderer")) {
      if (!isVisible(header)) continue;
      const actions = header.querySelector("yt-flexible-actions-view-model");
      if (actions && isVisible(actions)) {
        actions.insertAdjacentElement("afterend", btn);
        return true;
      }
    }

    // old header
    const old = root.querySelector("ytd-playlist-header-renderer");
    if (isVisible(old)) {
      (old.querySelector(".immersive-header-content") || old).appendChild(btn);
      return true;
    }
    return false;
  }

  let playlistBtnTimer = null;

  function ensurePlaylistButton(tries = 24) {
    clearTimeout(playlistBtnTimer);
    const existing = Array.from(document.querySelectorAll("#" + PLAYLIST_BTN_ID));
    if (!isPlaylistPage()) {
      existing.forEach((b) => b.remove());
      return;
    }
    if (existing.length === 1 && isVisible(existing[0])) return;
    existing.forEach((b) => b.remove()); // hidden / stale copy from a previous page or header

    if (placePlaylistButton(buildPlaylistButton(false))) return;
    if (tries > 0) {
      playlistBtnTimer = setTimeout(() => ensurePlaylistButton(tries - 1), 500);
      return;
    }
    document.body.appendChild(buildPlaylistButton(true)); // header markup not recognised: float it
  }

  function ensureButtons() {
    ensurePlayerButton();
    ensurePlaylistButton();
  }

  /* ------------------------------------------------ importing subscriptions */

  // The extension opens youtube.com/feed/channels#minimaltube-import when it couldn't read the
  // subscriptions through YouTube's API: scroll until every channel is rendered, then read them
  // from the page. On this page a channel's #subscribers line shows its @handle.
  async function importSubscriptionsFromPage() {
    const nodes = () => document.querySelectorAll("ytd-channel-renderer");
    notice("Collecting your subscriptions…", { error: false, ms: 0 });
    for (let i = 0; i < 60 && !nodes().length; i++) await sleep(250);
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 300 && stable < 4; i++) {
      const count = nodes().length;
      if (count === last) stable++;
      else {
        stable = 0;
        last = count;
        notice(`Collecting your subscriptions… ${count}`, { error: false, ms: 0 });
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(450);
    }
    const channels = [];
    nodes().forEach((node) => {
      const link = node.querySelector("a#main-link, a[href^='/@'], a[href^='/channel/']");
      const href = (link && link.getAttribute("href")) || "";
      const shown = ((node.querySelector("#subscribers") || {}).textContent || "").trim();
      const id = (href.match(/^\/channel\/(UC[\w-]{22})/) || [])[1];
      let handle = shown.startsWith("@") ? shown : null;
      if (!handle && href.startsWith("/@"))
        try {
          handle = decodeURIComponent(href.slice(1).split(/[/?#]/)[0]);
        } catch {}
      const name = ((node.querySelector("#channel-title #text, #text") || {}).textContent || "").trim();
      if (id || handle) channels.push({ id, handle, name });
    });
    if (!channels.length) return notice("No subscribed channels found on this page.");
    notice(`Sending ${channels.length} channels to MinimalTube…`, { error: false, ms: 0 });
    const res = await send({ type: "minimaltube-import-channels", channels });
    if (!reportFailure(res)) clearNotice(); // the extension closes this tab
  }

  /* ------------------------------------------- links open in MinimalTube */
  // With "Open YouTube links in MinimalTube" on, a click on a video, playlist or channel link here
  // opens it in the app: YouTube changes pages without loading them, so the redirect in
  // background.js (same links) never sees these. Ctrl/Shift/middle clicks load a page, so that
  // catches them. Links into the video on this page (timestamps) stay with YouTube.
  const APP_LINK_RE = new RegExp(
    [
      String.raw`^https?://(?:(?:www|m|music)\.)?youtube\.com/(?:watch\?(?:.*&)?v=[\w-]{11}|(?:shorts|live|embed|v)/[\w-]{11})`,
      String.raw`^https?://(?:(?:www|m|music)\.)?youtube\.com/playlist\?(?:.*&)?list=[\w-]{2,64}`,
      String.raw`^https?://(?:(?:www|m)\.)?youtube\.com/(?:@[^/?#]+|channel/UC[\w-]{22}|c/[^/?#]+|user/[^/?#]+)(?:/(?:videos|shorts|streams|featured))?/?(?:[?#].*)?$`,
      String.raw`^https?://youtu\.be/[\w-]{11}`,
    ].join("|"),
    "i",
  );
  let linksToApp = true;
  chrome.storage.local.get(["openYouTubeLinks"], (s) => (linksToApp = s.openYouTubeLinks !== false));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.openYouTubeLinks) linksToApp = changes.openYouTubeLinks.newValue !== false;
  });
  const linkVideoId = (href) => {
    try {
      const u = new URL(href);
      return u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/) || [])[1] || null;
    } catch {
      return null;
    }
  };
  window.addEventListener(
    "click",
    async (event) => {
      if (!linksToApp || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      const a = event.composedPath().find((el) => el instanceof HTMLAnchorElement && el.href);
      if (!a || !APP_LINK_RE.test(a.href)) return;
      const id = linkVideoId(a.href);
      if (id && id === linkVideoId(location.href)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const res = await send({ type: "minimaltube-open-link", url: a.href });
      if (reportFailure(res)) {
        // the app couldn't take it: YouTube opens it after all (the redirect lets this through)
        const url = new URL(a.href);
        url.searchParams.set("minimaltube", "skip");
        setTimeout(() => location.assign(url.href), 2500);
      }
    },
    true,
  );

  if (location.pathname === "/feed/channels" && location.hash === "#minimaltube-import")
    importSubscriptionsFromPage();

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensureButtons);
  else ensureButtons();
  document.addEventListener("yt-navigate-finish", () => setTimeout(ensureButtons, 600));
  // Around 1080px YouTube switches between the playlist header on top and the one in the side
  // column (both stay in the page, one hidden): the button moves to the one that shows.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => ensurePlaylistButton(), 400);
  });
})();
