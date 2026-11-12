/* MinimalTube player - The Undo bar: something the user can take back for five seconds (offerUndo).
 * Loaded in order by player.html (classic scripts sharing one scope). */

const UNDO_MS = 5000;
const undoBar = document.createElement("div");
undoBar.id = "undoBar";
undoBar.innerHTML =
  '<span class="ubText"></span><button type="button" class="ubUndo btn btn-sm btn-tint" title="Undo (U)">Undo<kbd class="kbd">U</kbd></button><div class="ubBar"></div>';
document.body.appendChild(undoBar);
let pendingUndo = null;
/**
 * Shows the Undo bar for UNDO_MS: the one way to let the user take something back. Whatever was
 * done should already look done when this is called; `commit` makes it final. A bar that is
 * still up is made final first.
 * @param {string} text What was done ("Queue cleared").
 * @param {object} action
 * @param {() => void} action.undo Runs when the user takes it back (the button, or U).
 * @param {() => void} action.commit Runs when the bar goes without that (also when the page
 *   closes): the real, final work, such as deleting on the server.
 * @param {string} [action.kind] Names what can be undone, for code that has to make it final
 *   early (flushUndo) because something else would clash with it.
 */
function offerUndo(text, { undo, commit, kind }) {
  flushUndo();
  const entry = { undo, commit, kind };
  entry.timer = setTimeout(() => finishUndo(entry), UNDO_MS);
  pendingUndo = entry;
  undoBar.querySelector(".ubText").textContent = text;
  restartAnimation(undoBar, "show");
}
function finishUndo(entry) {
  if (pendingUndo !== entry) return;
  pendingUndo = null;
  clearTimeout(entry.timer);
  undoBar.classList.remove("show");
  entry.commit();
}
function flushUndo() {
  if (pendingUndo) finishUndo(pendingUndo);
}
undoBar.querySelector(".ubUndo").addEventListener("click", (event) => {
  event.stopPropagation();
  const entry = pendingUndo;
  if (!entry) return;
  pendingUndo = null;
  clearTimeout(entry.timer);
  undoBar.classList.remove("show");
  entry.undo();
});
// U = the Undo button while the bar is up (a ⋮ menu's own letter keys come first)
document.addEventListener("keydown", (event) => {
  if (
    event.code !== "KeyU" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.repeat ||
    !pendingUndo ||
    isTypingTarget(event.target) ||
    popupOpen()
  )
    return;
  event.preventDefault();
  undoBar.querySelector(".ubUndo").click();
});
window.addEventListener("pagehide", flushUndo);
