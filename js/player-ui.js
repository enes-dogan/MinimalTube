/* MinimalTube player - Player chrome: collapsible panel sections, idle fade, "Up next", the description popup,
 * playback speed and the download indicator.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Collapsible Queue / Downloads sections
 * ===================================================================== */
const sectionEls = {
  queue: queueSection,
  library: document.getElementById("librarySection"),
};
function setSectionCollapsed(key, collapsed, save = true) {
  const sec = sectionEls[key];
  const header = sec.querySelector(".plHeader");
  sec.classList.toggle("collapsed", collapsed);
  header.setAttribute("aria-expanded", String(!collapsed));
  closeRowMenu();
  if (save)
    chrome.storage.local.set({
      collapsedSections: Object.fromEntries(
        Object.entries(sectionEls).map(([item, el]) => [
          item,
          el.classList.contains("collapsed"),
        ]),
      ),
    });
}
Object.entries(sectionEls).forEach(([key, sec]) => {
  const header = sec.querySelector(".plHeader");
  header.tabIndex = 0;
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", "true");
  const toggle = () =>
    setSectionCollapsed(key, !sec.classList.contains("collapsed"));
  header.addEventListener("click", (event) => {
    if (event.target.closest("button")) return; // e.g. "Download all"
    toggle();
  });
  header.addEventListener("keydown", (event) => {
    if (event.target !== header) return;
    if (event.key === "Enter") {
      event.preventDefault();
      toggle();
    }
  });
});
chrome.storage.local.get(["collapsedSections"], (res) => {
  const c = res.collapsedSections || {};
  Object.keys(sectionEls).forEach((item) => {
    if (c[item]) setSectionCollapsed(item, true, false);
  });
});
// The Downloads list follows /downloads (syncLibraryDownloads) and refreshes when downloads
// finish; this slow refresh only catches changes made outside the app.
setInterval(() => {
  if (queuePanel.classList.contains("open")) refreshLibrary();
}, 30000);
const IDLE_DELAY_MS = 2600;
let idleTimer = null;
function anyPanelOpen() {
  return (
    settingsPanel.classList.contains("open") ||
    queuePanel.classList.contains("open") ||
    descPopup.classList.contains("open")
  );
}
function resetIdleTimer() {
  playerFrame.classList.remove("idle");
  clearTimeout(idleTimer);
  if (!(video.paused || anyPanelOpen()))
    idleTimer = setTimeout(() => {
      if (!anyPanelOpen()) playerFrame.classList.add("idle");
    }, IDLE_DELAY_MS);
}
["mousemove", "mousedown", "touchstart", "keydown"].forEach((item) =>
  playerFrame.addEventListener(item, resetIdleTimer),
);
video.addEventListener("play", resetIdleTimer);
video.addEventListener("pause", () => {
  playerFrame.classList.remove("idle");
  clearTimeout(idleTimer);
});
[controls, floatBtns].forEach((item) => {
  item.addEventListener("mouseenter", () => {
    playerFrame.classList.remove("idle");
    clearTimeout(idleTimer);
  });
  item.addEventListener("mouseleave", resetIdleTimer);
});
chrome.storage.local.get(
  ["serverBase", "captionsEnabled", ...SETTINGS.map((setting) => setting.key)],
  (stored) => whenLoaded(() => {
    loadSettings(stored);
    if (stored.serverBase) serverBase = stored.serverBase;
    if (undefined !== stored.captionsEnabled)
      captionsWanted = stored.captionsEnabled;
    serverInput.value = serverBase;
    const params = new URLSearchParams(window.location.search),
      n = params.get("url"),
      s = params.get("pid"),
      fn = async (e) => {
        if (e && e.savePrompt) {
          takeYouTubePlaylist(e);
          if (document.body.classList.contains("browsing")) setBrowseTab(browseTab);
          return;
        }
        if (n) urlInput.value = n; // With "Remember queue" on, bring the saved queue back first so
        // anything opened from YouTube is appended below it, not over it.
        const saved = rememberQueue ? await loadSavedQueue() : null,
          hasSaved = !!(saved && saved.items && saved.items.length);
        if (e) {
          if (hasSaved) appendToSavedQueue(saved, e, n);
          else {
            setQueueFromPlaylist(e);
            if (n) playVideo(n);
          }
        } else if (n) {
          if (hasSaved) restoreSavedQueue(saved);
          // a video opened from YouTube plays either way: beside a playlist queue, not in it
          if (queueLockedReason() && !playlistIdFromUrl(n)) playVideoNow({ url: n, title: n });
          else addUrlToQueue(n);
        } else {
          if (hasSaved) restoreSavedQueue(saved);
          setTimeout(
            () =>
              document.body.classList.contains("browsing") &&
              setBrowseTab(browseTab),
            0,
          );
          maybeWelcome();
        }
      };
    if (s)
      chrome.storage.local.get([s], (e) => {
        chrome.storage.local.remove(s);
        const playlist = e[s];
        fn(
          playlist && Array.isArray(playlist.items) && playlist.items.length
            ? playlist
            : null,
        );
      });
    else fn(null);
    refreshLibrary();
  }),
);
/* =====================================================================
 * "Up next" countdown when a video ends
 * ===================================================================== */
const upNextEl = document.getElementById("upNext"),
  upNextTitle = document.getElementById("upNextTitle"),
  upNextCount = document.getElementById("upNextCount"),
  upNextNow = document.getElementById("upNextNow"),
  upNextCancel = document.getElementById("upNextCancel"),
  UP_NEXT_SECONDS = 5;
let upNextTimer = null,
  upNextTarget = null;

// Next video from whichever list the current one was started from.
function resolveNext() {
  if (playSource === "library") {
    const index = library.findIndex((entry) => entry.id === currentVideoId),
      nxt = index >= 0 ? library[index + 1] : null;
    return nxt
      ? {
          title: nxt.title || "Next video",
          play: () => playLibraryEntry(nxt),
        }
      : null;
  }
  if (!queue || queueIndex < 0) return null;
  // after a video played on the side of a playlist queue: the playlist goes on where it was left,
  // with the video that was playing, or the one after it if that one was watched to the end
  const interrupted = queue.items[queueIndex],
    nxt =
      playSource === "detour"
        ? queue.items[queueIndex + (interrupted && watchDone(itemVideoId(interrupted)) ? 1 : 0)]
        : queue.items[queueIndex + 1];
  if (!nxt) return null;
  return {
    title: nxt.title || nxt.url,
    play: () => {
      const idx = queue ? queue.items.indexOf(nxt) : -1;
      if (idx < 0) return;
      playSource = "queue";
      queueIndex = idx;
      markActiveQueueRow();
      playVideo(nxt.url);
      prefetchNextInQueue();
      saveQueue();
    },
  };
}
function cancelUpNext() {
  clearInterval(upNextTimer);
  upNextTimer = null;
  upNextTarget = null;
  upNextEl.classList.remove("show", "run");
}
function playUpNext() {
  const t = upNextTarget;
  cancelUpNext();
  if (t) t.play();
}

/* ---- A video that still has to download while another one is playing ----
 * pendingSwitch = { token, url, id, title, ready }. Nothing about the player changes: a short
 * notice says the download started, and when the current video ends the usual "Up next"
 * countdown offers the new one (Cancel / Esc keeps it from switching). */
let pendingSwitch = null,
  pendingToken = 0;
function isWatching() {
  return !!(
    currentVideoId &&
    video.getAttribute("src") &&
    video.readyState > 0 &&
    !video.ended &&
    loadingBox.style.display !== "flex"
  );
}
function pendingTarget() {
  const pending = pendingSwitch;
  if (!pending || !pending.ready) return null;
  return {
    title: pending.title,
    play: () => {
      if (pendingSwitch !== pending) return;
      pendingSwitch = null;
      pendingToken++;
      playVideo(pending.url, {
        gentle: false,
      });
    },
  };
}

// Resolves true when the video was taken over by the background path (the caller must not
// touch the player), false when it should just be loaded the normal way.
async function deferSwitch(url) {
  if (streamOnlyMode()) return false; // it streams right away; nothing to wait for
  const token = ++pendingToken;
  pendingSwitch = null;
  let job;
  try {
    job = await api(preparePath(url, false));
  } catch (err) {
    if (token !== pendingToken) return true;
    notify(`Couldn't start the download: ${netMessage(firstLine(err.message))}`, true, 4000);
    return true;
  }
  if (token !== pendingToken) return true; // a newer click took over
  if (job.status === "ready") return false; // already downloaded: switch right away
  pollDownloadsSoon();
  if (streamWhileDownloading && LiveStream.pick(job.stream)) return false;
  const pending = {
    token,
    url,
    id: job.video_id,
    title: job.title || url,
    ready: false,
  };
  pendingSwitch = pending;
  notify(
    `Download started: ${pending.title}. It plays after this video.`,
    false,
    4000,
  );
  (async () => {
    let status = job;
    while (pendingSwitch === pending && status.status !== "ready") {
      if (status.status === "error") {
        pendingSwitch = null;
        return notify(
          `Download failed: ${status.error || pending.title}`,
          true,
          4000,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (pendingSwitch !== pending) return;
      try {
        status = await fetchJobStatus(pending.id);
      } catch (err) {
        logQuiet("waiting download", err);
      }
    }
    if (pendingSwitch !== pending) return;
    pending.ready = true;
    if (video.ended || !isWatching()) return showUpNext(pendingTarget()); // it was waiting on us
    notify("Download finished. Playing next.", false, 2500);
  })();
  return true;
}
function userCancelUpNext() {
  // an explicit Cancel / Esc also drops a waiting download-switch
  pendingSwitch = null;
  pendingToken++;
  cancelUpNext();
}
function onVideoEnded() {
  cancelUpNext();
  if (pendingSwitch) {
    // the video we're waiting for: offer it as soon as it's downloaded
    if (pendingSwitch.ready) showUpNext(pendingTarget());
    else notify("Waiting for the download to finish…", false, 3000);
    return;
  }
  showUpNext(resolveNext(), { countdown: playSource !== "library" });
}
function showUpNext(next, { countdown = true } = {}) {
  if (!next) return;
  upNextTarget = next;
  let left = UP_NEXT_SECONDS;
  upNextTitle.textContent = next.title;
  upNextEl.classList.remove("run");
  if (!countdown) {
    upNextCount.textContent = "Press Play now to continue";
    upNextEl.classList.add("show");
    return;
  }
  upNextCount.textContent = `Playing in ${left}`;
  restartAnimation(upNextEl, "show", "run");
  upNextTimer = setInterval(() => {
    left--;
    if (left <= 0) return playUpNext();
    upNextCount.textContent = `Playing in ${left}`;
  }, 1000);
}
video.addEventListener("ended", onVideoEnded);
video.addEventListener("play", cancelUpNext);
upNextNow.addEventListener("click", playUpNext);
upNextCancel.addEventListener("click", userCancelUpNext);
addLayer({
  el: upNextEl,
  isOpen: () => upNextEl.classList.contains("show"),
  close: userCancelUpNext,
  outside: false,
});

/* =====================================================================
 * Description popup (click the title at the top left)
 * ===================================================================== */
const descPopup = document.getElementById("descPopup"),
  descBody = document.getElementById("descBody"),
  descDate = document.getElementById("descDate"),
  descMeta = document.getElementById("descMeta"),
  descViews = document.getElementById("descViews"),
  descChannel = document.getElementById("descChannel"),
  descCache = new Map(),
  DESC_LINGER = 4000,
  // stays this long after opening...
  DESC_LEAVE = 2000; // ...or after the mouse leaves; never closes while hovered
let descTimer = null,
  descReq = 0;

function ytVideoLink(href) {
  try {
    const url = new URL(href),
      host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
    const idOk = (v) => /^[A-Za-z0-9_-]{11}$/.test(v || "");
    if (host === "youtu.be") {
      const id = url.pathname.slice(1).split("/")[0];
      return idOk(id) ? `https://www.youtube.com/watch?v=${id}` : null;
    }
    if (host !== "youtube.com") return null;
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      return idOk(id) ? `https://www.youtube.com/watch?v=${id}` : null;
    }
    const m = url.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})/);
    if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
    if (url.pathname === "/playlist" && url.searchParams.get("list"))
      return `https://www.youtube.com/playlist?list=${url.searchParams.get("list")}`;
  } catch {}
  return null;
}

// "2026-10-20" -> "Oct 20, 2026" (in the browser's language); empty when unknown.
function fmtReleaseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return "";
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); // local date: no timezone shift
  return isNaN(date)
    ? ""
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

// 1,234 views / 12.5K views / 100K views / 1.5M views
function fmtDescViews(count) {
  if (count == null || !isFinite(count)) return "";
  const oneDecimal = (v) => String(Math.floor(v * 10) / 10);
  if (count >= 1e9) return `${oneDecimal(count / 1e9)}B views`;
  if (count >= 1e6) return `${oneDecimal(count / 1e6)}M views`;
  if (count >= 1e5) return `${Math.floor(count / 1e3)}K views`;
  if (count >= 1e4) return `${oneDecimal(count / 1e3)}K views`;
  return `${count.toLocaleString()} view${count === 1 ? "" : "s"}`;
}

function setDescMeta(channel) {
  channel = channel || {};
  descDate.textContent = fmtReleaseDate(channel.date);
  descViews.textContent = fmtDescViews(channel.views);
  const label = channel.handle || channel.channel || "";
  descChannel.hidden = !label;
  descChannel.textContent = label;
  descChannel._chan = channel.channel_id
    ? {
        id: channel.channel_id,
        name: channel.channel || channel.handle,
        handle: channel.handle || null,
      }
    : null;
  descChannel.disabled = !descChannel._chan;
  descChannel.title = descChannel._chan
    ? `Latest uploads from ${channel.channel || label}`
    : "";
}
const descShare = document.getElementById("descShare");
let descShareTimer = null;
descShare.addEventListener("click", async () => {
  if (!currentVideoId) return;
  const link = `https://youtu.be/${currentVideoId}`;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = link;
    textarea.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch {}
    textarea.remove();
  }
  const label = descShare.querySelector("span");
  label.textContent = "Copied";
  descShare.classList.add("done");
  clearTimeout(descShareTimer);
  descShareTimer = setTimeout(() => {
    label.textContent = "Share";
    descShare.classList.remove("done");
  }, 1600);
});
descChannel.addEventListener("click", () => {
  const ch = descChannel._chan;
  if (!ch) return;
  closeDesc();
  openChannel(ch);
});
function renderDescription(text) {
  descBody.textContent = "";
  descBody.classList.remove("muted");
  if (!text || !text.trim()) {
    descBody.classList.add("muted");
    descBody.textContent = "This video has no description.";
    return;
  }
  const re = /https?:\/\/[^\s<>"]+/g;
  let last = 0,
    m;
  while ((m = re.exec(text))) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]'"]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    if (m.index > last)
      descBody.appendChild(document.createTextNode(text.slice(last, m.index)));
    const link = document.createElement("a"),
      video = ytVideoLink(url);
    link.textContent = url;
    link.href = url;
    if (video) {
      link.classList.add("ytlink");
      link.title = "Add to queue";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        addUrlToQueue(video);
      });
    } else {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    descBody.appendChild(link);
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length)
    descBody.appendChild(document.createTextNode(text.slice(last)));
}
function armDescTimer(ms) {
  clearTimeout(descTimer);
  if (descPopup.matches(":hover")) return;
  descTimer = setTimeout(closeDesc, ms);
}
function closeDesc() {
  clearTimeout(descTimer);
  descReq++;
  if (!descPopup.classList.contains("open")) return;
  descPopup.classList.remove("open");
  resetIdleTimer();
}
async function openDesc() {
  if (!currentVideoId) return;
  const id = currentVideoId,
    req = ++descReq;
  descPopup.classList.add("open");
  clearTimeout(descTimer);
  if (descCache.has(id)) {
    const hit = descCache.get(id);
    setDescMeta(hit);
    renderDescription(hit.text);
    return armDescTimer(DESC_LINGER);
  }
  setDescMeta(null); // never show the previous video's date while this one loads
  descBody.classList.add("muted");
  descBody.textContent = "Loading description…";
  try {
    const data = await api(`/description/${id}`);
    descCache.set(id, {
      text: data.description || "",
      date: data.date || null,
      views: data.views ?? null,
      channel: data.channel || null,
      channel_id: data.channel_id || null,
      handle: data.handle || null,
    });
    if (req !== descReq) return;
    setDescMeta(data);
    renderDescription(data.description || "");
  } catch (err) {
    if (req !== descReq) return;
    descBody.classList.add("muted");
    descBody.textContent = `Couldn't load the description: ${netMessage(firstLine(err.message))}`;
  }
  armDescTimer(DESC_LINGER);
}
titleOverlay.addEventListener("click", () => {
  if (descPopup.classList.contains("open")) closeDesc();
  else openDesc();
});
descPopup.addEventListener("mouseenter", () => clearTimeout(descTimer));
descPopup.addEventListener("mouseleave", () => armDescTimer(DESC_LEAVE));
addLayer({
  el: descPopup,
  isOpen: () => descPopup.classList.contains("open"),
  close: closeDesc,
  inside: [titleOverlay],
});

/* =====================================================================
 * [ and ] change playback speed by 0.10x, \ puts it back to 1x; a flash in the middle
 * ===================================================================== */
function flashSpeed() {
  flashText(`${playbackRate.toFixed(2)}x`);
}
function flashText(text) {
  centerFlash.querySelector(".txt").textContent = text;
  centerFlash.classList.remove("show-pause");
  centerFlash.classList.add("show-text");
  restartAnimation(centerFlash, "flash");
}
document.addEventListener("keydown", (event) => {
  const down = event.code === "BracketLeft" || event.key === "[",
    up = event.code === "BracketRight" || event.key === "]",
    reset = event.key === "\\";
  if (!down && !up && !reset) return;
  // Layouts where [ ] \ need AltGr (e.g. Turkish Q) report ctrl/alt modifiers.
  if (
    (event.ctrlKey || event.metaKey || event.altKey) &&
    !(event.getModifierState && event.getModifierState("AltGraph"))
  )
    return;
  if (isTypingTarget(event.target) || !hasVideoLoaded()) return;
  event.preventDefault();
  setPlaybackRate(reset ? 1 : playbackRate + (up ? 0.1 : -0.1));
  flashSpeed();
});

/* =====================================================================
 * Download indicator (top right): count of active downloads inside a
 * progress ring; turns into a green tick when everything is done.
 * ===================================================================== */
const dlInd = document.getElementById("dlIndicator"),
  dlRing = dlInd.querySelector(".fg"),
  dlNum = dlInd.querySelector(".num"),
  DL_CIRC = 2 * Math.PI * 15.5;
const bpDlInd = document.getElementById("bpDlIndicator"),
  bpDlRing = bpDlInd.querySelector(".fg"),
  bpDlNum = bpDlInd.querySelector(".num");
// The same indicator, shown on the Subscriptions / Playlists / Downloads pages
// (the player's own copy is hidden while the mini player is shown).
function mirrorDlIndicator() {
  ["show", "done", "leave"].forEach((cls) =>
    bpDlInd.classList.toggle(cls, dlInd.classList.contains(cls)),
  );
  bpDlNum.textContent = dlNum.textContent;
  bpDlInd.title = dlInd.title;
}
let activeDownloads = new Map(); // id -> {id, status, percent} for downloads running right now
const dlBatch = new Map(); // id -> best known percent for the current batch
let dlDoneTimer = null,
  dlLeaveTimer = null;
function setDlRing(percent, instant = false) {
  const rings = [dlRing, bpDlRing];
  if (instant) rings.forEach((ring) => (ring.style.transition = "none"));
  rings.forEach(
    (ring) =>
      (ring.style.strokeDashoffset = String(
        DL_CIRC * (1 - Math.min(100, percent) / 100),
      )),
  );
  if (instant) {
    void dlRing.getBoundingClientRect();
    void bpDlRing.getBoundingClientRect();
    rings.forEach((ring) => (ring.style.transition = ""));
  }
}
async function pollDownloads() {
  await pollDownloadsCore();
  mirrorDlIndicator();
}
async function pollDownloadsCore() {
  let items;
  try {
    const res = await fetch(`${serverBase}/downloads`);
    if (!res.ok) return;
    items = (await res.json()).items || [];
  } catch (err) {
    return logQuiet("downloads", err);
  }
  activeDownloads = new Map(items.map((job) => [job.id, job]));
  if (
    queuePanel.classList.contains("open") ||
    document.body.classList.contains("browsing")
  )
    syncLibraryDownloads(items);
  if (items.length) {
    clearTimeout(dlDoneTimer);
    clearTimeout(dlLeaveTimer);
    const fresh =
      !dlInd.classList.contains("show") || dlInd.classList.contains("done");
    dlInd.classList.remove("done", "leave");
    if (fresh) {
      dlBatch.clear();
      setDlRing(0, true);
    }
    dlInd.classList.add("show");
    const active = new Set(items.map((item) => item.id));
    for (const id of dlBatch.keys()) if (!active.has(id)) dlBatch.set(id, 100);
    // yt-dlp reports video and audio streams separately, so never let a bar go backwards
    items.forEach((item) =>
      dlBatch.set(
        item.id,
        Math.max(dlBatch.get(item.id) || 0, Math.min(99, item.percent || 0)),
      ),
    );
    const avg =
      [...dlBatch.values()].reduce((sum, next) => sum + next, 0) / dlBatch.size;
    dlNum.textContent = String(items.length);
    setDlRing(avg);
    dlInd.title = `Downloading ${items.length} video${items.length > 1 ? "s" : ""}… ${Math.round(avg)}%`;
  } else if (dlBatch.size) {
    dlBatch.clear();
    setDlRing(100);
    dlInd.classList.add("show", "done");
    dlInd.title = "Downloads finished";
    refreshLibrary(); // refresh the Downloads list right away
    dlDoneTimer = setTimeout(() => {
      dlInd.classList.add("leave"); // fade out to the right
      mirrorDlIndicator();
      dlLeaveTimer = setTimeout(() => {
        dlInd.classList.remove("show", "leave", "done");
        mirrorDlIndicator();
      }, 600);
    }, 1500);
  }
}
// Every second while something downloads; slower when nothing does (or the window is hidden).
// Starting a download asks right away (pollDownloadsSoon).
const DL_POLL_ACTIVE_MS = 1000,
  DL_POLL_IDLE_MS = 4000,
  DL_POLL_HIDDEN_MS = 15000;
let dlPollTimer = 0;
async function downloadPollLoop() {
  clearTimeout(dlPollTimer);
  await pollDownloads();
  const delay = activeDownloads.size
    ? DL_POLL_ACTIVE_MS
    : document.hidden
      ? DL_POLL_HIDDEN_MS
      : DL_POLL_IDLE_MS;
  dlPollTimer = setTimeout(downloadPollLoop, delay);
}
function pollDownloadsSoon() {
  clearTimeout(dlPollTimer);
  dlPollTimer = setTimeout(downloadPollLoop, 300);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollDownloadsSoon();
});
whenLoaded(downloadPollLoop);

/* ---- Keep the indicator out of the way of the queue panel (the settings popup sits below it) ---- */
const DL_BASE_RIGHT = 98,
  // indicator's resting `right` offset (see CSS)
  DL_GAP = 12;
function updateDlShift() {
  let extent = 0; // how far in from the right edge the open panel reaches
  if (queuePanel.classList.contains("open"))
    extent = Math.max(extent, queuePanel.offsetWidth + DL_GAP);
  const shift = extent > DL_BASE_RIGHT ? extent - DL_BASE_RIGHT : 0;
  dlInd.style.setProperty("--dlShift", `${-shift}px`);
}
const dlShiftObserver = new MutationObserver(updateDlShift);
dlShiftObserver.observe(queuePanel, {
  attributes: true,
  attributeFilter: ["class"],
});
window.addEventListener("resize", updateDlShift);
updateDlShift();

// Persist the latest queue position when the player closes or reloads (never an
// empty queue: that could wipe a saved one before it has been restored).
window.addEventListener("pagehide", () => {
  if (queue && queue.items.length) saveQueue();
});
