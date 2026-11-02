"""MinimalTube server - is the internet there?

One cached probe of YouTube, shared by everything that fails: the feed, downloads, /prepare.
While it says offline, a watcher thread re-checks every few seconds and runs the on_online()
callbacks once YouTube answers again. The player mirrors the state from a response header.
"""
import threading
import time
import urllib.error
import urllib.request

PROBE_URL = "https://www.youtube.com/generate_204"
PROBE_TIMEOUT = 4
NET_CHECK_TTL = 5
WATCH_EVERY = 10

NET = {"online": True, "checked": 0.0}
_probe_lock = threading.Lock()
_callbacks = []
_watching = False


def _probe() -> bool:
    try:
        urllib.request.urlopen(urllib.request.Request(PROBE_URL, method="HEAD"),
                               timeout=PROBE_TIMEOUT).close()
    except urllib.error.HTTPError:
        pass  # an answer, even an error, means we're online
    except (urllib.error.URLError, OSError):
        return False
    return True


def internet_up(max_age: float = NET_CHECK_TTL) -> bool:
    with _probe_lock:
        if time.time() - NET["checked"] > max_age:
            was = NET["online"]
            NET.update(online=_probe(), checked=time.time())
            if was and not NET["online"]:
                _start_watcher()
            elif not was and NET["online"]:
                _run_callbacks()
        return NET["online"]


def is_online() -> bool:
    """The last known state, without probing."""
    return NET["online"]


def on_online(fn):
    _callbacks.append(fn)
    return fn


def _run_callbacks():
    for fn in list(_callbacks):
        threading.Thread(target=fn, daemon=True).start()


def _start_watcher():
    global _watching
    if _watching:
        return
    _watching = True

    def watch():
        global _watching
        try:
            while True:
                time.sleep(WATCH_EVERY)
                if internet_up(max_age=0):
                    break
        finally:
            _watching = False

    threading.Thread(target=watch, daemon=True).start()
