# Hive Build 96 — Spotify Background Provider Diagnostics

## Purpose

Build 95 corrected stale Xvfb display allocation but the target Arch runtime still reached the renderer's 20-second provider timeout without receiving a Spicetify state POST. Build 96 hardens the Linux Spotify launch path and makes the remaining provider boundary observable without replacing the existing transport.

## Changes

- Clear `WAYLAND_DISPLAY`, `WAYLAND_SOCKET`, and `WAYLAND_DEBUG` for the isolated Spotify process.
- Explicitly launch Spotify with `--ozone-platform=x11 --disable-features=UseOzonePlatform`, matching Hive's established Linux/XWayland compatibility path.
- Persist helper lifecycle status at `~/.cache/hive/spotify-background-status.json`.
- Return that status from Hive's existing `spotifyStatus()` IPC.
- Include the last provider phase in the renderer's connection failure notice.
- Record the first `/commands` poll and `/state` POST in the startup session log, including the request origin and no credentials.
- Extend provider startup wait from 20 to 30 seconds to accommodate a slow first Spotify launch.

## Diagnostic interpretation

The next runtime session can distinguish the failing boundary directly:

- `xvfb-ready`: isolated X server is working.
- `spotify-started` / `spotify-running`: Spotify launched under the isolated display.
- `SPOTIFY BRIDGE COMMAND POLL RECEIVED`: the Spicetify extension can reach Hive's command endpoint.
- `SPOTIFY BRIDGE STATE RECEIVED`: the extension initialized its Player API and can report state back to Hive.
- No command-poll event after `spotify-running`: investigate Spotify/Spicetify extension execution or browser network policy.
- Command poll received but no state POST: investigate bridge initialization/player-state generation.

No direct Spotify audio is downloaded or streamed by Hive; Spotify remains the external provider's streaming engine.
