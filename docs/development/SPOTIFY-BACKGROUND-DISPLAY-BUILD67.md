# Spotify Background Display — Build 67

## Problem

On Linux, Spotify can surface its Chromium/XWayland window when Hive starts playback through the Spicetify Player API. Build 66 correctly separated Spotify transport from GStreamer, but it deliberately required Spotify to be started separately, which left the visible desktop client in the user's session.

## Permanent direction

Spotify remains an external provider and Spicetify remains the transport authority. Hive now starts Spotify through `scripts/spotify-background.sh` when the bridge is unavailable. The helper:

- requires `Xvfb` and `spicetify`;
- refuses to take over an already-running desktop Spotify process;
- allocates an isolated X display;
- launches `spicetify auto` with that display;
- keeps Xvfb alive for the Spotify process lifetime;
- leaves Spotify audio in the user's normal session so it can still reach PipeWire;
- writes diagnostics to `~/.cache/hive/spotify-background.log`.

This intentionally replaces window-manager manipulation with display isolation. Hive does not use `wmctrl`, `xdotool`, or Wayland window ownership tricks.

## User dependency

Arch Linux users need the `xorg-server-xvfb` package. Spicetify remains a user-level tool and must not be run as root.

## Limitation

If Spotify is already running visibly, the helper refuses to attach to it. Close the desktop Spotify process and let Hive start the isolated provider. Runtime validation on the user's actual Spotify installation is still required.
