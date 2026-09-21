# Build 75 — MPRIS / Music Presence quick fix

## Regression clue

Experimental Build 49 was observed to publish Hive Rich Presence correctly, while experimental Build 50 did not. The MPRIS application source was unchanged between those two builds, so Build 49/50 are treated only as regression witnesses, not stable baselines.

## Fix

The current development source had later introduced a localhost artwork-proxy URL into `mpris:artUrl`. Build 75 restores the pre-proxy MPRIS behavior for local covers: MPRIS publishes the validated cached cover as a `file://` URI. Music Presence remains responsible for consuming MPRIS and externalizing local artwork for Discord.

The Hive artwork proxy remains available for the integration and its security/startup tests remain intact; it is simply no longer substituted into the player-provided MPRIS artwork URI.

## Validation

- `node --check app/main/mpris.js` — passed
- `node --check test/mpris-artwork-url-regression.test.js` — passed
- targeted MPRIS artwork tests — 4/4 passed
- No direct Discord IPC or second Rich Presence publisher added.

## Runtime status

Runtime Discord validation has not been observed in this build environment. The intended next step is to install/run Build 75 and verify that Music Presence detects `org.mpris.MediaPlayer2.Beehive` and publishes the currently playing track.
