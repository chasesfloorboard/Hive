# Build 239 — Canonical transport anti-pop behavior

Build 239 makes the transport anti-pop behavior explicit and permanent.

## Canonical behavior

- Manual replacement of an actively playing local track uses one protected 10 ms ramp-down before the persistent GStreamer playbin URI is replaced.
- A freshly loaded local track uses one protected 10 ms ramp-up at the beginning of playback, after GStreamer has reported STREAM_START and PLAYING.
- Resuming a song that is already loaded and paused does **not** start another transport ramp; playback returns directly to the user's selected volume.
- Ordinary volume slider input remains a direct GStreamer volume target. User input cancels any active transport ramp rather than entering a second smoothing/automation path.
- The renderer continues to use the existing `RAMPSTART -> PLAY` sequence for fresh local loads. No renderer sleep or competing playback engine is introduced.

This is transport protection only. It is not volume automation and must not continuously modify the user's volume setting during ordinary playback.
