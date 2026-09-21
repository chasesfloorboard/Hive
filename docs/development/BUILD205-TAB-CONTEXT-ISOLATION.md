# Build 205 — Music/Favorites Tab Context Isolation

## Purpose

Build 204 exposed a tab-context regression: selecting Favorites could create/use an additional music-kind tab, and returning to Music used the first `kind === 'music'` tab rather than the canonical Music navigation tab. That allowed the Favorites playlist viewer to appear to take over Music.

## Root cause

Two paths were ambiguous about music-kind tabs:

1. `restoreMusicBrowserState()` selected `tabs.find(t => t.kind === 'music')`, which is not sufficient once Favorites/playlists also use `kind: 'music'`.
2. `openPlaylistFromSidebar()` always delegated to `openOrReusePlaylistMusicTab()`, even when the requested sidebar destination already had its own pinned Music tab.

## Fix

- Canonical Music restoration now targets `navId === 'music' && kind === 'music'`.
- Sidebar playlist activation first reuses the tab whose `navId` is the requested sidebar destination; only if no such pinned tab exists does it create/reuse an extra playlist Music tab.
- This keeps Music and Favorites as separate browser instances while preserving the shared Music Viewer implementation.

## Regression coverage

`test/build205-tab-context-isolation.test.js` verifies:

- Music restoration cannot select another music-kind tab.
- Sidebar playlist activation can reuse its own pinned Music tab.
- Favorites does not create a second unpinned Music tab when its pinned tab exists.

## Validation

Targeted Build 205 tests pass. Full suite and static checks are run as part of the build audit; any pre-existing environment-only failures are recorded rather than hidden.
