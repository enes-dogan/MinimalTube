/* MinimalTube background - the player: there is only one, as its own window or in a browser tab.
 * Finding it, bringing it forward, moving it between the two, opening it, handing it something.
 * Loaded by background.js (importScripts: one scope with the other background files). */

const PLAYER_URL = chrome.runtime.getURL("player.html");

// Default window size: a 16:9 page 3/4 as wide as the main screen, plus the title bar. The player
// (js/startup.js) works that out from the real screen and stores it under "windowSize"; this
// fixed value is only the fallback until the player has run once.
const DEFAULT_WINDOW = { width: 1280, height: 750 };

async function getWindowSize() {
  try {
    const { windowSize } = await chrome.storage.local.get(["windowSize"]);
    const w = Math.round(Number(windowSize && windowSize.width));
    const h = Math.round(Number(windowSize && windowSize.height));
    if (w >= 400 && h >= 300) {
      const size = { width: w, height: h };
      // where the player put its window last (the middle of the main screen), so it opens there
      if (Number.isFinite(windowSize.left) && Number.isFinite(windowSize.top))
        Object.assign(size, { left: Math.round(windowSize.left), top: Math.round(windowSize.top) });
      return size;
    }
  } catch (err) {
    logQuiet("window size", err);
  }
  return DEFAULT_WINDOW;
}

const playerTabs = () => chrome.tabs.query({ url: PLAYER_URL + "*" });

async function findPlayerTab() {
  try {
    return (await playerTabs())[0] || null;
  } catch (err) {
    logQuiet("find the player", err);
    return null;
  }
}

// The player brought forward: its tab (it may be one of many in a browser window) and its window.
async function showPlayer(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

const styleOf = (win) => (win.type === "normal" ? "tab" : "window");
const browserWindow = async () => {
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  return win && win.type === "normal" ? win : null;
};

/**
 * Moves the running player into its own app window or into a browser tab. The page itself moves
 * (Chromium doesn't reload it), so whatever plays keeps playing and nothing is lost.
 * @param {chrome.tabs.Tab} tab The player's tab.
 * @param {"window"|"tab"} style Where it goes; already there, it's just brought forward.
 * @returns {Promise<"window"|"tab">} Where it is now (also remembered as "playerStyle").
 */
async function movePlayer(tab, style) {
  const from = await chrome.windows.get(tab.windowId);
  if (styleOf(from) !== style) {
    if (style === "window") {
      await chrome.windows.create({ tabId: tab.id, type: "popup", focused: true, ...(await getWindowSize()) });
    } else {
      const browser = await browserWindow();
      if (browser) await chrome.tabs.move(tab.id, { windowId: browser.id, index: -1 });
      else await chrome.windows.create({ tabId: tab.id, type: "normal", focused: true }); // no browser window open
    }
  }
  await showPlayer(await chrome.tabs.get(tab.id));
  await chrome.storage.local.set({ playerStyle: style });
  return style;
}

/**
 * Shows the player with `url` loaded: the one already open if there is one (it's only reloaded
 * when `url` carries something to open), else a new one.
 * @param {string} url player.html, with or without parameters.
 * @param {"window"|"tab"} [style] Asked for by name (the popup's buttons): a running player moves
 *   there, a new one opens there. Left out (links, videos), a running player stays where it is and
 *   a new one opens the way the player was last used ("playerStyle").
 */
async function openPlayerWindow(url, style) {
  const existing = await findPlayerTab();
  if (existing) {
    try {
      // A bare "open the player" request must not reload a player that's already running.
      if (url.includes("?")) await chrome.tabs.update(existing.id, { url });
      if (style) await movePlayer(existing, style);
      else await showPlayer(existing);
      return;
    } catch {} // it was just closed: open a new one below
  }
  style ??= (await chrome.storage.local.get(["playerStyle"])).playerStyle || "window";
  if (style === "tab") {
    const browser = await browserWindow();
    if (browser) await showPlayer(await chrome.tabs.create({ windowId: browser.id, url }));
    else await chrome.windows.create({ url, type: "normal", focused: true }); // no browser window open
    return;
  }
  await chrome.windows.create({ url, type: "popup", ...(await getWindowSize()) });
}

/**
 * Hands something to the player and brings it forward.
 * @param {object} message What a running player is told (js/startup.js answers these).
 * @param {string} fallbackUrl What a new player opens with instead, when none runs (or the one
 *   that does is still loading): player.html with the same thing as parameters.
 */
async function tellPlayerOrOpen(message, fallbackUrl) {
  const player = await findPlayerTab();
  if (player) {
    try {
      await chrome.tabs.sendMessage(player.id, message);
      await showPlayer(player);
      return;
    } catch {} // still loading or just closed: open it below
  }
  await openPlayerWindow(fallbackUrl);
}

// One player at a time. Each one says so when it starts: a second one that came without anything
// to open (the app menu's launcher, a typed address) closes, and the one already running moves to
// where it was opened (the launcher's app window: the running player becomes an app window). A
// player that stays remembers how it was opened, and the next one opened for a link or a video
// opens the same way.
async function playerOpened(tab, bare) {
  // the older one stays (tab ids only grow): two opened at once don't both close
  const other = (await playerTabs()).find((t) => t.id < tab.id);
  const style = styleOf(await chrome.windows.get(tab.windowId));
  if (other && bare) {
    await chrome.tabs.remove(tab.id);
    await movePlayer(other, style);
    return { duplicate: true };
  }
  await chrome.storage.local.set({ playerStyle: style });
  return { duplicate: false };
}
