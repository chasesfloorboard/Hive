# Build 207 — direct volume control

## Problem

The volume slider remained audibly choppy despite the Build 193 timer-based smoother. The previous architecture applied user volume through a second 5 ms exponential smoothing loop in the native helper, while renderer updates were coalesced to animation frames and native commands were serviced on a 20 ms timer. This introduced a delayed, timer-driven gain path that was unnecessary for ordinary user volume control.

## Architecture change

Build 207 separates **user volume** from **transport safety**:

- User volume is now a direct target applied to GStreamer's volume property.
- The renderer continues coalescing slider input to animation-frame updates so IPC is bounded rather than flooded.
- The native command service interval is reduced from 20 ms to 5 ms, removing an avoidable latency floor.
- The 10 ms transport ramp remains intact for PLAY, PAUSE, mute/unmute, and manual track replacement.
- A slider change during an active transport ramp updates `volume_target`; the existing ramp reads the latest target rather than restarting another fade.
- The renderer volume control now uses the canonical `audioEngine.volume` path instead of directly touching the HTML media element for local playback.
- The old native user-volume smoother was removed entirely.

This follows the pattern used by established open-source players: ordinary slider changes set the playback volume directly, while fades are a separate transport concern. Strawberry's GStreamer engine exposes direct `SetVolume` handling for normal volume changes and keeps fader behavior separate. GStreamer itself defines its volume property as a linear 0.0–1.0 control.

## Validation

- Build 207 targeted volume tests: 4/4 passed.
- Updated legacy volume regression tests: 11/11 targeted tests passed.
- `node --check app/renderer/renderer.js`: passed.
- `npm run check`: passed.
- Full `npm test`: 427/428 passed.
- Remaining full-suite failure: `test/artwork-payload.test.js`, because the supplied source tree lacks `node_modules/music-metadata/lib/index.js`. This is the same dependency/environment failure seen in prior builds and is unrelated to volume changes.
- Native GStreamer compilation was not available because the build environment lacks the GStreamer development pkg-config metadata/headers.
- No Electron/GStreamer GUI runtime validation was performed in this build environment.
- ZIP integrity and SHA-256 were checked after packaging.

## Protected behavior retained

- 10 ms anti-pop transport ramp.
- Persistent GStreamer playbin/playbin3 playback architecture.
- ReplayGain target multiplication.
- User volume persistence.
- Pause/resume and mute/unmute volume preservation.
- Local GStreamer remains authoritative for local audio.
