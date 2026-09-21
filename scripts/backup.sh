#!/usr/bin/env bash
# Zips the Hive source tree + assets into backups/, tagged with the current
# BUILD number and a timestamp. Excludes node_modules, logs, prior backups,
# and the user's personal "User Data Backup" (listening history etc - not
# source code).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD_NUM="$(tr -d '[:space:]' < BUILD 2>/dev/null || echo unknown)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT/backups"
OUT_FILE="$OUT_DIR/hive-build${BUILD_NUM}-${STAMP}.zip"
KEEP=10

mkdir -p "$OUT_DIR"

zip -r -q "$OUT_FILE" . \
  -x "node_modules/*" \
  -x "logs/*" \
  -x "backups/*" \
  -x "User Data Backup/*" \
  -x ".git/*"

echo "Backup written: $OUT_FILE"

# Prune to the $KEEP most recent backups.
mapfile -t OLD < <(ls -1t "$OUT_DIR"/hive-build*.zip 2>/dev/null | tail -n +$((KEEP + 1)))
if [ "${#OLD[@]}" -gt 0 ]; then
  rm -f "${OLD[@]}"
  echo "Pruned ${#OLD[@]} old backup(s)"
fi
