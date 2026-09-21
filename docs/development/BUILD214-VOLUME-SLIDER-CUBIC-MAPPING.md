# Hive Build 214 — GStreamer volume slider mapping

## Problem

The volume slider was being treated as a linear 0–100 value and passed directly to GStreamer's linear `volume` property. GStreamer documents that its playback volume is a linear 0.0–1.0 gain, while GUI volume sliders should usually use a cubic representation.

That meant the UI had no perceptual slider mapping: a visible 53% position was sent as exactly 0.53 linear gain instead of using the documented cubic UI representation.

## Fix

Build 214 keeps the user's slider value as the UI value and performs the conversion only at the audio-engine boundary:

- Slider `0–100` remains an exact, integer user control.
- Slider → engine uses `position³`.
- Engine → slider uses `cbrt(engineVolume)`.
- Persisted playback state remains the engine's linear 0.0–1.0 value.
- MPRIS remains linear 0.0–1.0 as an engine/API value.
- GStreamer continues receiving direct user volume targets; the protected 10 ms transport ramp is unchanged.
- ReplayGain remains a separate native `track_gain` multiplier.

Example: a visible slider value of **53** stays **53** in the UI and maps to approximately `0.1489` linear GStreamer gain.

## Validation

- Build 214 targeted volume tests: pending/validated during packaging.
- `node --check app/renderer/renderer.js`: validated.
- Full test suite: validated during packaging.
- Native GStreamer runtime: not available in the build environment; Linux desktop playback still requires runtime validation.

## Reference

GStreamer `GstStreamVolume` documents linear volume and recommends cubic volume for GUI sliders.
