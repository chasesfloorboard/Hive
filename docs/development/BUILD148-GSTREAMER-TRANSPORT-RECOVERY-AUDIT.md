# Build 148 — GStreamer Transport Recovery / Fail-Silent Audit

## Trigger

Build 147 reached the native `GSTREAMER READY` handshake, but the reported test session produced no audio and subsequent Play/Pause/Skip transport controls did not recover playback.

## Root cause found

Build 147 sent `MUTE\t1` immediately before every native `PLAY`. The native helper correctly interpreted `MUTE` as the persistent user mute state, so `user_muted` became true. The subsequent native `PLAYING` safety gate therefore refused to reopen the sink. Because native `PLAYING` was authoritative, the renderer also no longer sent an unsafe early `MUTE\t0`.

A second recovery issue was present: after a native fatal audio-path error, `gstFatalError` remained latched across explicit queue transitions. That preserved fail-silent behavior for the faulting track but also prevented a deliberate user Skip/Previous from starting a fresh, validated native session.

## Build 148 changes

- Removed the renderer's unconditional `MUTE\t1` from the initial native LOAD → PLAY sequence.
- Kept temporary transport silence inside the native `PLAY` command without modifying `user_muted`.
- Preserved the native `STREAM_START` + `PLAYING` safety gate and 10 ms ramp before opening audio.
- Explicit user Next/Previous now clears the fatal latch and invalidates the renderer's cached GStreamer availability state, allowing the next track to perform a fresh READY handshake.
- No Web Audio fallback was added for local playback.
- Explicit user mute remains persistent and is still honored by the native safety gate.

## Validation

Targeted GStreamer startup/transport safety suite: 11/11 passed.

Full JavaScript suite: 235/237 passed. The same two environment/fixture failures remain from the prior development archive:

1. `test/artwork-payload.test.js` cannot load `node_modules/music-metadata/lib/index.js` from the supplied archive.
2. The MusicBee Wrapped fixture test cannot find its archive fixture.

Additional static checks are required before packaging. Native GStreamer compilation/runtime validation is environment-dependent and was not available in the build container when GStreamer development headers/pkg-config data are absent.

## Safety invariant

A malformed or failing native audio path remains fail-silent. Recovery is permitted only through an explicit user-directed track transition, which must pass the same native startup validation before audio is reopened.
