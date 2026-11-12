/* MinimalTube player - The ⋮ menus (a side-panel row's, a browse card's), opened by their button,
 * a right-click or the keyboard, and the "Save to playlist" list that opens from them.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* ---- The two menus ----
 * One renderer, two places: #rowMenu lives inside the side panel (it moves and closes with it),
 * #bpMenu floats over the browse page. `host` is what a menu, and anything it opens, is placed
 * in (null: the window). */
function makeMenu(id, host) {
  const menuEl = el("div");
  menuEl.id = id;
  (host || document.body).appendChild(menuEl);
  return { el: menuEl, host, anchor: null, owner: null, dotsTimer: 0 };
}
const rowMenu = makeMenu("rowMenu", queuePanel),
  bpMenu = makeMenu("bpMenu", null);
const DOT_FRAMES = ["...", "..", "."]; // three, two, one

function closeMenu(menu) {
  menu.el._keys = null;
  clearInterval(menu.dotsTimer);
  menu.el.classList.remove("open");
  menu.el.innerHTML = "";
  if (menu.owner) menu.owner.classList.remove("menuOpen");
  menu.anchor = menu.owner = null;
}
const closeRowMenu = () => closeMenu(rowMenu),
  closeBpMenu = () => closeMenu(bpMenu);
const menuIsOpen = (menu) => menu.el.classList.contains("open");

/**
 * Opens a ⋮ menu.
 * @param {object} menu `rowMenu` or `bpMenu`.
 * @param {HTMLElement} anchor What it opens next to: its ⋮ button, or `menuPoint` after a right-click.
 * @param {Array<object|null|false>} entries Its items, top to bottom (falsy ones are skipped):
 *   {label, icon, key, danger, disabled, dots, keepOpen, cls, refuse, onClick}, or
 *   {separator: true}. `key` is the letter that picks the item (without one, the label's first
 *   letter when no other item starts with it). `refuse()` returns why the item can't run right
 *   now (or nothing): the menu then stays open and the item turns red. `onClick(context)` gets
 *   {menu, anchor, reopen}: where the item was picked, and a way back to this menu.
 * @param {HTMLElement} [owner] The row or card it belongs to (marked while the menu is open).
 */
function openMenu(menu, anchor, entries, owner) {
  closeMenu(menu);
  closeSaveToMenu(); // another item's ⋮: the "Save to" list of the last one goes
  const context = { menu, anchor, reopen: () => openMenu(menu, anchor, entries, owner) };
  entries = entries.filter(Boolean);
  const keys = menuKeysFor(entries.filter((entry) => !entry.separator)),
    dotEls = [];
  menu.el._keys = new Map();
  entries.forEach((entry) => {
    if (entry.separator) return menu.el.appendChild(el("div", "bpSep"));
    const item = el("button", "rowMenuItem" + (entry.danger ? " danger" : "") + (entry.cls ? ` ${entry.cls}` : ""));
    item.type = "button";
    item.disabled = !!entry.disabled;
    item.innerHTML = entry.icon || "";
    const label = el("span", null, entry.label);
    if (entry.dots) dotEls.push(label.appendChild(el("span", "dots", DOT_FRAMES[0])));
    item.appendChild(label);
    const key = keys.get(entry);
    if (key) {
      item.appendChild(el("kbd", "menuKey kbd", key));
      menu.el._keys.set(key, item);
    }
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      if (entry.disabled) return;
      const refusal = entry.refuse && entry.refuse();
      if (refusal) return refuseMenuItem(item, refusal);
      if (!entry.keepOpen) closeMenu(menu);
      if (entry.onClick) entry.onClick(context);
    });
    menu.el.appendChild(item);
  });
  menu.el.classList.add("open");
  menu.anchor = anchor;
  menu.owner = owner || null;
  if (owner) owner.classList.add("menuOpen");
  placePopup(menu.el, anchor, menu.host);
  if (dotEls.length) {
    let frame = 0;
    menu.dotsTimer = setInterval(() => {
      frame = (frame + 1) % DOT_FRAMES.length;
      dotEls.forEach((dots) => (dots.textContent = DOT_FRAMES[frame]));
    }, 450);
  }
}
function menuKeysFor(entries) {
  const keys = new Map(),
    taken = new Set(),
    counts = {};
  const firstLetter = (entry) => (entry.label || "").trim().charAt(0).toUpperCase();
  entries.forEach((entry) => {
    if (entry.key) {
      keys.set(entry, entry.key.toUpperCase());
      taken.add(entry.key.toUpperCase());
    } else if (/^[A-Z]$/.test(firstLetter(entry))) counts[firstLetter(entry)] = (counts[firstLetter(entry)] || 0) + 1;
  });
  entries.forEach((entry) => {
    const first = firstLetter(entry);
    if (!entry.key && counts[first] === 1 && !taken.has(first)) keys.set(entry, first);
  });
  return keys;
}
function refuseMenuItem(item, reason) {
  restartAnimation(item, "refused");
  clearTimeout(item._refusedTimer);
  item._refusedTimer = setTimeout(() => item.classList.remove("refused"), 1800);
  notify(reason, true, 5000);
}

/**
 * The ⋮ button of a row or card.
 * @param {object} menu `rowMenu` (side-panel rows) or `bpMenu` (browse cards).
 * @param {string} className "plMenuBtn" or "vMenuBtn": the button's look.
 * @param {() => Array} getEntries The menu's items (see openMenu), asked each time it opens.
 * @param {() => HTMLElement} [getOwner] The row or card the button is in.
 * @returns {HTMLButtonElement} `button._openMenu(anchor)` opens the menu somewhere else (the
 *   pointer after a right-click, the button itself from the keyboard).
 */
function menuButton(menu, className, getEntries, getOwner = () => null) {
  const btn = el("button", className);
  btn.title = "More";
  btn.innerHTML = ICON_DOTS;
  btn._openMenu = (anchor) => openMenu(menu, anchor, getEntries(), getOwner() || btn);
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menuIsOpen(menu) && menu.owner === (getOwner() || btn)) return closeMenu(menu);
    btn._openMenu(btn);
  });
  // Don't let a press on the button start anything else (e.g. text selection).
  btn.addEventListener("mousedown", (event) => event.stopPropagation());
  return btn;
}

// Puts a popup next to the button it belongs to (above it when there's no room below), within
// `container` or the window; menus opened by right-click appear at the pointer instead.
function placePopup(popup, anchor, container) {
  const box = container
      ? container.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
    width = popup.offsetWidth,
    height = popup.offsetHeight;
  let left, top;
  if (anchor === menuPoint) {
    left = parseFloat(menuPoint.style.left) - box.left;
    top = parseFloat(menuPoint.style.top) - box.top;
    if (top + height > box.height - 8) top = Math.max(8, top - height);
  } else {
    const rect = anchor.getBoundingClientRect();
    left = rect.right - box.left - width + 6;
    top = rect.bottom - box.top + 4;
    if (top + height > box.height - 8) top = Math.max(8, rect.top - box.top - height - 4);
  }
  popup.style.left = `${Math.max(8, Math.min(left, box.width - width - 8))}px`;
  popup.style.top = `${top}px`;
}

[rowMenu, bpMenu].forEach((menu) =>
  addLayer({
    el: menu.el,
    level: 2,
    isOpen: () => menuIsOpen(menu),
    close: () => closeMenu(menu),
    inside: [menu === rowMenu ? ".plMenuBtn" : ".vMenuBtn"],
    items: ".rowMenuItem:not(:disabled)",
  }),
);
// a letter key picks the open menu's item with that key
document.addEventListener(
  "keydown",
  (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || isTypingTarget(event.target) ||
        !/^Key[A-Z]$/.test(event.code))
      return;
    const menu = [bpMenu, rowMenu].find((candidate) => candidate.el._keys && menuIsOpen(candidate));
    const item = menu && menu.el._keys.get(event.code.slice(3));
    if (!item) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!item.disabled) item.click();
  },
  true,
);
// a menu doesn't follow what it belongs to when that scrolls away
[queueList, libraryList].forEach((list) => list.addEventListener("scroll", closeRowMenu, { passive: true }));
byId("browseBody").addEventListener("scroll", closeBpMenu, { passive: true });
window.addEventListener("resize", closeBpMenu);

/* ---------- right-click opens the same menu as the card's / row's ⋮ button ---------- */
const menuPoint = el("div");
menuPoint.style.cssText = "position:fixed;width:0;height:0;pointer-events:none;visibility:hidden";
document.body.appendChild(menuPoint);
document.addEventListener("contextmenu", (event) => {
  const item = event.target.closest && event.target.closest(".vCard, .plItem");
  const btn = item && item.querySelector(".vMenuBtn, .plMenuBtn");
  if (!btn || !btn._openMenu || isTypingTarget(event.target)) return;
  event.preventDefault();
  menuPoint.style.left = `${event.clientX}px`;
  menuPoint.style.top = `${event.clientY}px`;
  btn._openMenu(menuPoint);
});

/* ---- "Save to playlist": one list for every ⋮ menu ----
 * It opens in place of the menu it was picked from, and in the same place as that menu: inside
 * the side panel for a row's (so a press in it is a press in the panel), over the page for a
 * card's. */
const saveToMenu = el("div");
saveToMenu.id = "saveToMenu";
queuePanel.appendChild(saveToMenu);
const saveToBusy = new Set();
let saveTo = null; // {video, anchor, host, back} while the list is open

/**
 * A ⋮ menu's "Save to playlist" item.
 * @param {{id: string, title: string, url: string}|null|false} v The video; without one the item
 *   is greyed out (a queue item whose id isn't known yet).
 * @param {string} [key] Its letter key.
 * @returns {object} An entry for openMenu.
 */
function saveToEntry(v, key = "L") {
  return {
    label: "Save to playlist",
    key,
    icon: ICON_ADDLIST,
    disabled: !v,
    onClick: ({ menu, anchor, reopen }) => openSaveToMenu(v, anchor, menu.host, reopen),
  };
}
function closeSaveToMenu() {
  saveToMenu.classList.remove("open");
  saveToMenu.innerHTML = "";
  saveTo = null;
}
function saveToGoBack() {
  const back = saveTo && saveTo.back;
  closeSaveToMenu();
  if (back) back();
}
function openSaveToMenu(v, anchor, host, back) {
  const parent = host || document.body;
  if (saveToMenu.parentElement !== parent) parent.appendChild(saveToMenu);
  saveToMenu.classList.toggle("floating", !host);
  saveTo = { video: v, anchor, host: host || null, back: back || null };
  renderSaveToMenu();
  loadSavedPlaylists().then(() => {
    if (saveTo && saveTo.video === v) renderSaveToMenu();
  });
}
function renderSaveToMenu() {
  if (!saveTo) return;
  const v = saveTo.video,
    shown = saveToMenu.querySelector(".stList"),
    keepScroll = shown ? shown.scrollTop : 0;
  saveToMenu.innerHTML = "";
  if (saveTo.back) {
    const backBtn = el("button", "rowMenuItem stBack");
    backBtn.type = "button";
    backBtn.innerHTML = ICON_BACK;
    backBtn.append(el("span", null, "Back"), el("kbd", "menuKey kbd", "B"));
    backBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      saveToGoBack();
    });
    saveToMenu.appendChild(backBtn);
  }
  const list = el("div", "stList");
  if (!savedPlaylists.length) list.appendChild(el("div", "stEmpty", "No playlists yet."));
  savedPlaylists.forEach((pl) => {
    const items = pl.items || [],
      has = items.some((item) => item.id === v.id),
      first = items[0];
    const row = el("button", "stRow" + (has ? " saved" : ""));
    row.type = "button";
    row.disabled = saveToBusy.has(pl.id);
    row.title = has ? `Remove from ${pl.name}` : `Save to ${pl.name}`;
    const thumb = el("div", "stThumb");
    if (first && first.id) thumb.appendChild(makeThumbImg(`${serverBase}/thumb/${first.id}`, first.thumbnail));
    const name = el("div", "stName", pl.name);
    name.title = pl.name;
    const text = el("div", "stText");
    text.append(name, el("div", "stSub", plural(items.length, "video")));
    const mark = el("span", "stMark");
    mark.innerHTML = has ? ICON_BOOKMARK_FILLED : ICON_BOOKMARK;
    row.append(thumb, text, mark);
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSaveTo(pl, v, has);
    });
    list.appendChild(row);
  });
  const create = el("button", "stNew");
  create.type = "button";
  create.innerHTML = ICON_PLUS;
  create.appendChild(el("span", null, "New playlist"));
  create.addEventListener("click", (event) => {
    event.stopPropagation();
    closeSaveToMenu();
    openSavePlaylist({ items: [v], title: "New playlist", sub: v.title || v.url });
  });
  const foot = el("div", "stFoot");
  foot.appendChild(create);
  saveToMenu.append(el("div", "stHead", "Save to..."), list, foot);
  saveToMenu.classList.add("open");
  list.scrollTop = keepScroll;
  if (saveTo.anchor.isConnected) placePopup(saveToMenu, saveTo.anchor, saveTo.host);
}
async function toggleSaveTo(pl, v, has) {
  if (saveToBusy.has(pl.id)) return;
  saveToBusy.add(pl.id);
  renderSaveToMenu();
  try {
    const base = `/playlists/${encodeURIComponent(pl.id)}/items`;
    const data = has
      ? await api(`${base}/${encodeURIComponent(v.id)}`, { method: "DELETE" })
      : await api(base, { method: "POST", body: { items: [v], position: "top" } });
    applySavedPlaylist(data.playlist);
    renderPlaylistCards();
    notify(has ? `Removed from ${pl.name}` : `Saved to ${pl.name}`);
  } catch (err) {
    notify(`Couldn't ${has ? "remove from" : "save to"} playlist: ${firstLine(err.message)}`, true, 4000);
  } finally {
    saveToBusy.delete(pl.id);
    renderSaveToMenu();
  }
}
addLayer({
  el: saveToMenu,
  level: 3,
  isOpen: () => saveToMenu.classList.contains("open"),
  close: closeSaveToMenu,
  inside: [".plMenuBtn", ".vMenuBtn"],
  items: ".stRow, .stNew",
});
// B = its Back row
document.addEventListener("keydown", (event) => {
  if (!saveTo || !saveTo.back || event.code !== "KeyB" || isTypingTarget(event.target) ||
      event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
    return;
  event.preventDefault();
  event.stopImmediatePropagation();
  saveToGoBack();
});
[queueList, libraryList, byId("browseBody")].forEach((list) =>
  list.addEventListener("scroll", closeSaveToMenu, { passive: true }),
);
