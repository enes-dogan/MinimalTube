/* MinimalTube player - The browse page and the mini player: the tabs, moving the side panel over the page, the page's
 * round buttons, back to top and the sticky bars.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Mini player + browse page (Subscriptions / Playlists / Downloads)
 *
 * The button left of fullscreen shrinks the player into a small floating
 * window (same <video>, so playback never restarts) and shows the browse page:
 * the subscriptions feed, the saved playlists and the downloads.
 * ===================================================================== */
const browseBody = byId("browseBody"),
  browseTabBtns = Array.from(document.querySelectorAll("#browseTabs button")),
  subsView = byId("subsView"),
  plView = byId("plView"),
  feedGrid = byId("feedGrid"),
  feedStatus = byId("feedStatus"),
  subAddInput = byId("subAddInput"),
  subAddBtn = byId("subAddBtn"),
  subChips = byId("subChips"),
  subFocus = byId("subFocus"),
  subsToggle = byId("subsToggle"),
  subsToggleCount = byId("subsToggleCount"),
  subImportBtn = byId("subImportBtn"),
  feedRefresh = byId("feedRefresh"),
  plGrid = byId("plGrid"),
  miniToggle = byId("miniToggle"),
  miniExpand = byId("miniExpand");
let browseTab = "subs";
// While the browse page is up, the queue panel (and the save-playlist dialog) are moved out of the
// (small / hidden) player frame so the two buttons of the browse page can open them right on
// top of the page; they go back into the player when it is expanded again.
const panelHomes = [queuePanel, byId("savePlModal")].map(
  (el) => ({
    el,
    parent: el.parentNode,
    next: el.nextSibling,
  }),
);
function floatPanels(on) {
  panelHomes.forEach(({ el, parent, next }) => {
    el.classList.toggle("bpFloat", on);
    if (on) document.body.appendChild(el);
    else
      parent.insertBefore(el, next && next.parentNode === parent ? next : null);
  });
}
const FRAME_ANIM_MS = 300;
function frameRect() {
  if (
    document.fullscreenElement ||
    playerFrame.classList.contains("empty") ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return null;
  const rect = playerFrame.getBoundingClientRect();
  return rect.width && rect.height ? rect : null;
}
function animateFrameFrom(from) {
  if (!from) return;
  const to = playerFrame.getBoundingClientRect();
  if (!to.width || !to.height) return;
  const toMini = playerFrame.classList.contains("mini");
  playerFrame.animate(
    [
      {
        transformOrigin: "top left",
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        borderRadius: toMini ? "0px" : "12px",
      },
      {
        transformOrigin: "top left",
        transform: "none",
        borderRadius: toMini ? "12px" : "0px",
      },
    ],
    { duration: FRAME_ANIM_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  );
  if (toMini)
    document.getElementById("browsePage").animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: FRAME_ANIM_MS,
      easing: "ease-out",
    });
}
function enterBrowse(noLoad) {
  const from = document.body.classList.contains("browsing") ? null : frameRect();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  closeQueuePanel();
  closeSettings();
  floatPanels(true);
  refreshWatchBars();
  closeDesc();
  closeRowMenu();
  document.body.classList.add("browsing");
  playerFrame.classList.add("mini");
  playerFrame.classList.remove("idle");
  animateFrameFrom(from);
  if (noLoad !== true) setBrowseTab(browseTab);
}
function exitBrowse() {
  playerFrame.classList.remove("tucked");
  const from = document.body.classList.contains("browsing") ? frameRect() : null;
  closeBpMenu();
  closeQueuePanel();
  closeSettings();
  floatPanels(false);
  document.body.classList.remove("browsing");
  playerFrame.classList.remove("mini");
  animateFrameFrom(from);
}
miniToggle.addEventListener("click", () => enterBrowse());
miniExpand.addEventListener("click", exitBrowse);
// Don't let a click on the mini window's buttons also toggle play/pause.
miniExpand.addEventListener("dblclick", (event) => event.stopPropagation());
// Each tab keeps its own place on the page: they share one scrolling area
const tabScroll = {};
function setBrowseTab(tab) {
  if (tab !== "playlists") closePlaylistPage();
  const switching = tab !== browseTab;
  if (switching) tabScroll[browseTab] = browseBody.scrollTop;
  browseTab = tab;
  browseTabBtns.forEach((item) =>
    item.classList.toggle("active", item.dataset.tab === tab),
  );
  subsView.classList.toggle("active", tab === "subs");
  plView.classList.toggle("active", tab === "playlists");
  dlView.classList.toggle("active", tab === "downloads");
  closeBpMenu();
  if (tab === "subs") {
    feedMemoryReady.then(() => feedState.loaded || showFeed(false)); // before the server answers
    loadSubscriptions().then(() => showFeed());
  } else if (tab === "playlists") {
    renderPlaylistCards();
    loadSavedPlaylists();
  } else {
    renderDownloadCards();
    refreshLibrary(); // refresh the list from the server
  }
  if (switching) browseBody.scrollTop = tabScroll[tab] || 0;
}
browseTabBtns.forEach((item) =>
  item.addEventListener("click", () => {
    if (item.dataset.tab === "playlists" && browseTab === "playlists")
      closePlaylistPage();
    setBrowseTab(item.dataset.tab);
  }),
);

/* ---------- "Back to top": past about five rows of cards, scrolls the page back up ---------- */
const backToTop = byId("backToTop"),
  BACK_TO_TOP_ROWS = 5;
let backToTopFrame = 0;
function cardRowHeight() {
  const card = [...browseBody.querySelectorAll(".bpView.active .vCard")].find((c) => c.offsetHeight);
  if (!card) return 280;
  return card.offsetHeight + (parseFloat(getComputedStyle(card.parentElement).rowGap) || 0);
}
browseBody.addEventListener(
  "scroll",
  () => {
    if (backToTopFrame) return;
    backToTopFrame = requestAnimationFrame(() => {
      backToTopFrame = 0;
      browseBody.classList.toggle("scrolled", browseBody.scrollTop > 0); // the sticky bars' shadow
      backToTop.classList.toggle("show", browseBody.scrollTop > BACK_TO_TOP_ROWS * cardRowHeight());
    });
  },
  { passive: true },
);
// the sticky bar's real height (it wraps on a narrow window), for browse.css's scroll-padding
const stickyBars = [byId("subsBar"), byId("plHead")],
  stickyBarsSize = new ResizeObserver(() =>
    browseBody.style.setProperty("--stickyH", `${Math.max(...stickyBars.map((bar) => bar.offsetHeight))}px`),
  );
stickyBars.forEach((bar) => stickyBarsSize.observe(bar));
backToTop.addEventListener("click", () => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  browseBody.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
});

// Queue / settings are one click away from the browse page.
// They open the side panels on top of the page the user is on (no switch to the player).
const bpQueueBtn = byId("bpQueueBtn"),
  bpSettingsBtn = byId("bpSettingsBtn");
function setBpTop() {
  document.documentElement.style.setProperty(
    "--bpTop",
    `${byId("browseTop").offsetHeight}px`,
  );
}
window.addEventListener("resize", setBpTop);
bpQueueBtn.addEventListener("click", () => {
  setBpTop();
  closeSettings();
  queueToggleBtn.click();
});
bpSettingsBtn.addEventListener("click", () => {
  setBpTop();
  closeQueuePanel();
  gearBtn.click();
});
const syncBpButtons = () => {
  resetStrayScroll();
  bpQueueBtn.classList.toggle("active", queuePanel.classList.contains("open"));
  const queueOpen =
    queuePanel.classList.contains("open") &&
    document.body.classList.contains("browsing");
  if (queueOpen)
    document.documentElement.style.setProperty(
      "--bpQueueW",
      `${queuePanel.offsetWidth}px`,
    );
  document.body.classList.toggle("queueOpen", queueOpen);
  bpSettingsBtn.classList.toggle(
    "active",
    settingsPanel.classList.contains("open"),
  );
};
[queuePanel, settingsPanel].forEach((el) =>
  new MutationObserver(syncBpButtons).observe(el, {
    attributes: true,
    attributeFilter: ["class"],
  }),
);
byId("placeholderBrowse").addEventListener("click", () => enterBrowse());

/* ---------- the mini player's own buttons ---------- */
function toggleMiniPlayer() {
  if (document.body.classList.contains("browsing")) {
    if (!playerFrame.classList.contains("empty")) exitBrowse(); // nothing to restore if nothing was played
  } else enterBrowse();
}
// Close the mini player: it fades and shrinks away, then playback stops. The queue and its
// position are kept, so Shift+N / playing something again carries on from there.
const miniClose = byId("miniClose");
function closeMiniPlayer() {
  if (
    !playerFrame.classList.contains("mini") ||
    playerFrame.classList.contains("closing")
  )
    return;
  playerFrame.classList.add("closing");
  setTimeout(() => {
    const keepW = queueIndex,
      keepSource = playSource;
    stopPlayback(); // pauses, empties the video, hides the (now empty) mini window
    queueIndex = keepW;
    playSource = keepSource;
    playerFrame.classList.remove("closing");
  }, 240);
}
miniClose.addEventListener("click", closeMiniPlayer);
// Tucked away at the window's right edge, still playing; the tab left there brings it back
const miniTuck = byId("miniTuck");
miniTuck.addEventListener("click", (event) => {
  event.stopPropagation(); // not the mini window's own click (play / pause)
  playerFrame.classList.add("tucked");
});
miniTuck.addEventListener("dblclick", (event) => event.stopPropagation());
byId("miniUntuck").addEventListener("click", () => playerFrame.classList.remove("tucked"));
