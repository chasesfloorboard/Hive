# Hive — Spotify Path Persistence / Installer Audit — Build 50

## Problem

The installer detected `/opt/spotify`, but then invoked SpotX-Bash as a required interactive dependency. The current SpotX release rejected the explicit `-P /opt/spotify` path, and the launcher retained a SpotX repair marker that could cause another interactive repair on a later launch.

## Fix

- SpotX-Bash is no longer a required Hive dependency.
- Spicetify remains the required external bridge for Hive Spotify integration.
- Valid Spotify discovery is persisted in `~/.config/Hive/config.json` as:

```json
{
  "spotify": {
    "installPath": "/opt/spotify"
  }
}
```

- On subsequent installer/repair runs, Hive reads this path first and validates that the directory still exists and contains Spotify's `Apps` payload before accepting it.
- Fresh discovery falls back to Spicetify's configured `spotify_path`, native/spotify-launcher locations, Flatpak locations, and the existing targeted search.
- The validated path is also written through `spicetify config spotify_path ...`.
- The launcher no longer executes an interactive SpotX repair flow before every Hive launch.

## Security / persistence

- Hive config is written atomically with mode `0600`.
- The containing Hive config directory is kept at mode `0700` where supported.
- No remote Spotify installer is executed.
- No SpotX script is downloaded or executed by this installer path.
- Existing Hive config keys are preserved when the Spotify path is added.

## Validation

- `bash -n install.sh` — PASS
- `bash -n run.sh` — PASS
- `node scripts/check.js` — PASS
- JavaScript syntax validation included by `scripts/check.js` — PASS
- No forced dependency changes were made.

## Runtime test still required

On the target Arch machine, run `./install.sh` once with Spotify installed. Expected behavior after successful detection is a persisted `~/.config/Hive/config.json` containing `spotify.installPath`, with no SpotX confirmation prompt. A second installer/launcher invocation should reuse and validate that path without asking for `y`.
