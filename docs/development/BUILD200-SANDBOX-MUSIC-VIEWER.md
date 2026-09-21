# Build 200 — Sandbox + shared Music Viewer

## Scope

Build 200 replaces the former **Now Playing** sidebar destination with a generic **Sandbox** launcher. Sandbox is an extension home surface: installed plugins appear as icon tiles, and selecting a tile opens that plugin in its own independent sandbox surface.

The shipped first-party plugin catalog contains only **Monstercat Visualizer**. Community/plugin installation remains supported through the existing plugin API; this change does not add additional bundled extensions.

## Music Viewer

Hive's playable collection presentation is treated as a reusable **Music Viewer** concept rather than a playlist-specific page. The same viewer presentation is used for:

- the main Music library
- Favorites
- user playlists, including Spotify playlist records
- History
- Recently Added
- Top 25 Most Played
- configured library folders

The viewer exposes the same **Albums / Tracks / Artists** controls and the **Years** album grouping control wherever the destination represents playable music. Playlist destinations continue to use independent Music-tab DOM/state, so their scroll position, expanded album, view mode, and presentation state do not overwrite the main Music viewer.

The Playlists destination itself remains the playlist manager. Opening an individual playlist from that manager or the sidebar opens the playlist's own Music Viewer instead of routing back into the manager.

## Sandbox plugin contract

The public plugin UI capability is now `ui.sandbox` with `Hive.ui.registerSandboxPanel(...)`. The plugin continues to consume Hive's existing native GStreamer spectrum events and does not own playback or create a second audio engine.

The Sandbox launcher is intentionally separate from playback UI. Additional plugins can be added later without changing the launcher architecture.

## Compatibility

The old `nowplaying` navigation identifier is migrated to `sandbox` so existing user ordering/pinning is retained. Persisted tab state using the former special-view identifier is likewise migrated when restored.
