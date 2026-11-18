/* MinimalTube background - the colour theme's logo on the toolbar button and in notifications.
 * The manifest's icon (chrome://extensions) can't change, so it stays Violet. setIcon may not last
 * across a browser restart, so the icon is set again on every start. */

let toolbarTheme = "violet";

function paintToolbarIcon(theme) {
  toolbarTheme = themeId(theme);
  const path = {};
  for (const size of [16, 32, 48]) path[size] = themeIcon(toolbarTheme, size);
  chrome.action.setIcon({ path }).catch((err) => logQuiet("toolbar icon", err));
}

chrome.storage.local.get("theme").then(({ theme }) => paintToolbarIcon(theme));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.theme) paintToolbarIcon(changes.theme.newValue);
});
