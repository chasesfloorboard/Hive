# Build 186 — Favorites, Playlist Viewer, and Visualizer Regression Fix

## Fixed
- Playlist-backed sidebar presentation now derives from the persisted playlist record for label/icon, so Favorites and other sidebar playlists do not revert on restart.
- Playlist Info saves persist the UI projection immediately as well as the playlist record.
- Pinned playlist tabs are normalized to `specialView: 'playlist'` before activation and explicitly render their playlist browser.
- Favorites legacy navigation resolves to the canonical `star-favorites` playlist viewer.
- The redundant `Colored Now Playing background` Settings control is hidden; the underlying preference and renderer behavior remain intact.
- Spectrum plugin Canvas drawing no longer passes CSS `color-mix()` strings to Canvas APIs; colors are mixed to RGB/RGBA before drawing.

## Verification
- `node scripts/check.js`: passed.
- Targeted regression suite: 27/27 passed.
- Full `npm test` was attempted after `npm ci --ignore-scripts --no-audit --no-fund`; dependency installation timed out and removed `node_modules`, so a complete post-change suite could not be rerun in this environment.
- GUI runtime validation was not performed in this environment.
