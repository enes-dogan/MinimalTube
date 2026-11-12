#!/usr/bin/env python3
"""MinimalTube installer: the part every OS shares.

install.sh (Linux, macOS) and install.ps1 (Windows), next to this file, find or fetch the Python the server will run
on, then run this with it:

  1. the server's packages (Flask, Flask-CORS, waitress) when that Python is MinimalTube's own,
     and MinimalTube's own yt-dlp (pip, into the app folder; Settings -> Update yt-dlp later)
  2. ffmpeg, ffprobe and deno: the system's when it has them, else fetched into the app folder's
     bin/ (the server puts that first on its PATH; nothing outside MinimalTube's folders changes)
  3. the native host, registered with every Chromium-based browser found, so the extension can
     start the server (a JSON file per browser; on Windows, per-user registry keys)
  4. MinimalTube in the app menu (Linux), ~/Applications (macOS) or the Start menu (Windows):
     the player as an app window

No step needs admin rights. Run it again after moving this folder.

    python install.py [<extension id> ...]   (an id only for a copy without manifest.json's "key")
"""
from __future__ import annotations  # `str | None` annotations on Python 3.9

import importlib.util
import json
import os
import platform
import plistlib
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# No bytecode: the project folder keeps only the files it came with.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from minimaltube.system import (  # noqa: E402
    EXTENSION_DIR, MACOS, PROJECT_DIR, WINDOWS, app_dir, bin_dir, extension_id, installer_hint, use_own_tools)

HOST_NAME = "com.minimaltube.host"
ID_RE = re.compile(r"^[a-p]{32}$")
UA = {"User-Agent": "MinimalTube-installer"}
problems: list[str] = []


def say(text: str = "") -> None:
    print(text, flush=True)


def warn(text: str) -> None:
    problems.append(text)
    print(f"Warning: {text}", flush=True)


def write_if_changed(path: Path, text: str, encoding: str = "utf-8") -> None:
    """Write a file the installer generates, byte for byte as given (no newline translation), and
    only when its content differs: cmd.exe keeps reading a .bat while it runs, so the native-host
    launcher must not be rewritten under a browser that is using it."""
    data = text.encode(encoding, errors="replace")
    try:
        if path.read_bytes() == data:
            return
    except OSError:
        pass
    path.write_bytes(data)


# ---------------------------------------------------------------- extension id
def extension_ids(argv: list[str]) -> list[str]:
    # the id follows from manifest.json's "key" (system.extension_id), the same on every machine
    ids = list(argv) or [i for i in [extension_id(EXTENSION_DIR / "manifest.json")] if i]
    if not ids and sys.stdin.isatty():
        say("Open chrome://extensions, turn on Developer mode and copy MinimalTube's ID.")
        typed = input("Extension ID: ").strip()
        ids = [typed] if typed else []
    if not ids:
        sys.exit("Error: no extension ID: manifest.json has no \"key\". Pass the ID shown at "
                 "chrome://extensions: install <id>")
    for i in ids:
        if not ID_RE.match(i):
            sys.exit(f"Error: '{i}' doesn't look like a Chrome extension ID (32 letters a-p).")
    return ids


# ---------------------------------------------------------------- the server's Python
def own_python_in_use() -> bool:
    try:
        return Path(sys.prefix).resolve().is_relative_to((app_dir() / "python").resolve())
    except OSError:
        return False


def pip_install(*args: str) -> None:
    subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", "--no-input",
                    "--disable-pip-version-check", "--quiet", *args], check=True)


def server_packages() -> None:
    if not own_python_in_use():
        # a system Python (Linux): its packages come from the package manager
        missing = [m for m in ("flask", "flask_cors") if importlib.util.find_spec(m) is None]
        if missing:
            warn(f"{sys.executable} is missing {', '.join(missing)}. Run the installer itself "
                 f"({installer_hint()}) instead of install.py: it gives MinimalTube a Python of its own "
                 "when the system's lacks them.")
        return
    reqs = []
    for line in (PROJECT_DIR / "requirements.txt").read_text(encoding="utf-8").splitlines():
        req = line.split("#", 1)[0].strip()
        if req and not req.lower().startswith("yt-dlp"):  # yt-dlp: the own copy below
            reqs.append(req)
    say("Installing the server's Python packages (Flask, Flask-CORS, waitress)...")
    try:
        pip_install(*reqs)
    except subprocess.CalledProcessError:
        warn("pip couldn't install the server's packages (see above).")


def own_ytdlp() -> None:
    if importlib.util.find_spec("pip") is None:
        warn("this Python has no pip, so MinimalTube can't keep its own yt-dlp (a system-wide one "
             f"is used if there is one). Run the installer itself ({installer_hint()}) instead of install.py.")
        return
    say("Installing MinimalTube's own yt-dlp...")
    done = subprocess.run([sys.executable, "-X", "utf8", "-B", str(PROJECT_DIR / "server.py"), "--update-yt-dlp"])
    if done.returncode:
        warn("yt-dlp didn't install; a system-wide yt-dlp is used if there is one.")


# ---------------------------------------------------------------- ffmpeg, ffprobe, deno
def exe(name: str) -> str:
    return name + ".exe" if WINDOWS else name


def find_tool(name: str) -> str | None:
    own = bin_dir() / exe(name)
    return str(own) if own.is_file() else shutil.which(name)  # PATH includes bin/ (use_own_tools)


def arch() -> str:
    machine = platform.machine().lower()
    return "arm64" if machine in ("arm64", "aarch64") else "x64"


def download(url: str, dest: Path, label: str) -> None:
    """Fetch url into dest, showing how far along it is."""
    req = urllib.request.Request(url, headers=UA)
    try:
        resp = urllib.request.urlopen(req, timeout=60)
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e):
            raise
        # a Python that can't see the system's certificates: pip carries a bundle of them
        import ssl

        from pip._vendor import certifi

        resp = urllib.request.urlopen(req, timeout=60, context=ssl.create_default_context(cafile=certifi.where()))
    with resp, open(dest, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        got, shown = 0, -1
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            got += len(chunk)
            if total and got * 10 // total != shown:
                shown = got * 10 // total
                print(f"\r  {label}: {got * 100 // total}% of {total // (1 << 20)} MB", end="", flush=True)
    if total:
        print(flush=True)


def tool_downloads(missing: set[str]) -> list[tuple[str, str, dict[str, str]]]:
    """What to fetch for the missing tools: (url, label, {name in the zip: file name in bin/})."""
    a = arch()
    out = []
    ffmpegs = missing & {"ffmpeg", "ffprobe"}
    if ffmpegs and WINDOWS:
        # gyan.dev's build (linked from ffmpeg.org): one zip, both programs in its bin/ folder
        out.append(("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", "ffmpeg",
                    {f"bin/{exe(n)}": exe(n) for n in sorted(ffmpegs)}))
    elif ffmpegs:
        # Martin Riedl's builds (linked from ffmpeg.org): one zip per program
        system = "macos" if MACOS else "linux"
        cpu = "arm64" if a == "arm64" else "amd64"
        for n in sorted(ffmpegs):
            out.append((f"https://ffmpeg.martin-riedl.de/redirect/latest/{system}/{cpu}/release/{n}.zip",
                        n, {n: n}))
    if "deno" in missing:
        if WINDOWS:
            triple = "x86_64-pc-windows-msvc"  # also runs on Windows on Arm (emulated)
        elif MACOS:
            triple = "aarch64-apple-darwin" if a == "arm64" else "x86_64-apple-darwin"
        else:
            triple = "aarch64-unknown-linux-gnu" if a == "arm64" else "x86_64-unknown-linux-gnu"
        out.append((f"https://github.com/denoland/deno/releases/latest/download/deno-{triple}.zip",
                    "deno", {exe("deno"): exe("deno")}))
    return out


def tools() -> None:
    """ffmpeg merges and probes downloads; deno runs YouTube's player code for yt-dlp."""
    missing = {n for n in ("ffmpeg", "ffprobe", "deno") if not find_tool(n)}
    for n in ("ffmpeg", "ffprobe", "deno"):
        if n not in missing:
            say(f"{n}: {find_tool(n)}")
    if not missing:
        return
    say(f"Not on this system, so MinimalTube gets its own: {', '.join(sorted(missing))}")
    target = bin_dir()
    target.mkdir(parents=True, exist_ok=True)
    for url, label, members in tool_downloads(missing):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "download.zip"
            try:
                download(url, archive, label)
                with zipfile.ZipFile(archive) as z:
                    for want, name in members.items():
                        # match by the end of the path: zips put the programs in a folder of their own
                        entry = next((i for i in z.namelist() if i == want or i.endswith("/" + want)), None)
                        if not entry:
                            raise RuntimeError(f"{want} isn't in the download")
                        dest = target / name
                        with z.open(entry) as src, open(dest.with_suffix(".tmp"), "wb") as out:
                            shutil.copyfileobj(src, out)
                        os.replace(dest.with_suffix(".tmp"), dest)
                        if not WINDOWS:
                            dest.chmod(0o755)
                        say(f"  {name} -> {dest}")
            except Exception as e:
                warn(f"couldn't get {label} ({e}). Install it yourself and run the installer again.")


# ---------------------------------------------------------------- browsers
# The Chromium-based browsers MinimalTube knows, per OS. A browser that isn't listed still works
# when it is given by hand (MINIMALTUBE_BROWSER) and keeps its native hosts where Chromium does.
LINUX_BROWSERS = [
    # name, its folder in ~/.config, its programs, what its app windows' names start with
    ("Google Chrome", "google-chrome", ["google-chrome-stable", "google-chrome"], "chrome"),
    ("Google Chrome Beta", "google-chrome-beta", ["google-chrome-beta"], "chrome"),
    ("Google Chrome Dev", "google-chrome-unstable", ["google-chrome-unstable"], "chrome"),
    ("Chromium", "chromium", ["chromium", "chromium-browser", "ungoogled-chromium"], "chrome"),
    ("Brave", "BraveSoftware/Brave-Browser", ["brave", "brave-browser", "brave-browser-stable"], "brave"),
    ("Brave Beta", "BraveSoftware/Brave-Browser-Beta", ["brave-browser-beta"], "brave"),
    ("Vivaldi", "vivaldi", ["vivaldi-stable", "vivaldi"], "vivaldi"),
    ("Microsoft Edge", "microsoft-edge", ["microsoft-edge-stable", "microsoft-edge"], "msedge"),
    ("Opera", "opera", ["opera"], None),
]
MACOS_BROWSERS = [
    # name, its folder in ~/Library/Application Support, its .app (and program in it)
    ("Google Chrome", "Google/Chrome", "Google Chrome"),
    ("Google Chrome Beta", "Google/Chrome Beta", "Google Chrome Beta"),
    ("Chromium", "Chromium", "Chromium"),
    ("Brave", "BraveSoftware/Brave-Browser", "Brave Browser"),
    ("Vivaldi", "Vivaldi", "Vivaldi"),
    ("Microsoft Edge", "Microsoft Edge", "Microsoft Edge"),
    ("Opera", "com.operasoftware.Opera", "Opera"),
]
WINDOWS_BROWSERS = [
    # name, its user data folder (under %LOCALAPPDATA% unless "roaming"), its registry path (None:
    # it reads Chrome's), its name under "App Paths", where its program may be
    ("Google Chrome", "Google/Chrome/User Data", r"Software\Google\Chrome", "chrome.exe",
     ["Google/Chrome/Application/chrome.exe"]),
    ("Chromium", "Chromium/User Data", r"Software\Chromium", None, ["Chromium/Application/chrome.exe"]),
    ("Brave", "BraveSoftware/Brave-Browser/User Data", r"Software\BraveSoftware\Brave-Browser", "brave.exe",
     ["BraveSoftware/Brave-Browser/Application/brave.exe"]),
    ("Vivaldi", "Vivaldi/User Data", r"Software\Vivaldi", "vivaldi.exe", ["Vivaldi/Application/vivaldi.exe"]),
    ("Microsoft Edge", "Microsoft/Edge/User Data", r"Software\Microsoft\Edge", "msedge.exe",
     ["Microsoft/Edge/Application/msedge.exe"]),
    ("Opera", "roaming:Opera Software/Opera Stable", None, "opera.exe", ["Programs/Opera/opera.exe"]),
]
# Every Chromium-based browser on Windows also looks under these, whatever its own name is.
WINDOWS_SHARED_KEYS = [r"Software\Google\Chrome", r"Software\Chromium", r"Software\Microsoft\Edge"]
SNAP_BIN = Path("/snap/bin")  # where snaps' programs are: a browser found there is a snap
# Browsers as Flatpaks keep their folders in ~/.var/app: they are found only to say they can't be used.
FLATPAK_BROWSERS = {
    "com.google.Chrome": "Google Chrome", "org.chromium.Chromium": "Chromium",
    "io.github.ungoogled_software.ungoogled_chromium": "ungoogled-chromium",
    "com.brave.Browser": "Brave", "com.microsoft.Edge": "Microsoft Edge", "com.vivaldi.Vivaldi": "Vivaldi",
    "com.opera.Opera": "Opera",
}


def browsers() -> list[dict]:
    """The Chromium-based browsers found on this machine, each as a dict:

        name     what to call it
        data     its user data folder: where Linux and macOS keep native hosts, and its profiles
        exe      its program (None: its folder is there, the program wasn't found)
        reg      Windows: its registry path (None: it reads the shared ones)
        wm       Linux: what its app windows' names start with (None: not known)
        sandbox  Linux: "snap" for a confined browser, which can't run the native host
    """
    home = Path.home()
    found = []
    if WINDOWS:
        local = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
        roaming = Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming")
        roots = [Path(os.environ[v]) for v in ("PROGRAMFILES", "PROGRAMFILES(X86)") if os.environ.get(v)]
        for name, data, reg, app_path, rels in WINDOWS_BROWSERS:
            folder = roaming / data[len("roaming:"):] if data.startswith("roaming:") else local / data
            program = windows_app_path(app_path) if app_path else None
            if not program:
                program = next((str(r / rel) for r in [local, *roots] for rel in rels if (r / rel).is_file()), None)
            found.append({"name": name, "data": folder, "reg": reg, "exe": program})
    elif MACOS:
        support = home / "Library" / "Application Support"
        for name, data, app in MACOS_BROWSERS:
            bundles = [Path("/Applications") / f"{app}.app", home / "Applications" / f"{app}.app"]
            program = next((str(b / "Contents/MacOS" / app) for b in bundles if (b / "Contents/MacOS" / app).is_file()), None)
            found.append({"name": name, "data": support / data, "exe": program})
    else:
        config = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
        for name, data, programs, wm in LINUX_BROWSERS:
            program = next((shutil.which(b) for b in programs if shutil.which(b)), None)
            browser = {"name": name, "data": config / data, "exe": program, "wm": wm, "sandbox": None}
            if program and Path(program).parent == SNAP_BIN:
                # a snap keeps its folders to itself, and can't start programs outside it
                mine = home / "snap" / Path(program).name
                folders = [mine / "common" / data, mine / "current" / ".config" / data]
                browser.update(name=f"{name} (snap)", sandbox="snap",
                               data=next((f for f in folders if f.is_dir()), folders[0]))
            found.append(browser)
    return [b for b in found if b["data"].is_dir() or b["exe"]]


def flatpak_browsers() -> list[str]:
    """Names of the Chromium-based browsers installed as Flatpaks (Linux)."""
    if WINDOWS or MACOS:
        return []
    apps = Path.home() / ".var" / "app"
    return [name for app_id, name in FLATPAK_BROWSERS.items() if (apps / app_id).is_dir()]


def windows_app_path(program: str) -> str | None:
    """Where Windows' "App Paths" says a program is (how Run / Start find chrome.exe)."""
    import winreg

    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            path = winreg.QueryValue(hive, rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{program}")
        except OSError:
            continue
        path = path.strip('"')
        if path and Path(path).is_file():
            return path
    return None


def has_extension(browser: dict, ext_id: str) -> bool:
    for name in ("Preferences", "Secure Preferences"):
        for prefs in browser["data"].glob(f"*/{name}"):
            try:
                if ext_id.encode() in prefs.read_bytes():
                    return True
            except OSError:
                pass
    return False


# ---------------------------------------------------------------- native host
def host_launcher() -> Path:
    """A launcher the browser can start: it runs minimaltube_host.py with this Python."""
    folder = app_dir()
    folder.mkdir(parents=True, exist_ok=True)
    host = PROJECT_DIR / "minimaltube_host.py"
    if WINDOWS:
        # Windows starts native hosts through cmd.exe, which reads a .bat in the console's code
        # page: a non-English user name in a path would break it. So the .bat only has paths it
        # works out itself (%~dp0: its own folder), and a Python stub (UTF-8) knows the rest.
        write_if_changed(
            folder / "minimaltube-host.py",
            "# Written by MinimalTube's installer: starts the native host from MinimalTube's folder.\n"
            "import runpy, sys\n"
            "sys.dont_write_bytecode = True\n"
            f"HOST = {str(host)!r}\n"
            "sys.argv[0] = HOST\n"
            "runpy.run_path(HOST, run_name='__main__')\n")
        python = "%~dp0python\\python.exe" if own_python_in_use() else sys.executable.replace("%", "%%")
        bat = folder / "minimaltube-host.bat"
        write_if_changed(
            bat,
            "@echo off\r\n"
            "rem Written by MinimalTube's installer: runs the native host with the server's Python.\r\n"
            f'"{python}" -X utf8 -B "%~dp0minimaltube-host.py" %*\r\n', encoding="ascii")
        return bat
    script = folder / "minimaltube-host"
    write_if_changed(
        script,
        "#!/bin/sh\n"
        "# Written by MinimalTube's installer: runs the native host with the server's Python.\n"
        f"exec {shlex.quote(sys.executable)} -X utf8 -B {shlex.quote(str(host))} \"$@\"\n")
    script.chmod(0o755)
    return script


def register_host(ids: list[str], found: list[dict]) -> None:
    launcher = host_launcher()
    manifest = {
        "name": HOST_NAME,
        "description": "MinimalTube: start the local server",
        # Windows reads a path relative to this file; the others need it absolute
        "path": launcher.name if WINDOWS else str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{i}/" for i in ids],
    }
    text = json.dumps(manifest, indent=2) + "\n"
    if WINDOWS:
        import winreg

        path = app_dir() / f"{HOST_NAME}.json"
        write_if_changed(path, text)
        # under each browser's own key, and under the ones every Chromium-based browser reads
        # (Brave, Vivaldi and Opera look there; a browser installed later finds it there too)
        keys = dict.fromkeys([b["reg"] for b in found if b.get("reg")] + WINDOWS_SHARED_KEYS)
        for key in keys:
            try:
                winreg.SetValue(winreg.HKEY_CURRENT_USER, rf"{key}\NativeMessagingHosts\{HOST_NAME}",
                                winreg.REG_SZ, str(path))
            except OSError as e:
                warn(f"couldn't register the native host under {key}: {e}")
        say(f"Native host registered for {', '.join(b['name'] for b in found) or 'Chromium-based browsers'}")
        return
    for b in found:
        if not b["data"].is_dir():
            continue  # installed but never started: it has no folder yet (run this again after)
        folder = b["data"] / "NativeMessagingHosts"
        try:
            folder.mkdir(parents=True, exist_ok=True)
            write_if_changed(folder / f"{HOST_NAME}.json", text)
            say(f"Native host registered for {b['name']} ({folder})")
        except OSError as e:
            warn(f"couldn't register the native host for {b['name']}: {e}")


# ---------------------------------------------------------------- app launcher
def pick_browser(found: list[dict], ext_id: str) -> dict | None:
    forced = os.environ.get("MINIMALTUBE_BROWSER")
    if forced:
        return {"name": Path(forced).stem, "exe": forced, "wm": None, "sandbox": None}
    with_exe = [b for b in found if b["exe"]]
    # the browser that already has the extension, else the first one found
    return next((b for b in with_exe if has_extension(b, ext_id)), with_exe[0] if with_exe else None)


def write_ico(dest: Path) -> None:
    """An .ico of the PNG icons (Windows reads PNG images inside an .ico)."""
    images = [(s, (EXTENSION_DIR / "icons" / f"icon{s}.png").read_bytes())
              for s in (16, 32, 48, 64, 128, 256) if (EXTENSION_DIR / "icons" / f"icon{s}.png").is_file()]
    offset = 6 + 16 * len(images)
    head, body = struct.pack("<HHH", 0, 1, len(images)), b""
    for size, png in images:
        head += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset + len(body))
        body += png
    dest.write_bytes(head + body)


def launcher_linux(browser: dict, ext_id: str) -> str:
    apps = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "applications"
    apps.mkdir(parents=True, exist_ok=True)
    icon = EXTENSION_DIR / "icons" / "icon128.png"
    app_url = f"chrome-extension://{ext_id}/player.html"
    command = f'"{browser["exe"]}" --app={app_url}'
    if browser.get("sandbox"):
        # A confined browser can't run the native host, so the extension can't start the server:
        # the menu entry starts it (the same host, by hand), then the browser.
        opener = app_dir() / "minimaltube-open"
        write_if_changed(
            opener,
            "#!/bin/sh\n"
            "# Written by MinimalTube's installer: starts the server, then the player in the browser\n"
            "# (a sandboxed browser can't start the server itself).\n"
            f"{shlex.quote(str(host_launcher()))} --start-server\n"
            f"exec {shlex.quote(browser['exe'])} --app={app_url}\n")
        opener.chmod(0o755)
        command = f'"{opener}"'
    # No --window-size: when this entry is what starts the browser, Chromium gives every window that
    # size instead of the one it saved, and the player would have to resize it on each open.
    entry = ("[Desktop Entry]\n"
             "Type=Application\n"
             "Name=MinimalTube\n"
             "Comment=Minimal YouTube player\n"
             f"Exec={command}\n"
             f"Icon={icon if icon.is_file() else 'video-x-generic'}\n"
             "Terminal=false\n"
             "Categories=AudioVideo;Video;Player;\n")
    if browser.get("wm"):
        # how the desktop matches the player's window to this entry (its icon in the task bar)
        entry += f"StartupWMClass={browser['wm']}-{ext_id}__player.html-Default\n"
    write_if_changed(apps / "minimaltube.desktop", entry)
    for refresh in (["update-desktop-database", str(apps)], ["kbuildsycoca6"], ["kbuildsycoca5"]):
        if shutil.which(refresh[0]):
            subprocess.run(refresh, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return "your application menu"


def launcher_macos(browser: dict, ext_id: str) -> str:
    app = Path.home() / "Applications" / "MinimalTube.app"
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True, exist_ok=True)
    (contents / "Resources").mkdir(parents=True, exist_ok=True)
    version = json.loads((EXTENSION_DIR / "manifest.json").read_text(encoding="utf-8")).get("version", "1.0")
    with open(contents / "Info.plist", "wb") as f:
        plistlib.dump({
            "CFBundleName": "MinimalTube",
            "CFBundleDisplayName": "MinimalTube",
            "CFBundleIdentifier": "com.minimaltube.launcher",
            "CFBundleExecutable": "MinimalTube",
            "CFBundlePackageType": "APPL",
            "CFBundleIconFile": "MinimalTube",
            "CFBundleShortVersionString": version,
            "LSUIElement": True,  # it only asks the browser for the window and quits: no Dock icon of its own
        }, f)
    run = contents / "MacOS" / "MinimalTube"
    # The browser's own program, not `open -a`: a running browser ignores open's --args, while
    # its program hands the command line over to the running one.
    run.write_text(
        "#!/bin/sh\n"
        "# Written by MinimalTube's installer: opens the player as an app window of the browser.\n"
        f"{shlex.quote(browser['exe'])} --app=chrome-extension://{ext_id}/player.html >/dev/null 2>&1 &\n",
        encoding="utf-8")
    run.chmod(0o755)
    if shutil.which("iconutil"):
        with tempfile.TemporaryDirectory() as tmp:
            iconset = Path(tmp) / "MinimalTube.iconset"
            iconset.mkdir()
            for name, size in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64),
                               ("128x128", 128), ("128x128@2x", 256), ("256x256", 256)]:
                src = EXTENSION_DIR / "icons" / f"icon{size}.png"
                if src.is_file():
                    shutil.copyfile(src, iconset / f"icon_{name}.png")
            made = subprocess.run(["iconutil", "-c", "icns", "-o", str(contents / "Resources" / "MinimalTube.icns"),
                                   str(iconset)], capture_output=True, text=True)
            if made.returncode:
                warn(f"the app has no icon (iconutil: {made.stderr.strip()})")
    os.utime(app)  # Finder picks the new icon up
    return f"{app} (Launchpad / Spotlight: MinimalTube)"


def launcher_windows(browser: dict, ext_id: str) -> str:
    icon = app_dir() / "minimaltube.ico"
    write_ico(icon)
    programs = Path(os.environ.get("APPDATA") or Path.home() / "AppData/Roaming") / "Microsoft/Windows/Start Menu/Programs"
    programs.mkdir(parents=True, exist_ok=True)
    link = programs / "MinimalTube.lnk"
    # A .lnk is made through Windows' shell (COM); the values go in through the environment, so
    # no quoting can go wrong with them.
    script = ("$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:MT_LINK); "
              "$s.TargetPath = $env:MT_TARGET; $s.Arguments = $env:MT_ARGS; "
              "$s.IconLocation = $env:MT_ICON; $s.Description = 'MinimalTube'; $s.Save()")
    env = dict(os.environ, MT_LINK=str(link), MT_TARGET=browser["exe"],
               MT_ARGS=f"--app=chrome-extension://{ext_id}/player.html", MT_ICON=f"{icon},0")
    subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-Command", script], env=env, check=True, capture_output=True)
    return "the Start menu"


def app_launcher(found: list[dict], ext_id: str) -> None:
    browser = pick_browser(found, ext_id)
    if not browser:
        warn("no Chromium-based browser found, so there's no MinimalTube shortcut "
             "(set MINIMALTUBE_BROWSER to the browser's program and run this again).")
        return
    try:
        where = (launcher_windows if WINDOWS else launcher_macos if MACOS else launcher_linux)(browser, ext_id)
        say(f"Added MinimalTube to {where}, opening in {browser['name']}.")
    except Exception as e:
        warn(f"couldn't add the MinimalTube shortcut: {e}")


# ---------------------------------------------------------------- main
def main(argv: list[str]) -> int:
    use_own_tools()
    ids = extension_ids(argv)
    say(f"Extension ID: {ids[0]}")
    say(f"Python for the server: {sys.executable}"
        + (" (MinimalTube's own)" if own_python_in_use() else ""))
    if not (PROJECT_DIR / "server.py").is_file():
        warn(f"server.py isn't in {PROJECT_DIR}: the extension can't start the server.")
    server_packages()
    own_ytdlp()
    tools()
    found = browsers()
    if not found:
        warn("no Chromium-based browser found (Chrome, Chromium, Brave, Vivaldi, Edge, Opera).")
    register_host(ids, found)
    app_launcher(found, ids[0])
    sandboxed = [b["name"] for b in found if b.get("sandbox")]
    if sandboxed:
        say(f"Note: {', '.join(sandboxed)} runs in a sandbox and can't start MinimalTube's server by itself. "
            "Start MinimalTube from your application menu (that entry starts the server first), "
            "or use a browser installed as a normal package.")
    flatpaks = flatpak_browsers()
    if flatpaks:
        say(f"Note: found as Flatpak: {', '.join(flatpaks)}. A Flatpak browser can't start MinimalTube's "
            "server, and may not be allowed to read this folder: use one installed as a normal package.")
    say()
    if problems:
        say("Finished, with warnings (above).")
    else:
        say("Done.")
    say("If MinimalTube isn't in your browser yet: open chrome://extensions, turn on Developer mode,")
    say(f"click Load unpacked and pick this folder: {EXTENSION_DIR}")
    say("If it is: reload it there.")
    return 1 if problems and not found else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
