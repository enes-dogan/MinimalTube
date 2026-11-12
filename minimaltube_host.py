#!/usr/bin/env python3
"""MinimalTube native host.

Chrome talks to this script over native messaging (one JSON message in, one out):
  {"action": "start-server", "port": N}   start MinimalTube's server.py if needed
  {"action": "ping"}

`minimaltube_host.py --start-server [PORT]` does the same from a terminal or launcher.

The installer registers it with the browsers through a small launcher that runs it with the
Python the server uses (on Windows and macOS, MinimalTube's own).
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import urllib.request
from pathlib import Path

# This folder is also the extension, and Chromium refuses to load one that holds a name starting
# with "_": never write bytecode (__pycache__) here, not even for minimaltube.system below.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from minimaltube.system import (  # noqa: E402
    SERVER_PORT,
    SERVER_PORTS,
    WINDOWS,
    cache_dir,
    port_is_free,
    spawn_detached,
    use_own_tools,
)


def _read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("=I", raw_len)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def _send_message(obj: dict) -> None:
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def find_server_script() -> Path:
    candidates: list[Path] = []
    env = os.environ.get("MINIMALTUBE_SERVER")
    if env:
        candidates.append(Path(env).expanduser())
    here = Path(__file__).resolve().parent
    candidates += [here / "server.py", here.parent / "server.py", here / "server" / "server.py"]
    for c in candidates:
        if c.is_file():
            return c
    raise RuntimeError(
        "server.py not found. Keep it in the same folder as minimaltube_host.py "
        "(or set MINIMALTUBE_SERVER to its full path)."
    )


def server_is_healthy(port: int) -> bool:
    """Whether MinimalTube's server answers on this port (its /health says "app": "minimaltube";
    another program's server there doesn't count)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as resp:
            return resp.status == 200 and json.loads(resp.read()).get("app") == "minimaltube"
    except Exception:
        return False


def start_server(port: int) -> dict:
    """Start the server unless it already runs on one of its ports; the answer's "port" says
    where it is."""
    # another program may hold the preferred port: the server then takes the next free one
    ports = range(port, port + SERVER_PORTS)
    running = next((p for p in ports if server_is_healthy(p)), None)
    if running is not None:
        return {"ok": True, "already_running": True, "port": running}
    port = next((p for p in ports if port_is_free("127.0.0.1", p)), None)
    if port is None:
        raise RuntimeError(f"ports {ports.start}-{ports.stop - 1} are all taken by other programs")

    script = find_server_script()
    log_dir = cache_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    log = open(log_dir / "server.log", "ab")
    proc = spawn_detached(
        # -u: every line reaches the log as it's printed (a buffered one is lost when it's stopped).
        # -X utf8: files and the log are UTF-8 on every OS (Windows would use its code page).
        # -B: no __pycache__ in this folder (see above).
        [sys.executable, "-X", "utf8", "-u", "-B", str(script), "--host", "127.0.0.1", "--port", str(port)],
        cwd=script.parent,
        stdout=log,  # never inherit our stdout: it's the native-messaging channel
        stderr=log,
    )
    return {"ok": True, "pid": proc.pid, "port": port, "log": str(log_dir / "server.log")}


def run_native_host() -> int:
    try:
        msg = _read_message()
        if not msg:
            return 0
        action = msg.get("action")
        if action == "start-server":
            reply = start_server(int(msg.get("port") or SERVER_PORT))
        elif action == "ping":
            reply = {"ok": True}
        else:
            reply = {"ok": False, "error": f"unknown action: {action}"}
        _send_message(reply)
    except Exception as exc:
        _send_message({"ok": False, "error": str(exc)})
    return 0


def main() -> int:
    use_own_tools()  # browsers started from a launcher often have a minimal PATH (the server needs ffmpeg)
    if len(sys.argv) > 1 and sys.argv[1].startswith(("chrome-extension://", "moz-extension://")):
        if WINDOWS:  # the messages are binary: no newline translation on the pipes
            import msvcrt

            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        return run_native_host()

    parser = argparse.ArgumentParser(description="Start MinimalTube's local server.")
    parser.add_argument("--start-server", nargs="?", const=SERVER_PORT, type=int,
                        metavar="PORT", help="Start MinimalTube's server if needed, then exit")
    args = parser.parse_args()
    if args.start_server is None:
        parser.print_help()
        return 1

    try:
        port = start_server(args.start_server)["port"]
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    for _ in range(40):  # wait up to ~10s so the player doesn't open before the server
        if server_is_healthy(port):
            return 0
        time.sleep(0.25)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
