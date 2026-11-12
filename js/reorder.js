/* MinimalTube player - Drag to reorder: the side panel's rows (by their grip) and the browse
 * page's card grids (press and hold a card, or just drag it).
 * Loaded in order by player.html (classic scripts sharing one scope). */

let sortDragging = false; // lists aren't redrawn under a drag (refreshLibrary, loadSavedPlaylists)

/**
 * Lets the items of a list or grid be reordered by dragging. While one is dragged the others
 * make room, the container scrolls when the pointer nears its edge, and Esc puts everything back.
 * @param {HTMLElement} container The list or grid; its direct children are the items.
 * @param {object} options
 * @param {string} options.item Selector of the items.
 * @param {string} [options.handle] Selector of the grip inside an item. With one, a press on the
 *   grip starts the drag at once and the item moves up and down only (a list, whose rows may
 *   differ in height). Without one, the item itself is dragged, after a 220 ms hold or 8 px of
 *   movement (so a click still opens it), freely across the rows of a grid.
 * @param {HTMLElement} [options.scroller] What scrolls (the container itself by default).
 * @param {() => boolean} [options.canSort] Asked at each press; false leaves the item alone.
 * @param {(from: number, to: number) => void} options.onMove Runs when an item was dropped in
 *   another place: its old and new index among the items.
 */
function makeSortable(container, { item, handle, scroller = container, canSort = () => true, onMove }) {
  const itemsOf = () => Array.from(container.children).filter((child) => child.matches(item));
  if (handle) {
    container.addEventListener("pointerdown", (event) => {
      const grip = event.button === 0 && event.target.closest(handle);
      const dragged = grip && grip.closest(item);
      if (!dragged || dragged.parentElement !== container || !canSort()) return;
      event.preventDefault();
      runDrag({ container, scroller, items: itemsOf(), dragged, start: event, onMove, grip });
    });
    return;
  }
  container.addEventListener("dragstart", (event) => event.preventDefault());
  // the click that ends a drag must not open the card
  container.addEventListener(
    "click",
    (event) => {
      if (!container._dragged) return;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
  container.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const dragged = event.target.closest(item);
    if (!dragged || dragged.parentElement !== container || !canSort()) return;
    const timer = setTimeout(begin, 220);
    function wait(on) {
      document[on ? "addEventListener" : "removeEventListener"]("pointermove", moved);
      document[on ? "addEventListener" : "removeEventListener"]("pointerup", giveUp);
      document[on ? "addEventListener" : "removeEventListener"]("pointercancel", giveUp);
    }
    function giveUp() {
      clearTimeout(timer);
      wait(false);
    }
    function moved(move) {
      if (Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) > 8) begin();
    }
    function begin() {
      giveUp();
      runDrag({ container, scroller, items: itemsOf(), dragged, start: event, onMove });
    }
    wait(true);
  });
}

// One drag, from the press to the drop. With a `grip` the pointer is captured by it (a list row);
// without one the document follows the pointer (a grid card, already under way when this starts).
function runDrag({ container, scroller, items, dragged, start, onMove, grip }) {
  const from = items.indexOf(dragged);
  if (from < 0) return;
  closeRowMenu();
  closeBpMenu();
  const place = (grip ? listPlacer : gridPlacer)(items, from, start, scroller),
    edge = grip ? 36 : 60, // how near the scroller's edge the pointer starts scrolling it
    fastest = grip ? 18 : 20, // pixels per frame
    target = grip || document;
  let pointer = { x: start.clientX, y: start.clientY },
    to = from,
    raf = 0,
    done = false;
  sortDragging = true;
  container.classList.add("sorting");
  dragged.classList.add("dragging");
  document.body.style.cursor = "grabbing";
  if (grip)
    try {
      grip.setPointerCapture(start.pointerId);
    } catch {}
  const update = () => (to = place(pointer));
  function autoScroll() {
    if (done) return;
    const rect = scroller.getBoundingClientRect();
    let step = 0;
    if (pointer.y < rect.top + edge) step = -Math.ceil((rect.top + edge - pointer.y) / 4);
    else if (pointer.y > rect.bottom - edge) step = Math.ceil((pointer.y - (rect.bottom - edge)) / 4);
    if (step) {
      scroller.scrollTop += Math.max(-fastest, Math.min(fastest, step));
      update();
    }
    raf = requestAnimationFrame(autoScroll);
  }
  function finish(commit) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    listen(false);
    if (grip)
      try {
        grip.releasePointerCapture(start.pointerId);
      } catch {}
    items.forEach((other) => (other.style.transform = ""));
    dragged.classList.remove("dragging");
    container.classList.remove("sorting");
    document.body.style.cursor = "";
    sortDragging = false;
    container._dragged = true;
    setTimeout(() => (container._dragged = false), 0);
    if (commit && to !== from) onMove(from, to);
  }
  const onPointerMove = (event) => {
    pointer = { x: event.clientX, y: event.clientY };
    update();
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  };
  function listen(on) {
    const act = on ? "addEventListener" : "removeEventListener";
    target[act]("pointermove", onPointerMove);
    target[act]("pointerup", onUp);
    target[act]("pointercancel", onCancel);
    if (grip) grip[act]("lostpointercapture", onCancel);
    document[act]("keydown", onKey, true);
  }
  listen(true);
  update();
  raf = requestAnimationFrame(autoScroll);
}

// A list: the dragged row follows the pointer up and down; the rows it passes shift by its
// height (rows may be of different heights). Returns the placer: pointer -> the index it's at.
function listPlacer(rows, from, start, list) {
  const tops = rows.map((row) => row.offsetTop),
    heights = rows.map((row) => row.offsetHeight),
    dragHeight = heights[from],
    total = tops[rows.length - 1] + heights[rows.length - 1],
    grab = start.clientY - list.getBoundingClientRect().top + list.scrollTop - tops[from];
  return (pointer) => {
    const y = pointer.y - list.getBoundingClientRect().top + list.scrollTop,
      top = Math.min(Math.max(0, y - grab), Math.max(0, total - dragHeight)),
      centre = top + dragHeight / 2;
    let to = 0;
    rows.forEach((row, index) => {
      if (index !== from && tops[index] + heights[index] / 2 < centre) to++;
    });
    rows.forEach((row, index) => {
      let shift = 0;
      if (index === from) shift = top - tops[from];
      else if (to > from && index > from && index <= to) shift = -dragHeight;
      else if (to < from && index >= to && index < from) shift = dragHeight;
      row.style.transform = shift ? `translateY(${shift}px)` : "";
    });
    return to;
  };
}

// A grid: the dragged card follows the pointer freely; it goes to the slot whose centre is
// nearest, and the cards in between move over by one slot (across rows too). Positions are in
// the scroller's content, so scrolling while dragging keeps working.
function gridPlacer(cards, from, start, scroller) {
  const slots = cards.map((card) => {
    const rect = card.getBoundingClientRect();
    return { x: rect.left + scroller.scrollLeft, y: rect.top + scroller.scrollTop, w: rect.width, h: rect.height };
  });
  const startX = start.clientX + scroller.scrollLeft,
    startY = start.clientY + scroller.scrollTop;
  return (pointer) => {
    const dx = pointer.x + scroller.scrollLeft - startX,
      dy = pointer.y + scroller.scrollTop - startY,
      centreX = slots[from].x + slots[from].w / 2 + dx,
      centreY = slots[from].y + slots[from].h / 2 + dy;
    let to = from,
      nearest = Infinity;
    slots.forEach((slot, index) => {
      const distance = Math.hypot(slot.x + slot.w / 2 - centreX, slot.y + slot.h / 2 - centreY);
      if (distance < nearest) {
        nearest = distance;
        to = index;
      }
    });
    cards.forEach((card, index) => {
      if (index === from) return void (card.style.transform = `translate(${dx}px, ${dy}px) scale(1.03)`);
      let slot = index;
      if (to > from && index > from && index <= to) slot = index - 1;
      else if (to < from && index >= to && index < from) slot = index + 1;
      card.style.transform =
        slot === index ? "" : `translate(${slots[slot].x - slots[index].x}px, ${slots[slot].y - slots[index].y}px)`;
    });
    return to;
  };
}
