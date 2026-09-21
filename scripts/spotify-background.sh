#!/usr/bin/env bash
set -u

log_dir="${XDG_CACHE_HOME:-$HOME/.cache}/hive"
mkdir -p "$log_dir" 2>/dev/null || true
log_file="$log_dir/spotify-background.log"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$log_file" 2>/dev/null || true; }
status_file="$log_dir/spotify-background-status.json"
status() {
  local phase="$1" detail="${2:-}"
  STATUS_PHASE="$phase" STATUS_DETAIL="$detail" STATUS_DISPLAY="${DISPLAY_NUM:-}" STATUS_XVFB_PID="${XVFB_PID:-}" STATUS_SPOTIFY_PID="${SPOTIFY_PID:-}" STATUS_EXEC="${spotify_exec:-}" STATUS_FILE="$status_file" python3 - <<'PYSTATUS' >/tmp/hive-spotify-status.$$ 2>/dev/null || true
import json, os, time
path=os.environ['STATUS_FILE']
data={
  'phase': os.environ.get('STATUS_PHASE',''),
  'detail': os.environ.get('STATUS_DETAIL',''),
  'display': os.environ.get('STATUS_DISPLAY',''),
  'xvfbPid': os.environ.get('STATUS_XVFB_PID',''),
  'spotifyPid': os.environ.get('STATUS_SPOTIFY_PID',''),
  'spotifyExec': os.environ.get('STATUS_EXEC',''),
  'updatedAt': int(time.time()*1000),
}
try:
  with open(path,'w',encoding='utf-8') as f: json.dump(data,f,separators=(',',':'))
except Exception: pass
PYSTATUS
  rm -f /tmp/hive-spotify-status.$$ >/dev/null 2>&1 || true
}

status 'starting' 'Checking Xvfb and Python prerequisites.'
if ! command -v Xvfb >/dev/null 2>&1; then
  log 'Xvfb is not installed; install Arch package xorg-server-xvfb.'
  status 'failed' 'Xvfb is not installed.'
  exit 127
fi
if ! command -v python3 >/dev/null 2>&1; then
  log 'python3 is required to read Hive Spotify configuration.'
  status 'failed' 'python3 is required.'
  exit 127
fi

# A previous Hive launch can outlive its helper process. Spotify may also hand the original launch PID off to child processes. The transient lifecycle status file is therefore not a sufficient ownership record: it can be overwritten by a second helper and its PID can stop being the process that owns the Spotify client. Keep a durable owner record and an inherited per-instance marker instead.
owner_file="$log_dir/spotify-background-owner.json"
hive_owned_spotify=0
SPOTIFY_OWNED=1
hive_owned_spotify_pid=''
hive_owned_spotify_display=''
hive_owned_xvfb_pid=''
hive_owned_instance_id=''

if [[ -f "$owner_file" ]]; then
  read -r hive_owned_instance_id hive_owned_spotify_display hive_owned_xvfb_pid hive_owned_recorded_spotify_pid < <(OWNER_FILE="$owner_file" python3 - <<'PY'
import json, os
try:
    with open(os.environ['OWNER_FILE'], encoding='utf-8') as f:
        data = json.load(f)
    instance = str(data.get('instanceId', ''))
    display = str(data.get('display', ''))
    xvfb_pid = str(data.get('xvfbPid', ''))
    spotify_pid = str(data.get('spotifyPid', ''))
    if display.startswith(':'):
        print(instance, display, xvfb_pid if xvfb_pid.isdigit() else '', spotify_pid if spotify_pid.isdigit() else '')
except Exception:
    pass
PY
  )
fi

# Spotify may strip custom HIVE_* environment variables when it creates or
# hands off Chromium processes. The isolated DISPLAY is the stronger ownership
# boundary: a desktop Spotify cannot legitimately be using Hive's private Xvfb
# display. First trust the durable launch PID when it still identifies a
# Spotify process on that display, then fall back to any Spotify process using
# the same isolated display.
spotify_process_display() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ -r "/proc/$pid/environ" ]] || return 1
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^DISPLAY=//p' | head -n 1
}

hive_owned_recorded_spotify_pid=''
if [[ -n "$hive_owned_spotify_display" && -n "$hive_owned_recorded_spotify_pid" ]]; then
  recorded_comm="$(ps -p "$hive_owned_recorded_spotify_pid" -o comm= 2>/dev/null | tr -d '[:space:]' || true)"
  recorded_display="$(spotify_process_display "$hive_owned_recorded_spotify_pid" || true)"
  if [[ "$recorded_comm" == 'spotify' && "$recorded_display" == "$hive_owned_spotify_display" ]]; then
    hive_owned_spotify_pid="$hive_owned_recorded_spotify_pid"
  fi
fi

# If the recorded Xvfb server disappeared, the provider is orphaned. Recover
# that orphan using the durable launch PID/display record even if Spotify
# dropped the HIVE_* marker variables. Never kill a PID that no longer names a
# Spotify process on Hive's recorded isolated display.
if [[ -n "$hive_owned_spotify_pid" && -n "$hive_owned_xvfb_pid" ]] && ! kill -0 "$hive_owned_xvfb_pid" >/dev/null 2>&1; then
  log "Recorded Hive-owned Spotify PID $hive_owned_spotify_pid is orphaned because Xvfb PID $hive_owned_xvfb_pid is gone; terminating the orphaned provider."
  kill "$hive_owned_spotify_pid" >/dev/null 2>&1 || true
  rm -f "$owner_file" >/dev/null 2>&1 || true
  hive_owned_spotify_pid=''
fi

# Find any Spotify process carrying our exact instance marker. This survives Spotify's normal Chromium process/PID handoff, unlike trusting only $!.
hive_owned_spotify_pids=''
if [[ -n "$hive_owned_instance_id" && -n "$hive_owned_spotify_display" ]]; then
  while read -r candidate_pid; do
    [[ "$candidate_pid" =~ ^[0-9]+$ ]] || continue
    candidate_env="$(tr '\0' '\n' < "/proc/$candidate_pid/environ" 2>/dev/null || true)"
    candidate_instance="$(printf '%s\n' "$candidate_env" | sed -n 's/^HIVE_SPOTIFY_INSTANCE_ID=//p' | head -n 1)"
    candidate_owner="$(printf '%s\n' "$candidate_env" | sed -n 's/^HIVE_SPOTIFY_OWNER=//p' | head -n 1)"
    candidate_display="$(printf '%s\n' "$candidate_env" | sed -n 's/^DISPLAY=//p' | head -n 1)"
    if [[ "$candidate_display" == "$hive_owned_spotify_display" && ( "$candidate_owner" == '1' && "$candidate_instance" == "$hive_owned_instance_id" || "$candidate_pid" == "$hive_owned_spotify_pid" ) ]]; then
      hive_owned_spotify_pids="${hive_owned_spotify_pids:+$hive_owned_spotify_pids }$candidate_pid"
    elif [[ "$candidate_display" == "$hive_owned_spotify_display" ]]; then
      # A Spotify process on Hive's private Xvfb display is owned by Hive even
      # when Spotify has stripped the custom ownership variables.
      hive_owned_spotify_pids="${hive_owned_spotify_pids:+$hive_owned_spotify_pids }$candidate_pid"
    fi
  done < <(pgrep -x spotify 2>/dev/null || true)
  hive_owned_spotify_pid="${hive_owned_spotify_pids%% *}"
fi

if [[ -n "$hive_owned_spotify_pids" ]]; then
  if [[ -n "$hive_owned_xvfb_pid" ]] && ! kill -0 "$hive_owned_xvfb_pid" >/dev/null 2>&1; then
    log "Found Hive-owned Spotify process(es) $hive_owned_spotify_pids but their Xvfb PID $hive_owned_xvfb_pid is gone; refusing to reuse the orphaned client."
    for owned_pid in $hive_owned_spotify_pids; do kill "$owned_pid" >/dev/null 2>&1 || true; done
    rm -f "$owner_file" >/dev/null 2>&1 || true
    hive_owned_spotify_pid=''
  else
    hive_owned_spotify=1
    SPOTIFY_OWNED=0
    DISPLAY_NUM="$hive_owned_spotify_display"
    SPOTIFY_PID="$hive_owned_spotify_pid"
    XVFB_PID="$hive_owned_xvfb_pid"
    log "Reusing Hive-owned Spotify PID $SPOTIFY_PID on isolated display $DISPLAY_NUM (instance $hive_owned_instance_id; matched processes: $hive_owned_spotify_pids)."
    status 'spotify-running' "Reusing Hive-owned Spotify on $DISPLAY_NUM (PID $SPOTIFY_PID)."
  fi
elif [[ -f "$owner_file" ]]; then
  log 'Discarding stale Hive Spotify owner record; no matching owned Spotify process remains.'
  rm -f "$owner_file" >/dev/null 2>&1 || true
fi

if [[ "$hive_owned_spotify" -eq 0 ]] && pgrep -x spotify >/dev/null 2>&1; then
  log 'Spotify is already running on the desktop; refusing to take ownership of it.'
  status 'failed' 'Spotify is already running visibly.'
  exit 3
fi

DISPLAY_NUM="${DISPLAY_NUM:-}"
XVFB_PID="${XVFB_PID:-}"
SPOTIFY_PID="${SPOTIFY_PID:-}"
DISPLAY_FILE="$(mktemp "$log_dir/spotify-display.XXXXXX" 2>/dev/null || true)"
cleanup() {
  if [[ "$SPOTIFY_OWNED" -eq 1 && -n "$SPOTIFY_PID" ]]; then kill "$SPOTIFY_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "$XVFB_PID" ]]; then kill "$XVFB_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "$DISPLAY_FILE" ]]; then rm -f "$DISPLAY_FILE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

if [[ "$hive_owned_spotify" -eq 1 ]]; then
  export DISPLAY="$DISPLAY_NUM"
  export GDK_BACKEND=x11
  export ELECTRON_OZONE_PLATFORM_HINT=x11
  export LIBGL_ALWAYS_SOFTWARE=1
  unset WAYLAND_DISPLAY WAYLAND_SOCKET WAYLAND_DEBUG
  log "Hive-owned Spotify is already running on $DISPLAY; waiting for Spicetify bridge connection."
  while kill -0 "$SPOTIFY_PID" >/dev/null 2>&1; do
    sleep 2
  done
  log 'Hive-owned Spotify exited; stopping its isolated display.'
  rm -f "$owner_file" >/dev/null 2>&1 || true
  status 'spotify-exited' 'Hive-owned Spotify exited.'
  exit 0
fi

if [[ -z "$DISPLAY_FILE" ]]; then
  log 'Could not create a temporary Xvfb display allocation file.'
  status 'failed' 'Could not create Xvfb display allocation file.'
  exit 1
fi
status 'starting-xvfb' 'Requesting an isolated X display.'

# Let Xvfb choose an unused display itself. The old fixed :90-:119 scan could
# mistake stale /tmp/.X11-unix locks for live servers and never recover.
# -displayfd writes the selected display number only after Xvfb is ready.
: > "$DISPLAY_FILE"
Xvfb -displayfd 3 -screen 0 1280x720x24 -nolisten tcp -noreset >>"$log_file" 2>&1 3>"$DISPLAY_FILE" &
XVFB_PID=$!
for _ in $(seq 1 50); do
  if [[ -s "$DISPLAY_FILE" ]]; then
    DISPLAY_NUM=":$(tr -d '[:space:]' < "$DISPLAY_FILE")"
    break
  fi
  if ! kill -0 "$XVFB_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if [[ -z "$DISPLAY_NUM" ]]; then
  log 'Could not allocate an isolated Xvfb display; see the background log for Xvfb errors.'
  status 'failed' 'Xvfb did not report a display.'
  exit 1
fi
log "Allocated isolated Xvfb display $DISPLAY_NUM."
status 'xvfb-ready' "Xvfb allocated $DISPLAY_NUM."

export DISPLAY="$DISPLAY_NUM"
export GDK_BACKEND=x11
export ELECTRON_OZONE_PLATFORM_HINT=x11
export LIBGL_ALWAYS_SOFTWARE=1
unset WAYLAND_DISPLAY WAYLAND_SOCKET WAYLAND_DEBUG
log "Starting Spotify on isolated display $DISPLAY."

# The installer already applies Hive's Spicetify extension. Do not invoke
# `spicetify auto` for every playback request: that command performs an
# apply/restart cycle and its restart path can hand Linux Spotify back to the
# desktop session instead of the isolated DISPLAY. Launch the validated
# already-patched Spotify executable directly.
spotify_install_path=''
hive_config="${XDG_CONFIG_HOME:-$HOME/.config}/Hive/config.json"
if [[ -f "$hive_config" ]]; then
  spotify_install_path="$(HIVE_CONFIG_PATH="$hive_config" python3 - <<'PY'
import json, os
try:
    with open(os.environ['HIVE_CONFIG_PATH'], encoding='utf-8') as f:
        value = json.load(f).get('spotify', {}).get('installPath', '')
    print(value if isinstance(value, str) else '')
except Exception:
    pass
PY
)"
fi

spotify_exec=''
if [[ -n "$spotify_install_path" && -x "$spotify_install_path/spotify" ]]; then
  spotify_exec="$spotify_install_path/spotify"
elif command -v spotify >/dev/null 2>&1; then
  spotify_exec="$(command -v spotify)"
fi
if [[ -z "$spotify_exec" ]]; then
  log 'Could not resolve a Spotify executable from Hive config or PATH.'
  exit 1
fi

spotify_instance_id="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(16))
PY
)"
if [[ -z "$spotify_instance_id" ]]; then
  log 'Could not generate a Spotify ownership instance marker.'
  status 'failed' 'Could not generate Spotify ownership marker.'
  exit 1
fi

log "Launching Spotify executable: $spotify_exec"
status 'launching-spotify' "Launching $spotify_exec on $DISPLAY_NUM."
env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u WAYLAND_DEBUG \
  HIVE_SPOTIFY_OWNER=1 HIVE_SPOTIFY_INSTANCE_ID="$spotify_instance_id" \
  "$spotify_exec" --ozone-platform=x11 --disable-features=UseOzonePlatform >>"$log_file" 2>&1 &
SPOTIFY_PID=$!
log "Spotify launch PID: $SPOTIFY_PID (instance $spotify_instance_id)"
OWNER_INSTANCE_ID="$spotify_instance_id" OWNER_DISPLAY="$DISPLAY_NUM" OWNER_XVFB_PID="$XVFB_PID" OWNER_SPOTIFY_PID="$SPOTIFY_PID" OWNER_EXEC="$spotify_exec" OWNER_FILE="$owner_file" python3 - <<'PY'
import json, os, time
path=os.environ['OWNER_FILE']
data={
  'instanceId': os.environ['OWNER_INSTANCE_ID'],
  'display': os.environ['OWNER_DISPLAY'],
  'xvfbPid': os.environ['OWNER_XVFB_PID'],
  'spotifyPid': os.environ['OWNER_SPOTIFY_PID'],
  'spotifyExec': os.environ['OWNER_EXEC'],
  'createdAt': int(time.time()*1000),
}
tmp=path+'.tmp'
with open(tmp,'w',encoding='utf-8') as f:
    json.dump(data,f,separators=(',',':'))
os.replace(tmp,path)
PY
status 'spotify-started' "Spotify process launched with PID $SPOTIFY_PID."

for _ in $(seq 1 60); do
  if kill -0 "$SPOTIFY_PID" >/dev/null 2>&1 || pgrep -x spotify >/dev/null 2>&1; then break; fi
  sleep 0.5
done

if ! kill -0 "$SPOTIFY_PID" >/dev/null 2>&1 && ! pgrep -x spotify >/dev/null 2>&1; then
  log 'Spotify did not stay running after direct launch.'
  status 'failed' 'Spotify exited immediately after launch.'
  exit 1
fi

log 'Spotify is running on the isolated display.'
status 'spotify-running' "Spotify is running on $DISPLAY_NUM; waiting for Spicetify bridge connection."
while pgrep -x spotify >/dev/null 2>&1 || kill -0 "$SPOTIFY_PID" >/dev/null 2>&1; do
  sleep 2
done
log 'Spotify exited; stopping isolated display.'
rm -f "$owner_file" >/dev/null 2>&1 || true
status 'spotify-exited' 'Spotify exited before the provider bridge connected or after playback.'
