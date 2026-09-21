# Build 28 — Tracks/UI optimization pass

## Goal

Reduce renderer work in the hot Tracks/Favorites scrolling and interaction paths without replacing established playback, library, artwork, or tab architecture.

## Changes

### Virtualized Tracks interaction path
- Replaced per-row click, double-click, dragstart, dragend, and rating listeners with delegation from the persistent song table.
- Virtual row repaint now replaces only row markup and selection state; it no longer installs multiple listeners on every newly mounted row.
- Rows remain draggable and preserve selection, range selection, rating, context-menu, playback, and native-file-drag behavior.
- This makes listener count effectively constant while scrolling instead of scaling with every virtual window repaint.

### Renderer layout containment
- Kept the existing `contain: layout paint` boundary on song rows.
- Added `content-visibility: auto` to song rows so Chromium can skip unnecessary rendering work for rows outside the visible region while retaining the existing virtualized list geometry.

### Love-state hot path
- `syncLoveStateForPath()` now updates the canonical library object through `libraryTrackByPath` and only checks genuinely separate queue/selection/now-playing objects.
- Removed repeated full traversals of every album and artist entry for a single Love toggle; those derived collections reference the canonical track objects.
- A Love click therefore no longer scales with the total album/artist model size.

## Intentionally not changed

- GStreamer/local playback architecture.
- MPRIS/Music Presence boundary.
- Artwork provider architecture.
- Album virtualization. The existing album expansion/reflow code has a documented DOM-sibling dependency, so a safe album virtualization redesign remains a separate architectural task rather than being mixed into this pass.
- Persistent data schemas.

## Validation

- JavaScript syntax check: PASS.
- Structural project check: PASS.
- Shell syntax checks: PASS.
- Unit tests: expected environment-only `music-metadata` module absence remains the known single failure.
- Runtime UI testing was not available in this environment; no runtime success is claimed.
