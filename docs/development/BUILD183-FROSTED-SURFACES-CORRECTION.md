# Build 183 — Frosted surfaces and tab presentation correction

## Source baseline

Build 173 was reviewed as the requested visual/settings reference. Its Frosted Glass surface model contains a single `Now Playing / player` area control under `Frosted surfaces`, while a separate `Frosted Now Playing bar` setting also existed. The latter was the redundant control that should be removed; the area-specific surface functionality must remain.

## Changes

- Restored `data-glass-area="playbar"` to the Frosted surfaces settings list.
- Restored `playbar: true` to the persisted glass-area defaults.
- Restored the generic `playerGlassEnabled && glassAreaPrefs[area] !== false` application logic, including the playbar.
- Kept the separate `setting-playbar-frosted` control removed.
- Kept the legacy `beehive:playbar-frosted` preference unused.
- Preserved the existing shared `#playbar.player-glass-surface` accent-tinted glass background, border, and blur treatment.
- Reduced the Add Tab control from 34px to 22px while retaining its circular shape.

## Regression intent

The important invariant is:

> There is one user-facing area-specific setting for the Now Playing/playbar frosted surface: `Frosted surfaces → Now Playing / player`.

The dedicated `Frosted Now Playing bar` setting must not return, but removing that duplicate control must never remove the underlying area-specific functionality.

## Validation

- Build 183 targeted frosted-surface and adjacent regression tests: 25/25 passed.
- `npm run check`: passed.
- Full `npm test`: 344/345 passed. The one remaining failure is `test/artwork-payload.test.js`, which requires `music-metadata`; the dependency was unavailable because `npm ci --ignore-scripts --no-audit --no-fund` timed out in this build environment.
- Runtime GUI validation was not performed in this environment.
