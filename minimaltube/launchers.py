"""MinimalTube - the installed app's icon in the colour theme picked in Settings.

The installer makes the app's launcher (Linux: a .desktop entry, Windows: a Start-menu shortcut,
macOS: ~/Applications/MinimalTube.app); this module gives it the icon of a theme, from the installer
and from the server when Settings changes the theme (PUT /launcher-icon). The theme is kept in the
data folder's settings.json ("launcher_theme"), so running the installer again keeps it. The theme
is per browser profile; the launcher is the computer account's, so the last pick wins there.
"""
from __future__ import annotations  # `str | None` annotations on Python 3.9

import os
import re
import shutil
import subprocess
import struct
import tempfile
from pathlib import Path

from .jsonfile import read_json, write_json_atomic
from .system import EXTENSION_DIR, MACOS, WINDOWS, app_dir, data_dir

THEMES = ("violet", "crimson", "clay", "mint", "sky", "sakura")  # js/common.js THEMES
ICON_SIZES = (16, 32, 48, 64, 128, 256, 512)


def icon_file(theme: str, size: int) -> Path:
    """The PNG logo of a theme.

    Args:
        theme (str): One of THEMES; anything else gives Violet's.
        size (int): One of ICON_SIZES.

    Returns:
        Path: extension/icons/themes/<theme>/icon<size>.png
    """
    return EXTENSION_DIR / "icons" / "themes" / (theme if theme in THEMES else "violet") / f"icon{size}.png"


def _settings_path() -> Path:
    return data_dir() / "settings.json"


def saved_theme() -> str:
    """The theme the launcher has, from settings.json: Violet unless Settings picked another."""
    theme = read_json(_settings_path(), {}).get("launcher_theme")
    return theme if theme in THEMES else "violet"


def write_ico(dest: Path, theme: str) -> None:
    """Write an .ico of a theme's logo (Windows reads PNG images inside an .ico).

    Args:
        dest (Path): The .ico to (re)write.
        theme (str): One of THEMES.
    """
    images = [(s, icon_file(theme, s).read_bytes()) for s in (16, 32, 48, 64, 128, 256) if icon_file(theme, s).is_file()]
    offset = 6 + 16 * len(images)
    head, body = struct.pack("<HHH", 0, 1, len(images)), b""
    for size, png in images:
        head += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset + len(body))
        body += png
    dest.write_bytes(head + body)


def windows_ico(theme: str) -> Path:
    """The .ico the Windows shortcuts use for a theme, in the app folder, written when missing.
    Each theme has its own file name, so Windows' icon cache can't show the old picture under it."""
    ico = app_dir() / f"minimaltube-{theme if theme in THEMES else 'violet'}.ico"
    if not ico.is_file():
        app_dir().mkdir(parents=True, exist_ok=True)
        write_ico(ico, theme)
    return ico


def write_icns(app: Path, theme: str) -> str | None:
    """Give a macOS app bundle a theme's icon (Contents/Resources/MinimalTube.icns, by iconutil).

    Args:
        app (Path): The .app bundle.
        theme (str): One of THEMES.

    Returns:
        str | None: None when done, else what went wrong (iconutil missing or failing).
    """
    if not shutil.which("iconutil"):
        return "iconutil isn't there"
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "MinimalTube.iconset"
        iconset.mkdir()
        for name, size in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                           ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512)]:
            if icon_file(theme, size).is_file():
                shutil.copyfile(icon_file(theme, size), iconset / f"icon_{name}.png")
        (app / "Contents" / "Resources").mkdir(parents=True, exist_ok=True)
        made = subprocess.run(["iconutil", "-c", "icns", "-o", str(app / "Contents" / "Resources" / "MinimalTube.icns"),
                               str(iconset)], capture_output=True, text=True)
    if made.returncode:
        return made.stderr.strip() or "iconutil failed"
    os.utime(app)  # Finder picks the new icon up
    return None


def linux_apps_dir() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "applications"


def refresh_linux_menus(apps: Path) -> None:
    """Tell the desktop (KDE, GNOME, ...) that the .desktop entries in `apps` changed."""
    for refresh in (["update-desktop-database", str(apps)], ["kbuildsycoca6"], ["kbuildsycoca5"]):
        if shutil.which(refresh[0]):
            subprocess.run(refresh, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def macos_app() -> Path:
    return Path.home() / "Applications" / "MinimalTube.app"


def windows_shortcuts() -> list[Path]:
    """The Start-menu shortcut and a taskbar pin of it, those that exist."""
    roaming = Path(os.environ.get("APPDATA") or Path.home() / "AppData/Roaming")
    places = [roaming / "Microsoft/Windows/Start Menu/Programs/MinimalTube.lnk",
              roaming / "Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar/MinimalTube.lnk"]
    return [p for p in places if p.is_file()]


def windows_relink(links: list[Path], ico: Path) -> None:
    """Point Windows shortcuts (.lnk) at an .ico and tell the shell, so the Start menu and a taskbar
    pin show it. Raises on failure (PowerShell's COM call)."""
    # Saved again through Windows' shell (COM), the paths passed through the environment; then each
    # is announced with SHChangeNotify(SHCNE_UPDATEITEM), which also refreshes a taskbar pin.
    script = ("foreach ($p in $env:MT_LINKS.Split('|')) { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($p); "
              "$s.IconLocation = $env:MT_ICON; $s.Save() }")
    env = dict(os.environ, MT_LINKS="|".join(map(str, links)), MT_ICON=f"{ico},0")
    subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                   env=env, check=True, capture_output=True)
    import ctypes
    shell32 = ctypes.windll.shell32
    for link in links:
        shell32.SHChangeNotify(0x00002000, 0x0005, ctypes.c_wchar_p(str(link)), None)  # UPDATEITEM, PATHW
    shell32.SHChangeNotify(0x08000000, 0x0000, None, None)  # ASSOCCHANGED: icon caches in general


def set_launcher_theme(theme: str) -> dict:
    """Remember a theme for the launcher and give the installed launcher its icon now.

    Args:
        theme (str): One of THEMES (the caller checked it).

    Returns:
        dict: {"theme", "updated": bool, "note": str | None}. "updated" is False when no launcher
        is installed (the installer gives it the remembered theme later); "note" says when the
        system may show the old icon for a while.

    Raises:
        OSError: settings.json couldn't be written.
        RuntimeError: the launcher couldn't be changed (the message says why).
    """
    settings = read_json(_settings_path(), {})
    settings["launcher_theme"] = theme
    if not write_json_atomic(_settings_path(), settings, "settings"):
        raise OSError("couldn't save the theme")
    note = None
    if WINDOWS:
        links = windows_shortcuts()
        if not links:
            return {"theme": theme, "updated": False, "note": None}
        try:
            windows_relink(links, windows_ico(theme))
        except Exception as e:
            raise RuntimeError(f"couldn't change the shortcut's icon ({e})") from e
        note = ("The Start menu shows the new icon now. If the taskbar keeps the old one, run "
                "install-windows.cmd again.")
    elif MACOS:
        app = macos_app()
        if not app.is_dir():
            return {"theme": theme, "updated": False, "note": None}
        problem = write_icns(app, theme)
        if problem:
            raise RuntimeError(f"couldn't change the app's icon ({problem})")
        note = "The Dock may show the old icon until it restarts (or until you log in again)."
    else:
        entry = linux_apps_dir() / "minimaltube.desktop"
        try:
            text = entry.read_text(encoding="utf-8")
        except OSError:
            return {"theme": theme, "updated": False, "note": None}
        new = re.sub(r"(?m)^Icon=.*$", f"Icon={icon_file(theme, 256)}", text)
        if new != text:
            entry.write_text(new, encoding="utf-8")
            refresh_linux_menus(entry.parent)
    return {"theme": theme, "updated": True, "note": note}
