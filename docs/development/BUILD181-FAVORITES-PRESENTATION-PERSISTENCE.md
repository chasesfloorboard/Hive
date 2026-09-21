# Build 181 — Favorites Presentation Persistence

## Root cause

The canonical `hive-star-favorites` autoplaylist had already been made editable in the persisted playlist record, but the renderer's Favorites sidebar migration still treated the sidebar projection as a legacy/default object. On startup it could overwrite a saved rich label and icon with `Favorites` / `★`. The migration also removed the legacy `pl-favorites` pinned destination without reliably transferring that pin to the canonical playlist entry. The Playlist Manager separately forced the default star icon for the canonical playlist.

## Fix

- Preserve the canonical Favorites playlist's persisted `label` and `icon` when creating or normalizing its sidebar projection.
- Preserve an existing customized sidebar label/icon; only fill missing presentation fields from the canonical playlist/defaults.
- Transfer the legacy Favorites pinned state to the canonical sidebar playlist entry.
- Pin the newly-created canonical Favorites entry during the one-time migration when Favorites is supposed to be automatically pinned.
- Remove the legacy `pl-favorites` pin after transfer.
- Render `pl.icon` in Playlist Manager for all playlists, including canonical Favorites.

## Regression coverage

Build 177's Playlist Details tests were extended with coverage for Favorites migration presentation/pinning and Playlist Manager icon rendering.

## Validation

- Renderer/main JavaScript syntax checks: passed.
- `npm run check`: passed.
- Targeted Playlist Details/Favorites tests: 7/7 passed.
- Navigation Favorites + MusicBee Wrapped tests: 6/6 passed.
- Full `npm test`: 338/339 passed. The single remaining failure requires the `music-metadata` dependency, which could not be installed in this build environment because `npm ci --ignore-scripts --no-audit --no-fund` timed out. No failure was caused by Build 181's Favorites changes.
- GUI runtime test: not available in this build environment.
