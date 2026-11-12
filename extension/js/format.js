/* MinimalTube player - How things are written out: lengths, counts, ages, sizes, dates.
 * Loaded in order by player.html (classic scripts sharing one scope). */

function clockParts(seconds) {
  const total = isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
}
const twoDigits = (value) => String(value).padStart(2, "0");

/** A position in a video, for the time label: "03:07", or "00:03:07" when `long`. */
function formatTime(seconds, long = false) {
  const [hours, minutes, sec] = clockParts(seconds);
  return long ? `${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(sec)}` : `${twoDigits(minutes)}:${twoDigits(sec)}`;
}

/** A video's length the way YouTube badges it: "3:07", "1:02:45"; "" when unknown. */
function fmtDur(seconds) {
  if (seconds == null || !isFinite(seconds)) return "";
  const [hours, minutes, sec] = clockParts(seconds);
  return hours ? `${hours}:${twoDigits(minutes)}:${twoDigits(sec)}` : `${minutes}:${twoDigits(sec)}`;
}

/** "1 video", "3 videos". */
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * A count the way YouTube shortens it: 1234 → "1.2K views", 15300000 → "15.3M subscribers"
 * (cut off, never rounded up: 1290 is "1.2K").
 * @param {number|null} count The number; null / not finite gives "".
 * @param {string} noun What is counted, singular ("view", "subscriber"); an "s" is added.
 * @param {boolean} [exact] Numbers under 10,000 are written out ("1,234 views"), as under a
 *   video's description.
 * @returns {string}
 */
function fmtCount(count, noun, exact = false) {
  if (count == null || !isFinite(count)) return "";
  const short = (value, unit) => `${value >= 100 ? Math.floor(value) : Math.floor(value * 10) / 10}${unit} ${noun}s`;
  if (count >= 1e9) return short(count / 1e9, "B");
  if (count >= 1e6) return short(count / 1e6, "M");
  if (count >= (exact ? 1e4 : 1e3)) return short(count / 1e3, "K");
  return `${exact ? count.toLocaleString() : count} ${noun}${count === 1 ? "" : "s"}`;
}

/** How long ago a Unix time (seconds) was: "5m ago", "3d ago", "2y ago"; "" without one. */
function timeAgo(ts) {
  if (!ts) return "";
  const ago = Math.max(0, Date.now() / 1000 - ts);
  if (ago < 3600) return `${Math.max(1, Math.floor(ago / 60))}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  if (ago < 86400 * 30) return `${Math.floor(ago / 86400)}d ago`;
  if (ago < 86400 * 365) return `${Math.floor(ago / (86400 * 30))}mo ago`;
  return `${Math.floor(ago / (86400 * 365))}y ago`;
}

/** A file size: "412 KB", "1.3 GB"; "" for none. */
function fmtSize(bytes) {
  if (!bytes || !isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0,
    size = bytes;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : Math.round(size * 10) / 10} ${units[unit]}`;
}

/** "2026-10-20" → "Oct 20, 2026" (in the browser's language); "" when unknown. */
function fmtReleaseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return "";
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); // local date: no timezone shift
  return isNaN(date) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The first line of a message, cut to a length a notice can show. */
function firstLine(message) {
  return String(message).split("\n")[0].slice(0, 200);
}
