/* MinimalTube - the colour theme on a page (player, toolbar popup, "Opening" page): the tokens through
 * <html data-theme> (css/themes.css), and the theme's logo in every <img data-logo="size">, the tab
 * icon and --logo-url. Follows chrome.storage.local "theme", so every open page changes together.
 * Needs js/common.js (THEMES, themeIcon). */

const currentTheme = () => themeId(document.documentElement.dataset.theme);

function paintTheme(id) {
  const theme = themeId(id);
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("mt_theme", theme);
  } catch {}
  document.documentElement.style.setProperty("--logo-url", `url("${chrome.runtime.getURL(themeIcon(theme, 128))}")`);
  document.querySelectorAll("img[data-logo]").forEach((img) => (img.src = themeIcon(theme, img.dataset.logo)));
  document.querySelectorAll('link[rel="icon"]').forEach((icon) => {
    icon.href = themeIcon(theme, parseInt(icon.getAttribute("sizes"), 10) || 32);
  });
  document.dispatchEvent(new CustomEvent("minimaltube-theme", { detail: theme }));
}

paintTheme(currentTheme());
chrome.storage.local.get("theme").then(({ theme }) => {
  if (themeId(theme) !== currentTheme()) paintTheme(theme);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.theme) paintTheme(changes.theme.newValue);
});
