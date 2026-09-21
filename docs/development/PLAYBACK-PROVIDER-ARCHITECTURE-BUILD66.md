# Build 66 — Playback Provider Architecture

Build 66 establishes an explicit active playback-provider boundary for local GStreamer, Spotify/Spicetify, and podcasts. The shared Hive transport facade remains the UI contract, but only the active provider receives transport commands or publishes authoritative state.

## Ownership

- `local`: GStreamer is authoritative for local play/pause, position, duration, seeking, volume, and queue handoff.
- `spotify`: Spicetify is authoritative for Spotify play/pause, position, duration, seeking, volume, mute, shuffle, repeat, and current-track state. Spotify duration/progress are normalized to Hive seconds at the provider boundary.
- `podcast`: the existing HTML media transport remains authoritative.

Entering Spotify explicitly tears down active GStreamer/Web Audio sources before Spotify becomes active. Entering local playback pauses Spotify before local playback becomes active. Provider state from Spotify is ignored unless it identifies the active Spotify queue URI.

## UI synchronization

Spotify `songchange`, `onplaypause`, and `onprogress` state updates drive the shared play/pause state, seek position, duration, artwork/metadata, and MPRIS. Volume state is temporarily prevented from overwriting the volume slider while the user is dragging it and for a short confirmation window after release.

## Validation

Static JavaScript/shell checks, the Hive project checker, and provider architecture tests are required before packaging. Full Spotify runtime validation still requires the user's external Spotify/Spicetify session.
