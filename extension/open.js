// Where a YouTube link lands when "Open YouTube links in MinimalTube" is on (background.js sends
// it here before YouTube loads): hands the link to the app, then gets out of the way. A tab the
// link opened closes; a tab that was on another page goes back to it. When the app can't take
// the link, it opens on YouTube after all.
const link = location.hash.slice(1);

function leave() {
  if (history.length > 1) return history.back();
  chrome.tabs.getCurrent((tab) => {
    if (chrome.runtime.lastError || !tab) return window.close();
    chrome.tabs.remove(tab.id, () => chrome.runtime.lastError);
  });
}

function toYouTube(why) {
  document.getElementById("status").textContent = "Opening it on YouTube instead…";
  document.getElementById("detail").textContent = why || "";
  let url;
  try {
    url = new URL(link);
    url.searchParams.set("minimaltube", "skip"); // background.js's LINK_SKIP: lets it through
  } catch {
    return;
  }
  setTimeout(() => location.replace(url.href), why ? 1500 : 0);
}

document.getElementById("detail").textContent = link;
chrome.runtime.sendMessage({ type: "minimaltube-open-link", url: link }, (res) => {
  if (chrome.runtime.lastError) return toYouTube("MinimalTube isn't answering.");
  if (res && res.ok) return leave();
  toYouTube(res && !res.notLink ? res.error || "MinimalTube couldn't open it." : "");
});
