/* MinimalTube player - The keyboard shortcuts overlay and the welcome screen.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Keyboard shortcuts overlay (the "i" button in the settings panel)
 * ===================================================================== */
const SHORTCUT_LIST = [
  [["Space"], "Play / pause"],
  [["←", "→"], "Back / forward 5 s"],
  [["1", "…", "9"], "Jump to 10 … 90 %"],
  [["0"], "Jump to the end"],
  [["↑", "↓"], "Volume ±5 %"],
  [["M"], "Mute"],
  [["C"], "Captions on / off"],
  [["[", "]", "\\"], "Speed −/+ 0.1×, back to 1×"],
  [["F"], "Fullscreen (or double-click the video)"],
  [["I"], "Mini player ↔ browse page"],
  [["T"], "Queue & downloads panel"],
  [["Shift", "N"], "Next video"],
  [["Shift", "B"], "Previous video"],
  [["Esc"], "Close panels and popups, cancel Up next"],
  [["U"], "Undo a delete, removal or Clear queue (while its bar shows)"],
  [["Right-click"], "A video or row opens its ⋮ menu"],
  "Lists: videos, playlists, downloads, channels, the queue",
  [["Tab"], "Next area; on the browse page the first Tab skips to the videos"],
  [["←", "↑", "→", "↓"], "Move between items"],
  [["Enter"], "Play / open the focused item"],
  [[".", "Menu"], "Its ⋮ menu (↑ ↓ and Enter inside it)"],
  [["Del"], "Remove it (videos stay in Undo for 5 s)"],
];
const SHORTCUT_CALLOUTS = [
  { el: () => playPauseBtn, keys: ["Space"], text: "Play / pause", row: 0, align: "left" },
  { el: () => prevBtn, keys: ["Shift", "B"], text: "Previous video", row: 1, align: "left" },
  { el: () => nextBtn, keys: ["Shift", "N"], text: "Next video", row: 2, align: "left" },
  { el: () => seekWrap, keys: ["←", "→", "1–9", "0"], text: "Seek ±5 s, jump 10–90 %, end", row: 0, align: "center" },
  { el: () => captionsBtn, keys: ["C"], text: "Captions", row: 4, align: "right" },
  { el: () => speedBadge, keys: ["[", "]", "\\"], text: "Speed", row: 3, align: "right" },
  { el: () => volumeIcon, keys: ["↑", "↓", "M"], text: "Volume, mute", row: 2, align: "right" },
  { el: () => miniToggle, keys: ["I"], text: "Mini player", row: 1, align: "right" },
  { el: () => fullscreenBtn, keys: ["F"], text: "Fullscreen", row: 0, align: "right" },
];
const CALLOUT_ROW_H = 44,
  CALLOUT_GAP = 22;
let helpState = null;

function keyChips(keys) {
  return keys
    .map((key) => (key === "…" ? "<span class='helpDots'>…</span>" : `<kbd class="kbd">${key}</kbd>`))
    .join("");
}
function renderShortcutHelp() {
  const overlay = helpState && helpState.overlay;
  if (!overlay) return;
  overlay.innerHTML = "";
  const box = overlay.getBoundingClientRect();
  const controlsTop = controls.getBoundingClientRect().top - box.top;
  const add = (cls, style, html = "") => {
    const el = document.createElement("div");
    el.className = cls;
    Object.assign(el.style, style);
    el.innerHTML = html;
    overlay.appendChild(el);
    return el;
  };
  SHORTCUT_CALLOUTS.forEach((c) => {
    const target = c.el();
    const r = target && target.getBoundingClientRect();
    if (!r || !r.width) return;
    const cx = r.left + r.width / 2 - box.left,
      tipY = r.top - box.top - 4,
      labelBottom = controlsTop - CALLOUT_GAP - c.row * CALLOUT_ROW_H;
    add("helpLine", {
      left: `${cx}px`,
      top: `${labelBottom}px`,
      height: `${Math.max(0, tipY - labelBottom)}px`,
    });
    const label = add(
      "helpLabel",
      { bottom: `${box.height - labelBottom}px` },
      `${keyChips(c.keys)}<span>${c.text}</span>`,
    );
    if (c.align === "center") {
      label.style.left = `${cx}px`;
      label.style.transform = "translateX(-50%)";
    } else if (c.align === "left") label.style.left = `${Math.max(8, cx - 14)}px`;
    else label.style.right = `${Math.max(8, box.width - cx - 14)}px`;
  });
  const queueBtn = queueToggleBtn.getBoundingClientRect();
  if (queueBtn.width) {
    const y = queueBtn.top + queueBtn.height / 2 - box.top,
      right = box.width - (queueBtn.left - box.left) + 6;
    add("helpLine helpLineH", { top: `${y}px`, right: `${right}px`, width: "26px" });
    add(
      "helpLabel",
      { top: `${y}px`, right: `${right + 26}px`, transform: "translateY(-50%)" },
      `${keyChips(["T"])}<span>Queue & downloads</span>`,
    );
  }
  const cardTop = 84,
    cardMax = controlsTop - CALLOUT_GAP - 5 * CALLOUT_ROW_H - 12 - cardTop;
  add(
    "helpCard",
    { top: `${cardTop}px`, maxHeight: `${Math.max(150, cardMax)}px` },
    `<div class="helpTitle">Keyboard shortcuts</div><div class="helpGrid">${SHORTCUT_LIST.map(
      (row) =>
        typeof row === "string"
          ? `<div class="helpSection">${row}</div>`
          : `<div class="helpKeys">${keyChips(row[0])}</div><div>${row[1]}</div>`,
    ).join("")}</div><div class="helpHint">Click anywhere or press any key to close</div>`,
  );
}
function openShortcutHelp() {
  if (helpState) return;
  helpState = {
    browsing: document.body.classList.contains("browsing"),
    empty: playerFrame.classList.contains("empty"),
    controlsDisplay: controls.style.display,
    captionsDisplay: captionsBtn.style.display,
    queueOpen: queuePanel.classList.contains("open"),
  };
  closeSettings();
  closeQueuePanel();
  if (helpState.browsing) exitBrowse();
  playerFrame.classList.remove("empty", "idle");
  controls.style.display = "flex";
  captionsBtn.style.display = "flex";
  playerFrame.classList.add("helpOpen");
  helpState.overlay = document.createElement("div");
  helpState.overlay.id = "shortcutHelp";
  document.getElementById("stage").appendChild(helpState.overlay);
  setTimeout(renderShortcutHelp, helpState.browsing ? FRAME_ANIM_MS + 20 : 0);
  setTimeout(() => {
    document.addEventListener("pointerdown", closeShortcutHelp, true);
    document.addEventListener("keydown", closeShortcutHelp, true);
  }, 0);
  window.addEventListener("resize", renderShortcutHelp);
}
function swallowClick(event) {
  event.preventDefault();
  event.stopPropagation();
}
function closeShortcutHelp(event) {
  const state = helpState;
  if (!state) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.type === "pointerdown") {
    document.addEventListener("click", swallowClick, { capture: true, once: true });
    setTimeout(
      () => document.removeEventListener("click", swallowClick, true),
      600,
    );
  }
  document.removeEventListener("pointerdown", closeShortcutHelp, true);
  document.removeEventListener("keydown", closeShortcutHelp, true);
  window.removeEventListener("resize", renderShortcutHelp);
  helpState = null;
  state.overlay.remove();
  playerFrame.classList.remove("helpOpen");
  controls.style.display = state.controlsDisplay;
  captionsBtn.style.display = state.captionsDisplay;
  if (state.empty) playerFrame.classList.add("empty");
  if (state.browsing) enterBrowse(true);
  if (state.queueOpen) {
    queuePanel.classList.add("open");
    queueToggleBtn.classList.add("active");
  }
  resetIdleTimer();
}
document.getElementById("shortcutsBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  openShortcutHelp();
});

/* =====================================================================
 * Welcome: how MinimalTube works, then the keyboard shortcuts. Shown once, on the first start
 * with nothing in it yet (no subscriptions, playlists or downloads); the ★ button in Settings
 * opens it again.
 * ===================================================================== */
const WELCOME_FEATURES = [
  ["▶", "Watch without the noise", "Any YouTube video plays here ad-free, downloaded in the best quality so it's yours offline. On youtube.com, right-click a video or link → <b>Add to MinimalTube queue</b>, or paste a link in Settings."],
  ["◉", "Your subscriptions", "Add a channel on the Subscriptions tab with its @handle or link. New uploads from all of them arrive in one feed, newest first; click a purple channel name to see only that channel."],
  ["☰", "Queue and playlists", "⋮ → <b>Add next to queue</b> lines videos up; drag to reorder, Back / Next move through it. Save the queue as a playlist with <b>+</b>, or any video with ⋮ → <b>Save to playlist</b>."],
  ["⟳", "Synced with YouTube", "Save one of your own playlists from its page on youtube.com and it stays two-way synced: changes on either side show up on the other. Finished videos can go to your YouTube history (Settings)."],
  ["⬇", "Downloads", "Everything you watched is on the Downloads tab and plays offline. Delete a file, a playlist or remove a video from a list, or clear the queue; the bar in the corner (or <b>U</b>) undoes it for 5 seconds."],
  ["⚡", "Instant start", "Settings → <b>Stream while downloading</b> starts videos in a second while they download; <b>Stream only</b> just streams, at up to 1080p, without keeping a copy."],
  ["⏱", "Picks up where you left off", "Videos resume where you stopped, with progress bars on every thumbnail. Captions in the video's own language, SponsorBlock skipping and chapters come along."],
  ["⌨", "Made for the keyboard", "Every list works with Tab, the arrow keys and Enter; every ⋮ menu has letter keys. The shortcuts come next."],
];
let welcomeEl = null;
function showWelcome({ then } = {}) {
  if (welcomeEl) return;
  welcomeEl = document.createElement("div");
  welcomeEl.id = "welcome";
  welcomeEl.innerHTML = `
    <div class="welcomeCard" role="dialog" aria-labelledby="welcomeTitle">
      <div class="welcomeHead">
        <img src="icons/icon256.png" alt="" />
        <div>
          <h1 id="welcomeTitle">Welcome to MinimalTube</h1>
          <p>YouTube without the noise: your subscriptions, playlists and downloads in one calm player.</p>
        </div>
      </div>
      <ul class="welcomeList">${WELCOME_FEATURES.map(
        ([icon, title, text]) =>
          `<li><span class="welcomeIcon">${icon}</span><div><b>${title}</b><span>${text}</span></div></li>`,
      ).join("")}</ul>
      <div class="welcomeActions">
        <button type="button" class="welcomeSkip btn btn-rect btn-ghost">${then ? "Skip" : "Close"}</button>
        <button type="button" class="welcomeNext btn btn-rect btn-primary">${then ? "Next: keyboard shortcuts" : "Got it"}</button>
      </div>
    </div>`;
  document.body.appendChild(welcomeEl);
  const close = (next) => {
    if (!welcomeEl) return;
    welcomeEl.remove();
    welcomeEl = null;
    document.removeEventListener("keydown", onKey, true);
    chrome.storage.local.set({ welcomeSeen: true });
    if (next && then) then();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close(false);
    else if (event.key === "Enter" && !event.target.closest(".welcomeSkip")) close(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  welcomeEl.querySelector(".welcomeSkip").addEventListener("click", () => close(false));
  welcomeEl.querySelector(".welcomeNext").addEventListener("click", () => close(true));
  document.addEventListener("keydown", onKey, true);
  welcomeEl.querySelector(".welcomeNext").focus({ preventScroll: true });
}
// First start: the server is up and there's nothing in the app yet. Anyone who already has
// subscriptions, playlists or downloads never sees it.
async function maybeWelcome(triesLeft = 20) {
  const { welcomeSeen } = await chrome.storage.local.get(["welcomeSeen"]);
  if (welcomeSeen) return;
  let lists;
  try {
    lists = await Promise.all(
      ["subscriptions", "playlists", "library"].map((path) => api(`/${path}`)),
    );
  } catch {
    if (triesLeft > 0) setTimeout(() => maybeWelcome(triesLeft - 1), 1500); // server starting
    return;
  }
  const [subs, pls, lib] = lists;
  const empty =
    !(subs.subscriptions || []).length && !(pls.playlists || []).length && !(lib.items || []).length;
  if (!empty) return chrome.storage.local.set({ welcomeSeen: true });
  showWelcome({ then: openShortcutHelp });
}
document.getElementById("welcomeBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  closeSettings();
  showWelcome();
});

prevBtn.addEventListener("click", () => skipVideo(-1));
nextBtn.addEventListener("click", () => skipVideo(1));
