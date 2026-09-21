# Build 142 — 1.0 Pre-Release Audit Pass

## Included

- Restored the `Years: ON/OFF` Music toolbar control while keeping the removed Release Date sort control removed.
- Reused the existing persisted per-tab `albumYearDividers` state and year-divider renderer.
- Made Star Favorites persist/render with the real `★` icon while retaining its Smart/Auto Playlist definition.
- Added playlist duplication from the Playlist manager with `Name Copy`, then `Name Copy 2`, `Name Copy 3`, etc. naming.
- Duplicated playlists receive a new identity and never inherit the built-in Star Favorites `systemKey`.
- Added persistent custom playlist destinations to the left sidebar/navigation model.
- Added playlist add/remove controls to Settings → Navigation as well as Playlist context-menu access.
- Sidebar playlist destinations remain linked to the underlying playlist and therefore follow playlist edits/renames.
- Preserved the existing queue, GStreamer, MPRIS, Spotify/Spicetify, artwork, tagging, plugin, and tab architecture.

## Existing 1.0 work audited but not claimed as runtime-complete

The source already contains ReplayGain controls/application, millisecond-capable start/end tag fields and native trim handling, the event-driven GStreamer spectrum path, and monochrome/adaptive logo handling. These remain release-gate test items until exercised against real media/UI scenarios.

## Validation

- Targeted Build 142 regression tests: 6/6 passed.
- Full `npm test`: 208/210 passed. Two known environment-dependent failures remain:
  - embedded artwork payload test: the extracted source tree does not contain `node_modules/music-metadata/lib/index.js`.
  - MusicBee Wrapped importer test: its expected Wrapped archive fixture is not present in the extracted source tree.
- `npm run check`: passed.
- Node syntax checks for touched/runtime entry points: passed.
- Shell entrypoint permissions: `install.sh`, `scripts/hive-launcher.sh`, and `scripts/spotify-background.sh` are executable.
- No full desktop playback/UI runtime session was performed in this packaging pass.
