# Spotify Hive Transport Audit — Build 52

## Goal

Make imported Spotify playlists behave as a Hive provider rather than handing playback to the visible Spotify UI.

## Architecture

- Spotify/Spicetify remains the streaming engine.
- Hive is the provider UI/controller.
- The loopback Spicetify bridge is the source of truth for Spotify playback state.
- Hive does not download Spotify audio and does not create a second Spotify playback engine.
- Direct `spotify:track:`/`xdg-open` playback fallback was removed.
- Spotify bootstrap requests `--minimized` so the client can act as the transport backend without intentionally foregrounding it.

## Playback state

The bridge now reports:

- URI/track identity
- title/artist/album
- duration and position in seconds
- playing/paused state
- Spotify artwork URL
- volume via `Spicetify.Player.getVolume()`
- shuffle via `Spicetify.Player.getShuffle()`
- repeat mode via `Spicetify.Player.getRepeat()`

Hive volume writes now call `Spicetify.Player.setVolume()` when Spotify is active. Repeat uses the documented numeric Spicetify modes 0/1/2.

## Artwork

Spotify playlist import now persists:

- playlist cover
- playlist artwork URL
- per-track artwork URL
- album URI/artist metadata

The bridge obtains playlist artwork from the playlist image list and falls back to imported track artwork. Hive primes Chromium's normal HTTP image cache with bounded concurrency after import without retaining decoded `Image` objects as a long-lived cache.

The Spotify playlist manager displays the playlist cover directly.

## Validation

- JavaScript syntax checks: PASS for main, preload, renderer, bridge.
- `scripts/check.js`: PASS.
- Existing test suite: 19/20 passed; the same pre-existing dependency/environment failure remains in `test/artwork-payload.test.js` because `node_modules/music-metadata/lib/index.js` is absent in the source checkout. The remaining 19 tests passed.
- Runtime Spotify validation was not performed in this container because the real Spotify/Spicetify client is not available here.
