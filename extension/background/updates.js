/* MinimalTube background - after MinimalTube updated itself (minimaltube/updater.py): the extension
 * reloads to run the version that is now in its folder, and the player opens again where it was
 * (it keeps what it showed first: js/updates.js).
 * Loaded by background.js (importScripts: one scope with the other background files). */

// The version in the extension's folder, as the server reads it from manifest.json (/health).
async function installedVersion() {
  const data = await (await fetch(`${await getServerBase()}/health`)).json();
  return typeof data.version === "string" ? data.version : null;
}

/**
 * Reloads the extension so it runs the version installed in its folder. A player that is open
 * keeps what it shows first and opens again afterwards, as a window or a tab as it was.
 * @param {string} version The installed version.
 * @param {boolean} [force] Reload even when this version was reloaded for already (after an
 *   install the player asked for). Otherwise once per version: a browser that loads another,
 *   older copy of the folder must not reload over and over.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function reloadForUpdate(version, force = false) {
  const { reloadedFor } = await chrome.storage.local.get(["reloadedFor"]);
  if (!force && reloadedFor === version) return { ok: false, error: "reloaded for this version already" };
  const player = await findPlayerTab();
  let reopen = null;
  if (player) {
    const kept = chrome.tabs.sendMessage(player.id, { type: "minimaltube-before-reload" }).catch(() => null);
    await Promise.race([kept, sleep(3000)]);
    const win = await chrome.windows.get(player.windowId).catch(() => null);
    reopen = { style: win ? styleOf(win) : "window", at: Date.now() };
  }
  await chrome.storage.local.set({ reloadedFor: version, reopenPlayer: reopen });
  setTimeout(() => chrome.runtime.reload(), 150); // once the answer is out
  return { ok: true };
}

// Another profile or browser that uses the same folder installed an update (or the reload after
// one didn't happen): the folder holds another version than the one running here.
async function followInstalledVersion() {
  try {
    const version = await installedVersion();
    if (version && version !== chrome.runtime.getManifest().version) await reloadForUpdate(version);
  } catch (err) {
    logQuiet("installed version", err);
  }
}

// After a reload for an update: the player that was open opens again (js/updates.js and
// js/startup.js bring back what it showed).
chrome.storage.local.get(["reopenPlayer"]).then(({ reopenPlayer }) => {
  if (!reopenPlayer) return;
  chrome.storage.local.remove("reopenPlayer");
  if (Date.now() - (reopenPlayer.at || 0) < 120000)
    openPlayerWindow(PLAYER_URL, reopenPlayer.style === "tab" ? "tab" : "window").catch((err) =>
      logQuiet("reopen the player", err),
    );
});
setTimeout(followInstalledVersion, 3000);
