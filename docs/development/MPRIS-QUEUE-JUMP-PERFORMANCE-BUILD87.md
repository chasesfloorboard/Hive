# Build 87 — MPRIS throttling, neutral logo tones, album-focus layout, and queue-jump performance

## Changes

- Ordinary MPRIS position synchronization is throttled to one renderer projection every five seconds. Track transitions, play/pause, shuffle/repeat, and seeks can still publish immediate state changes.
- Repetitive MPRIS artwork-resolution diagnostics are limited to one console/session-log entry every five seconds.
- Monochrome artwork now gives the Hive glass logo an explicit neutral dark/light treatment instead of falling through the hue-rotation fallback and becoming pink. Colorful artwork retains artwork-derived tinting.
- Special album-focus/search rendering now explicitly uses the full-width grouped-year layout when Years is enabled, preventing the `.grid` base class from shrinking a one-album search result to a single card column.
- Manual GStreamer queue jumps no longer wait for optional ReplayGain tag reads before issuing the LOAD. The metadata read and pipeline load proceed in parallel, then the resolved gain is applied.
- Manual GStreamer queue jumps no longer send a redundant STOP before LOAD; the persistent playbin's LOAD handler already moves the pipeline through READY/PAUSED.
- Removed the arbitrary 25 ms renderer delay after LOAD because the native helper waits for PAUSED/preroll before returning from the LOAD command.

## Validation

- Renderer/main/color-extraction syntax checks: passed
- Hive static/security checker: passed
- Targeted regression/performance tests: passed
- Full suite: 70/71 passed; the only failure is the existing clean-source `music-metadata` module absence in `artwork-payload.test.js`.
- Runtime UI/audio testing: not performed in this environment.
