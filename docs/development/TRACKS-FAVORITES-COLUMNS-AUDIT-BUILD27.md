# Build 27 — Tracks/Favorites performance and column-fit audit

## Findings

1. The main Music Tracks view already used `songVirtualState` and rendered only the visible/overscanned rows.
2. Favorites and the other special track collections used a separate non-virtual renderer that created one `.song-row` DOM node per track. Favorites could therefore be materially heavier than Music even with fewer tracks.
3. The column fitter allocated the entire `songsTable.clientWidth` to CSS grid tracks, but each row/header also added horizontal padding and inter-column gaps. Those layout extras were outside the fitted track total, so the rightmost column could extend beyond the viewer.
4. The column `ResizeObserver` was created once and could remain attached to a previously active Music tab after tab DOM was switched.

## Build 27 changes

- Favorites, History, Recently Added, Top Played, folders, and special playlist track views now use the same virtualized song-row renderer as the main Music Tracks view.
- Column fitting now subtracts actual header/row horizontal padding and grid gaps before distributing width across columns.
- Song header/rows now have an explicit `width:100%`, `min-width:0`, and `box-sizing:border-box` invariant so fitted columns cannot add an accidental max-content width.
- The single column resize observer is rebound to the currently active tab's song table whenever the header is bound.
- Existing column proportions, manual resize behavior, persisted settings, sorting, selection, drag/drop, ratings, and playback queue behavior are preserved.

## Validation

- JavaScript syntax check: PASS.
- Structural project check: PASS.
- Shell syntax checks: PASS.
- Unit test suite: expected environment-only `music-metadata` module absence remains the known 1 failure; no forced dependency repair was performed.
- Runtime UI verification was not available in this environment, so no runtime success is claimed.
