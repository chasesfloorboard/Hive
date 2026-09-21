# Build 219 — Albums Viewer Rounded Corners

## Correction

Build 217/218 targeted the wrong surface for the requested bottom-corner fix. The requested surface is the albums/music viewer frame (`#main`), not the bottom playback/Now Playing bar.

## Fix

- `#main` now uses the established `var(--radius)` on all four corners.
- `#playbar.player-glass-surface` is restored to its established upper-only radius (`var(--radius) var(--radius) 0 0`).
- No playback, queue, scrolling, or glass behavior is changed.

## Validation

- Added `test/build219-albums-viewer-rounded-corners.test.js`.
- Targeted corner regression tests pass.
