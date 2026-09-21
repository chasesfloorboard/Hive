# Hive Build 84 — Sidebar Navigation Settings

## Scope

Fix the sidebar navigation behavior reported after the album year-divider work.

## Changes

- Podcasts is no longer a default pinned top-bar destination.
- A one-time migration removes Podcasts from stale pinned navigation created by older builds; after the migration, users may explicitly pin it again.
- Podcasts can be right-clicked and exposes an Info action without pretending that a podcast show collection is a playable M3U track collection.
- Sidebar Info settings now persist the configured display view and automatic visual shuffle together in each destination's `nav:<id>` metadata.
- Older sidebar display-view localStorage keys remain readable as a backward-compatible fallback.
- The sidebar automatic-shuffle preference applies to the Tracks view for the active sidebar destination without changing the Albums ordering or the global transport Shuffle switch.
- Entering a sidebar destination uses that destination's configured default view.
- Podcast Info disables library-specific Albums/Tracks/Artists and automatic-shuffle controls because Podcasts has its own discovery/episode UI.
- The existing Years control remains visible only while Albums is selected.

## Validation

- `node --check app/renderer/renderer.js` — passed.
- Sidebar navigation regression tests — 5/5 passed.
- `node scripts/check.js` — passed.
- Full test suite — 57/58 passed. The only failure is the pre-existing clean-tree `music-metadata` module absence in `test/artwork-payload.test.js`; no dependency changes were made.

## Runtime status

No Electron/GNOME runtime test was performed in this build environment. The build must be tested interactively, especially:

1. Podcasts is absent from the top bar on a fresh/default navigation state.
2. Right-clicking Podcasts opens Info.
3. Music Info configured as Albums + automatic shuffle leaves Albums normally ordered and randomizes Tracks.
4. Changing Music settings does not alter History/Favorites/Recently Added/Top 25 behavior.
5. The Years button disappears when Tracks or Artists is selected.
