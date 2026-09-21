# Build 175 — Frosted Now Playing setting consolidation

## Change

Build 175 removes the redundant `Frosted Now Playing bar` Appearance setting. The existing Frosted Glass surface control for `Now Playing / player` remains the single source of truth for the playbar surface.

The renderer no longer loads, saves, or listens to the legacy `beehive:playbar-frosted` preference. The old `playbar-frosted` CSS class path was removed as well; `applyPlayerGlass()` now applies the existing `player-glass-surface` / `player-glass-transparent` classes from the dedicated surface preference.

## Validation

- Build 175 targeted regression tests: 3/3 passing.
- `node scripts/check.js`: passing.
- Full `npm test`: 321 passing / 2 environment-dependent failures in the supplied source tree. The failures are the existing missing `node_modules/music-metadata/lib/index.js` dependency and the missing MusicBee Wrapped fixture used by the artwork scanner test; neither is related to this setting cleanup.
- Electron GUI runtime was not available in this environment.
