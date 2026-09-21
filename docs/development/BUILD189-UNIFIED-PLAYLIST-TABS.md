# Build 189 — Unified Playlist Tabs

## Goal

Make Favorites a first-class playlist Music tab using the same browser path as every user playlist/autoplaylist, rather than maintaining a separate Favorites viewer.

## Root cause

The canonical `hive-star-favorites` autoplaylist already existed and ordinary playlists already used `specialView: 'playlist'` plus `activePlaylistId`. Favorites still retained several legacy `specialView: 'favorites'` branches in navigation, rendering, sorting, Love refresh, and context handling. That split caused Favorites to behave differently from ordinary playlist tabs and made its independent tab state and actions inconsistent.

## Changes

- `pl-favorites` now resolves `starFavoritesPlaylist()` and delegates directly to `openPlaylistFromSidebar()`.
- Removed the canonical Favorites-specific Music viewer/rendering path.
- Legacy saved `specialView: 'favorites'` tab state is converted to canonical playlist state during hydration.
- Playlist Info saves refresh open playlist-tab presentation from the updated canonical playlist record without replacing independent browser state.
- Favorite-added timestamp sorting is now restricted to the canonical Favorites playlist instead of every playlist using the `position` column.
- Love/scan refresh logic now recognizes the active playlist context instead of a separate Favorites viewer.
- The canonical playlist's label/icon remain the source of truth for sidebar and tab presentation.

## Regression coverage

New `test/build189-unified-playlist-tabs.test.js` covers:

- Favorites sidebar activation uses the shared playlist-tab path.
- Canonical Favorites receives `specialView: 'playlist'` and `activePlaylistId`.
- Playlist-tab presentation derives from the playlist record.
- Playlist Info refreshes open playlist tabs.
- Refresh does not overwrite per-tab scroll/album state.
- No separate canonical Favorites renderer is required.

Existing Favorites, navigation, playlist, Years, and Playlist Info tests were updated where their assertions described the obsolete Favorites-specific viewer.

## Verification

- `node --check app/renderer/renderer.js` — PASS
- `node scripts/check.js` — PASS
- `bash -n` on all six shipped shell entrypoints — PASS
- Relevant playlist/navigation suite — 48/48 PASS
- Expanded Favorites/playlist regression suite — 25/25 PASS
- Full `npm test` — 371/372 PASS. The one failure is the pre-existing environment/dependency condition in `test/artwork-payload.test.js`: `music-metadata/lib/index.js` is absent because the dependency installation was not available in this build environment. No new test failure was introduced.
- Electron runtime GUI validation — NOT PERFORMED in this environment.
- `electron-builder` packaging — NOT PERFORMED because `node_modules/electron` and `electron-builder` are absent in this environment. The deliverable is the runnable Hive source/development package; `install.sh` installs the dependencies and Electron in the target Linux environment according to the established project flow.

## Build

Build number: **189**

Stable builds were not modified.
