/* MinimalTube player - Around the video: the idle fade, "Up next" (and a video that waits for its download while
 * another plays), and the description popup.
 * Loaded in order by player.html (classic scripts sharing one scope). */

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
    job = await prepareVideo(url, false);
  } catch (err) {
    if (token !== pendingToken) return true;
    notify(`Couldn't start the download: ${netMessage(firstLine(err.message))}`, true, 4000);
    return true;
  }
  if (token !== pendingToken) return true; // a newer click took over
  if (job.status === "ready") return false; // already downloaded: switch right away
  pollStateSoon();
  if (streamWhileDownloading && LiveStream.pick(job.stream)) return false;
  const pending = { token, url, id: job.video_id, title: job.title || url, ready: false };
  pendingSwitch = pending;
  notify(`Download started: ${pending.title}. It plays after this video.`, false, 4000);
  untilDownloaded(pending.id, () => pendingSwitch !== pending, { patient: true })
    .then((done) => {
      if (!done) return;
      pending.ready = true;
      if (video.ended || !isWatching()) return showUpNext(pendingTarget()); // it was waiting on us
      notify("Download finished. Playing next.", false, 2500);
    })
    .catch((err) => {
      if (pendingSwitch !== pending) return;
      pendingSwitch = null;
      notify(`Download failed: ${firstLine(err.message) || pending.title}`, true, 4000);
    });
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
dialogKeys(upNextEl, { KeyP: upNextNow, KeyC: upNextCancel });
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

// What stands above the description: the release date, the views and the channel (a button to
// its page). `meta` is /description's answer; null empties it.
function setDescMeta(meta) {
  meta = meta || {};
  descDate.textContent = fmtReleaseDate(meta.date);
  descViews.textContent = fmtCount(meta.views, "view", true);
  const label = meta.handle || meta.channel || "";
  descChannel.hidden = !label;
  descChannel.textContent = label;
  descChannel._chan = meta.channel_id
    ? { id: meta.channel_id, name: meta.channel || meta.handle, handle: meta.handle || null }
    : null;
  descChannel.disabled = !descChannel._chan;
  descChannel.title = descChannel._chan ? `Latest uploads from ${meta.channel || label}` : "";
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
// A link in a description that the app can queue: a video (as its watch link) or a playlist.
function queueableLink(href) {
  const { videoId, listId } = youTubeIds(href);
  if (videoId) return watchUrl(videoId);
  return listId ? `${YT_ORIGIN}/playlist?list=${listId}` : null;
}
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
    const link = el("a", null, url),
      queueable = queueableLink(url);
    link.href = url;
    if (queueable) {
      link.classList.add("ytlink");
      link.title = "Add to queue";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        addUrlToQueue(queueable);
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
