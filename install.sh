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

install_spotify_stack() {
  say "Preparing Spotify + Spicetify integration"

  # Hive does not install Spotify itself. Spotify must already be installed
  # through a trusted distro/package source. SpotX is optional and is never a
  # prerequisite for the Hive Spicetify bridge.
  if command -v spotify >/dev/null 2>&1 || command -v spotify-launcher >/dev/null 2>&1; then
    say "Spotify is already installed; keeping the existing client"
  else
    printf '\nWARNING: Spotify was not found. Hive will not download and execute a remote Spotify installer automatically.\n' >&2
    printf '         Install Spotify through your normal trusted package source, then rerun install.sh.\n' >&2
  fi

  # SpotX is optional. Hive's Spotify integration is the Spicetify bridge;
  # SpotX must never make the installer interactive on every launch.
  hive_spotify_state_dir="${XDG_CONFIG_HOME:-$HOME/.config}/Hive"
  mkdir -p "$hive_spotify_state_dir"
  chmod 700 "$hive_spotify_state_dir" 2>/dev/null || true


  if ! command -v spicetify >/dev/null 2>&1; then
    printf '\nWARNING: Spicetify is not installed. Hive cannot install its Spotify bridge yet.\n' >&2
    printf '         Install Spicetify separately from its official documentation, then rerun install.sh.\n' >&2
  else
    say "Spicetify is already installed"
  fi

  if command -v spicetify >/dev/null 2>&1; then
    mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/spicetify/Extensions"
    bridge_token_dir="${XDG_CONFIG_HOME:-$HOME/.config}/Hive"
    bridge_token_file="$bridge_token_dir/spotify-bridge-token"
    mkdir -p "$bridge_token_dir"
    chmod 700 "$bridge_token_dir" 2>/dev/null || true
    if [ ! -s "$bridge_token_file" ]; then
      if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32 > "$bridge_token_file"
      elif command -v python3 >/dev/null 2>&1; then
        python3 -c 'import secrets; print(secrets.token_hex(32))' > "$bridge_token_file"
      else
        printf '\nWARNING: openssl or python3 is required to create the local Spotify bridge token.\n' >&2
        return 0
      fi
    fi
    chmod 600 "$bridge_token_file" 2>/dev/null || true
    bridge_token="$(tr -d '\r\n' < "$bridge_token_file")"
    if ! printf '%s' "$bridge_token" | grep -Eq '^[A-Fa-f0-9]{64}$'; then
      printf '\nWARNING: Existing Hive Spotify bridge token is invalid; refusing to install the extension.\n' >&2
      return 0
    fi
    sed "s/__HIVE_SPOTIFY_BRIDGE_TOKEN__/$bridge_token/g" \
      "$PROJECT_DIR/resources/spicetify/hive-spotify-bridge.js" > \
      "${XDG_CONFIG_HOME:-$HOME/.config}/spicetify/Extensions/hive-spotify-bridge.js"
    chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/spicetify/Extensions/hive-spotify-bridge.js" 2>/dev/null || true
    spicetify config extensions hive-spotify-bridge.js >/dev/null 2>&1 || true

    # Spicetify cannot apply until Spotify has created its prefs file. Its
    # auto-detection is unreliable on some Arch/launcher installs, so resolve
    # the common native + Flatpak locations ourselves and set prefs_path when
    # one exists. This fixes the installer error:
    #   Cannot detect Spotify "prefs" file location.
    # without asking the user to edit config-xpui.ini manually.
    spotify_prefs=""
    for candidate in \
      "$HOME/.config/spotify/prefs" \
      "$HOME/.var/app/com.spotify.Client/config/spotify/prefs" \
      "$HOME/.var/app/com.spotify.Client/.config/spotify/prefs"; do
      if [ -f "$candidate" ]; then spotify_prefs="$candidate"; break; fi
    done
    if [ -z "$spotify_prefs" ]; then
      spotify_prefs="$(find "$HOME/.config" "$HOME/.var/app" -type f -path '*/spotify/prefs' -print -quit 2>/dev/null || true)"
    fi
    if [ -n "$spotify_prefs" ]; then
      say "Found Spotify prefs: $spotify_prefs"
      spicetify config prefs_path "$spotify_prefs" >/dev/null 2>&1 || printf '\nWARNING: Could not set Spicetify prefs_path automatically.\n' >&2
    else
      printf '\nWARNING: Spotify has not created its prefs file yet. Open Spotify and sign in once, then rerun: spicetify apply\n' >&2
    fi

    # Spicetify must run as the normal user. Discover the actual Spotify
    # installation instead of trusting human-readable output from `spicetify
    # path`. Some Spicetify versions print help text for unsupported path
    # arguments; treating that output as a filesystem path previously produced
    # garbage chmod commands such as "available options: all, userdata".
    #
    # Detection order follows Spicetify's documented configuration and common
    # Linux/Arch installation locations, including spotify-launcher and Flatpak.
    spotify_install_path=""

    is_valid_spotify_dir() {
      local candidate="$1"
      [ -n "$candidate" ] || return 1
      case "$candidate" in
        /*) ;;
        *) return 1 ;;
      esac
      case "$candidate" in
        *$'\033'*|*$'\n'*|*$'\r'*|*" available options: "*|*"Usage:"*|*"usage:"*) return 1 ;;
      esac
      [ -d "$candidate" ] || return 1
      [ -f "$candidate/Apps/xpui.spa" ] || [ -d "$candidate/Apps" ] || return 1
      return 0
    }

    add_spotify_candidate() {
      local candidate="$1"
      candidate="$(printf '%s' "$candidate" | sed $'s/\033\[[0-9;]*[[:alpha:]]//g; s/^[[:space:]]*//; s/[[:space:]]*$//')"
      if is_valid_spotify_dir "$candidate"; then
        candidate="${candidate%/}"
        spotify_install_path="$candidate"
        return 0
      fi
      return 1
    }

    # 1) Reuse Hive's own persisted path first. It is accepted only after the
    # same filesystem validation used for fresh discovery, so a stale/moved
    # Spotify install automatically falls through to rediscovery.
    hive_config_path="$hive_spotify_state_dir/config.json"
    if [ -f "$hive_config_path" ] && command -v python3 >/dev/null 2>&1; then
      configured_hive_spotify_path="$(HIVE_CONFIG_PATH="$hive_config_path" python3 - <<'PYCONF'
import json, os
try:
    with open(os.environ['HIVE_CONFIG_PATH'], encoding='utf-8') as f:
        value = json.load(f).get('spotify', {}).get('installPath', '')
    print(value if isinstance(value, str) else '')
except Exception:
    print('')
PYCONF
)"
      add_spotify_candidate "$configured_hive_spotify_path" || true
    fi

    # 2) Read the configured spotify_path directly from Spicetify's config.
    # `spicetify -c` gives us the authoritative config filename; parsing the
    # key is safer than relying on human-readable path command output.
    if [ -z "$spotify_install_path" ] && command -v spicetify >/dev/null 2>&1; then
      spicetify_config="$(spicetify -c 2>/dev/null || true)"
      if [ -n "$spicetify_config" ] && [ -f "$spicetify_config" ]; then
        configured_spotify_path="$(sed -n 's/^spotify_path[[:space:]]*=[[:space:]]*//p' "$spicetify_config" | head -n 1)"
        add_spotify_candidate "$configured_spotify_path" || true
      fi
    fi

    # 3) Known native/launcher locations documented by Spicetify.
    if [ -z "$spotify_install_path" ]; then
      for candidate in \
        /opt/spotify \
        /usr/share/spotify \
        "$HOME/.local/share/spotify-launcher/install/usr/share/spotify"; do
        if add_spotify_candidate "$candidate"; then break; fi
      done
    fi

    # 4) Flatpak locations. Prefer the actual active deployment reported by
    # Flatpak, then fall back to the standard system/user deployment paths.
    if [ -z "$spotify_install_path" ] && command -v flatpak >/dev/null 2>&1; then
      flatpak_location="$(flatpak info --show-location com.spotify.Client 2>/dev/null || true)"
      if [ -n "$flatpak_location" ]; then
        add_spotify_candidate "$flatpak_location/files/extra/share/spotify" || true
      fi
    fi
    if [ -z "$spotify_install_path" ]; then
      for candidate in \
        "/var/lib/flatpak/app/com.spotify.Client/x86_64/stable/active/files/extra/share/spotify" \
        "$HOME/.local/share/flatpak/app/com.spotify.Client/x86_64/stable/active/files/extra/share/spotify"; do
        if add_spotify_candidate "$candidate"; then break; fi
      done
    fi

    # 5) Last-resort targeted search in user-owned application locations. Do
    # not recursively scan the whole filesystem.
    if [ -z "$spotify_install_path" ]; then
      while IFS= read -r candidate; do
        if add_spotify_candidate "$candidate"; then break; fi
      done < <(find "$HOME/.local/share" "$HOME/.var/app" -type f -path '*/spotify*/Apps/xpui.spa' -printf '%h/..\n' 2>/dev/null | sed 's#//*/#/#g' | sort -u)
    fi

    # Persist the validated path immediately. This is deliberately written
    # before Spicetify apply so the next installer/launcher invocation can use
    # it without asking the user to confirm anything again.
    if [ -n "$spotify_install_path" ]; then
      hive_config_path="$hive_spotify_state_dir/config.json"
      if command -v python3 >/dev/null 2>&1; then
        HIVE_CONFIG_PATH="$hive_config_path" SPOTIFY_INSTALL_PATH="$spotify_install_path" python3 - <<'PYCONF'
import json, os, tempfile
path = os.environ['HIVE_CONFIG_PATH']
spotify_path = os.environ['SPOTIFY_INSTALL_PATH']
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
try:
    with open(path, encoding='utf-8') as f:
        config = json.load(f)
    if not isinstance(config, dict): config = {}
except Exception:
    config = {}
spotify = config.get('spotify')
if not isinstance(spotify, dict): spotify = {}
spotify['installPath'] = spotify_path
config['spotify'] = spotify
fd, tmp = tempfile.mkstemp(prefix='.config.', dir=os.path.dirname(path))
os.chmod(tmp, 0o600)
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)
finally:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
PYCONF
        chmod 600 "$hive_config_path" 2>/dev/null || true
      fi
      # Also persist it in Spicetify's own config so its next invocation uses
      # the same validated location without rediscovery.
      spicetify config spotify_path "$spotify_install_path" >/dev/null 2>&1 || true
    fi

    spicetify_permissions_ok=1
    if [ -n "$spotify_install_path" ]; then
      say "Found Spotify installation: $spotify_install_path"
      printf '    Apps directory: %s/Apps\n' "$spotify_install_path"
      if [ -e "$spotify_install_path/Apps/xpui.spa" ]; then
        printf '    xpui.spa: detected\n'
      fi
      printf '    Owner: %s\n' "$(stat -c '%U:%G' "$spotify_install_path" 2>/dev/null || printf 'unknown')"
      if [ -w "$spotify_install_path" ] && [ -w "$spotify_install_path/Apps" ]; then
        printf '    Write access: yes\n'
      else
        spicetify_permissions_ok=0
        printf '    Write access: no\n'
        printf '\nWARNING: Spotify is installed at %s, but that directory is not writable by the current user.\n' "$spotify_install_path" >&2
        printf '         Spicetify can back up the client but cannot replace its Apps/*.spa files.\n' >&2
        printf '         This is a filesystem-permission issue, not a missing Spotify backup.\n\n' >&2
        if command -v setfacl >/dev/null 2>&1; then
          printf 'Recommended: grant access only to your current user with ACLs:\n' >&2
          printf '  sudo setfacl -m u:%s:rwx %q\n' "$USER" "$spotify_install_path" >&2
          printf '  sudo setfacl -R -m u:%s:rwX %q\n' "$USER" "$spotify_install_path/Apps" >&2
        else
          printf 'Recommended: install ACL tools, then grant access only to your current user:\n' >&2
          printf '  sudo pacman -S acl\n' >&2
          printf '  sudo setfacl -m u:%s:rwx %q\n' "$USER" "$spotify_install_path" >&2
          printf '  sudo setfacl -R -m u:%s:rwX %q\n' "$USER" "$spotify_install_path/Apps" >&2
          printf '\nSpicetify documents chmod a+wr as an alternative, but Hive does not recommend world-writable Spotify directories.\n' >&2
        fi
        printf '\nHive can apply this narrower per-user permission fix now, before Hive launches.\n' >&2
        if command -v setfacl >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
          printf 'This grants only user %s access; it does not make Spotify world-writable.\n' "$USER" >&2
          printf 'The installer will ask for your administrator password through sudo.\n\n' >&2
          printf 'Grant Hive/Spicetify access to this Spotify installation now? [y/N] '
          read -r grant_spotify_access
          case "$grant_spotify_access" in
            y|Y|yes|YES)
              say "Requesting consented Spotify filesystem access"
              if sudo setfacl -m "u:$USER:rwx" "$spotify_install_path" && \
                 sudo setfacl -R -m "u:$USER:rwX" "$spotify_install_path/Apps"; then
                if [ -w "$spotify_install_path" ] && [ -w "$spotify_install_path/Apps" ]; then
                  spicetify_permissions_ok=1
                  say "Spotify filesystem access granted to $USER"
                else
                  printf '\nWARNING: Permission commands completed, but write access could not be verified. Spicetify apply will be skipped.\n' >&2
                fi
              else
                printf '\nWARNING: Could not grant Spotify access. Spicetify apply will be skipped.\n' >&2
              fi
              ;;
            *)
              printf '\nSkipping the permission change at your request. Hive will continue normally.\n\n' >&2
              ;;
          esac
        else
          printf '\nAutomatic permission setup is unavailable because sudo or setfacl is not installed.\n' >&2
          printf 'Hive will continue normally without changing Spotify permissions.\n\n' >&2
        fi
      fi
    else
      printf '\nWARNING: Could not automatically locate the Spotify installation.\n' >&2
      printf '         Spotify may still work, but Spicetify apply was skipped.\n' >&2
      printf '         Open Spotify once, then set spotify_path with Spicetify if needed.\n\n' >&2
    fi

  # No SpotX prompt here. A valid Spotify path is persisted below and
  # Spicetify remains the sole required bridge installer.

    if command -v spotify >/dev/null 2>&1 || command -v spotify-launcher >/dev/null 2>&1; then
      if [ "$spicetify_permissions_ok" -eq 0 ]; then
        say "Skipping Spicetify apply until Spotify write permissions are fixed"
      else
        say "Applying Spicetify Hive bridge"
        spicetify_output=""
        if ! spicetify_output="$(spicetify apply --no-restart 2>&1)"; then
          printf '%s\n' "$spicetify_output"
          if printf '%s' "$spicetify_output" | grep -qi "haven't backed up\|have not backed up\|backup apply"; then
            say "Spicetify has no client backup yet; creating the required backup and applying Hive"
            if backup_output="$(spicetify backup apply --no-restart 2>&1)"; then
              printf '%s\n' "$backup_output"
              say "Spicetify Hive bridge applied"
            else
              printf '%s\n' "$backup_output"
              if printf '%s' "$backup_output" | grep -qi "permission denied\|failed to copy raw assets\|unlinkat"; then
                printf '\nWARNING: Spicetify reached the Spotify client but could not write its Apps files.\n' >&2
                printf '         Check the Spotify path permissions above, then rerun this installer.\n' >&2
              else
                printf '\nWARNING: Spicetify backup/apply failed. The complete error is shown above.\n' >&2
              fi
            fi
          elif printf '%s' "$spicetify_output" | grep -qi "permission denied\|failed to copy raw assets\|unlinkat"; then
            printf '\nWARNING: Spicetify cannot write the Spotify client files.\n' >&2
            printf '         This is a filesystem-permission problem; opening Spotify again will not fix it.\n' >&2
            if [ -n "$spotify_install_path" ]; then
              printf '         Spotify path: %s\n' "$spotify_install_path" >&2
            fi
          else
            printf '\nWARNING: Spicetify could not apply the Hive bridge. The complete error is shown above.\n' >&2
          fi
        else
          printf '%s\n' "$spicetify_output"
          say "Spicetify Hive bridge applied"
        fi

        # Do not declare Spotify integration healthy merely because the CLI
        # returned success. Spicetify's documented extension workflow requires
        # both the extension file and its enabled config entry before apply.
        bridge_extension="${XDG_CONFIG_HOME:-$HOME/.config}/spicetify/Extensions/hive-spotify-bridge.js"
        extension_config_ok=0
        if [ -f "$bridge_extension" ] && command -v spicetify >/dev/null 2>&1; then
          extension_config_dump="$(spicetify config extensions 2>/dev/null || true)"
          if printf '%s\n' "$extension_config_dump" | grep -Fq 'hive-spotify-bridge.js'; then
            extension_config_ok=1
          fi
        fi
        if [ "$extension_config_ok" -eq 1 ]; then
          say "Verified Hive Spotify bridge extension is installed and enabled"
        else
          printf '\nWARNING: Spotify integration was not fully verified.\n' >&2
          printf '         Bridge file: %s\n' "$bridge_extension" >&2
          printf '         Expected enabled extension: hive-spotify-bridge.js\n' >&2
          printf '         Run this installer again with Spotify fully closed if the extension was not applied.\n' >&2
        fi
      fi
    fi
  fi
}

GLOBAL_INSTALL_MARKER="${XDG_STATE_HOME:-$HOME/.local/state}/beehive/install-complete"
mkdir -p "$(dirname "$GLOBAL_INSTALL_MARKER")"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

install_hive_desktop_integration() {
  # GNOME's media controls use MPRIS for transport/metadata, but the MPRIS
  # DesktopEntry property must resolve to a real .desktop file before Hive is
  # treated like an installed desktop media application. Keep this user-local
  # and portable: no root access is needed, and rerunning the installer updates
  # the entry if the project directory moved.
  local applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  # 743x743 is not a real hicolor theme size (nothing declares it in
  # index.theme), so GNOME's icon lookup never found it for the dock/taskbar
  # and silently fell back to a generic placeholder icon. 512x512 is one of
  # the standard sizes the system hicolor theme actually declares; the source
  # PNG (1254x1254) is higher-resolution than that, which is fine -- desktop
  # environments downscale a too-large icon without complaint, they just
  # can't find one filed under a size nothing recognizes.
  local icons_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
  local desktop_path="$applications_dir/hive.desktop"
  local icon_path="$icons_dir/hive.png"
  local template="$PROJECT_DIR/resources/hive.desktop"

  [ -f "$template" ] || { printf '\nWARNING: Hive desktop integration template is missing; continuing without it.\n' >&2; return 0; }
  mkdir -p "$applications_dir" "$icons_dir" || { printf '\nWARNING: Could not create user desktop integration directories.\n' >&2; return 0; }

  # run.sh is the portable project launcher and does not require sudo.
  sed "s|__HIVE_EXEC__|$PROJECT_DIR/run.sh|g" "$template" > "$desktop_path" || {
    printf '\nWARNING: Could not write %s.\n' "$desktop_path" >&2
    return 0
  }
  chmod 644 "$desktop_path" 2>/dev/null || true

  if [ -f "$PROJECT_DIR/resources/hive-minimal-black.png" ]; then
    cp -f "$PROJECT_DIR/resources/hive-minimal-black.png" "$icon_path" 2>/dev/null || {
      printf '\nWARNING: Could not install the Hive application icon.\n' >&2
      return 0
    }
    chmod 644 "$icon_path" 2>/dev/null || true
  fi

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1 || true
  fi
  say "Installed Hive GNOME desktop/MPRIS integration"
}

install_spotify_background_dependency() {
  # Spotify background mode requires a real Xvfb binary. This is a system
  # dependency rather than an npm dependency because the Spotify client runs
  # outside Hive's Electron process. Install it once when it is missing;
  # subsequent installer runs simply detect the existing binary.
  if command -v Xvfb >/dev/null 2>&1; then
    say "Spotify background display dependency already installed (Xvfb)"
    return 0
  fi

  say "Installing Spotify background display dependency (Xvfb)"
  if command -v pacman >/dev/null 2>&1; then
    command -v sudo >/dev/null 2>&1 || fail "sudo is required to install xorg-server-xvfb on Arch Linux."
    sudo pacman -S --needed xorg-server-xvfb \
      || fail "Could not install xorg-server-xvfb. Spotify background playback requires Xvfb."
  elif command -v apt-get >/dev/null 2>&1; then
    command -v sudo >/dev/null 2>&1 || fail "sudo is required to install xvfb on Debian/Ubuntu."
    sudo apt-get update \
      || fail "Could not refresh the package index for the Spotify Xvfb dependency."
    sudo apt-get install -y xvfb \
      || fail "Could not install xvfb. Spotify background playback requires Xvfb."
  elif command -v dnf >/dev/null 2>&1; then
    command -v sudo >/dev/null 2>&1 || fail "sudo is required to install Xvfb on Fedora."
    sudo dnf install -y xorg-x11-server-Xvfb \
      || fail "Could not install Xorg Xvfb. Spotify background playback requires Xvfb."
  else
    fail "Spotify background playback requires Xvfb, but no supported package manager was found. Install Xvfb manually, then rerun install.sh."
  fi

  command -v Xvfb >/dev/null 2>&1 || fail "Xvfb installation completed without an Xvfb binary. Spotify background playback cannot continue."
  say "Verified Xvfb: $(command -v Xvfb)"
}

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js first."
command -v npm >/dev/null 2>&1 || fail "npm is not installed. Install npm first."
command -v unzip >/dev/null 2>&1 || fail "unzip is not installed. On Ubuntu/Debian run: sudo apt install unzip"

install_hive_desktop_integration
# POST-SPOTIFY 1.0: Spotify background-display setup is paused too. Keep the
# function intact so it can be resumed with the rest of Spotify later.
# install_spotify_background_dependency
# POST-SPOTIFY 1.0: Spotify/Spicetify installation is paused.
# Keep the full installer implementation above intact so Spotify development
# can be resumed later by uncommenting this call when explicitly requested.
# install_spotify_stack

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  fail "Node.js 18 or newer is required. Found $(node -v)."
fi

if [ ! -f "$INSTALL_MARKER" ] || [ ! -d "$PROJECT_DIR/node_modules" ]; then
  say "Installing Beehive dependencies (Electron scripts intentionally skipped)"
  # dbus-next provides the Linux MPRIS2 service used by Music Presence. It is
  # ordinary JavaScript and needs no native build step.
  npm install --ignore-scripts || fail "npm install failed."
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
const path = require('path');
const electronPackage = require.resolve('./node_modules/electron/package.json');
const electronDir = path.dirname(electronPackage);
let getModule;
try {
  // Prefer a hoisted copy when npm provides one.
  getModule = require('@electron/get');
} catch (_) {
  // With Electron's lifecycle scripts disabled, npm commonly keeps Electron's
  // required @electron/get dependency nested beneath the Electron package.
  // Resolve that copy explicitly instead of assuming it was hoisted.
  getModule = require(path.join(electronDir, 'node_modules', '@electron', 'get'));
}
const { download } = getModule;
const version = require(electronPackage).version;
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

# npm lifecycle scripts are intentionally skipped above, so npm does not create
# the usual node_modules/.bin/electron shim. The package start script expects
# that shim; create it explicitly after the Electron binary is installed.
ELECTRON_SHIM="$PROJECT_DIR/node_modules/.bin/electron"
mkdir -p "$PROJECT_DIR/node_modules/.bin"
ln -sfn "$ELECTRON_BIN" "$ELECTRON_SHIM"
[ -x "$ELECTRON_SHIM" ] || fail "Could not create Electron command shim: $ELECTRON_SHIM"

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
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/scan-live.log"
mkdir -p "$LOG_DIR"
printf '%s\n' "Live scan log: $LOG_FILE"
printf '%s\n' "Session logs: $LOG_DIR/session-*.txt (newest 20 retained)"
printf '%s\n' "The terminal shows useful startup/errors and live scan events; repetitive Fontconfig/VSync noise is filtered from the terminal but remains available in the live scan log where applicable."
printf '%s\n\n' "Leave this terminal open while Beehive is scanning."
export BEEHIVE_LIVE_LOG=1
# Always enable startup diagnostics when launching from the installer.
# This keeps the startup trace available for diagnosing slow/hung launches.
export BEEHIVE_STARTUP_DEBUG=1
# Keep the installer terminal live so a stalled file can be diagnosed without
# needing a developer console. The same log is also persisted to disk.
"$PROJECT_DIR/run.sh" --startup-debug 2>&1 | tee -a "$LOG_FILE" | grep -vE '^(Fontconfig warning:|[[:space:]]*invalid attribute|[[:space:]]*invalid constant used|.*gl_surface_presentation_helper.*)$'

exit ${PIPESTATUS[0]}
