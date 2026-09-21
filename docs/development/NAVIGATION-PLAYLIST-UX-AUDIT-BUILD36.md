# Navigation / Playlist UX Audit — Build 36

## Scope

Build 36 extends the existing Build 35 queue/playback stability work with navigation-list customization and session persistence.

## Changes

- Playlist Info now supports:
  - automatic Shuffle when the list is opened/entered;
  - a static text-symbol icon selection;
  - the existing display mode selection.
- The same list-info controls are available from the context menu for built-in left-sidebar collections and configured library folders.
- Playlist icons are also shown beside playlist names in the Playlists browser.
- Sidebar icons have explicit width/margin so symbols do not hug destination text.
- Configured library folders use the monochrome text-presentation Closed File Folder symbol (`U+1F5C0` + `U+FE0E`) instead of the folder emoji.
- Music Explorer is removed as a sidebar destination and replaced by a `+ Library` action directly below the configured folders in Computer. The action opens the existing native folder chooser and starts the normal scan path.
- The Now Playing sidebar destination now opens a real main-browser view containing the current queue in queue order. Queue changes repaint that view without changing playback transport.
- UI navigation state is additionally persisted in the durable Hive config (`config.json`), including sidebar order/visibility/labels, sidebar metadata, top-tab order/visibility, active tab, and saved tab browser state. Existing localStorage preferences remain compatible.
- Settings tabs are flat wrapping buttons rather than a scrollable tab strip.

## Playback safety

Entering a list with automatic Shuffle enabled only turns the global Shuffle state on; it does not tear down or reload the current GStreamer stream. Starting the list still uses the established playback path.

## Validation

- `node --check app/renderer/renderer.js` — PASS
- `node --check app/main/main.js` — PASS
- `node --check app/main/preload.js` — PASS
- `bash -n install.sh` — PASS
- `npm run check` — PASS
- `npm test` — 19/20 PASS; the existing environment-only artwork test cannot resolve `node_modules/music-metadata/lib/index.js`.
- Electron runtime UI/playback was not available for this build validation; no runtime success is claimed.
