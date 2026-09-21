# Build 217 — Playbar Rounded Corners

## Bug
The bottom main playback bar had a rounded top edge but square lower corners when the frosted/player-glass surface was active.

## Root cause
`#playbar.player-glass-surface` explicitly used `border-radius: var(--radius) var(--radius) 0 0`, which rounded only the two upper corners.

## Fix
Use the established Hive `var(--radius)` on the entire playbar surface so all four corners are rounded. No playback, layout, or interaction behavior was changed.

## Validation
- Added `test/build217-playbar-rounded-corners.test.js` as a regression test.
- Targeted regression tests pass after the CSS change.
- `npm run check` and the full test suite should be run if dependencies are available; this source package does not contain `node_modules`.
