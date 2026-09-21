# Build 91 — Spotify playback and provider-state repair

## Findings

Build 90 contained a Spotify provider path that could queue commands correctly but had two release-blocking integration gaps:

1. The renderer exposed `spotifyApplyState()` but did not subscribe to the existing `window.beehive.onSpotifyState()` IPC event. Provider state therefore could not reliably reach Now Playing, queue metadata, the seek clock, MPRIS synchronization, or artwork updates.
2. The Spicetify bridge passed playlist context as `{ uri: contextUri }`. Current Spicetify documentation describes the context shape using `ContextOption.contextURI`; the previous object could be ignored or rejected by newer clients.

## Changes

- Wired the renderer to the existing main-process Spotify state event.
- Applied the current provider state returned by `spotifyStatus()` when the bridge is already connected.
- Changed `playUri()` context to `{ contextURI, trackUri }`.
- Added a bounded bare-track fallback when contextual `playUri()` is rejected, so a provider API context-shape change cannot prevent the selected Spotify track from starting.
- Preserved Spotify as the audio engine; Hive still does not download Spotify audio.
- Preserved Spotify artwork as the primary artwork source and the existing persistent artwork cache.
- Preserved playlist context on persisted Spotify queue entries so restored provider queues do not lose their context.

## Validation

- `node --check app/renderer/renderer.js` — PASS
- `node --check app/main/main.js` — PASS
- `node --check resources/spicetify/hive-spotify-bridge.js` — PASS
- Spotify targeted tests — PASS (16/16)
- `node scripts/check.js` — PASS
- Full `npm test` — 79/81 PASS. The two existing failures are unrelated test-environment fixtures: missing `node_modules/music-metadata/lib/index.js` in the source checkout and missing MusicBee Wrapped archive fixture.
- Electron/Spotify runtime playback was not available inside this build environment; the user-side Linux Spotify/Spicetify installation remains the required runtime validation.

## Runtime test target

After installing Build 91, import/open an existing Spotify playlist, play a track, and verify:

- Spotify actually starts streaming the selected track.
- Hive Now Playing receives the Spotify track state.
- Spotify artwork appears in the queue/Now Playing.
- Pause/resume, seek, volume, shuffle, and repeat continue to route through Spotify.
- MPRIS and Music Presence reflect the Spotify provider state without affecting local playback.
