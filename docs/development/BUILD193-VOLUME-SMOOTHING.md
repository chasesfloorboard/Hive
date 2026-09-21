# Build 193 — rapid volume smoothing

## Problem

Build 188 coalesced renderer slider events, but the native helper still treated each received `VOLUME` command as a fresh 10 ms transport ramp. Because the helper command loop runs about every 20 ms, rapid back-and-forth dragging could repeatedly start short gain fades and remain audible as popping/zippering.

## Fix

Build 193 separates two concerns:

- **Transport safety:** the existing 10 ms ramp remains for PLAY/PAUSE/track transitions.
- **User volume:** GStreamer now follows a persistent target using a 5 ms high-priority smoothing loop with an approximately 38 ms exponential response.

Changing the target while the smoother is active does not restart a fade from the current level. The smoother simply follows the newest target. This makes fast slider reversals a continuous gain trajectory rather than a chain of restarted ramps.

The user target remains independent from transport fades and is never overwritten by a fade-to-zero operation.

## Build

`Hive-1.0.0-pre-release-build193-volume-smoothing.zip`

## Validation

- Build 168 audio regression test: passed.
- Build 188 audio regression tests: passed.
- Build 193 volume smoothing tests: passed.
- `scripts/check.js`: passed.
- JavaScript syntax checks: passed.
- Full test suite: 389/390 passed.
- Remaining failure is the existing artwork-payload test because the supplied source archive does not contain the `music-metadata` dependency under `node_modules`.
- Native GStreamer compilation/runtime was not available in the build environment because `pkg-config` could not locate `gstreamer-1.0`; therefore native runtime audio behavior still requires validation in the normal Hive Linux environment.
