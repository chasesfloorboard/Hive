#!/usr/bin/env bash
set -u
set -o pipefail

# Hive's self-hosted Discord Rich Presence artwork stack: a loon server
# (https://github.com/ungive/loon), tunneled to the public internet with
# Bore. Arch Linux / systemd-user setup. Bore is intentionally used as a
# testing tunnel, matching loon's documented basic-deployment test setup.
#
# Hive connects to this loon server directly (app/main/loon-client.js +
# app/main/discord-presence.js) and publishes Discord Rich Presence itself
# over the Discord IPC socket -- it does not depend on the separate Music
# Presence application. This script therefore does not install or start
# music-presence.service; if an earlier install left one enabled, Hive and
# it would fight over the same Discord activity.

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/beehive-music-presence"
LOON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/beehive-loon"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# Matches Electron's default Linux userData path for productName "Hive"
# (app.getPath('userData')). A portable install roots userData elsewhere
# (HIVE_PORTABLE_ROOT) and will not see these files; Settings > Discord's
# setup instructions cover that case manually.
HIVE_USER_DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Hive"
# This checkout's own absolute path, for referencing app/main/bore-resume-
# watcher.js later -- resolved from this script's own location rather than
# the caller's cwd so it's correct regardless of how install.sh invoked it.
HIVE_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$STATE_DIR" "$SERVICE_DIR" "$HIVE_USER_DATA_DIR"

# Stop and disable a previous install's music-presence.service. Harmless if
# it was never installed; systemctl --user just reports "not found" quietly.
if systemctl --user is-enabled --quiet music-presence.service 2>/dev/null || systemctl --user is-active --quiet music-presence.service 2>/dev/null; then
  systemctl --user disable --now music-presence.service 2>/dev/null || true
fi

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nWARNING: %s\n' "$*" >&2; }

[ "$(uname -s)" = Linux ] || { warn "Discord Rich Presence (loon) setup is Linux-only."; exit 0; }

# This script is setup/installation, not Beehive startup. Once the background
# stack has been configured successfully, subsequent Beehive launches skip it
# completely (and therefore never ask for a sudo password).
SETUP_MARKER="$STATE_DIR/setup-complete"
GLOBAL_INSTALL_MARKER="${XDG_STATE_HOME:-$HOME/.local/state}/beehive/install-complete"
if [ -f "$SETUP_MARKER" ] || [ -f "$GLOBAL_INSTALL_MARKER" ]; then
  exit 0
fi

# If this project was re-extracted but the background services from an earlier
# Beehive installation still exist, setup is already complete -- as long as
# Hive's own credentials file for talking to that loon server is also still
# there (an older install of this script may have provisioned the tunnels
# without ever writing it). Do not invoke yay (which may invoke sudo) just to
# discover that packages are already installed.
if systemctl --user is-enabled --quiet beehive-loon-https.service 2>/dev/null && \
   systemctl --user is-enabled --quiet beehive-loon-http.service 2>/dev/null && \
   [ -f "$HIVE_USER_DATA_DIR/discord-presence.json" ] && \
   [ -f "$HIVE_USER_DATA_DIR/discord-presence-loon-ca.pem" ]; then
  touch "$SETUP_MARKER" "$GLOBAL_INSTALL_MARKER"
  exit 0
fi

if command -v yay >/dev/null 2>&1; then
  say "Installing Bore, Docker and Git (Arch/AUR)"
  yay -S --needed --noconfirm bore docker git || warn "Some optional packages could not be installed."
elif command -v paru >/dev/null 2>&1; then
  say "Installing Bore, Docker and Git (Arch/AUR)"
  paru -S --needed --noconfirm bore docker git || warn "Some optional packages could not be installed."
else
  warn "No yay/paru found. Install bore, docker and git manually, then rerun this setup."
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

if [ ! -f caddy.env ]; then
  # caddy.env.example ships a fixed, publicly-documented example password
  # ("hiccup", from the Caddyfile's own comment) baked into a bcrypt hash.
  # Using that unmodified would mean every Hive install shares the exact
  # same known basic-auth credential for its loon server's /ws endpoint,
  # so anyone could occupy the connection instead of just this user. Every
  # fresh setup generates and hashes its own random password instead.
  cp caddy.env.example caddy.env
  if command -v docker >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1; then
    GENERATED_PASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)"
    GENERATED_HASH="$(docker run --rm caddy:latest caddy hash-password -p "$GENERATED_PASS" 2>/dev/null)"
    if [ -n "$GENERATED_PASS" ] && [ -n "$GENERATED_HASH" ]; then
      sed -i "s#^HTTP_WS_PASS_BCRYPT=.*#HTTP_WS_PASS_BCRYPT='$GENERATED_HASH'#" caddy.env
      printf '%s\n' "$GENERATED_PASS" > "$STATE_DIR/ws-password"
      chmod 600 "$STATE_DIR/ws-password"
    else
      warn "Could not generate a random loon basic-auth password; using the shared example credential from caddy.env.example."
    fi
  else
    warn "Docker/openssl unavailable while generating loon credentials; using the shared example credential from caddy.env.example."
  fi
fi
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

# bore.pub's free tunnel silently stops forwarding across a suspend/resume
# cycle -- the local bore client stays "active" the whole time, but the
# actual public forwarding is dead until it's restarted (reproduced live).
# Reacting to logind's PrepareForSleep D-Bus signal is more reliable than a
# fixed polling interval and needs no root-level system-sleep hook script.
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ] && [ -f "$HIVE_PROJECT_DIR/app/main/bore-resume-watcher.js" ]; then
  cat > "$SERVICE_DIR/beehive-bore-resume-watcher.service" <<SERVICERESUME
[Unit]
Description=Restart Beehive/Hive bore tunnels after system resume
After=beehive-loon-https.service beehive-loon-http.service
Wants=beehive-loon-https.service beehive-loon-http.service

[Service]
Type=simple
ExecStart=$NODE_BIN $HIVE_PROJECT_DIR/app/main/bore-resume-watcher.js
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
SERVICERESUME
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now beehive-bore-resume-watcher.service 2>/dev/null || true
else
  warn "Node.js not found; skipping the bore resume-watcher (tunnels won't auto-recover after sleep -- rerun this script once Node is available, or restart beehive-loon-https/http.service manually after waking the machine)."
fi

# Wire Hive's own direct loon client (app/main/loon-client.js /
# discord-presence.js) up to what was just provisioned, so a fresh install
# doesn't require anyone to hand-craft these files. Without them,
# discordPresenceConfig.loonUrl in main.js is empty and Discord Rich
# Presence just silently never starts -- no error, no setup prompt.
WS_USER="$(sed -n 's/^HTTP_WS_USER=\(.*\)$/\1/p' caddy.env | tr -d "'\"" | head -n1)"
WS_PASS="hiccup"
[ -f "$STATE_DIR/ws-password" ] && WS_PASS="$(cat "$STATE_DIR/ws-password")"
[ -n "$WS_USER" ] || WS_USER="loon"

cat > "$HIVE_USER_DATA_DIR/discord-presence.json" <<JSON
{
  "loonWsUrl": "wss://${WS_USER}:${WS_PASS}@bore.pub:${HTTPS_PORT}/ws"
}
JSON
chmod 600 "$HIVE_USER_DATA_DIR/discord-presence.json"

# Pin trust to loon's own self-signed local CA (Caddy's `tls internal`)
# instead of disabling TLS verification. The root, not the leaf/intermediate,
# is what stays stable across Caddy's periodic short-lived-intermediate
# rotation -- see app/main/main.js's discord-presence-loon-ca.pem comment.
CA_WRITTEN=0
for attempt in 1 2 3 4 5 6; do
  if docker exec loon-basic-deployment-caddy-1 cat /data/caddy/pki/authorities/local/root.crt > "$HIVE_USER_DATA_DIR/discord-presence-loon-ca.pem" 2>/dev/null \
     && [ -s "$HIVE_USER_DATA_DIR/discord-presence-loon-ca.pem" ]; then
    CA_WRITTEN=1
    break
  fi
  sleep 2
done
if [ "$CA_WRITTEN" -ne 1 ]; then
  rm -f "$HIVE_USER_DATA_DIR/discord-presence-loon-ca.pem"
  warn "Could not extract loon's local CA certificate from the Caddy container yet (it may still be starting). Discord Rich Presence will retry on Hive's next restart; rerun this script if it keeps failing."
fi

# Mark setup complete only after all requested configuration steps have run.
# User services continue independently after Beehive exits.
touch "$SETUP_MARKER" "$GLOBAL_INSTALL_MARKER"

say "Hive Discord Rich Presence (loon) background setup complete"
printf 'HTTPS proxy: wss://bore.pub:%s/ws\n' "$HTTPS_PORT"
printf 'HTTP image base: http://bore.pub:%s\n' "$HTTP_PORT"
printf 'loon directory: %s\n' "$LOON_DIR"
printf 'Hive credentials file: %s/discord-presence.json\n' "$HIVE_USER_DATA_DIR"
if [ "$CA_WRITTEN" -eq 1 ]; then printf 'Hive pinned CA: %s/discord-presence-loon-ca.pem\n' "$HIVE_USER_DATA_DIR"; fi
printf '%s\n' 'One remaining manual step: Hive still needs a Discord Application ID to publish Rich Presence under (Settings > Discord). See docs/ai/HIVE-METADATA-BACKEND-CANON.md-adjacent setup docs -- TODO: point this at the real Discord setup guide once written.'
printf '%s\n' 'Bore is a testing tunnel; a production deployment should use a real public server/domain.'
