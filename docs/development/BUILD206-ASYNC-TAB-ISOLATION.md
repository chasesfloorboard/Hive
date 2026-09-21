# Build 206 — Async Tab Isolation

## Problem reproduced

The Music tab could intermittently display the Playlists manager after repeated opening, closing, navigation, and playlist-save activity. The visible state could be reproduced after an asynchronous playlist refresh completed while the user had already switched back to Music.

## Root cause

Hive's renderer keeps `el.*` bound to the currently active tab's DOM. `showSpecialNavigation('pl-explorer')` awaited `window.beehive.getPlaylists()` and then called `renderPlaylistManager()` without verifying that the Playlists tab was still active. A delayed continuation could therefore mutate the Music tab's `tabPlaceholder` after `activateTabDom()` had rebound `el` to Music.

The same stale-continuation hazard existed for History's asynchronous `getHistory()` render path.

## Fix

- Added a navigation-generation counter so asynchronous navigation work can detect that a newer navigation request superseded it.
- Async History rendering now aborts if the navigation request or target tab is stale.
- Async Playlists-manager navigation now aborts if the request or target tab is stale.
- `renderPlaylistManager()` now has a defensive active-tab-kind guard and will never paint the manager into a Music/Favorites tab.
- Sidebar Music activation now uses the same navigation path as top-bar Music activation, ensuring it invalidates pending async navigation work.

This is deliberately a guard-and-ownership fix rather than another Music/playlist state rewrite. The existing independent tab DOM/state architecture remains intact.

## Validation

- `node --test test/build205-tab-context-isolation.test.js test/build206-async-tab-isolation.test.js` — 6/6 passed.
- `node --check app/renderer/renderer.js` — passed.
- `npm run check` — passed.
- Full `npm test` — 424/425 passed; the sole failure is the pre-existing environment dependency failure in `test/artwork-payload.test.js` because `node_modules/music-metadata/lib/index.js` is absent from the supplied source tree.
- Electron GUI/runtime validation was not performed in this environment.
- GStreamer native compilation/runtime validation was not performed.

No Stable build was modified.
