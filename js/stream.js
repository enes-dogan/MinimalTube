/* MinimalTube - play a video from YouTube's separate video + audio streams (through the
 * local server's /live proxy) with Media Source Extensions, while the full download runs.
 * The server hands each format's index as [[t0, t1, byteStart, byteEnd], ...].
 *
 * Adaptive (Stream only mode): the video starts at 720p; while the connection comfortably
 * carries 1080p it switches up at the next segment, and back down when the buffer runs low. */

const LIVE_READ_AHEAD = 120;
const LIVE_MIN_AHEAD = 30;
const LIVE_CODEC_RANK = { avc1: 0, vp09: 1, vp9: 1, av01: 2 };
const LIVE_START_HEIGHT = 720;
const LIVE_UP_HEADROOM = 1.6; // measured speed ÷ 1080p bitrate needed to switch up
const LIVE_UP_MIN_AHEAD = 20; // seconds buffered before switching up
const LIVE_DOWN_AHEAD = 10; // fewer seconds buffered than this (while playing): back to 720p
const LIVE_SWITCH_GAP_MS = 15000; // no switching back and forth faster than this
const LIVE_UP_KEEP = 12; // switching up: 720p already buffered past this many seconds is replaced

class LiveTrack {
  constructor(stream, format, index, buffer, upgrade) {
    this.stream = stream;
    this.format = format;
    this.segments = index.segments;
    this.buffer = buffer;
    this.controller = null;
    this.busy = false;
    this.done = false;
    this.next = { index: 0, from: -1 };
    // adaptive: [start quality, higher quality]; index loaded when first needed
    this.levels = upgrade ? [{ format, index }, { format: upgrade, index: null }] : null;
    this.level = 0;
    this.switchedAt = Date.now();
    this.speed = 0; // bits per second, smoothed over the last segments
    this.samples = 0;
  }

  noteSpeed(bytes, ms) {
    if (ms < 30 || bytes < 50000) return; // too small to say anything
    const bps = (bytes * 8 * 1000) / ms;
    this.speed = this.speed ? this.speed * 0.6 + bps * 0.4 : bps;
    this.samples++;
  }

  // average bitrate of a quality, from its segment table
  static bitrate(index) {
    const segs = index.segments;
    const bytes = segs.reduce((sum, s) => sum + (s[3] - s[2] + 1), 0);
    const secs = segs[segs.length - 1][1] - segs[0][0];
    return secs > 0 ? (bytes * 8) / secs : Infinity;
  }

  async adapt(ahead, t) {
    if (!this.levels || Date.now() - this.switchedAt < LIVE_SWITCH_GAP_MS) return;
    const playing = !this.stream.video.paused;
    if (this.level === 0) {
      if (this.samples < 3 || ahead - t < LIVE_UP_MIN_AHEAD) return;
      const high = this.levels[1];
      if (!high.index) high.index = await this.stream.loadIndex(high.format);
      if (this.speed >= LiveTrack.bitrate(high.index) * LIVE_UP_HEADROOM)
        await this.switchTo(1);
    } else if (playing && ahead - t < LIVE_DOWN_AHEAD) await this.switchTo(0);
  }

  // Switch quality: the new format's init segment goes in first, then its segments follow
  // from where the buffer ends (YouTube's segments line up across qualities). Going up, the
  // 720p buffered beyond the next few seconds is dropped, so 1080p shows within seconds.
  async switchTo(level) {
    const { format, index } = this.levels[level];
    const init = await this.stream.fetchBytes(this, index.init[0], index.init[1], format);
    if (!init || this.stream.destroyed) return;
    await this.stream.whenIdle(this.buffer);
    const keepTo = this.stream.video.currentTime + LIVE_UP_KEEP;
    if (level > this.level && this.bufferedEnd(this.stream.video.currentTime) > keepTo) {
      this.buffer.remove(keepTo, Infinity);
      await this.stream.whenIdle(this.buffer);
    }
    if (this.buffer.changeType) this.buffer.changeType(format.mime);
    await this.append(init);
    this.level = level;
    this.format = format;
    this.segments = index.segments;
    this.next = { index: 0, from: -1 };
    this.switchedAt = Date.now();
    this.stream.qualityChanged(format);
  }

  stalled() {
    if (this.levels && this.level === 1) this.switchedAt = 0; // step down at the next segment
  }

  bufferedEnd(t) {
    const ranges = this.buffer.buffered;
    for (let i = 0; i < ranges.length; i++)
      if (ranges.start(i) <= t + 0.3 && ranges.end(i) >= t) return ranges.end(i);
    return t;
  }

  segmentAfter(t) {
    let lo = 0,
      hi = this.segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.segments[mid][1] <= t + 0.05) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  async pump() {
    if (this.busy || this.stream.destroyed) return;
    const video = this.stream.video;
    const t = video.currentTime;
    let ahead = this.bufferedEnd(t);
    const wanted = video.paused ? LIVE_MIN_AHEAD : LIVE_READ_AHEAD;
    if (ahead - t >= wanted) return;
    this.busy = true;
    try {
      await this.adapt(ahead, t);
    } catch (err) {
      console.warn("MinimalTube: couldn't change the stream quality:", err);
    }
    this.busy = false;
    if (this.stream.destroyed) return;
    ahead = this.bufferedEnd(t); // a switch up may have dropped what was ahead
    let i = this.segmentAfter(ahead);
    if (i < this.next.index && Math.abs(ahead - this.next.from) < 0.5)
      i = this.next.index;
    if (i >= this.segments.length) {
      this.done = true;
      this.stream.maybeEnd();
      return;
    }
    this.done = false;
    this.busy = true;
    try {
      const [, , start, end] = this.segments[i];
      const began = performance.now();
      const bytes = await this.stream.fetchBytes(this, start, end);
      if (bytes) this.noteSpeed(bytes.byteLength, performance.now() - began);
      if (bytes) {
        await this.append(bytes);
        this.next = { index: i + 1, from: this.bufferedEnd(t) };
      }
    } catch (err) {
      if (err.name !== "AbortError") this.stream.fail(err);
    } finally {
      this.busy = false;
    }
    if (!this.stream.destroyed) this.stream.schedule();
  }

  async append(bytes) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.stream.whenIdle(this.buffer);
        if (this.stream.destroyed) return;
        this.buffer.appendBuffer(bytes);
        await this.stream.whenIdle(this.buffer);
        return;
      } catch (err) {
        if (err.name !== "QuotaExceededError" || attempt >= 2) throw err;
        await this.evict(attempt);
      }
    }
  }

  async evict(attempt) {
    const t = this.stream.video.currentTime;
    const keepBehind = attempt === 0 ? 60 : 5;
    await this.stream.whenIdle(this.buffer);
    if (t - keepBehind > 0) this.buffer.remove(0, t - keepBehind);
    await this.stream.whenIdle(this.buffer);
    const farAhead = t + LIVE_READ_AHEAD + 30;
    if (this.stream.source.duration > farAhead) {
      this.buffer.remove(farAhead, this.stream.source.duration);
      await this.stream.whenIdle(this.buffer);
    }
  }

  abort() {
    if (this.controller) this.controller.abort();
  }
}

class LiveStream {
  // { video, audio } at up to 720p; with adaptive, also `upgrade`: the best supported quality
  // above 720p (up to the server's 1080p), preferably in the same codec
  static pick(candidates, { adaptive = false } = {}) {
    const maxHeight = LIVE_START_HEIGHT;
    if (typeof MediaSource === "undefined" || !Array.isArray(candidates))
      return null;
    const supported = (c) => MediaSource.isTypeSupported(c.mime);
    const rank = (c) => {
      const codec = (c.mime.match(/codecs="([a-z0-9]+)/i) || [])[1] || "";
      return LIVE_CODEC_RANK[codec.toLowerCase()] ?? 9;
    };
    const video = candidates
      .filter((c) => c.kind === "video" && (c.height || 0) <= maxHeight && supported(c))
      .sort(
        (a, b) =>
          b.height - a.height ||
          rank(a) - rank(b) ||
          (b.fps || 0) - (a.fps || 0),
      )[0];
    const audio = candidates
      .filter((c) => c.kind === "audio" && supported(c))
      .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
    if (!video || !audio) return null;
    const upgrade = adaptive
      ? candidates
          .filter((c) => c.kind === "video" && (c.height || 0) > maxHeight && supported(c))
          .sort(
            (a, b) =>
              (rank(a) !== rank(video)) - (rank(b) !== rank(video)) ||
              b.height - a.height ||
              rank(a) - rank(b) ||
              (b.fps || 0) - (a.fps || 0),
          )[0]
      : null;
    return { video, audio, upgrade: upgrade || null };
  }

  constructor(video, { base, videoId, picks, duration, startAt = 0, onfail, onquality }) {
    this.video = video;
    this.base = base;
    this.videoId = videoId;
    this.picks = picks;
    this.duration = duration;
    this.startAt = startAt;
    this.onfail = onfail;
    this.onquality = onquality;
    this.tracks = [];
    this.destroyed = false;
    this.failed = false;
    this.timer = 0;
    this.onActivity = () => this.schedule(0);
    this.onError = () =>
      this.fail(new Error(this.video.error?.message || "playback error"));
    this.onWaiting = () => this.tracks.forEach((t) => t.stalled());
    this.onSeeking = () => {
      this.tracks.forEach((track) => {
        const t = this.video.currentTime;
        if (track.bufferedEnd(t) === t) track.abort();
      });
      this.schedule(0);
    };
  }

  async start() {
    this.source = new MediaSource();
    this.url = URL.createObjectURL(this.source);
    this.video.src = this.url;
    await new Promise((resolve) =>
      this.source.addEventListener("sourceopen", resolve, { once: true }),
    );
    const formats = [this.picks.video, this.picks.audio];
    const indexes = await Promise.all(formats.map((f) => this.loadIndex(f)));
    if (this.destroyed) return;
    const lastEnd = Math.max(
      ...indexes.map((index) => index.segments[index.segments.length - 1][1]),
    );
    this.source.duration = Math.max(this.duration || 0, lastEnd);
    this.tracks = formats.map(
      (format, i) =>
        new LiveTrack(
          this,
          format,
          indexes[i],
          this.source.addSourceBuffer(format.mime),
          format.kind === "video" ? this.picks.upgrade : null,
        ),
    );
    for (const track of this.tracks) {
      const [start, end] = indexes[this.tracks.indexOf(track)].init;
      const init = await this.fetchBytes(track, start, end);
      if (this.destroyed) return;
      await track.append(init);
    }
    if (this.startAt > 0) this.video.currentTime = this.startAt;
    this.video.addEventListener("seeking", this.onSeeking);
    this.video.addEventListener("timeupdate", this.onActivity);
    this.video.addEventListener("play", this.onActivity);
    this.video.addEventListener("error", this.onError);
    this.video.addEventListener("waiting", this.onWaiting);
    this.schedule(0);
  }

  qualityChanged(format) {
    if (this.onquality) this.onquality(format);
  }


  async loadIndex(format) {
    const res = await fetch(
      `${this.base}/live/${this.videoId}/${encodeURIComponent(format.id)}/index`,
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error || !data.segments || !data.segments.length)
      throw new Error(data.error || `stream index returned ${res.status}`);
    return data;
  }

  async fetchBytes(track, start, end, format = track.format) {
    track.controller = new AbortController();
    const res = await fetch(
      `${this.base}/live/${this.videoId}/${encodeURIComponent(format.id)}?start=${start}&end=${end}`,
      { signal: track.controller.signal },
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `stream returned ${res.status}`);
    }
    const bytes = await res.arrayBuffer();
    track.controller = null;
    return this.destroyed ? null : bytes;
  }

  whenIdle(buffer) {
    if (!buffer.updating) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        resolve();
      };
      const failed = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        reject(new Error("the browser couldn't decode the stream"));
      };
      buffer.addEventListener("updateend", done);
      buffer.addEventListener("error", failed);
    });
  }

  schedule(delay = 500) {
    if (this.destroyed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tracks.forEach((t) => t.pump()), delay);
  }

  maybeEnd() {
    if (
      this.tracks.every((t) => t.done && !t.buffer.updating) &&
      this.source.readyState === "open"
    ) {
      try {
        this.source.endOfStream();
      } catch {} // already ended or closing: nothing to do
    }
  }

  buffered() {
    const video = this.tracks.find((t) => t.format.kind === "video");
    return video ? video.buffer.buffered : null;
  }

  fail(err) {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    if (this.onfail) this.onfail(err);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.timer);
    this.tracks.forEach((t) => t.abort());
    this.video.removeEventListener("seeking", this.onSeeking);
    this.video.removeEventListener("timeupdate", this.onActivity);
    this.video.removeEventListener("play", this.onActivity);
    this.video.removeEventListener("error", this.onError);
    this.video.removeEventListener("waiting", this.onWaiting);
    if (this.url) URL.revokeObjectURL(this.url);
  }
}
