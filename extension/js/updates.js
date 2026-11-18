/* MinimalTube player - Updates from GitHub. The server does the work (minimaltube/updater.py); this
 * shows it: the Updates group in Settings, a dot on the Settings buttons while a newer version
 * waits, the update card (release notes, what changes, Install or Roll back) and what follows an
 * install: the extension reloads to run the new version and the player comes back where it was
 * (the queue and the video, paused at its place).
 * Loaded in order by player.html (classic scripts sharing one scope). */

const updTitle = byId("updTitle"),
  updSub = byId("updSub"),
  updActionBtn = byId("updActionBtn"),
  updBackBtn = byId("updBackBtn"),
  updAutoToggle = byId("updAutoToggle");
const UPDATE_SNAPSHOT_MS = 10 * 60 * 1000, // older than this, a snapshot is a leftover
  UPDATE_WAIT_MS = 180000, // an install that takes longer is reported as stuck
  INSTALL_RUNNING = ["waiting", "backup", "swapping", "swapped", "finishing", "starting", "undoing"];
let updateInfo = null, // the server's /update/status, as last asked
  updateChecking = false,
  updateBusy = false, // an install or rollback this page started is running
  updateCard = null; // {overlay, mode, ...} while the update card shows
const loadedVersion = () => chrome.runtime.getManifest().version;

/** Asks the server about updates (GET /update/status) and repaints what shows it.
 * @returns {Promise<object|null>} The status, or null when the server can't be asked. */
async function loadUpdateStatus() {
  try {
    updateInfo = await api("/update/status");
  } catch (err) {
    logQuiet("update status", err);
    updateInfo = null;
  }
  paintUpdates();
  return updateInfo;
}

const canUpdate = (s) => !!(s && s.available && s.latest && !s.blocked);
const installRunning = (s) => updateBusy || !!(s && s.install && INSTALL_RUNNING.includes(s.install.phase));
const downloadRunning = (s) => !!(s && s.download && ["downloading", "verifying"].includes(s.download.phase));
const checkedAgo = (ts) => (Date.now() / 1000 - ts < 60 ? "just now" : timeAgo(ts));
const releasedAgo = (latest) => {
  const at = Date.parse(latest.published || "") / 1000;
  return at > 0 ? `released ${timeAgo(at)}` : "";
};
// "12 files change: player 8, server 3, installer 1"
function changesText(changes) {
  const groups = ["player", "server", "installer", "other"].filter((g) => changes.groups[g]);
  const count = changes.count;
  return `${plural(count, "file")} change${count === 1 ? "s" : ""}: ${groups.map((g) => `${g} ${changes.groups[g]}`).join(", ")}`;
}
function updateLine(s) {
  if (!s) return "The server can't be asked about updates right now.";
  const inst = s.install,
    latest = s.latest;
  if (updateChecking) return "Asking GitHub…";
  if (installRunning(s)) return `Installing ${(inst && inst.version) || ""}…`;
  if (s.download && s.download.phase === "downloading") return `Downloading ${s.download.version}…`;
  if (s.download && s.download.phase === "verifying") return "Checking the downloaded files…";
  if (s.blocked) return s.blocked.text;
  if (canUpdate(s) && inst && inst.phase === "failed" && inst.version === latest.version)
    return `The update to ${inst.version} didn't work${inst.undone ? " and was undone" : ""}: ${inst.error || "unknown error"}`;
  if (canUpdate(s))
    return [`You have ${s.version}`, releasedAgo(latest), s.staged && changesText(s.staged.changes)].filter(Boolean).join(" · ");
  if (s.error && (!s.checked || s.tried > s.checked))
    return `Couldn't check: ${s.error}${s.checked ? ` · last checked ${checkedAgo(s.checked)}` : ""}`;
  if (inst && inst.phase === "done" && inst.version === s.version && Date.now() / 1000 - inst.finished < 86400) {
    const how = inst.kind === "rollback" ? `Went back from ${inst.from}` : `Updated from ${inst.from}`;
    return [`${how} ${timeAgo(inst.finished)}`, ...inst.notes].join(" · ");
  }
  if (!s.checked) return "Not checked yet";
  return `Up to date${latest ? "" : " (no releases yet)"} · checked ${checkedAgo(s.checked)}`;
}
/** Repaints the Updates group in Settings, the dot on the Settings buttons and the update card. */
function paintUpdates() {
  const s = updateInfo,
    busy = updateChecking || installRunning(s) || downloadRunning(s);
  [gearBtn, byId("bpSettingsBtn")].forEach((btn) => btn && btn.classList.toggle("hasUpdate", canUpdate(s)));
  updTitle.textContent = canUpdate(s) ? `MinimalTube ${s.latest.version} is out` : `MinimalTube ${loadedVersion()}`;
  updSub.textContent = updateLine(s);
  updSub.classList.toggle("problem", !!(s && (s.blocked || (s.error && !s.available))));
  updActionBtn.textContent = canUpdate(s) ? `Update to ${s.latest.version}` : "Check for updates";
  updActionBtn.classList.toggle("btn-primary", canUpdate(s));
  updActionBtn.classList.toggle("btn-ghost", !canUpdate(s));
  updActionBtn.disabled = !s || busy;
  updBackBtn.hidden = !(s && s.rollback && !canUpdate(s));
  if (!updBackBtn.hidden) updBackBtn.textContent = `Back to ${s.rollback.version}`;
  updBackBtn.disabled = busy;
  updAutoToggle.checked = !!(s && s.auto);
  updAutoToggle.disabled = !s || !!s.blocked;
  updAutoToggle.closest(".checkrow").classList.toggle("off", updAutoToggle.disabled);
  if (updateCard) paintUpdateCard();
}

async function checkForUpdates() {
  updateChecking = true;
  paintUpdates();
  try {
    updateInfo = await api("/update/check", { method: "POST", body: {} });
  } catch (err) {
    notify(`Couldn't check for updates: ${firstLine(err.message)}`, true, 5000);
  } finally {
    updateChecking = false;
  }
  paintUpdates();
  if (updateInfo && !updateInfo.available && !updateInfo.error)
    notify(`MinimalTube ${loadedVersion()} is the newest version`, false, 3000);
}
updActionBtn.addEventListener("click", () => (canUpdate(updateInfo) ? openUpdateCard() : checkForUpdates()));
updBackBtn.addEventListener("click", () => openUpdateCard({ rollback: true }));
updAutoToggle.addEventListener("change", async () => {
  const on = updAutoToggle.checked;
  try {
    updateInfo = await api("/update/settings", { method: "PUT", body: { auto: on } });
  } catch (err) {
    updAutoToggle.checked = !on;
    notify(`Couldn't change it: ${firstLine(err.message)}`, true, 5000);
  }
  paintUpdates();
});

/* ---- Release notes: GitHub writes them in Markdown; headings, lists, **bold**, `code` and
 * links (their text) are shown, everything as text, never as HTML ---- */
function notesInline(node, text) {
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g;
  let at = 0,
    m;
  while ((m = re.exec(text))) {
    node.append(text.slice(at, m.index));
    if (m[1] != null) node.appendChild(el("b", null, m[1]));
    else if (m[2] != null) node.appendChild(el("code", null, m[2]));
    else node.append(m[3]);
    at = re.lastIndex;
  }
  node.append(text.slice(at));
  return node;
}
function renderNotes(box, text) {
  box.textContent = "";
  let list = null;
  String(text || "")
    .split(/\r?\n/)
    .forEach((raw) => {
      const line = raw.trim(),
        item = /^[-*+]\s+(.*)$/.exec(line),
        head = /^#{1,6}\s+(.*)$/.exec(line);
      if (!line) return void (list = null);
      if (item) {
        list = list || box.appendChild(el("ul"));
        list.appendChild(notesInline(el("li"), item[1]));
        return;
      }
      list = null;
      box.appendChild(notesInline(el(head ? "h3" : "p"), head ? head[1] : line));
    });
  if (!box.childElementCount) box.appendChild(el("p", "updNone", "This release has no notes."));
}

/* ---- The update card: over the app, like the welcome card ---- */
function openUpdateCard({ rollback = false } = {}) {
  const s = updateInfo;
  if (!s || (rollback ? !s.rollback : !canUpdate(s))) return;
  closeSettings();
  if (updateCard) updateCard.overlay.remove();
  const overlay = el("div");
  overlay.id = "updateOverlay";
  overlay.innerHTML = `
    <div class="updCard" role="dialog" aria-modal="true" aria-labelledby="updCardTitle" tabindex="-1">
      <div class="updCardHead">
        <img src="${themeIcon(currentTheme(), 64)}" data-logo="64" alt="" />
        <div><h2 id="updCardTitle"></h2><div class="updCardSub"></div></div>
      </div>
      <div class="updNotes"></div>
      <div class="updChanges"></div>
      <div class="updState" role="status"></div>
      <div class="updActions">
        <button type="button" class="updPage btn btn-rect btn-ghost">Release page</button>
        <span class="updSpacer"></span>
        <button type="button" class="updLater btn btn-rect btn-ghost">Later</button>
        <button type="button" class="updGo btn btn-rect btn-primary"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const card = overlay.querySelector(".updCard");
  updateCard = { overlay, card, rollback, state: "", problem: false };
  overlay.querySelector(".updLater").addEventListener("click", closeUpdateCard);
  overlay.querySelector(".updPage").addEventListener("click", () => {
    const url = (updateInfo && ((updateInfo.latest && updateInfo.latest.url) || updateInfo.releases)) || "";
    if (url.startsWith("https://github.com/")) chrome.tabs.create({ url });
  });
  overlay.querySelector(".updGo").addEventListener("click", () => installUpdate(rollback));
  // a click on the blurred page around the card closes it (one that started in the card doesn't)
  let downOnBackdrop = false;
  overlay.addEventListener("pointerdown", (event) => (downOnBackdrop = event.target === overlay));
  overlay.addEventListener("click", (event) => downOnBackdrop && event.target === overlay && closeUpdateCard());
  // Tab goes round the card's buttons; other keys stay in the card (Space presses a button, it
  // doesn't play / pause); Esc goes on to the layers, which close it
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (event.key !== "Tab") return;
    const stops = [...overlay.querySelectorAll("button")].filter((b) => !b.disabled && b.getClientRects().length);
    if (!stops.length) return;
    const at = stops.indexOf(document.activeElement);
    event.preventDefault();
    stops[at < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
  });
  paintUpdateCard();
  card.focus({ preventScroll: true });
  if (!rollback && !s.staged && !downloadRunning(s)) downloadUpdate();
}
function closeUpdateCard() {
  if (!updateCard) return;
  removeAnimated(updateCard.overlay);
  updateCard = null;
}
addLayer({
  el: null, // its own backdrop closes it (above)
  isOpen: () => !!updateCard,
  close: closeUpdateCard,
  level: 3,
  outside: false,
});
function setUpdateCardState(text, problem = false) {
  if (!updateCard) return;
  updateCard.state = text;
  updateCard.problem = problem;
  paintUpdateCard();
}
function paintUpdateCard() {
  const { overlay, rollback } = updateCard,
    s = updateInfo,
    q = (sel) => overlay.querySelector(sel),
    go = q(".updGo"),
    changes = q(".updChanges");
  const busy = installRunning(s) || downloadRunning(s);
  changes.textContent = "";
  if (rollback) {
    q("#updCardTitle").textContent = `Back to MinimalTube ${s && s.rollback ? s.rollback.version : ""}?`;
    q(".updCardSub").textContent = `You have ${s ? s.version : loadedVersion()}`;
    renderNotes(
      q(".updNotes"),
      "The files the last update replaced are put back, and the ones it added are removed. Your " +
        "playlists, subscriptions, downloads and settings stay as they are.\n\n" +
        "MinimalTube then reloads and comes back where it was, the video paused. Automatic " +
        "updates skip this version until you update by hand.",
    );
    go.textContent = "Roll back";
    go.disabled = !s || !s.rollback || busy;
  } else {
    const latest = (s && s.latest) || {};
    q("#updCardTitle").textContent = `MinimalTube ${latest.version || ""}`;
    q(".updCardSub").textContent = [`You have ${s ? s.version : loadedVersion()}`, releasedAgo(latest)].filter(Boolean).join(" · ");
    if (q(".updNotes").dataset.version !== latest.version) {
      renderNotes(q(".updNotes"), latest.notes);
      q(".updNotes").dataset.version = latest.version || "";
    }
    const c = s && s.staged && s.staged.changes;
    if (c) {
      const lines = [changesText(c) + "."];
      if (c.edited.length)
        lines.push(`${plural(c.edited.length, "file")} you changed by hand ${c.edited.length === 1 ? "is" : "are"} replaced; a copy is kept.`);
      lines.push(
        c.restart
          ? "The server restarts; downloads pick up where they were. MinimalTube then reloads and comes back where it was, the video paused."
          : "MinimalTube then reloads and comes back where it was, the video paused.",
      );
      lines.forEach((line) => changes.appendChild(el("div", null, line)));
    }
    go.textContent = "Install";
    go.disabled = !s || !s.staged || !!s.blocked || busy;
  }
  let state = updateCard.state,
    problem = updateCard.problem;
  if (!state && s && s.download) {
    const d = s.download;
    if (d.phase === "downloading") state = `Downloading ${d.version}…`;
    else if (d.phase === "verifying") state = "Checking every file against GitHub's copy…";
    else if (d.phase === "error") [state, problem] = [`The download didn't work: ${d.error}`, true];
  }
  if (!state && s && s.blocked) [state, problem] = [s.blocked.text, true];
  q(".updState").textContent = state;
  q(".updState").classList.toggle("problem", problem);
  q(".updLater").textContent = installRunning(s) ? "Close" : "Later";
}

async function downloadUpdate() {
  try {
    updateInfo = await api("/update/download", { method: "POST", body: {} });
  } catch (err) {
    setUpdateCardState(`The download didn't start: ${firstLine(err.message)}`, true);
    return;
  }
  paintUpdates();
  for (let i = 0; i < 300 && updateCard && downloadRunning(updateInfo); i++) {
    await sleep(400);
    await loadUpdateStatus();
  }
}

// After an install or a rollback: the status's "install" with this id says how it ended. While
// the server restarts it doesn't answer; one that isn't back in time is started by the extension.
async function waitForUpdateEnd(id) {
  const ended = (s) => s && s.install && s.install.id === id && !INSTALL_RUNNING.includes(s.install.phase);
  const until = Date.now() + UPDATE_WAIT_MS;
  while (Date.now() < until) {
    await sleep(800);
    const s = await api("/update/status").catch(() => null);
    if (s) updateInfo = s;
    if (ended(s)) return s.install;
  }
  await chrome.runtime.sendMessage({ type: "minimaltube-ensure-server" }).catch(() => null);
  const s = await api("/update/status").catch(() => null);
  return ended(s) ? s.install : null;
}

/**
 * Installs the downloaded update (or goes back to the version before the last one), follows it to
 * its end and reloads the extension when it's done.
 * @param {boolean} [rollback] Roll back instead.
 */
async function installUpdate(rollback = false) {
  if (updateBusy) return;
  updateBusy = true;
  setUpdateCardState(rollback ? "Rolling back…" : "Installing…");
  paintUpdates();
  let res;
  try {
    res = await api(rollback ? "/update/rollback" : "/update/install", { method: "POST", body: {} });
  } catch (err) {
    updateBusy = false;
    setUpdateCardState(`It didn't start: ${firstLine(err.message)}`, true);
    await loadUpdateStatus();
    return;
  }
  setUpdateCardState(
    `${rollback ? "Rolling back" : "Installing"}… ${res.restart ? "The server restarts; downloads pick up where they were." : ""}`,
  );
  const end = await waitForUpdateEnd(res.id);
  updateBusy = false;
  if (end && end.phase === "done") {
    setUpdateCardState(`${rollback ? "Back on" : "Updated to"} ${res.version}. Reloading MinimalTube…`);
    await reloadForNewVersion();
    return;
  }
  await loadUpdateStatus();
  setUpdateCardState(
    end
      ? `It didn't work${end.undone ? ", and everything was put back" : ""}: ${end.error || "unknown error"}`
      : "It didn't finish in time. Restart the server in Settings, then look here again.",
    true,
  );
}

// The background reloads the extension (background/updates.js): first it asks this page to keep
// what it shows (below), then the page closes and a new player opens where this one was.
async function reloadForNewVersion() {
  const res = await chrome.runtime.sendMessage({ type: "minimaltube-reload-for-update" }).catch(() => null);
  if (res && res.ok) return;
  setUpdateCardState("Reload MinimalTube on chrome://extensions to finish the update.", true);
}

/* ---- What the player shows, kept across the reload after an update (even with "Remember
 * queue" off): the queue, the video and its place (its watch progress) ---- */
async function saveUpdateSnapshot() {
  noteWatchProgress();
  flushUndo();
  flushFeedMemory();
  await chrome.storage.local.set({
    updateSnapshot: {
      at: Date.now(),
      items: queueHasItems() ? queue.items : [],
      currentIndex: queueIndex,
      playlistId: (queue && queue.playlistId) || null,
      // a video playing beside the queue (from Downloads, or next to a playlist)
      current: currentVideoId && playSource !== "queue" ? { url: watchUrl(currentVideoId), source: playSource } : null,
      loaded: !!currentVideoId,
    },
  });
}
/** The snapshot an update's reload left, once (startup.js). @returns {Promise<object|null>} */
async function takeUpdateSnapshot() {
  const { updateSnapshot: snap } = await chrome.storage.local.get(["updateSnapshot"]);
  if (!snap) return null;
  chrome.storage.local.remove("updateSnapshot");
  return Date.now() - (snap.at || 0) < UPDATE_SNAPSHOT_MS && Array.isArray(snap.items) ? snap : null;
}
function resumeFromSnapshot(snap) {
  if (snap.items.length) restoreSavedQueue(snap);
  if (snap.current) {
    playSource = snap.current.source;
    playVideo(snap.current.url, { gentle: false, autoplay: false });
  } else if (snap.loaded && snap.items.length) resumeSavedVideo();
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || message.type !== "minimaltube-before-reload") return;
  saveUpdateSnapshot().then(
    () => respond({ ok: true }),
    (err) => respond({ ok: false, error: errorText(err) }),
  );
  return true;
});

/* ---- At start: the dot, one notice per new version, and with "Install updates automatically"
 * on, a downloaded update installs before anything plays ---- */
async function showUpdateIfAsked() {
  const { showUpdate } = await chrome.storage.local.get(["showUpdate"]);
  if (!showUpdate) return false;
  chrome.storage.local.remove("showUpdate");
  if (Date.now() - showUpdate > 60000) return false;
  if (!canUpdate(await loadUpdateStatus())) return false;
  openUpdateCard();
  return true;
}
// the popup's "update available" line
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.showUpdate && changes.showUpdate.newValue) whenLoaded(showUpdateIfAsked);
});
async function startupUpdates() {
  if (await showUpdateIfAsked()) return;
  const s = await loadUpdateStatus();
  if (!canUpdate(s)) return;
  const inst = s.install,
    failedBefore = inst && inst.phase === "failed" && inst.version === s.latest.version;
  if (s.auto && s.staged && !failedBefore && s.skipped !== s.latest.version && !location.search && video.paused) {
    openUpdateCard();
    installUpdate();
    return;
  }
  const { updateNoticeShown } = await chrome.storage.local.get(["updateNoticeShown"]);
  if (updateNoticeShown === s.latest.version) return;
  chrome.storage.local.set({ updateNoticeShown: s.latest.version });
  notify(`MinimalTube ${s.latest.version} is out: Settings → Updates`, false, 8000);
}
whenLoaded(() => setTimeout(startupUpdates, 2500));
