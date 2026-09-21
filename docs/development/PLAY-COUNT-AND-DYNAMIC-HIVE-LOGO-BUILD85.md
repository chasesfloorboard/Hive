# Hive Build 85 — Qualified Play Counts + Dynamic Frosted Hive Logo

## Scope

Implement the requested song-play qualification and make the existing frosted-glass Hive logo follow the current artwork-derived UI accent without regenerating the logo asset.

## Changes

- A Beehive play is now recorded only after 5 seconds of actual active playback time.
- Pausing pauses qualification; resumed playback continues the same 5-second window.
- Skipping/changing tracks abandons an unqualified candidate. A qualified candidate is persisted once and cannot double-count.
- The existing Yearly Wrap 5-second listening threshold remains separate from play-count persistence.
- The existing transparent frosted-glass Hive logo asset remains the source image. CSS hue rotation derives from the same artwork palette that drives Hive's glass UI.
- The logo no longer carries a hard-coded blue glow/filter. Its hue and glow follow `--accent`, while retaining the frosted/glass luminance of the existing asset.

## Validation

- `node --check app/renderer/renderer.js` — expected/pass after packaging check.
- Focused play-count/logo tests — expected/pass after packaging check.
- `node scripts/check.js` — expected/pass after packaging check.
- Full suite may still report the known clean-tree `music-metadata` absence if dependencies are not installed.

## Runtime status

No Electron runtime test was performed in the build environment. The first runtime checks should be: play a track for under 5 seconds then skip (no play increment), pause/resume across the 5-second boundary (one increment), and confirm the Hive logo changes hue with different album art while remaining frosted rather than becoming a fixed blue icon.
