# Build 224 — Locked Playlists Top-Bar Position

## Request
The canonical Playlists tab should be present in the top bar by default, locked there, and positioned between Music and Favorites.

## Implementation
- `pl-explorer` is now a permanent pinned top-bar destination.
- Top-bar normalization enforces `Music → Playlists → Favorites` when Favorites is already pinned.
- Other pinned navigation entries retain their relative order after the fixed destinations.
- The Settings navigation editor shows Playlists as **Locked to top bar** rather than offering an unpin action.
- Top-bar drag/drop excludes the locked Playlists tab as both a drag source and drop target.
- Existing user preference for whether Favorites is pinned is not overridden.

## Compatibility
The change operates on the existing `sidebarNavigation.pinned` / `pinnedOrder` persistence model. No new storage schema is introduced. Existing saved navigation preferences are normalized on load so the locked Playlists position is deterministic.
