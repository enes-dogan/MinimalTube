/* MinimalTube player - Seekbar extras: chapters and SponsorBlock marks.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* =====================================================================
 * Seekbar extras: chapters (sections with names) and SponsorBlock marks
 *
 * Chapters come from yt-dlp via the server (/chapters/<id>). Videos without
 * chapters keep the regular seekbar. The gaps between chapters are a CSS mask
 * over the whole bar, so the progress fill and the green marks are cut at the
 * chapter boundaries too.
 * ===================================================================== */
const seekVisual = byId("seekVisual"),
  seekMarks = byId("seekMarks"),
  seekTip = byId("seekTip"),
  chapterLabel = byId("chapterLabel");
let chapters = [];
function normalizeChapters(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((chapter) => ({
      start: Number(chapter && chapter.start),
      end: Number(chapter && chapter.end),
      title: String((chapter && chapter.title) || "").trim(),
    }))
    .filter(
      (item) =>
        isFinite(item.start) &&
        isFinite(item.end) &&
        item.start >= 0 &&
        item.end > item.start,
    )
    .sort((a, b) => a.start - b.start);
  return list.length >= 2 ? list : []; // a single "chapter" is just a regular video
}
function seekDuration() {
  return isFinite(video.duration) && video.duration > 0
    ? video.duration
    : chapters.length
      ? chapters[chapters.length - 1].end
      : 0;
}

// CSS mask with a thin transparent gap at every chapter boundary (null: no chapters).
function chapterMaskGradient(list, duration) {
  if (!list.length || !(duration > 0)) return null;
  const stops = ["#000 0"];
  list.slice(1).forEach((chapter) => {
    const percent = Math.min(
      100,
      Math.max(0, (chapter.start / duration) * 100),
    ).toFixed(3);
    stops.push(
      `#000 calc(${percent}% - 1.5px)`,
      `transparent calc(${percent}% - 1.5px)`,
      `transparent calc(${percent}% + 1.5px)`,
      `#000 calc(${percent}% + 1.5px)`,
    );
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
function chapterAt(at) {
  let found = null;
  for (const chapter of chapters) {
    if (at >= chapter.start) found = chapter;
    else break;
  }
  return found;
}
function updateChapterLabel() {
  const chapter = chapters.length ? chapterAt(video.currentTime || 0) : null;
  if (!chapter) {
    chapterLabel.hidden = true;
    return;
  }
  if (chapterLabel.textContent !== chapter.title)
    chapterLabel.textContent = chapter.title;
  chapterLabel.title = chapter.title;
  chapterLabel.hidden = false;
}
function renderChapters() {
  const mask = chapterMaskGradient(chapters, seekDuration());
  seekVisual.style.webkitMaskImage = mask || "";
  seekVisual.style.maskImage = mask || "";
  updateChapterLabel();
}
function renderSeekMarks() {
  seekMarks.innerHTML = "";
  const duration = seekDuration();
  if (!sponsorBlockEnabled || !sponsorSegments.length || !(duration > 0))
    return;
  sponsorSegments.forEach((seg) => {
    const start = Math.max(0, seg.start),
      end = Math.min(duration, seg.end);
    if (!(end > start)) return;
    const mark = document.createElement("div");
    mark.className = "sbMark";
    mark.style.left = `${(start / duration) * 100}%`;
    mark.style.width = `${Math.max(0.2, ((end - start) / duration) * 100)}%`;
    seekMarks.appendChild(mark);
  });
}
function clearSeekExtras() {
  chapters = [];
  sponsorSegments = []; // sponsor segments of the video that was playing
  seekTip.classList.remove("show");
  renderChapters();
  renderSeekMarks();
}
async function loadChapters(id) {
  try {
    const data = await api(`/chapters/${encodeURIComponent(id)}`);
    if (id !== currentVideoId) return; // the user moved on to another video meanwhile
    chapters = normalizeChapters(data.chapters);
    renderChapters();
  } catch (err) {
    logQuiet("chapters", err); // offline and never cached: a plain seekbar
  }
}

// Positions depend on the duration, which is only known once the video's metadata is loaded.
video.addEventListener("durationchange", () => {
  renderChapters();
  renderSeekMarks();
});

// Hovering the seekbar names the chapter under the cursor (only for videos with chapters).
seekWrap.addEventListener("mousemove", (event) => {
  const d = seekDuration();
  if (!chapters.length || !(d > 0)) return seekTip.classList.remove("show");
  const rect = seekWrap.getBoundingClientRect();
  if (!(rect.width > 0)) return;
  const frac = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    ),
    t = frac * d,
    chapter = chapterAt(t);
  seekTip.innerHTML = "";
  seekTip.append(chapter ? chapter.title : "");
  const time = document.createElement("small");
  time.textContent = formatTime(t, d >= 3600);
  seekTip.appendChild(time);
  const half = seekTip.offsetWidth / 2;
  seekTip.style.left = `${Math.min(Math.max(event.clientX - rect.left, half), Math.max(half, rect.width - half)) - half}px`;
  seekTip.classList.add("show");
});
seekWrap.addEventListener("mouseleave", () => seekTip.classList.remove("show"));
