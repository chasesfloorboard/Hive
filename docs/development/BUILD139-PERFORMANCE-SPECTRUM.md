# Build 139 — Playback Performance + Native Spectrum Stability

## Purpose

Build 139 reduces avoidable Electron/UI work during playback and fixes the native GStreamer spectrum value extraction contract.

## Changes

- Session logging now queues normal log writes through asynchronous filesystem I/O instead of synchronously appending on every console call.
- Renderer console capture no longer performs synchronous session-log I/O.
- The native GStreamer `spectrum` element now reads the documented `GST_TYPE_LIST` magnitude values.
- The left-sidebar Now Playing spectrum renderer is event-driven: a canvas frame is scheduled only when new spectrum data arrives or the visualizer is resized.
- First-party Spectrum and Signal Rings visualizer plugins no longer run unconditional 60 Hz animation loops; they redraw on spectrum updates.
- Existing GStreamer playback ownership, queue handoff, transport persistence, and Spotify architecture are unchanged.

## Validation

- Build 139 regression tests: expected green.
- Existing plugin/spectrum contract tests: expected green.
- JavaScript syntax checks: expected green.
- Full test suite and project checks are run as part of packaging; environment-only fixture failures are recorded separately rather than masked.

## Runtime limitation

No full desktop playback/GPU hitch benchmark is claimed unless the build is actually launched on a Linux desktop. The code changes specifically remove synchronous per-console disk I/O and continuous visualizer redraw loops, but real hitch validation still requires playback on the target desktop.
