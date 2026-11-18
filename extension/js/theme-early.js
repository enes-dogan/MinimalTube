/* MinimalTube - puts the colour theme on the page before its first paint (loaded in <head>, before the
 * stylesheets). localStorage is the copy js/theme.js keeps; chrome.storage.local is the real setting. */
try {
  document.documentElement.dataset.theme = localStorage.getItem("mt_theme") || "violet";
} catch {
  document.documentElement.dataset.theme = "violet";
}
