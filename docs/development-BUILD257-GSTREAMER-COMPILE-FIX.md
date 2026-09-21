# Build 257 — GStreamer soft-volume compile fix

## Problem

Build 256 could not start local playback on Linux because Hive compiled `app/native/gstreamer-player.c` at startup and the Build 254 native-volume change referenced the `GST_PLAY_FLAG_SOFT_VOLUME` identifier directly. GStreamer documents the flag as bit `0x10`, but the playbin flag enum is plugin API rather than a symbol exported by the core `gst/gst.h` headers. The compile failure therefore prevented the persistent GStreamer helper from starting.

## Fix

Keep the Build 254 architecture: ordinary user volume remains the playbin stream-volume property and soft-volume remains disabled so a native sink can handle the volume when supported. The only change is to represent the documented soft-volume bit locally as `HIVE_PLAY_FLAG_SOFT_VOLUME` instead of requiring the unavailable plugin enum identifier.

No alternate playback engine, renderer fallback, software user-volume stage, or metadata path was introduced.

## Validation

- Build 254 native-volume architecture regression tests: passed.
- Build 256 metadata-safety regression tests: passed.
- Build 257 GStreamer soft-volume flag regression tests: passed.
- `node --check app/main/main.js`: passed.
- `node --check app/renderer/renderer.js`: passed.
- `node scripts/check.js`: passed.
- Actual native GStreamer runtime compilation/playback could not be executed in the packaging environment because GStreamer development headers/runtime are not installed there; the fix is therefore statically validated, not runtime-validated in this environment.
