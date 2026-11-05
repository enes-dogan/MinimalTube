#!/usr/bin/env python3
"""MinimalTube native host.

Chrome talks to this script over native messaging (one JSON message in, one out):
  {"action": "start-server", "port": N}   start MinimalTube's server.py if needed
  {"action": "ping"}

`minimaltube_host.py --start-server [PORT]` does the same from a terminal or launcher.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

DEFAULT_SERVER_PORT = 7860
# Another program may hold the preferred port: the server then takes the next free one of these.
PORT_RANGE = 10


def augment_path() -> None:
    """Browsers started from a desktop launcher often have a minimal PATH (the server needs ffmpeg)."""
    home = Path.home()
    extra = [home / ".local" / "bin", home / "bin", Path("/usr/local/bin"),
             Path("/usr/bin"), Path("/bin"), Path("/snap/bin"),
             Path("/var/lib/flatpak/exports/bin"), home / ".local/share/flatpak/exports/bin"]
    current = os.environ.get("PATH", "").split(os.pathsep)
    for d in extra:
        if str(d) not in current:
            current.append(str(d))
    os.environ["PATH"] = os.pathsep.join(p for p in current if p)


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


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def start_server(port: int) -> dict:
    """Start the server unless it already runs on one of its ports; the answer's "port" says
    where it is."""
    ports = range(port, port + PORT_RANGE)
    running = next((p for p in ports if server_is_healthy(p)), None)
    if running is not None:
        return {"ok": True, "already_running": True, "port": running}
    port = next((p for p in ports if port_is_free(p)), None)
    if port is None:
        raise RuntimeError(f"ports {ports.start}-{ports.stop - 1} are all taken by other programs")

    script = find_server_script()
    log_dir = Path.home() / ".cache" / "minimaltube"
    log_dir.mkdir(parents=True, exist_ok=True)
    log = open(log_dir / "server.log", "ab")
    proc = subprocess.Popen(
        # -u: every line reaches the log as it's printed (a buffered one is lost on pkill)
        [sys.executable, "-u", str(script), "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(script.parent),
        stdin=subprocess.DEVNULL,
        stdout=log,  # never inherit our stdout: it's the native-messaging channel
        stderr=log,
        start_new_session=True,  # outlive this short-lived host process
    )
    return {"ok": True, "pid": proc.pid, "port": port, "log": str(log_dir / "server.log")}


def run_native_host() -> int:
    try:
        msg = _read_message()
        if not msg:
            return 0
        action = msg.get("action")
        if action == "start-server":
            reply = start_server(int(msg.get("port") or DEFAULT_SERVER_PORT))
        elif action == "ping":
            reply = {"ok": True}
        else:
            reply = {"ok": False, "error": f"unknown action: {action}"}
        _send_message(reply)
    except Exception as exc:
        _send_message({"ok": False, "error": str(exc)})
    return 0


def main() -> int:
    augment_path()
    if len(sys.argv) > 1 and sys.argv[1].startswith(("chrome-extension://", "moz-extension://")):
        return run_native_host()

    parser = argparse.ArgumentParser(description="Start MinimalTube's local server.")
    parser.add_argument("--start-server", nargs="?", const=DEFAULT_SERVER_PORT, type=int,
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
