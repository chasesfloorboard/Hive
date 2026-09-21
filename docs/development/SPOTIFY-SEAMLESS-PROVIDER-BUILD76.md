# Build 76 — Spotify Seamless Provider Context

Build 76 tightens the existing Spotify/Spicetify provider without replacing the protected Build 75 MPRIS/Music Presence path.

## Changes

- Spotify playlist imports now carry an explicit `spotify:playlist:<id>` playback context on each track.
- The Spicetify bridge passes that context to `Spicetify.Player.playUri()` instead of always starting an unscoped track.
- Spotify player state reports its active context back to Hive.
- Hive preserves the provider context on the active track when Spotify reports it.
- Spotify starts synchronize Hive's current shuffle/repeat state with the real Spotify player.
- Paused Spotify restoration uses the same playlist context.
- Existing event-driven `songchange`, `onplaypause`, and `onprogress` state flow remains intact.

## Why

The existing bridge already used the documented Spicetify Player API as the Spotify source of truth, but `playUri()` was always called without context. That could make a Hive Spotify playlist feel like a collection of individually launched tracks rather than a continuous Spotify playback context. The new path keeps Spotify as the streaming engine while preserving Hive's unified queue/UI.

## Validation

Static and targeted tests are required before packaging. Full Spotify playback remains a runtime test on the user's Linux Spotify/Spicetify installation.
