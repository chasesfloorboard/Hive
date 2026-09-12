#!/usr/bin/env bash
set -u

# Beehive Linux installer / repair script.
# It deliberately installs npm packages without lifecycle scripts, then
# downloads and installs Electron's binary explicitly. This avoids npm's
# install-scripts policy blocking Electron's postinstall step.

set -o pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR" || exit 1

INSTALL_MARKER="$PROJECT_DIR/.beehive-installed"
GLOBAL_INSTALL_MARKER="${XDG_STATE_HOME:-$HOME/.local/state}/beehive/install-complete"
mkdir -p "$(dirname "$GLOBAL_INSTALL_MARKER")"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js first."
command -v npm >/dev/null 2>&1 || fail "npm is not installed. Install npm first."
command -v unzip >/dev/null 2>&1 || fail "unzip is not installed. On Ubuntu/Debian run: sudo apt install unzip"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  fail "Node.js 18 or newer is required. Found $(node -v)."
fi

if [ ! -f "$INSTALL_MARKER" ] || [ ! -d "$PROJECT_DIR/node_modules" ]; then
  say "Installing Beehive dependencies (Electron scripts intentionally skipped)"
  # dbus-next provides the Linux MPRIS2 service used by Music Presence. It is
  # ordinary JavaScript and needs no native build step.
  npm install --ignore-scripts || fail "npm install failed."

  # node-datachannel ships native libdatachannel WebSocket bindings.  The main
  # dependency install is intentionally --ignore-scripts, so explicitly run only
  # this package's install/rebuild step to fetch its prebuilt N-API binary (or
  # build it when a prebuilt is unavailable).
  if npm ls node-datachannel --depth=0 >/dev/null 2>&1; then
    say "Preparing loon/libdatachannel WebSocket transport"
    npm rebuild node-datachannel --foreground-scripts || fail "node-datachannel native transport setup failed."
  fi
else
  say "Beehive dependencies already installed; skipping npm setup."
fi

# Read the Electron version actually installed by npm.
ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null)" \
  || fail "Electron was not installed by npm."

say "Electron version: $ELECTRON_VERSION"

ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/electron"
if [ -x "$ELECTRON_BIN" ]; then
  say "Electron binary already exists; skipping download."
else
  say "Downloading Electron $ELECTRON_VERSION"
  DOWNLOAD_PATH="$(node - <<'NODE'
const { download } = require('@electron/get');
const version = require('./node_modules/electron/package.json').version;
download(version, { platform: 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64' })
  .then(p => process.stdout.write(p + '\n'))
  .catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
NODE
)" || fail "Electron download failed."

  [ -f "$DOWNLOAD_PATH" ] || fail "Electron download completed but ZIP was not found: $DOWNLOAD_PATH"

  say "Extracting Electron into node_modules/electron/dist"
  mkdir -p "$PROJECT_DIR/node_modules/electron/dist"
  rm -rf "$PROJECT_DIR/node_modules/electron/dist"/*
  unzip -o -q "$DOWNLOAD_PATH" -d "$PROJECT_DIR/node_modules/electron/dist" \
    || fail "Could not extract the Electron ZIP."

  printf '%s' 'electron' > "$PROJECT_DIR/node_modules/electron/path.txt"
  chmod +x "$ELECTRON_BIN" || fail "Could not make Electron executable."
fi

[ -x "$ELECTRON_BIN" ] || fail "Electron binary is still missing: $ELECTRON_BIN"

# Music Presence is the external Discord integration for Beehive.
# This is a one-time machine/user setup. It must NOT run on every Beehive launch.
if [ ! -f "$GLOBAL_INSTALL_MARKER" ]; then
  say "Configuring Music Presence + loon artwork proxy (one-time setup)"
  if [ -x "$PROJECT_DIR/setup-music-presence.sh" ]; then
    "$PROJECT_DIR/setup-music-presence.sh" || printf '\nWARNING: Music Presence/loon setup could not be completed. Beehive installation will continue.\n' >&2
  fi
  # Only the setup script's own successful completion should normally create its
  # persistent marker. If it was already configured externally, the service checks
  # below will still allow future launches without sudo.
else
  say "Music Presence + loon already configured; skipping system setup."
fi

touch "$INSTALL_MARKER"

say "Beehive is installed and ready."
printf '\nProject: %s\nElectron: %s\n\n' "$PROJECT_DIR" "$ELECTRON_VERSION"

# Installing Beehive also launches it. Keep --launch accepted for backwards compatibility.
say "Launching Beehive with live scan logging"
LOG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Beehive"
LOG_FILE="$LOG_DIR/scan-live.log"
mkdir -p "$LOG_DIR"
printf '%s\n' "Live scan log: $LOG_FILE"
printf '%s\n' "The terminal below will show SCAN IPC / WALK / STAT / SCAN START / SCAN WAIT / SCAN DONE / SCAN TIMEOUT events."
printf '%s\n\n' "Leave this terminal open while Beehive is scanning."
export BEEHIVE_LIVE_LOG=1
# Always enable startup diagnostics when launching from the installer.
# This keeps the startup trace available for diagnosing slow/hung launches.
export BEEHIVE_STARTUP_DEBUG=1
# Keep the installer terminal live so a stalled file can be diagnosed without
# needing a developer console. The same log is also persisted to disk.
npm start -- --startup-debug 2>&1 | tee -a "$LOG_FILE"
exit ${PIPESTATUS[0]}
