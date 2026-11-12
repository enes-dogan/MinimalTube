#!/usr/bin/env bash
# MinimalTube installer for Linux and macOS (on Windows: install.cmd). Run it once, and again if
# you move this folder: ./install.sh (on macOS, double-clicking install.command does the same).
#
# It finds the Python the server will run on, then install.py does the rest with it (the server's
# packages and its own yt-dlp; ffmpeg and deno when the system has none; the native host the
# extension starts the server through; MinimalTube in the app menu / Applications):
#   - Linux: the system python3 when it already has everything the server needs (Flask,
#     Flask-CORS and pip, as with your distribution's packages for them); otherwise MinimalTube's
#     own Python. Either way nothing is installed system-wide and nothing needs sudo.
#   - macOS: MinimalTube's own Python (the one macOS comes with is too old)
# MinimalTube's own Python is a standalone CPython build (python-build-standalone) in
# MinimalTube's app folder: no admin rights, nothing installed system-wide.
# (MINIMALTUBE_OWN_PYTHON=1 gives it its own Python on Linux too.)
#
# The extension ID follows from the "key" in manifest.json, so there's nothing to fill in; a copy
# without that key passes its ID: ./install.sh <id> [<id> ...]
set -euo pipefail

OS="$(uname -s)"

# Linux, started by double-click (no terminal)? Re-launch inside one so output is visible.
if [ "$OS" = Linux ] && [ ! -t 1 ] && [ -z "${MINIMALTUBE_IN_TERMINAL:-}" ]; then
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
case "$OS" in
  Darwin) APP_DIR="$HOME/Library/Application Support/MinimalTube" ;;
  *) APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/minimaltube" ;;
esac
OWN_PY="$APP_DIR/python/bin/python3"
# used when GitHub can't be asked for the newest build
PBS_TAG=20261026
PBS_PYTHON=3.13.18

fetch() { # url file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    echo "Error: neither curl nor wget is installed." >&2
    return 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

fetch_own_python() {
  local machine triple tmp url name want got
  machine="$(uname -m)"
  case "$OS-$machine" in
    Darwin-arm64) triple=aarch64-apple-darwin ;;
    Darwin-x86_64) triple=x86_64-apple-darwin ;;
    Linux-x86_64) triple=x86_64-unknown-linux-gnu ;;
    Linux-aarch64|Linux-arm64) triple=aarch64-unknown-linux-gnu ;;
    *)
      echo "Error: there's no ready-made Python for $OS $machine. Install Python 3.10 or newer" >&2
      echo "       with Flask and Flask-CORS, then run this again." >&2
      return 1 ;;
  esac
  echo "Getting MinimalTube's own Python (about 30 MB, once)..."
  tmp="$(mktemp -d)"
  url=""
  if fetch "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest" "$tmp/release.json" 2>/dev/null; then
    url="$(grep -o "\"browser_download_url\": *\"[^\"]*/cpython-3\.13\.[0-9]*%2B[0-9]*-$triple-install_only\.tar\.gz\"" "$tmp/release.json" \
      | head -n 1 | sed -e 's/^.*"\(https:[^"]*\)"$/\1/')" || true
  fi
  [ -n "$url" ] || url="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG/cpython-$PBS_PYTHON%2B$PBS_TAG-$triple-install_only.tar.gz"
  name="$(printf '%s' "${url##*/}" | sed 's/%2B/+/g')"
  fetch "$url" "$tmp/python.tar.gz"
  # the release lists every file's SHA-256: the download has to match it
  if fetch "${url%/*}/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
    want="$(awk -v n="$name" '$2 == n { print $1 }' "$tmp/SHA256SUMS")"
    got="$(sha256_of "$tmp/python.tar.gz")"
    if [ -z "$want" ] || [ "$want" != "$got" ]; then
      echo "Error: the Python download doesn't match its published checksum." >&2
      rm -rf "$tmp"
      return 1
    fi
  else
    echo "Warning: couldn't get the checksums to verify the Python download."
  fi
  tar -xzf "$tmp/python.tar.gz" -C "$tmp"
  mkdir -p "$APP_DIR"
  rm -rf "$APP_DIR/python"
  mv "$tmp/python" "$APP_DIR/python"
  rm -rf "$tmp"
}

if [ "$OS" = Linux ] && [ -z "${MINIMALTUBE_OWN_PYTHON:-}" ] && command -v python3 >/dev/null 2>&1 \
  && python3 -c 'import sys, flask, flask_cors, pip; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
  PY="$(command -v python3)"
else
  if ! "$OWN_PY" -c 'import sys' >/dev/null 2>&1; then
    fetch_own_python
  fi
  PY="$OWN_PY"
fi

# ${1+"$@"}: bash 3.2 (macOS) calls a plain "$@" unset under set -u when there are no arguments
"$PY" -X utf8 -B "$DIR/install.py" ${1+"$@"}
