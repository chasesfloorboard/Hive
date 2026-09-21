# Build 173 — Playlist Details inspector polish

## Scope

Build 173 retains all Build 172 navigation, Favorites, and Lyrics fixes and adds a focused cleanup of the Playlist Details dialog.

### Playlist Details
- Added a bounded, independently scrolling content region so long playlist/sidebar details never extend beyond the dialog or become inaccessible.
- Kept the modal header stable while the details content scrolls.
- Refined the hierarchy into a compact inspector-style flow: collection identity, summary facts, playlist behavior, sidebar appearance, live preview, and save.
- Reduced the icon picker from individually boxed controls to a lightweight symbol list with a compact selected state.
- Moved custom label markup behind an Advanced disclosure so the common appearance workflow stays uncluttered.
- Kept the live sidebar preview so appearance changes remain immediately understandable.
- Removed the lightning-bolt icon from the supported sidebar icon choices. Legacy saved lightning values normalize to no icon when the editor opens.

### Preserved Build 172 behavior
- Years remains an Albums-only control and stays visible when toggled.
- Favorites reuses one canonical Music tab labeled Favorites.
- User-added sidebar playlists retain persistent top-bar pin/lock controls.
- Lyrics glass remains a single visible frosted bubble and synchronized active lyrics remain only slightly larger than surrounding lines.

## Validation

- Targeted Build 172 + Build 173 regression suite: 7/7 passing.
- `node --check app/renderer/renderer.js`: passing.
- `npm run check`: passing.
- Full `npm test`: 317 passing / 2 environment-dependent failures in the supplied source tree because `node_modules/music-metadata` is absent and the MusicBee Wrapped test archive fixture is absent. Neither failure is related to Build 173.
- GUI/Electron runtime validation was not performed in this environment.

Stable builds were not modified.
