#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ELECTRON_DIST="$PROJECT_DIR/node_modules/electron/dist"
ELECTRON_LOCAL="$ELECTRON_DIST/electron"
STABLE_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/hive/runtime"
STABLE_ELECTRON="$STABLE_ROOT/Hive"

log() { printf '[Hive launcher] %s\n' "$*"; }

# Hive builds are portable folders, so every build historically had a different
# Electron executable path. Discord consequently saw each build as a different
# game. Keep one stable Linux executable path and point its resources at the
# current build instead. The executable itself is hard-linked when possible so
# /proc/<pid>/exe remains the same path across builds.
#
# The stable binary is named "Hive", not "electron": Discord's own local game
# detection scans running executables, but a plain "electron" binary is
# indistinguishable from the dozens of unrelated non-game Electron apps
# (VS Code, Slack, Signal, Discord itself) that all ship one -- it was never
# offered as a detectable game because of that, even though the path itself
# was already stable. Electron resolves its own resources (locales/, *.pak,
# etc.) from the executable's directory, not its filename, so renaming just
# the binary is safe.
prepare_stable_runtime() {
  [[ -x "$ELECTRON_LOCAL" ]] || { log "Electron is not installed: $ELECTRON_LOCAL" >&2; return 1; }
  mkdir -p "$STABLE_ROOT"
  rm -f -- "$STABLE_ROOT/electron"

  local item name target
  for item in "$ELECTRON_DIST"/*; do
    [[ -e "$item" || -L "$item" ]] || continue
    name="$(basename "$item")"
    if [[ "$name" == "electron" ]]; then
      target="$STABLE_ELECTRON"
      rm -rf -- "$target"
      if ! ln "$item" "$target" 2>/dev/null; then
        cp -f -- "$item" "$target"
      fi
      chmod +x "$target" 2>/dev/null || true
    else
      target="$STABLE_ROOT/$name"
      rm -rf -- "$target"
      ln -s -- "$item" "$target"
    fi
  done

  [[ -x "$STABLE_ELECTRON" ]] || { log "Could not prepare stable Electron runtime." >&2; return 1; }
}

# Discord game detection keys applications by their running executable. Never
# let stale Hive builds compete for that identity. Only kill processes whose
# command line belongs to a Hive build; the normal Spotify desktop process is
# deliberately left alone.
cleanup_old_hive_processes() {
  local current_pid="$$" pid ppid args matched
  local -a victims=()
  while read -r pid ppid args; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" == "$current_pid" ]] && continue
    [[ "$pid" == "1" ]] && continue
    matched=0
    case "$args" in
      *"/Hive-"*"/node_modules/electron/dist/electron"*|\
      *"/Hive-"*"/scripts/spotify-background.sh"*|\
      *"/Hive-"*"/app/workers/database-worker.py"*) matched=1 ;;
    esac
    [[ "$matched" -eq 1 ]] || continue
    victims+=("$pid")
  done < <(ps -eo pid=,ppid=,args=)

  if ((${#victims[@]})); then
    log "Stopping ${#victims[@]} stale Hive process(es) before launch."
    kill -TERM "${victims[@]}" 2>/dev/null || true
    sleep 0.5
    local still=()
    for pid in "${victims[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then still+=("$pid"); fi
    done
    if ((${#still[@]})); then
      log "Force-stopping ${#still[@]} Hive process(es) that did not exit cleanly."
      kill -KILL "${still[@]}" 2>/dev/null || true
    fi
  fi
}

cleanup_old_hive_processes
prepare_stable_runtime

cd -- "$PROJECT_DIR"
export NODE_OPTIONS="--max-old-space-size=8192"
# The Electron binary is intentionally kept at one stable path for Discord
# identity, so app.getPath('exe') is NOT the portable build root. Tell Hive
# explicitly where the current portable folder lives; all userData/session
# storage then stays under this build's data/ directory.
export HIVE_PORTABLE_ROOT="$PROJECT_DIR"
exec "$STABLE_ELECTRON" --js-flags="--max-old-space-size=8192 --expose-gc" "$PROJECT_DIR" "$@"
