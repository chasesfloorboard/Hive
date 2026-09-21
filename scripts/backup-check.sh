#!/usr/bin/env bash
# Runs after every Claude Code turn (Stop hook). If the BUILD file has
# changed since the last backup, zips the source tree via backup.sh and
# records the new BUILD number so we don't re-zip on every turn.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CURRENT_BUILD="$(tr -d '[:space:]' < BUILD 2>/dev/null || echo "")"
LAST_BUILD_FILE="backups/.last_build"
mkdir -p backups

LAST_BUILD=""
if [ -f "$LAST_BUILD_FILE" ]; then
  LAST_BUILD="$(cat "$LAST_BUILD_FILE")"
fi

if [ -n "$CURRENT_BUILD" ] && [ "$CURRENT_BUILD" != "$LAST_BUILD" ]; then
  bash scripts/backup.sh
  echo -n "$CURRENT_BUILD" > "$LAST_BUILD_FILE"
fi
