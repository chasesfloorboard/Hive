# Build 259 — Monotonic-Cubic User-Volume Ramp

## Purpose

Build 259 is a focused follow-up to the real-hardware volume-slider pop that remained after the Build 258 baseline. It changes the shape of the existing in-pipeline user-volume ramp without changing the established audio routing.

## Changes

- `app/native/gstreamer-player.c`
  - Keeps `hive-user-volume` in the dedicated `audio-sink` bin immediately upstream of the real sink.
  - Keeps the 10 ms user-volume ramp.
  - Changes the `GstInterpolationControlSource` mode from linear to `GST_INTERPOLATION_MODE_CUBIC_MONOTONIC`.
  - The monotonic cubic mode is documented by GStreamer as avoiding values outside the control-point min/max range.
- `test/volume.test.js`
  - Updated the canonical volume test in place to require the monotonic-cubic mode and reject the old linear mode.
- `app/main/main.js`
  - Removed the confirmed-dead legacy `writeMp4LoveTag` implementation and its unused atom-builder imports.
  - The live Love write path remains the canonical Mutagen-backed `embedLoveInFile` path.
- `BUILD` and `CHANGELOG.md` advanced to build 259.

## Validation

- `node --check app/main/main.js` — PASS
- `node --check app/main/preload.js` — PASS
- `node --check app/renderer/renderer.js` — PASS
- `python3 -m py_compile resources/python/tag_helper.py` — PASS
- `node --test test/volume.test.js` — PASS (9/9)
- `node --test test/build258-metadata-backend-canon.test.js test/volume.test.js` — PASS (12/12)
- Full `npm test` — 540/542 passing. Two pre-existing environment failures remain because this source package has no installed `node_modules/music-metadata` tree.
- Native GStreamer compile — NOT RUNNABLE in this environment because `pkg-config` cannot find `gstreamer-1.0` or `gstreamer-controller-1.0` development packages.
- Electron/audio runtime — NOT RUNNABLE here; real audible validation remains required on the target Linux/PipeWire system.

## Runtime test requested from developer

Please test real local playback and drag the volume slider repeatedly across the range. Report whether the residual pop is:

1. gone,
2. unchanged,
3. worse,

and, if it remains, whether it occurs throughout the range or only around a particular volume level.
