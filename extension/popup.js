// Toolbar popup: paste a URL to add it to the queue, or just open the player.
// (js/common.js, loaded before this file, has DEFAULT_SERVER and INSTALLER.)

const urlInput = document.getElementById("url");
const addBtn = document.getElementById("play");
const openAppBtn = document.getElementById("openApp");
const warning = document.getElementById("serverWarning");

async function addToQueue() {
  const url = urlInput.value.trim();
  if (!url) return;

  warning.style.display = "none";
  addBtn.disabled = true;
  addBtn.textContent = "Adding…";

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "minimaltube-queue-add",
      url,
    });
  } catch {
    res = { ok: false, serverBase: DEFAULT_SERVER };
  }

  addBtn.disabled = false;
  addBtn.textContent = "Add to Queue";

  if (!res || !res.ok) {
    warning.textContent =
      res?.error ||
      `MinimalTube server isn't running at ${res?.serverBase || DEFAULT_SERVER} and couldn't be started. Run MinimalTube's installer again (${INSTALLER}).`;
    warning.style.display = "block";
    return;
  }
  window.close();
}

// An open player (window or tab) is brought forward; otherwise one opens the way the button says.
function openPlayer(style) {
  chrome.runtime.sendMessage({
    type: "minimaltube-open-window",
    playerUrl: chrome.runtime.getURL("player.html"),
    style,
  });
  window.close();
}

addBtn.addEventListener("click", addToQueue);
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addToQueue();
});
openAppBtn.addEventListener("click", () => openPlayer("window"));
document.getElementById("openTab").addEventListener("click", () => openPlayer("tab"));

// A newer MinimalTube is out (the server checks GitHub): the player opens with its update card.
const updateLine = document.getElementById("updateLine");
(async () => {
  const { serverBase } = await chrome.storage.local.get(["serverBase"]);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${serverBase || DEFAULT_SERVER}/update/status`, { signal: ctrl.signal });
    const status = await res.json();
    if (!status.available || status.blocked || !status.latest) return;
    updateLine.textContent = `MinimalTube ${status.latest.version} is out: update`;
    updateLine.hidden = false;
  } catch {} // no server, or one from before updates: nothing to show
})();
updateLine.addEventListener("click", async () => {
  await chrome.storage.local.set({ showUpdate: Date.now() });
  chrome.runtime.sendMessage({ type: "minimaltube-open-window", playerUrl: chrome.runtime.getURL("player.html") });
  window.close();
});
