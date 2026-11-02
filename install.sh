#!/usr/bin/env bash
# MinimalTube installer. Double-click it (or run ./install.sh) once, and again if
# you move this folder or the extension gets a different ID.
#
# >>> Paste your extension ID between the quotes below. <<<
# It is shown on the extension's card at chrome://extensions (Developer mode on).
EXTENSION_ID="najlipoidlccffplgbdpgphoofloojkp"
#
# (You can also pass IDs on the command line: ./install.sh <id> [<id> ...])
#
# What it does:
#   1. registers minimaltube_host.py as a native messaging host, so the extension can
#      start server.py automatically
#   2. adds MinimalTube to the application menu (opens the player as an app window; the
#      extension starts the server when the player opens)
set -euo pipefail

# Started by double-click (no terminal)? Re-launch inside one so output is visible.
if [ ! -t 1 ] && [ -z "${MINIMALTUBE_IN_TERMINAL:-}" ]; then
  export MINIMALTUBE_IN_TERMINAL=1
  self="$(readlink -f "${BASH_SOURCE[0]}")"
  for term in konsole gnome-terminal kgx xfce4-terminal mate-terminal lxterminal alacritty kitty xterm; do
    if command -v "$term" >/dev/null 2>&1; then
      case "$term" in
        gnome-terminal|kgx) exec "$term" -- bash "$self" "$@" ;;
        xfce4-terminal|mate-terminal|lxterminal) exec "$term" -e "bash '$self'" ;;
        *) exec "$term" -e bash "$self" "$@" ;;
      esac
    fi
  done
fi

# Keep the window open at the end so the result can be read.
if [ -t 0 ] && [ -t 1 ]; then
  trap 'echo; read -rp "Press Enter to close..." _' EXIT
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$DIR/minimaltube_host.py"
HOST_NAME="com.minimaltube.host"

chmod +x "$HOST_PATH"

# ---- extension IDs -----------------------------------------------------------
IDS=("$@")
[ -n "${EXTENSION_ID:-}" ] && IDS+=("$EXTENSION_ID")
if [ "${#IDS[@]}" -eq 0 ] && [ -t 0 ]; then
  echo "Open chrome://extensions, enable Developer mode and copy the ID of MinimalTube."
  read -rp "Extension ID: " typed
  [ -n "$typed" ] && IDS=("$typed")
fi
for id in "${IDS[@]}"; do
  if ! [[ "$id" =~ ^[a-p]{32}$ ]]; then
    echo "Error: '$id' doesn't look like a Chrome extension ID (32 letters a-p)." >&2
    exit 1
  fi
done
if [ "${#IDS[@]}" -eq 0 ]; then
  echo "Error: no extension ID given. Paste your ID into EXTENSION_ID at the top of install.sh" >&2
  echo "       (or pass it: ./install.sh <id>) and run it again." >&2
  exit 1
fi
APP_ID="${IDS[0]}"   # the user's own extension ID (used for the Start-menu shortcut)

ORIGINS=""
for id in "${IDS[@]}"; do
  ORIGINS+="${ORIGINS:+, }\"chrome-extension://$id/\""
done

# ---- sanity checks -----------------------------------------------------------
[ -f "$DIR/server.py" ] || echo "Warning: server.py not found next to install.sh - auto-start won't work (or set MINIMALTUBE_SERVER)."
for prog in yt-dlp ffmpeg; do
  command -v "$prog" >/dev/null || echo "Warning: '$prog' not found in PATH"
done
python3 -c "import flask, flask_cors, yt_dlp" 2>/dev/null \
  || echo "Warning: python3 is missing flask / flask-cors / yt-dlp (needed by server.py)."

# ---- native messaging manifest -----------------------------------------------
MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "MinimalTube: start the local server",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
JSON
)

installed=0
for base in \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/google-chrome-beta" \
  "$HOME/.config/chromium" \
  "$HOME/.config/BraveSoftware/Brave-Browser" \
  "$HOME/.config/vivaldi" \
  "$HOME/.config/microsoft-edge"; do
  if [ -d "$base" ]; then
    mkdir -p "$base/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$base/NativeMessagingHosts/$HOST_NAME.json"
    echo "Installed for: $base"
    installed=1
  fi
done

[ "$installed" = 1 ] || echo "No supported browser profile folder found."

# ---- Start-menu shortcut (opens the player as a standalone app window) ---------
pick_browser() {
  local entry cfg bins bin path fallback=""
  local pairs=(
    "$HOME/.config/google-chrome|google-chrome-stable google-chrome"
    "$HOME/.config/google-chrome-beta|google-chrome-beta"
    "$HOME/.config/chromium|chromium chromium-browser"
    "$HOME/.config/BraveSoftware/Brave-Browser|brave brave-browser"
    "$HOME/.config/vivaldi|vivaldi-stable vivaldi"
    "$HOME/.config/microsoft-edge|microsoft-edge-stable microsoft-edge"
  )
  for entry in "${pairs[@]}"; do
    cfg="${entry%%|*}"; bins="${entry#*|}"
    [ -d "$cfg" ] || continue
    for bin in $bins; do
      if command -v "$bin" >/dev/null 2>&1; then
        path="$(command -v "$bin")"
        [ -z "$fallback" ] && fallback="$path"
        # prefer the browser whose profile actually contains this extension
        if grep -qs "$APP_ID" "$cfg"/*/Preferences "$cfg"/*/"Secure Preferences" 2>/dev/null; then
          echo "$path"; return
        fi
        break
      fi
    done
  done
  echo "$fallback"
}

BROWSER_BIN="${MINIMALTUBE_BROWSER:-$(pick_browser)}"
if [ -z "$BROWSER_BIN" ]; then
  echo "Skipped the Start-menu shortcut: no Chromium-based browser found (set MINIMALTUBE_BROWSER=/path/to/browser)."
else
  # The menu entry opens the player as an app window; the player asks the extension to start
  # the server (through the native host above) and sizes its window on the first start.
  rm -f "$DIR/minimaltube-launch.sh" # the generated launcher older versions put here

  ICON="$DIR/icons/icon128.png"
  [ -f "$ICON" ] || ICON="video-x-generic"

  APPS_DIR="$HOME/.local/share/applications"
  mkdir -p "$APPS_DIR"
  cat > "$APPS_DIR/minimaltube.desktop" <<EOF3
[Desktop Entry]
Type=Application
Name=MinimalTube
Comment=Minimal YouTube player
Exec="$BROWSER_BIN" --app=chrome-extension://$APP_ID/player.html --window-size=1280,900
Icon=$ICON
Terminal=false
Categories=AudioVideo;Video;Player;
StartupWMClass=chrome-${APP_ID}__player.html-Default
EOF3
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 >/dev/null 2>&1 || true
  echo "Added 'MinimalTube' to your application menu (using $BROWSER_BIN)."
fi

echo "Done. Reload the extension."
