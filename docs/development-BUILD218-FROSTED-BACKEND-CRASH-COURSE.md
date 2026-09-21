# Build 218 — Frosted surfaces + backend crash-course diagnostics

## Scope

Build 218 is the next Editor Build after Build 217. It fixes the reported sidebar/queue frosted-surface regression and turns the existing in-app diagnostic session into a controlled backend crash-course instrument.

## UI correction

The sidebar and queue previously had both legacy `::before` glass overlays and the newer `player-glass-surface` ownership. Build 218 removes the competing pseudo-element surfaces and lets each panel itself own its background, border, blur, and transparency state. The established Frosted Glass preferences remain authoritative.

## Backend diagnostics

Starting an in-app diagnostic session enables the native GStreamer trace only for that session. Renderer actions are recorded into a bounded action timeline. Native traces include commands, GStreamer state transitions, stream-start/mute state, volume state, and decoder/backend events already provided by the player. Finishing the session collects the evidence before tracing is disabled.

The crash-course sequence is displayed in Settings → Logs: baseline/library scan, transport, volume, scrubber, queue, persistence, stress, and report handoff.

## Volume safety

Build 218 does not introduce another volume smoother or repurpose the 10 ms transport ramp. Ordinary user volume remains a direct GStreamer target. The purpose of this build is to correlate the audible pop with the actual command/state sequence before changing that architecture.

## Validation

- Targeted Build 218 regression tests: PASS.
- Existing Build 183 frosted-surface regression tests: PASS.
- Existing Build 188 volume regression tests: PASS.
- Existing Build 207 direct-volume regression tests: PASS.
- Build 217 playbar corner regression remains preserved (upper-only radius).
- Node syntax checks for renderer, main, preload, and diagnostics: PASS.
- GUI/audio runtime validation: not performed in this build environment; the next validation step is the user's in-app crash-course run.
