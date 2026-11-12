#!/usr/bin/env bash
# MinimalTube installer for Linux: run ./install-linux.sh in a terminal, or double-click this file
# (and again if you move this folder). installer/install.sh does the work.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/installer/install.sh" "$@"
