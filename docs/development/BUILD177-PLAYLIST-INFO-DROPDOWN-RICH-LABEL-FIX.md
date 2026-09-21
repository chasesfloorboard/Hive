# Build 177 — Playlist Details Dropdown & Favorites Rich Label Fix

## Changes

- Moved **Save changes** into the Playlist Details modal header, immediately beside the close control, as a compact pill.
- Reworked playlist icon selection so the existing hero icon is the picker trigger on every Playlist Details page. The full icon grid is no longer rendered in the page body.
- The icon menu remains themed, compact, keyboard/ARIA-friendly, and closes after selection or when clicking outside it.
- Fixed the canonical Favorites Auto Playlist persistence path so user-selected icon and rich label styles are retained instead of being forcibly reset to `★` / `Favorites` by the main process.
- When a playlist is also represented by a custom sidebar entry, saving Playlist Details now synchronizes that sidebar projection with the saved playlist label and icon.
- Replaced the previous Rainbow `hue-rotate()` treatment with an explicit animated text gradient to avoid Chromium/theme combinations rendering the rich label as black.

## Validation

Targeted Build 177 Playlist Details tests: **5/5 passed**.

Relevant regression tests: **24/24 passed**.

Full suite: **332/334 passed**. The two failures are the existing environment/fixture failures involving the unavailable `music-metadata` module in the artwork payload test and the existing MusicBee Wrapped fixture test. `npm run check` passed and renderer/main JavaScript syntax checks passed.

No GUI runtime test was available in this build environment.
