# Build 182 — Now Playing Frosted Glass Presentation Correction

## Requirement

The dedicated Now Playing / player Frosted Glass checkbox was removed from Settings, but the playbar itself must retain the established frosted surface and accent-colored border. Removing the control must not remove the visual treatment.

## Root cause

Build 181 retained the playbar in the independently configurable `glassAreaPrefs` map. In addition, the base `#playbar` rule explicitly cleared its border, so the later player-glass surface rule restored the blur/background but did not restore the colored glass border.

## Fix

- Removed `data-glass-area="playbar"` from Settings.
- Removed `playbar` from the persisted per-area defaults.
- Made the playbar follow the existing master `playerGlassEnabled` preference directly. Old saved per-playbar values are ignored.
- Restored the accent-derived glass border on `#playbar.player-glass-surface`.
- Kept the existing blur/saturation and tinted glass background intact.

## Validation

- Build 182 targeted regression tests: 5/5 passed.
- Existing Frosted Glass / UI regression tests: 12/12 passed in the targeted run.
- `npm run check`: passed.
- Full `npm test`: 339 passed, 2 failed in the current archive because the local `node_modules/music-metadata` installation is incomplete; the failures are dependency/environment related rather than assertion failures from this change.
- GUI runtime validation: not performed in this environment.
