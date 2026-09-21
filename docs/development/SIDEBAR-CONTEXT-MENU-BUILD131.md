# Build 131 — Sidebar Context Menu Audit

## Scope

Standardize right-click behavior for left-sidebar music collections without changing playback, queue ordering, or sidebar navigation state.

## Behavior

Track-bearing sidebar destinations now share four actions in this order:

1. **Play** — replace the current queue with the collection's playback order and start it.
2. **Queue** — append the collection to the existing queue without starting playback.
3. **Info** — open the existing sidebar collection information editor.
4. **Export as M3U** — export the collection using the existing exporter.

Favorites, Recently Added, and Top 25 no longer use a separate `Add playlist to queue` label or implementation.

Podcasts remain informational because their sidebar records represent podcast shows rather than local playable music tracks.

## Regression protection

`test/sidebar-context-menu.test.js` verifies the shared menu helper, action ordering/availability, and removal of the dynamic-playlist-specific menu path.

## Performance / architecture

The change only consolidates menu construction. It does not alter collection retrieval, playback transport, queue storage, or library reconciliation.
