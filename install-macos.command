#!/bin/bash
# MinimalTube installer for macOS: double-click this file (and again if you move this folder);
# Terminal opens and runs installer/install.sh, which does the work.
exec bash "$(cd "$(dirname "$0")" && pwd)/installer/install.sh" "$@"
