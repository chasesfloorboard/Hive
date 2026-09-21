# Build 172 — Navigation, Favorites + Lyrics polish

## Scope

Build 172 combines the requested navigation fixes with the Lyrics frosted-glass cleanup.

### Navigation
- The Years control is exposed only for the main Albums browser. It remains visible after switching Years on/off.
- Sidebar playlist activation reuses an existing playlist Music tab when that playlist is already open.
- The canonical Favorites autoplaylist continues to use the user-facing label `Favorites` and the star icon.
- Custom playlists added to the sidebar can be pinned from Settings → Navigation with the existing top-bar projection model.
- Custom playlist pin state is persisted in the existing navigation preferences and restored after the playlist list loads at startup.

### Lyrics
- The Lyrics section itself no longer paints a second glass surface behind the Lyrics bubble.
- The existing Lyrics bubble remains the visible frosted surface.
- The active synchronized lyric is highlighted at 13px instead of receiving a large size increase.

## Validation

- Targeted Build 172 regression suite: passing.
- JavaScript syntax check: passing.
- `npm run check`: passing.
- Full `npm test`: 314 passing / 2 environment-dependent failures in the supplied source tree because `node_modules/music-metadata` is absent and the MusicBee Wrapped test archive fixture is absent. Neither failure is related to Build 172 changes.
- GUI/Electron runtime validation was not performed in this environment.

Stable builds were not modified.
