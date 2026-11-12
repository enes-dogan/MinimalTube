/* MinimalTube player - What the server is doing, asked in one place: one loop asks GET /state and
 * everything that follows the server's work listens to its answer (the download ring, the rows'
 * progress, a video waiting for its download or its captions, the Downloads list).
 * Loaded in order by player.html (classic scripts sharing one scope). */

// Every second while something downloads or is waited for; slower when nothing is (or the window
// is hidden). Starting something asks right away (pollStateSoon).
const STATE_ACTIVE_MS = 1000,
  STATE_IDLE_MS = 4000,
  STATE_HIDDEN_MS = 15000;

let activeDownloads = new Map(), // id -> {id, status, percent} for downloads running right now
  serverLibraryRev = null; // the revision of the server's Downloads list (side-panel.js follows it)
const watchedJobs = new Map(), // video id -> how many are waiting for that video's download
  watchedStatuses = new Map(), // video id -> its job as of the last answer (null: it has none)
  stateListeners = [],
  stateWaiters = [];
let captionsAwaited = null, // the video id whose captions the player waits for
  stateTimer = 0;

/**
 * Runs `fn(state)` after every answer of the server's state: `state` is /state's JSON
 * ({downloads, statuses, rev, captions}). `activeDownloads` and `serverLibraryRev` are already
 * up to date when it runs.
 */
const whenStateChanges = (fn) => stateListeners.push(fn);

async function pollState() {
  const params = new URLSearchParams();
  if (watchedJobs.size) params.set("ids", [...watchedJobs.keys()].join(","));
  if (captionsAwaited) params.set("captions", captionsAwaited);
  const query = params.toString();
  let state;
  try {
    state = await api(`/state${query ? `?${query}` : ""}`);
  } catch (err) {
    logQuiet("server state", err);
    stateWaiters.splice(0).forEach((waiter) => waiter.reject(err));
    return;
  }
  activeDownloads = new Map((state.downloads || []).map((job) => [job.id, job]));
  serverLibraryRev = state.rev ?? null;
  Object.entries(state.statuses || {}).forEach(([id, job]) => watchedStatuses.set(id, job));
  stateListeners.forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      logQuiet("server state listener", err);
    }
  });
  stateWaiters.splice(0).forEach((waiter) => waiter.resolve());
}
async function stateLoop() {
  clearTimeout(stateTimer);
  await pollState();
  const busy = activeDownloads.size || watchedJobs.size || captionsAwaited;
  stateTimer = setTimeout(stateLoop, busy ? STATE_ACTIVE_MS : document.hidden ? STATE_HIDDEN_MS : STATE_IDLE_MS);
}
/** Asks the server's state again in a moment: something was just started or changed. */
function pollStateSoon() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(stateLoop, 300);
}
const nextState = () => new Promise((resolve, reject) => stateWaiters.push({ resolve, reject }));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollStateSoon();
});
whenLoaded(stateLoop);

/**
 * Waits until a video's download is done, following it through the state loop.
 * @param {string} videoId The video (its download was started by /prepare or /queue).
 * @param {() => boolean} isStale Asked after every answer: true ends the wait (the player moved on).
 * @param {object} [options]
 * @param {(job: object) => void} [options.onProgress] Runs with the job ({status, percent}) while
 *   it isn't ready.
 * @param {boolean} [options.patient] Keep waiting while the server can't be reached; otherwise
 *   that ends the wait with its error.
 * @returns {Promise<object|null>} The job once its status is "ready"; null when `isStale` ended it.
 * @throws {Error} The download failed (the server's reason), or there is no such download.
 */
async function untilDownloaded(videoId, isStale, { onProgress, patient = false } = {}) {
  watchedJobs.set(videoId, (watchedJobs.get(videoId) || 0) + 1);
  watchedStatuses.delete(videoId); // what was known before this wait is old
  pollStateSoon();
  try {
    for (let unknown = 0; ; ) {
      try {
        await nextState();
      } catch (err) {
        if (isStale()) return null;
        if (!patient) throw err;
        continue;
      }
      if (isStale()) return null;
      const job = watchedStatuses.get(videoId);
      if (!job) {
        // not in the answer yet (it was asked before this wait began), or the download is gone
        if (++unknown > 3) throw new Error("the download stopped");
        continue;
      }
      unknown = 0;
      if (job.status === "ready") return job;
      if (job.status === "error") throw new Error(job.error || "Download failed");
      if (onProgress) onProgress(job);
    }
  } finally {
    const left = watchedJobs.get(videoId) - 1;
    if (left > 0) watchedJobs.set(videoId, left);
    else {
      watchedJobs.delete(videoId);
      watchedStatuses.delete(videoId);
    }
  }
}

// Titles the player already knows, so the server can name queued downloads right away.
function titlesFor(items) {
  const out = {};
  items.forEach((item) => {
    const id = itemVideoId(item);
    if (id && item.title && !/^https?:\/\//i.test(item.title)) out[id] = item.title;
  });
  return out;
}
/**
 * Has the server download videos in the background.
 * @param {string[]} ids Their video ids.
 * @param {object[]} items The queue items or videos they belong to (for their titles).
 * @returns {Promise<{queued: number}>} How many were new (not downloaded or on their way).
 */
async function requestDownloads(ids, items) {
  const data = await api("/queue", {
    method: "POST",
    body: { ids, titles: titlesFor(items), sponsorblock: sponsorBlockEnabled },
  });
  pollStateSoon();
  return data;
}

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
  ["show", "done", "leave"].forEach((cls) => bpDlInd.classList.toggle(cls, dlInd.classList.contains(cls)));
  bpDlNum.textContent = dlNum.textContent;
  bpDlInd.title = dlInd.title;
}
const dlBatch = new Map(); // id -> best known percent for the current batch
let dlDoneTimer = null,
  dlLeaveTimer = null;
function setDlRing(percent, instant = false) {
  const rings = [dlRing, bpDlRing];
  if (instant) rings.forEach((ring) => (ring.style.transition = "none"));
  rings.forEach((ring) => (ring.style.strokeDashoffset = String(DL_CIRC * (1 - Math.min(100, percent) / 100))));
  if (instant) {
    void dlRing.getBoundingClientRect();
    void bpDlRing.getBoundingClientRect();
    rings.forEach((ring) => (ring.style.transition = ""));
  }
}
function paintDlIndicator() {
  const items = [...activeDownloads.values()];
  if (items.length) {
    clearTimeout(dlDoneTimer);
    clearTimeout(dlLeaveTimer);
    const fresh = !dlInd.classList.contains("show") || dlInd.classList.contains("done");
    dlInd.classList.remove("done", "leave");
    if (fresh) {
      dlBatch.clear();
      setDlRing(0, true);
    }
    dlInd.classList.add("show");
    for (const id of dlBatch.keys()) if (!activeDownloads.has(id)) dlBatch.set(id, 100);
    // yt-dlp reports video and audio streams separately, so never let a bar go backwards
    items.forEach((item) => dlBatch.set(item.id, Math.max(dlBatch.get(item.id) || 0, Math.min(99, item.percent || 0))));
    const avg = [...dlBatch.values()].reduce((sum, next) => sum + next, 0) / dlBatch.size;
    dlNum.textContent = String(items.length);
    setDlRing(avg);
    dlInd.title = `Downloading ${plural(items.length, "video")}… ${Math.round(avg)}%`;
  } else if (dlBatch.size) {
    dlBatch.clear();
    setDlRing(100);
    dlInd.classList.add("show", "done");
    dlInd.title = "Downloads finished";
    dlDoneTimer = setTimeout(() => {
      dlInd.classList.add("leave"); // fade out to the right
      mirrorDlIndicator();
      dlLeaveTimer = setTimeout(() => {
        dlInd.classList.remove("show", "leave", "done");
        mirrorDlIndicator();
      }, 600);
    }, 1500);
  }
  mirrorDlIndicator();
}
whenStateChanges(paintDlIndicator);
bpDlInd.addEventListener("click", () => setBrowseTab("downloads"));

/* ---- Both indicators stay out of the open side panel's way: they slide left of it, so its
 * header buttons are never under one. DL_RIGHT / BP_DL_RIGHT are how far each indicator's right
 * edge rests from the window's (see indicators.css). ---- */
const DL_RIGHT = 98,
  BP_DL_RIGHT = 104,
  DL_GAP = 12;
function updateDlShift() {
  const reach = queuePanel.classList.contains("open") ? queuePanel.offsetWidth + DL_GAP : 0,
    bpShift = Math.max(0, reach - BP_DL_RIGHT);
  dlInd.style.setProperty("--dlShift", `${-Math.max(0, reach - DL_RIGHT)}px`);
  bpDlInd.style.setProperty("--dlShift", `${-bpShift}px`);
  // no room left of the panel (a narrow window: the tabs are there): the ring hides, and the
  // panel's own rows show the progress
  const tabs = document.getElementById("browseTabs").getBoundingClientRect();
  bpDlInd.classList.toggle("crowded", bpShift > 0 && window.innerWidth - BP_DL_RIGHT - bpShift - bpDlInd.offsetWidth < tabs.right + 8);
}
new MutationObserver(updateDlShift).observe(queuePanel, { attributes: true, attributeFilter: ["class"] });
window.addEventListener("resize", updateDlShift);
updateDlShift();
