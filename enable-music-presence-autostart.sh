#!/usr/bin/env bash
set -u

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/music-presence.service"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

command -v systemctl >/dev/null 2>&1 || fail "systemctl is required to configure Music Presence autostart."

MUSIC_PRESENCE_BIN=""
for candidate in music-presence musicpresence; do
  if command -v "$candidate" >/dev/null 2>&1; then
    MUSIC_PRESENCE_BIN="$(command -v "$candidate")"
    break
  fi
done

if [ -z "$MUSIC_PRESENCE_BIN" ]; then
  # AUR/package installations can expose the executable under a slightly
  # different basename. Check the usual system locations without assuming one.
  for candidate in /usr/bin/music-presence /usr/bin/musicpresence /opt/music-presence/music-presence; do
    if [ -x "$candidate" ]; then
      MUSIC_PRESENCE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$MUSIC_PRESENCE_BIN" ]; then
  say "Music Presence was not found; skipping autostart setup."
  say "Install music-presence-bin, then run this script again."
  exit 0
fi

mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Music Presence Discord Rich Presence
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=$MUSIC_PRESENCE_BIN
Restart=on-failure
RestartSec=3
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload || fail "Could not reload the user systemd manager."
systemctl --user enable --now music-presence.service || fail "Could not enable/start Music Presence autostart."

say "Music Presence autostart enabled."
printf 'Service: %s\nExecutable: %s\n' "$SERVICE_FILE" "$MUSIC_PRESENCE_BIN"
printf '\nIt will start automatically when you log into your desktop and restart if it exits unexpectedly.\n'
