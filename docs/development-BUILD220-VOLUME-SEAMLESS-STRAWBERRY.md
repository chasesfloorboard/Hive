# Build 220 — Direct GStreamer Volume Control

## Purpose

Build 220 changes local GStreamer volume control to follow the persistent engine-owned model used by Strawberry, while preserving Hive's protected 10 ms transport ramp for play/pause and track transitions.

## Root cause found

The Build 218 diagnostic showed repeated `VOLUME INPUT` events immediately followed by both `MUTE` and `VOLUME` commands. The renderer's volume slider handler was setting `audioEngine.muted = false` for every non-zero slider movement. That invoked Hive's native unmute path, which deliberately sets the sink to zero and starts the 10 ms transport ramp. Consequently, ordinary slider movement could repeatedly force the playing audio through a mute/ramp transition.

## Changes

- Local volume slider changes no longer modify mute state.
- Local volume is sent directly to the persistent native GStreamer helper on each user change; no renderer `requestAnimationFrame` volume smoother is used.
- Native `VOLUME` remains separate from `MUTE` and transport ramps.
- Native volume updates compare the desired effective gain with the current GStreamer volume before calling `g_object_set`, avoiding redundant writes.
- The existing 10 ms transport ramp remains intact for play/pause and deliberate track transitions.
- Spotify and podcast provider volume paths are unchanged.
- Volume persistence remains debounced and pointer-release/blur safe.

## Strawberry alignment

Strawberry keeps the user volume as an authoritative engine value and applies changed volume directly to its persistent GStreamer volume element. Hive now follows the same core model without replacing its established Electron/native architecture.

## Validation

- New Build 220 volume regression tests pass.
- Existing Build 188, 207, and 211 volume regression tests were updated to reflect the superseding direct-volume architecture and pass.
- Renderer `node --check` passes.
- Native C compilation was attempted but could not run in this build environment because GStreamer/GLib development headers and pkg-config metadata are unavailable here. Runtime GStreamer validation must therefore be performed on the target Arch environment.
