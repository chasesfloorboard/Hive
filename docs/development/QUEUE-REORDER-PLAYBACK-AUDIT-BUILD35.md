# Queue Reorder Playback Audit — Build 35

## Requirement

Moving the currently playing track in the queue must not cause playback to stutter, restart, seek, pause, or reload.

## Root cause

The previous queue-move implementation preserved the current track by path, but then called `gstStop()` followed by `gstLoadCurrent(position)` whenever GStreamer was active and playing. That unnecessarily tore down the persistent native playbin and restarted the current stream. Even when the saved position was correct, this could produce an audible interruption.

## Fix

Queue movement is now treated as a queue/session mutation rather than a playback command. For GStreamer:

- the current native stream is never stopped or reloaded;
- the current queue item remains the same track by object/path;
- `currentIndex` is updated to the track's new queue position;
- the native track index is updated;
- only the pending `NEXT` URI is refreshed.

The persistent GStreamer playbin therefore keeps its existing clock, decoder, sink, and playback position.

For the Web Audio fallback, the active `AudioBufferSourceNode` is likewise left untouched. If a queue move changes the identity of the future gapless successor, only that future scheduled source is replaced and re-armed; the audible current source is never stopped.

## Protected behavior

A queue reorder must not call any of the following against the currently playing track:

- `gstStop()`
- `gstLoadCurrent()`
- `requestLoadAndPlayCurrent()`
- `audioEngine.pause()` / `audioEngine.play()`
- a transport seek

## Validation

- Renderer JavaScript syntax check: PASS
- Main JavaScript syntax check: PASS
- Native source inspection: PASS; `NEXT` only changes the pending URI and does not alter the active pipeline state.
- Targeted static assertion: PASS; queue move path contains no GStreamer stop/load sequence.
- Existing test suite: 19/20, with the known environment-only missing `node_modules/music-metadata/lib/index.js` failure.
- Runtime Electron playback test: not available in this environment, so no runtime success claim is made.
