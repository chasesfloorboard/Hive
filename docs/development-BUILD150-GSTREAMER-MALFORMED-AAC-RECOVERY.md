# Hive Build 150 — GStreamer malformed-AAC recovery

## Reproduction

The supplied `infinity (888) [feat. Joey Bada$$].m4a` reproduces a native playback failure pattern: the AAC stream can produce audio initially, but independent decoding with ffmpeg reports repeated malformed AAC bitstream errors and eventually fails. Hive must treat this as a bad-stream condition, not as permission to keep an unsafe audio path alive.

## Change

Build 149 already made native decoder/sink errors fail-silent. Build 150 adds an explicit, user-directed native backend recovery boundary:

- a failed persistent GStreamer playbin is discarded instead of reused;
- the main process exposes a `gstreamer:restart` IPC operation;
- the preload exposes `gstreamerRestart()`;
- pressing Play after a native audio fault establishes a fresh GStreamer READY handshake before retrying the current track;
- the renderer does not synthesize a play event before the new backend is ready;
- automatic retry behavior remains disabled for native audio faults;
- the native backend still mutes and returns to READY before reporting the fatal error.

This is intentionally a recovery mechanism, not a second local playback engine and not an automatic retry loop.

## Verification

- Build 150 targeted recovery tests: passed.
- JavaScript syntax checks: passed.
- Native GStreamer compilation/runtime: not available in this build environment because the GStreamer development headers/pkg-config package are absent.
- The supplied M4A was independently inspected with ffprobe/ffmpeg; its AAC decoder emits malformed-bitstream errors.

## User test

Use the supplied M4A as the first reproduction. Verify that if it causes a native decoder failure, Hive remains silent and the transport can be recovered by pressing Play again or explicitly selecting/skipping to another track. Then verify a known-good FLAC/MP3/M4A plays normally afterward.
