# Build 188 — Playback Regression Audit

Build 188 is an audio-stability correction following reports of live-volume stutter and audible pops during manual track transitions.

## Root causes addressed

- Rapid volume-slider input was restarting the native 10 ms ramp for every pointer event and synchronously invoking playback persistence. Build 188 coalesces native volume commands per animation frame and debounces persistence, flushing the final value when interaction ends.
- The GStreamer helper was deliberately niced below normal desktop scheduling priority. Because it owns the actual audio sink/transport, Build 188 restores normal process priority so background/UI workloads cannot starve the transport.
- The 10 ms native transport ramp remains intact; its callback is scheduled at high GLib priority.

## Protected transition path

Manual local track changes still use the single persistent GStreamer playbin path: fade to silence -> native PAUSED -> LOAD new URI -> native zero seek -> RAMPSTART -> PLAY. No second local playback engine is introduced and no renderer sleep is used as an audio synchronization mechanism.

## Validation

- Targeted playback/audio regression suite: 41/41 passed.
- Full test suite: 365/366 passed. The only failure is `artwork-payload.test.js` because `node_modules/music-metadata/lib/index.js` is unavailable after the environment's `npm ci --ignore-scripts --no-audit --no-fund` timed out.
- `node scripts/check.js`: passed.
- GUI/audio runtime validation: not performed in this environment.
