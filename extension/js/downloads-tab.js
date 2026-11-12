/* MinimalTube player - The Downloads tab: a card for every download, with its progress while it's on its way.
 * Loaded in order by player.html (classic scripts sharing one scope). */

const dlView = byId("dlView"),
  dlGrid = byId("dlGrid");
function paintDlBadge(badge, entry) {
  const state = entry.status;
  badge.classList.toggle("prog", isActiveEntry(entry));
  badge.textContent =
    state === "downloading"
      ? `${Math.round(entry.percent ?? 0)}%`
      : state === "merging"
        ? "Merging…"
        : state === "waiting"
          ? "Paused"
          : state === "queued"
          ? "Queued"
          : entry.duration
            ? fmtDur(entry.duration)
            : ""; // video length (the size is in the line below)
  badge.style.display = badge.textContent ? "" : "none";
}
function refreshDownloadBadges() {
  dlGrid.querySelectorAll(".vCard").forEach((card) => card._entry && card._badge && paintDlBadge(card._badge, card._entry));
}
function downloadVideoObj(entry) {
  const url = entry.url || watchUrl(entry.id);
  return {
    id: entry.id,
    title: entry.title || url,
    url,
    thumbnail: `${serverBase}/thumb/${entry.id}`,
    // stored by the server, so it also shows offline
    thumbFallback: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
    downloaded: !entry.status || entry.status === "ready",
  };
}
function playDownload(entry) {
  exitBrowse();
  playLibraryEntry(entry);
}
function makeDownloadCard(entry) {
  const v = downloadVideoObj(entry);
  const card = makeCard({
    thumb: v.thumbnail,
    fallback: v.thumbFallback,
    videoId: entry.id,
    badge: "",
    title: entry.title || `${entry.id} (looking up title…)`,
    lines: [
      isActiveEntry(entry)
        ? activeEntryText(entry)
        : ["Downloaded", fmtSize(entry.size)].filter(Boolean).join(" · "),
    ],
    open: () => playDownload(entry),
    menu: () => libraryMenuEntries(entry, { play: () => playDownload(entry) }),
    className: entry.id === currentVideoId ? "playing" : "",
  });
  card.dataset.vid = entry.id;
  card._entry = entry;
  paintDlBadge(card._badge, entry);
  return card;
}
function renderDownloadCards() {
  if (
    !document.body.classList.contains("browsing") ||
    browseTab !== "downloads"
  )
    return;
  if (bpMenu.owner && dlGrid.contains(bpMenu.owner)) closeBpMenu();
  dlGrid.innerHTML = "";
  if (!library.length) {
    dlGrid.appendChild(el("div", "bpEmpty", "No downloads yet. Use ⋮ on any video → Download, or Download all in the queue."));
    return;
  }
  library.forEach((entry) => dlGrid.appendChild(makeDownloadCard(entry)));
}
makeSortable(dlGrid, { item: ".vCard[data-vid]", scroller: browseBody, canSort: () => library.length > 1, onMove: moveLibraryItem });
