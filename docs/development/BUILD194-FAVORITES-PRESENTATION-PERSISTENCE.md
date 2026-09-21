# Build 194 — Favorites presentation persistence

Build 194 fixes a persistence edge case in the canonical Favorites playlist.

## Problem

Favorites is a real persisted autoplaylist, while Music/Playlists navigation label styling is persisted in `sidebarNavigation`. Older navigation migrations could therefore leave a rich Favorites label (for example the Rainbow style) in the sidebar projection while the canonical playlist record still contained the plain `Favorites` label. On a subsequent startup, the canonical playlist record won and the visual style disappeared.

## Fix

During Favorites navigation migration, when the canonical playlist still has the untouched plain `Favorites` label and the existing canonical sidebar projection contains a recognized Hive rich-label style, Hive promotes that projection back into the canonical playlist and persists it through `savePlaylist`. The sidebar projection then continues to mirror the canonical playlist.

This preserves the single-source-of-truth model while recovering presentation saved by older builds.
