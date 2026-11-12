/* MinimalTube player - The side panel: its two sections (Queue, Downloads), their rows, the rows' download
 * progress, and the Downloads list itself (`library`), which other parts of the app read too.
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
        Object.entries(sectionEls).map(([name, section]) => [name, section.classList.contains("collapsed")]),
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
chrome.storage.local.get(["collapsedSections"], (stored) =>
  whenLoaded(() => {
    const collapsed = stored.collapsedSections || {};
    Object.keys(sectionEls).forEach((name) => collapsed[name] && setSectionCollapsed(name, true, false));
  }),
);

// Video lengths for the side panel rows: from the item itself, else asked from the server
// (it knows the length of anything prepared / downloaded before).
const durCache = new Map(),
  durAsked = new Map();
function rowDuration(item) {
  return item.duration || durCache.get(item.id || itemVideoId(item)) || 0;
}
function wantDurations(items) {
  const now = Date.now(),
    ids = [];
  items.forEach((item) => {
    const id = item.id || itemVideoId(item);
    if (!id || item.duration || durCache.has(id)) return;
    if (now - (durAsked.get(id) || 0) < 3000) return;
    durAsked.set(id, now);
    ids.push(id);
  });
  if (!ids.length) return;
  api(`/durations?ids=${ids.slice(0, 200).join(",")}`)
    .then((response) => {
      let found = false;
      Object.entries((response && response.durations) || {}).forEach(
        ([id, sec]) => {
          if (sec > 0) {
            durCache.set(id, sec);
            found = true;
          }
        },
      );
      if (response && response.pending)
        setTimeout(() => {
          if (queue) wantDurations(queue.items);
        }, 4000); // still being looked up
      if (found) {
        // refresh the labels in place (no re-render, so open menus / drags are left alone)
        document.querySelectorAll(".plItem").forEach((row) => {
          const shown = row._item || row._entry,
            durEl = row.querySelector(".plDur");
          if (shown && durEl && !durEl.textContent) paintDur(durEl, rowDuration(shown));
        });
      }
    })
    .catch((err) => logQuiet("durations", err));
}
function paintDur(durEl, sec) {
  durEl.textContent = sec > 0 ? fmtDur(sec) : "";
}
function makePlBadges(item) {
  const box = el("div", "plBadges");
  paintDur(box.appendChild(el("div", "plDur")), rowDuration(item));
  return box;
}
function makeRow({ videoId, index, badges, title, pending, sub, active, className, menu, onClick }) {
  const row = el("div", "plItem" + (className ? ` ${className}` : "") + (active ? " active" : ""));
  const thumb = makePlThumb(videoId);
  thumb.append(el("div", "plIndex", index), badges);
  const titleEl = el("div", "plTitle" + (pending ? " pending" : ""), title);
  titleEl.title = title;
  const text = el("div", "plText");
  text.appendChild(titleEl);
  if (sub != null) text.appendChild(el("div", "plSub", sub));
  row.append(thumb, text, menuButton(rowMenu, "plMenuBtn", menu, () => row), makeGrip());
  row.addEventListener("click", onClick);
  return row;
}
function makePlThumb(id) {
  const thumb = el("div", "plThumb");
  if (id) {
    thumb.dataset.vid = id;
    paintWatch(thumb);
    thumb.appendChild(makeThumbImg(`${serverBase}/thumb/${id}`, `https://i.ytimg.com/vi/${id}/mqdefault.jpg`));
  }
  return thumb;
}
function makeGrip() {
  const grip = el("div", "plGrip");
  grip.title = "Drag to reorder";
  grip.innerHTML = ICON_GRIP;
  // The click that follows a drag/press on the grip must not play the row.
  grip.addEventListener("click", (event) => event.stopPropagation());
  return grip;
}
function renderQueue() {
  // something new in the queue makes "Queue cleared" final (an Undo would have to mix the two)
  if (queueHasItems() && pendingUndo && pendingUndo.kind === "queue-clear") flushUndo();
  updateSkipButtons();
  const linked = queue && queue.playlistId ? savedPlaylists.find((playlist) => playlist.id === queue.playlistId) : null;
  queuePlName.textContent = linked ? linked.name : "";
  queuePlName.title = linked ? `Playing the playlist "${linked.name}"` : "";
  document.getElementById("queueEmpty").hidden = queueHasItems();
  closeRowMenu();
  queueList.innerHTML = "";
  queueSection.style.display = queueHasItems() ? "flex" : "none";
  if (!queueHasItems()) return;
  queue.items.forEach((item, idx) => {
    const status = el("div", "plStatus");
    paintStatus(status, videoJob(itemVideoId(item)));
    const badges = makePlBadges(item);
    badges.appendChild(status); // the tick / percent sits right of the length
    const row = makeRow({
      videoId: itemVideoId(item),
      index: item.index,
      badges,
      title: item.title,
      active: idx === queueIndex,
      menu: () => queueMenuEntries(item),
      onClick: () => playQueueItem(idx),
    });
    row._item = item;
    row._status = status;
    queueList.appendChild(row);
  });
  wantDurations(queue.items);
}
// A row's download state: ✓ downloaded, a percentage, ⏳ merging, … queued, ⏸ waiting for the
// connection, nothing otherwise.
function paintStatus(statusEl, job) {
  const status = job ? job.status : null,
    text =
      status === "downloading"
        ? `${Math.round(job.percent ?? 0)}%`
        : { ready: "✓", merging: "⏳", queued: "…", waiting: "⏸" }[status] || "",
    look = status === "ready" ? "ready" : status === "downloading" || status === "merging" ? "downloading" : "";
  if (statusEl._shown === text + look) return; // most rows are the same at every tick
  statusEl._shown = text + look;
  statusEl.textContent = text;
  statusEl.classList.toggle("ready", look === "ready");
  statusEl.classList.toggle("downloading", look === "downloading");
}
const queueRowOf = (item) => Array.from(queueList.children).find((row) => row._item === item);
// The rows' ticks and percentages follow the server's state (jobs.js) and the Downloads list.
function paintQueueStatuses() {
  for (const row of queueList.children)
    if (row._status) paintStatus(row._status, videoJob(itemVideoId(row._item)));
}
function updateSkipButtons() {
  const inQueue =
    playSource === "queue" && queue && queueIndex >= 0 && currentVideoId;
  prevBtn.style.display = inQueue && queueIndex > 0 ? "" : "none";
  nextBtn.style.display =
    (inQueue && queueIndex < queue.items.length - 1) || (playSource === "detour" && resolveNext())
      ? ""
      : "none";
}
function markActiveQueueRow() {
  updateSkipButtons();
  queueList.querySelectorAll(".plItem").forEach((row, index) => row.classList.toggle("active", index === queueIndex));
}
function scrollActiveQueueRowIntoView() {
  const row = queueList.children[queueIndex];
  if (!row) return;
  const list = queueList.getBoundingClientRect(),
    rect = row.getBoundingClientRect();
  if (rect.top < list.top) queueList.scrollTop += rect.top - list.top;
  else if (rect.bottom > list.bottom)
    queueList.scrollTop += rect.bottom - list.bottom;
}
function closeQueuePanel() {
  closeSaveToMenu();
  queuePanel.classList.remove("open");
  queueToggleBtn.classList.remove("active");
}
queueToggleBtn.addEventListener("click", () => {
  if (queuePanel.classList.contains("open")) closeQueuePanel();
  else {
    queuePanel.classList.add("open");
    queueToggleBtn.classList.add("active");
    refreshLibrary();
  }
});
addLayer({
  el: queuePanel,
  isOpen: () => queuePanel.classList.contains("open"),
  close: closeQueuePanel,
  inside: [queueToggleBtn, "#bpQueueBtn", "#savePlModal"],
});
/* ---- The Downloads list ----
 * `library` is the server's list (GET /library): every downloaded video, and the ones on their
 * way. It is loaded again whenever the server's revision of it (jobs.js: serverLibraryRev)
 * differs from the one this copy was made from. */
let library = [],
  libraryKey = null, // what the drawn list was made from (null: nothing loaded yet)
  libraryRev = null, // the server's revision of the loaded list
  libraryLoading = false,
  libEpoch = 0, // bumped when the list is changed here: an answer already on its way is dropped
  downloadedIds = new Set(); // the ids in `library` that are fully downloaded
const isDownloadedId = (id) => downloadedIds.has(id);
function setLibrary(items) {
  libEpoch++;
  library = items;
  libraryKey = libKey(items);
  downloadedIds = new Set(items.filter((entry) => !isActiveEntry(entry)).map((entry) => entry.id));
  renderLibrary();
  paintQueueStatuses();
}
function libKey(list) {
  return list
    .map(
      (entry) =>
        `${entry.id}\t${entry.title || ""}\t${entry.status || ""}\t${entry.duration || ""}`,
    )
    .join("\n");
}
const isActiveEntry = (entry) => !!entry.status && entry.status !== "ready";
const activeEntryText = (entry) =>
  entry.status === "queued"
    ? "Waiting to download"
    : entry.status === "waiting"
      ? "Waiting for internet connection"
      : "Downloading…";
// After every answer of the state loop: progress stays live in the Downloads rows and cards, and
// a download that started (or went away) since the list was loaded loads the list again.
let lastLibSync = 0;
function syncLibraryDownloads() {
  const known = new Set(library.map((entry) => entry.id));
  let stale = [...activeDownloads.keys()].some((id) => !known.has(id));
  libraryList.querySelectorAll(".libItem").forEach((row) => {
    const entry = row._entry;
    if (!entry || !isActiveEntry(entry)) return;
    const live = activeDownloads.get(entry.id);
    if (!live) return void (stale = true); // finished (or was cancelled): the row is redrawn
    entry.status = live.status;
    entry.percent = live.percent;
    const statusEl = row.querySelector(".plStatus");
    if (statusEl) paintStatus(statusEl, entry);
  });
  refreshDownloadBadges();
  if (stale && Date.now() - lastLibSync > 1500) {
    lastLibSync = Date.now();
    refreshLibrary();
  }
}
whenStateChanges(() => {
  if (queuePanel.classList.contains("open") || document.body.classList.contains("browsing")) syncLibraryDownloads();
  if (serverLibraryRev !== libraryRev) refreshLibrary(); // a download finished, a file is gone
  paintQueueStatuses();
});
async function refreshLibrary() {
  if (libraryLoading || sortDragging || menuIsOpen(rowMenu)) return;
  const epoch = libEpoch;
  libraryLoading = true;
  try {
    const data = await api("/library"),
      items = (Array.isArray(data.items) ? data.items : []).filter((item) => !hiddenDeletes.has(item.id));
    // changed here meanwhile, or in use: this answer is dropped, the next state answer asks again
    if (epoch !== libEpoch || sortDragging || menuIsOpen(rowMenu)) return;
    libraryRev = data.rev ?? null;
    if (libKey(items) !== libraryKey) setLibrary(items);
  } catch (err) {
    logQuiet("Downloads list", err);
  } finally {
    libraryLoading = false;
  }
}
// The list from scratch, whatever this copy holds (after something was deleted on the server).
function reloadLibrary() {
  libraryKey = null;
  refreshLibrary();
}
function renderLibrary() {
  renderLibraryPanel();
  try {
    renderDownloadCards();
  } catch (err) {
    logQuiet("Downloads tab", err);
  }
  try {
    refreshFeedDownloadedFlags();
  } catch (err) {
    logQuiet("downloaded badges in the feed", err);
  }
}
function renderLibraryPanel() {
  closeRowMenu();
  libraryCount.textContent = library.length ? String(library.length) : "";
  libraryList.innerHTML = "";
  if (!library.length) return void libraryList.appendChild(el("div", "libEmpty", "No downloads yet."));
  library.forEach((entry, index) => {
    const badges = makePlBadges(entry);
    if (isActiveEntry(entry)) {
      const progress = el("div", "plStatus");
      paintStatus(progress, entry);
      badges.appendChild(progress);
    }
    const row = makeRow({
      videoId: entry.id,
      index: String(index + 1),
      badges,
      title: entry.title || `${entry.id} (looking up title…)`,
      pending: !entry.title,
      sub: isActiveEntry(entry) ? activeEntryText(entry) : fmtSize(entry.size),
      active: entry.id === currentVideoId,
      className: "libItem",
      menu: () => libraryMenuEntries(entry),
      onClick: () => playLibraryEntry(entry),
    });
    row.dataset.vid = entry.id;
    row._entry = entry;
    libraryList.appendChild(row);
  });
}
function markActiveLibraryRow() {
  updateSkipButtons();
  libraryList.querySelectorAll(".libItem").forEach((row) => row.classList.toggle("active", row.dataset.vid === currentVideoId));
}
function moveLibraryItem(from, to) {
  const [moved] = library.splice(from, 1);
  library.splice(to, 0, moved);
  libEpoch++;
  libraryKey = libKey(library);
  renderLibrary();
  api("/library/order", { method: "POST", body: { ids: library.map((entry) => entry.id) } }).catch(
    (err) => notify(`Couldn't save the new order: ${netMessage(firstLine(err.message))}`, true, 3000),
  );
}
makeSortable(queueList, { item: ".plItem", handle: ".plGrip", onMove: moveQueueItem });
makeSortable(libraryList, { item: ".plItem", handle: ".plGrip", onMove: moveLibraryItem });
