#!/usr/bin/env bash
set -u
set -o pipefail

# Beehive optional Discord artwork stack: Music Presence + loon + Bore.
# Arch Linux / systemd-user setup. Bore is intentionally used as a testing
# tunnel, matching loon's documented basic-deployment test setup.

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/beehive-music-presence"
LOON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/beehive-loon"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$STATE_DIR" "$SERVICE_DIR"

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nWARNING: %s\n' "$*" >&2; }

[ "$(uname -s)" = Linux ] || { warn "Music Presence/loon setup is Linux-only."; exit 0; }

# This script is setup/installation, not Beehive startup. Once the background
# stack has been configured successfully, subsequent Beehive launches skip it
# completely (and therefore never ask for a sudo password).
SETUP_MARKER="$STATE_DIR/setup-complete"
GLOBAL_INSTALL_MARKER="${XDG_STATE_HOME:-$HOME/.local/state}/beehive/install-complete"
if [ -f "$SETUP_MARKER" ] || [ -f "$GLOBAL_INSTALL_MARKER" ]; then
  exit 0
fi

# If this project was re-extracted but the background services from an earlier
# Beehive installation still exist, setup is already complete. Do not invoke yay
# (which may invoke sudo) just to discover that packages are already installed.
if systemctl --user is-enabled --quiet beehive-loon-https.service 2>/dev/null && \
   systemctl --user is-enabled --quiet beehive-loon-http.service 2>/dev/null && \
   systemctl --user is-enabled --quiet music-presence.service 2>/dev/null; then
  touch "$SETUP_MARKER" "$GLOBAL_INSTALL_MARKER"
  exit 0
fi

if command -v yay >/dev/null 2>&1; then
  say "Installing Music Presence, Bore, Docker and Git (Arch/AUR)"
  yay -S --needed --noconfirm music-presence-bin bore docker git || warn "Some optional packages could not be installed."
elif command -v paru >/dev/null 2>&1; then
  say "Installing Music Presence, Bore, Docker and Git (Arch/AUR)"
  paru -S --needed --noconfirm music-presence-bin bore docker git || warn "Some optional packages could not be installed."
else
  warn "No yay/paru found. Install music-presence-bin and bore, then rerun this setup."
  exit 0
fi

command -v docker >/dev/null 2>&1 || { warn "Docker is unavailable; skipping loon."; exit 0; }
command -v bore >/dev/null 2>&1 || { warn "bore is unavailable; skipping tunnels."; exit 0; }
command -v git >/dev/null 2>&1 || { warn "git is unavailable; skipping loon."; exit 0; }

# Docker is a one-time host service. Do not invoke sudo when it is already active.
if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-active --quiet docker 2>/dev/null; then
    sudo systemctl enable --now docker 2>/dev/null || true
  fi
fi

if [ ! -d "$LOON_DIR/.git" ]; then
  say "Downloading official loon"
  rm -rf "$LOON_DIR"
  git clone --depth 1 https://github.com/ungive/loon.git "$LOON_DIR" || { warn "Could not clone loon."; exit 0; }
else
  git -C "$LOON_DIR" pull --ff-only || true
fi

DEPLOY="$LOON_DIR/deployments/basic-deployment"
[ -d "$DEPLOY" ] || { warn "loon basic deployment is missing."; exit 0; }
cd "$DEPLOY" || exit 0

[ -f caddy.env ] || cp caddy.env.example caddy.env
sed -i 's/^SERVER_DOMAIN=.*/SERVER_DOMAIN=bore.pub/' caddy.env

cat > config.yml <<'YAML'
protocol:
  base_url: http://bore.pub:3648
  chunk_buffer_size: 8
  constraints:
    chunk_size: 65536
    max_content_size: 16777216
    accepted_content_types:
      - image/png
      - image/jpeg
      - text/plain
      - text/html
    cache_duration: 30s
  intervals:
    write_wait: 10s
    pong_wait: 60s
    ping_interval: 48s
    timeout_duration: 30s
    timeout_interval: 8s
http:
  write_timeout: 30s
  read_timeout: 10s
  idle_timeout: 30s
log:
  level: INFO
YAML

say "Starting loon containers"
docker compose up -d || { warn "Could not start loon containers."; exit 0; }

HTTPS_PORT=17341
HTTP_PORT=3648

cat > "$STATE_DIR/start-bore-https.sh" <<'BOREHTTPS'
#!/usr/bin/env bash
set -u
exec bore local 443 --to bore.pub --port 17341
BOREHTTPS
chmod +x "$STATE_DIR/start-bore-https.sh"

cat > "$STATE_DIR/start-bore-http.sh" <<'BOREHTTP'
#!/usr/bin/env bash
set -u
exec bore local 80 --to bore.pub --port 3648
BOREHTTP
chmod +x "$STATE_DIR/start-bore-http.sh"

cat > "$SERVICE_DIR/beehive-loon-https.service" <<SERVICEHTTPS
[Unit]
Description=Beehive loon HTTPS tunnel
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$STATE_DIR/start-bore-https.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICEHTTPS

cat > "$SERVICE_DIR/beehive-loon-http.service" <<SERVICEHTTP
[Unit]
Description=Beehive loon HTTP tunnel
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$STATE_DIR/start-bore-http.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICEHTTP

systemctl --user daemon-reload 2>/dev/null || true
systemctl --user enable --now beehive-loon-https.service beehive-loon-http.service 2>/dev/null || true

MP_BIN=""
if command -v musicpresence >/dev/null 2>&1; then MP_BIN="$(command -v musicpresence)"; elif command -v music-presence >/dev/null 2>&1; then MP_BIN="$(command -v music-presence)"; fi
if [ -n "$MP_BIN" ]; then
  cat > "$SERVICE_DIR/music-presence.service" <<SERVICE
[Unit]
Description=Music Presence Discord Rich Presence
After=graphical-session.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$MP_BIN
Restart=on-failure
RestartSec=3
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
SERVICE
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now music-presence.service 2>/dev/null || true
fi

# Mark setup complete only after all requested configuration steps have run.
# User services continue independently after Beehive exits.
touch "$SETUP_MARKER" "$GLOBAL_INSTALL_MARKER"

say "Music Presence/loon background setup complete"
printf 'HTTPS proxy: wss://bore.pub:%s/ws\n' "$HTTPS_PORT"
printf 'HTTP image base: http://bore.pub:%s\n' "$HTTP_PORT"
printf 'loon directory: %s\n' "$LOON_DIR"
printf '%s\n' 'Music Presence settings are preserved; existing custom proxy settings are not overwritten.'
printf '%s\n' 'Bore is a testing tunnel; a production deployment should use a real public server/domain.'
