"""MinimalTube server - streaming a video while it downloads.

/prepare registers the adaptive formats yt-dlp already extracted; the player then reads a
time -> byte-range index per format (MP4 'sidx' / WebM 'Cues') and fetches segments through
the /live proxy, which replays yt-dlp's URL and headers. Nothing here runs unless the player
asks for it.
"""
import struct
import threading
import time
import urllib.error
import urllib.request

STREAM_MAX_HEIGHT = 1080  # 720p to start; Stream only can step up to 1080p
INDEX_HEAD_BYTES = 64 * 1024
INDEX_MAX_BYTES = 4 * 1024 * 1024
MAX_STREAMS = 20
STREAM_FRESH_SECONDS = 3600
UPSTREAM_MAX_WAIT = 20

live_lock = threading.Lock()
live_streams = {}


class UpstreamError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status  # YouTube's HTTP status, when it answered


def stream_candidates(info: dict) -> dict:
    formats = {}
    audio = []
    for f in info.get("formats") or []:
        container = {"mp4": "mp4", "m4a": "mp4", "webm": "webm"}.get(f.get("ext"))
        fid = str(f.get("format_id") or "")
        if f.get("protocol") != "https" or not f.get("url") or not container or "drc" in fid:
            continue
        vcodec, acodec = f.get("vcodec") or "none", f.get("acodec") or "none"
        if vcodec != "none" and acodec == "none":
            if not f.get("height") or f["height"] > STREAM_MAX_HEIGHT:
                continue
            kind, codecs = "video", vcodec
        elif vcodec == "none" and acodec != "none":
            kind, codecs = "audio", acodec
        else:
            continue
        entry = {
            "id": fid, "kind": kind, "container": container,
            "mime": f'{kind}/{container}; codecs="{codecs}"',
            "height": f.get("height"), "fps": f.get("fps"), "tbr": f.get("tbr"),
            "url": f["url"], "headers": dict(f.get("http_headers") or {}),
            "filesize": f.get("filesize"), "available_at": f.get("available_at"),
        }
        if kind == "audio":
            entry["original"] = "original" in str(f.get("format_note") or "").lower()
            audio.append(entry)
        else:
            formats[fid] = entry
    if any(a["original"] for a in audio):
        audio = [a for a in audio if a["original"]]
    formats.update({a["id"]: a for a in audio})
    return formats


def _public(formats: dict) -> list:
    return [{k: v for k, v in f.items() if k not in ("url", "headers", "original", "available_at")}
            for f in formats.values()]


def register_stream(video_id: str, info: dict) -> list:
    formats = stream_candidates(info)
    with live_lock:
        live_streams.pop(video_id, None)
        live_streams[video_id] = {"formats": formats, "index": {}, "at": time.time(),
                                  "duration": info.get("duration")}
        while len(live_streams) > MAX_STREAMS:
            live_streams.pop(next(iter(live_streams)))
    return _public(formats)


def stream_age(video_id: str):
    with live_lock:
        stream = live_streams.get(video_id)
        return None if not stream else time.time() - stream["at"]


def refresh_stream(video_id: str, info: dict):
    """New URLs for a stream being watched (YouTube's expire after some hours); the format ids
    and their byte indexes stay the same, so playback just continues."""
    formats = stream_candidates(info)
    with live_lock:
        stream = live_streams.get(video_id)
        if not stream:
            return register_stream(video_id, info)
        stream["formats"].update(formats)
        stream["at"] = time.time()
    return _public(formats)


def registered_stream(video_id: str):
    with live_lock:
        stream = live_streams.get(video_id)
        if not stream or time.time() - stream["at"] > STREAM_FRESH_SECONDS:
            return None
        return {"stream": _public(stream["formats"]), "duration": stream["duration"]}


def stream_format(video_id: str, format_id: str):
    with live_lock:
        stream = live_streams.get(video_id)
        return stream and stream["formats"].get(format_id)


def open_upstream(entry: dict, start: int, end: int):
    """YouTube marks many format URLs 'available_at' a few seconds after extraction (yt-dlp's
    downloader waits for it too); before that they answer 403."""
    available_at = entry.get("available_at") or 0
    wait = available_at - time.time()
    if wait > 0:
        time.sleep(min(wait + 0.3, UPSTREAM_MAX_WAIT))
    req = urllib.request.Request(entry["url"], headers={**entry["headers"],
                                                        "Range": f"bytes={start}-{end}"})
    while True:
        try:
            return urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as e:
            if e.code == 403 and time.time() < available_at + UPSTREAM_MAX_WAIT:
                time.sleep(1)
                continue
            raise UpstreamError(f"YouTube returned {e.code}", e.code) from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise UpstreamError(str(e)) from e


def fetch_bytes(entry: dict, start: int, end: int):
    with open_upstream(entry, start, end) as res:
        total = None
        content_range = res.headers.get("Content-Range") or ""
        if "/" in content_range and content_range.rsplit("/", 1)[1].isdigit():
            total = int(content_range.rsplit("/", 1)[1])
        return res.read(), total


# ---------------------------------------------------------------- MP4 (sidx)

def _mp4_boxes(data: bytes, offset: int = 0):
    while offset + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[offset:offset + 8])
        header = 8
        if size == 1:
            if offset + 16 > len(data):
                return
            size = struct.unpack(">Q", data[offset + 8:offset + 16])[0]
            header = 16
        elif size == 0:
            return
        yield kind.decode("latin-1"), offset, header, size
        offset += size


def parse_mp4_index(data: bytes):
    """-> (index dict, None) or (None, bytes needed)."""
    for kind, offset, header, size in _mp4_boxes(data):
        if kind != "sidx":
            continue
        if offset + size > len(data):
            return None, offset + size
        body = data[offset + header:offset + size]
        version = body[0]
        timescale = struct.unpack(">I", body[8:12])[0]
        if version == 0:
            earliest, first_offset = struct.unpack(">II", body[12:20])
            pos = 20
        else:
            earliest, first_offset = struct.unpack(">QQ", body[12:28])
            pos = 28
        count = struct.unpack(">H", body[pos + 2:pos + 4])[0]
        pos += 4
        byte = offset + size + first_offset
        t = earliest / timescale
        segments = []
        for _ in range(count):
            ref, duration = struct.unpack(">II", body[pos:pos + 8])
            pos += 12
            length = ref & 0x7FFFFFFF
            segments.append([round(t, 3), round(t + duration / timescale, 3),
                             byte, byte + length - 1])
            t += duration / timescale
            byte += length
        return {"init": [0, offset - 1], "segments": segments}, None
    return None, (len(data) * 2 if len(data) < INDEX_MAX_BYTES else None)


# ---------------------------------------------------------------- WebM (Cues)

EBML_HEADER, SEGMENT, SEEK_HEAD, INFO, TRACKS, CUES, CLUSTER = (
    0x1A45DFA3, 0x18538067, 0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1C53BB6B, 0x1F43B675)


def _vint(data: bytes, pos: int, keep_marker: bool):
    first = data[pos]
    length = 1
    while length <= 8 and not first & (0x80 >> (length - 1)):
        length += 1
    if length > 8 or pos + length > len(data):
        raise IndexError
    value = first if keep_marker else first & (0xFF >> length)
    for b in data[pos + 1:pos + length]:
        value = (value << 8) | b
    unknown = not keep_marker and value == (1 << (7 * length)) - 1
    return value, length, unknown


def _ebml_elements(data: bytes, start: int, end: int):
    pos = start
    while pos < end:
        eid, id_len, _ = _vint(data, pos, True)
        size, size_len, unknown = _vint(data, pos + id_len, False)
        body = pos + id_len + size_len
        yield eid, pos, body, None if unknown else size
        if unknown:
            return
        pos = body + size


def _uint(data: bytes, body: int, size: int) -> int:
    return int.from_bytes(data[body:body + size], "big")


def parse_webm_index(data: bytes, total: int):
    """-> (index dict, None) or (None, bytes needed)."""
    try:
        elements = list(_ebml_elements(data, 0, len(data)))
        segment = next((e for e in elements if e[0] == SEGMENT), None)
        if not segment:
            return None, len(data) * 2
        seg_body = segment[2]
        seg_end = len(data) if segment[3] is None else min(len(data), seg_body + segment[3])
        timescale, duration, cues, cues_pos, first_cluster = 1_000_000, None, None, None, None
        for eid, pos, body, size in _ebml_elements(data, seg_body, seg_end):
            if size is not None and body + size > len(data) and eid != CLUSTER:
                return None, body + size
            if eid == SEEK_HEAD:
                for _sid, _p, seek_body, seek_size in _ebml_elements(data, body, body + size):
                    target, position = None, None
                    for cid, _cp, cbody, csize in _ebml_elements(data, seek_body, seek_body + seek_size):
                        if cid == 0x53AB:
                            target = _uint(data, cbody, csize)
                        elif cid == 0x53AC:
                            position = _uint(data, cbody, csize)
                    if target == CUES and position is not None:
                        cues_pos = seg_body + position
            elif eid == INFO:
                for iid, _ip, ibody, isize in _ebml_elements(data, body, body + size):
                    if iid == 0x2AD7B1:
                        timescale = _uint(data, ibody, isize)
                    elif iid == 0x4489:
                        fmt = ">f" if isize == 4 else ">d"
                        duration = struct.unpack(fmt, data[ibody:ibody + isize])[0]
            elif eid == CUES:
                cues = (pos, body, size)
            elif eid == CLUSTER:
                first_cluster = pos
                break
        if cues is None:
            if cues_pos is not None and cues_pos >= len(data):
                return None, cues_pos + 65536
            return None, None
        _pos, body, size = cues
        points = []
        for _cid, _cp, pbody, psize in _ebml_elements(data, body, body + size):
            cue_time, cluster = None, None
            for eid, _ep, ebody, esize in _ebml_elements(data, pbody, pbody + psize):
                if eid == 0xB3:
                    cue_time = _uint(data, ebody, esize)
                elif eid == 0xB7:
                    for tid, _tp, tbody, tsize in _ebml_elements(data, ebody, ebody + esize):
                        if tid == 0xF1:
                            cluster = _uint(data, tbody, tsize)
            if cue_time is not None and cluster is not None:
                points.append((cue_time * timescale / 1e9, seg_body + cluster))
        points = sorted(dict((byte, t) for t, byte in points).items())
        if not points:
            return None, None
        end_time = (duration * timescale / 1e9) if duration else None
        segments = []
        for i, (byte, t) in enumerate(points):
            next_byte = points[i + 1][0] if i + 1 < len(points) else total
            next_t = points[i + 1][1] if i + 1 < len(points) else (end_time or t)
            segments.append([round(t, 3), round(next_t, 3), byte, next_byte - 1])
        init_end = min(p for p in (cues[0], first_cluster, points[0][0]) if p is not None)
        return {"init": [0, init_end - 1], "segments": segments}, None
    except (IndexError, struct.error):
        return None, (len(data) * 2 if len(data) < INDEX_MAX_BYTES else None)


def stream_index(video_id: str, format_id: str):
    entry = stream_format(video_id, format_id)
    if not entry:
        return None
    with live_lock:
        cached = live_streams.get(video_id, {}).get("index", {}).get(format_id)
    if cached:
        return cached
    length = INDEX_HEAD_BYTES
    while True:
        data, total = fetch_bytes(entry, 0, length - 1)
        total = total or entry.get("filesize")
        if entry["container"] == "mp4":
            index, needed = parse_mp4_index(data)
        else:
            if not total:
                raise UpstreamError("unknown file size")
            index, needed = parse_webm_index(data, total)
        if index:
            break
        if not needed or needed <= len(data) or needed > INDEX_MAX_BYTES or len(data) < length:
            raise UpstreamError("couldn't find the stream's index")
        length = needed
    index.update(mime=entry["mime"], kind=entry["kind"])
    with live_lock:
        if video_id in live_streams:
            live_streams[video_id]["index"][format_id] = index
    return index
