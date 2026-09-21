# Build 184 — Favorites Playlist Info Live Projection Fix

## Problem
Playlist Info edits for the canonical Favorites autoplaylist were persisted and could appear in the Playlist Manager, but the left sidebar projection was not repainted until a later lifecycle such as restart.

## Root cause
`savePlaylistInfoChanges()` updated the persisted playlist and the in-memory `playlists` array, and synchronized `sidebarNavigation.custom`, but the canonical playlist branch did not call `renderSidebarNavigation()` (or refresh dependent tab projections).

## Fix
After a successful playlist-backed Playlist Info save:
- persist navigation state,
- immediately render the sidebar,
- immediately render tabs,
- update the active tab label,
- refresh the Favorites view when the edited playlist is the canonical Favorites autoplaylist.

No duplicate Favorites entity or alternate identity was introduced.

## Regression coverage
The Build 177 Playlist Info regression suite now explicitly requires the live projection calls in the playlist-backed save path.
