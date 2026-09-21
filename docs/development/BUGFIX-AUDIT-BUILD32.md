# Build 32 — Spotify discovery, installer safety, and artwork identity audit

## Scope

Build 32 is based on Build 31. It fixes the Spotify installer path-discovery bug and hardens Spotify track artwork/identity handling.

## Installer root cause

Build 31 trusted the output of `spicetify path spotify` as though it were always a filesystem path. On the affected Spicetify version, that command produced help/option text (`available options: all, userdata`). The installer then emitted a `chmod` command against that text.

Build 32 no longer trusts that output.

## Automatic Spotify discovery

The installer now discovers Spotify in this order:

1. `spotify_path` from the Spicetify config file returned by `spicetify -c`.
2. Common native/Arch locations:
   - `/opt/spotify`
   - `/usr/share/spotify`
   - `$HOME/.local/share/spotify-launcher/install/usr/share/spotify`
3. The active Flatpak deployment reported by `flatpak info --show-location com.spotify.Client`.
4. Standard system/user Flatpak deployment paths.
5. A targeted search under `$HOME/.local/share` and `$HOME/.var/app` for `spotify*/Apps/xpui.spa`.

Every candidate is validated as an absolute directory and must contain an `Apps` directory or `Apps/xpui.spa`. ANSI/control/help text is rejected before any path is used.

The installer prints the detected path, Apps path, `xpui.spa` presence, ownership, and write access. Permission remediation is only printed after a real Spotify path has been positively identified.

Hive and Spicetify continue to run as the normal user; the installer never invokes Spicetify through `sudo`.

## Spotify artwork/identity hardening

- Spotify state artwork is only allowed to overwrite a queue track when the state URI matches that track.
- A delayed state event from another Spotify track can no longer paint the previous track's artwork onto the current track.
- Spotify playlist imports now preserve canonical album URI and album artist metadata.
- Spotify album grouping uses the canonical album URI when available, preventing unrelated albums with the same synthetic/display album name from sharing one artwork/card.

## Validation

- `node --check app/renderer/renderer.js` — PASS
- `node --check app/main/main.js` — PASS
- `node --check resources/spicetify/hive-spotify-bridge.js` — PASS
- `bash -n install.sh` — PASS
- Runtime Spotify/Spicetify testing is not claimed in this environment.
