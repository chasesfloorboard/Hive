# Build 171 — Context Playlist + Rating Menu Audit

## Scope

Build 171 changes the track/album right-click menu without changing the existing playlist persistence model or Love/rating storage architecture.

## Add to submenu

Right-clicking a selected track or album exposes `Add to ›` with:

1. `+ New Playlist`
2. The persisted built-in Favorites autoplaylist
3. Writable user-created local playlists

Smart playlists and Spotify-controlled playlists are not writable destinations. Favorites is handled through the existing Love/tag path so its smart membership remains authoritative.

Existing playlist paths are merged through a `Set`, preventing duplicate membership.

## Rating submenu

The Rating flyout is intentionally compact and symbol-only:

- Heart — Love
- Five-star through one-star symbols — rating values
- `×` — clear rating

Each action keeps an invisible `aria-label` for accessibility. Hover help is rendered as a separate Hive-styled label above the flyout and updates as the pointer moves between rating actions. Native `title` tooltips are not used.

The parent Rating control also has additional spacing before its `›` arrow.
