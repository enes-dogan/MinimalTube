// Toolbar popup: paste a URL to add it to the queue, or just open the player.
const DEFAULT_SERVER = "http://127.0.0.1:7860";

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
      `MinimalTube server isn't running at ${res?.serverBase || DEFAULT_SERVER} and couldn't be started. Run ./install.sh again.`;
    warning.style.display = "block";
    return;
  }
  window.close();
}

function openPlayer() {
  chrome.runtime.sendMessage({
    type: "minimaltube-open-window",
    playerUrl: chrome.runtime.getURL("player.html"),
  });
  window.close();
}

addBtn.addEventListener("click", addToQueue);
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addToQueue();
});
openAppBtn.addEventListener("click", openPlayer);
