# AI Development Notes

## Performance audit — 1.0.0-rc.1

The startup-debug Build 3 audit established that the normal incremental scan can
find and stat all 29,879 files quickly when nothing changed. The major remaining
startup hitch was not filesystem scanning: the main process returned the entire
~93 MB renderer-safe library snapshot over IPC even when the scan found zero
changes. That produced a renderer event-loop stall of about 1.48 seconds.

### Required behavior

- A normal incremental `library:scan` must return a bounded delta, not the entire
  library snapshot, when the renderer already owns the cached library.
- The delta contains changed/new renderer tracks, removed paths, and `scannedAt`.
- The renderer applies changed/new tracks through its maintained indexes and
  removes deleted tracks without replacing the entire library object graph.
- A full authoritative rescan (`forceFull`) continues to return the complete
  renderer payload.
- When an incremental scan finds no changed or removed files, do not rewrite the
  large JSON/gzip startup cache. Avoiding that redundant write prevents a large
  serialization/compression/heap spike.
- Embedded Love reconciliation remains part of the normal scan. If it changes
  cached Love state, the cache must still be rewritten and the renderer receives
  the affected `library:scanTrack` updates.

### Regression guard

Do not trade away the established GStreamer playback invariants, progressive
scan path index, native-tag persistence, artwork behavior, or startup paint
opportunities while optimizing library reconciliation.


## Spotify streaming source — first implementation

Hive's Spotify integration is intentionally a control/metadata layer, not an audio downloader.
The installed Spicetify extension (`resources/spicetify/hive-spotify-bridge.js`) is the bridge
between Hive and the running Spotify desktop client. Hive sends play/pause/seek/next/previous
commands over a loopback HTTP service on `127.0.0.1:43872`; Spicetify executes those commands
through `Spicetify.Player` and reports player state back to Hive. Spotify remains the streaming
engine and no Spotify audio is downloaded into the Hive library.

Spotify playlists are persisted with `source: "spotify"` and `spotifyTracks`. They are virtual
streaming tracks and must not be matched against local files. The normal Hive player UI and
queue are reused; local GStreamer remains authoritative for local files.

The Linux installer prepares Spotify, Spicetify, SpotX-Bash when available, and installs/enables
the Hive Spicetify bridge. Spicetify's internal APIs are version-sensitive, so the integration
must use feature detection and remain isolated from the local GStreamer path.

## UI / navigation polish — Build 7

- Removed decorative emoji icons from the left sidebar navigation. Favorites keeps its `★` marker.
- The sidebar `Playlist Explorer` destination is now labeled `☰ Playlists`.
- The fixed Playlists top tab uses the hamburger icon and reflects the currently selected playlist name when one is open.
- Top-level tabs can be reordered by drag-and-drop; the order is persisted in renderer localStorage for the built-in tabs.
- The standalone Beta Lab top tab was removed. Its existing release-engineering diagnostics are now hosted inside Settings → Beta Lab.
- ReplayGain playback normalization is now implemented for local tracks using embedded `REPLAYGAIN_TRACK_*` / `REPLAYGAIN_ALBUM_*` metadata. Track or album mode and peak-based clipping protection are configurable in Settings → General. The existing GStreamer transport remains authoritative and the 10 ms transport ramp is preserved.

## UI polish / diagnostics — Build 8

- Tag-editor checkboxes/radios use a single themed toggle/card language; do not reintroduce scattered native-looking controls.
- Lyrics editing uses a grouped toolbar and themed writing surface consistent with the rest of the editor.
- Browser-native `title` tooltips are converted to Beehive-themed hover tooltips, including dynamically-created controls.
- Renderer `alert`, `confirm`, and `prompt` calls were removed in favor of the themed in-app dialog surface. Native OS file/folder chooser dialogs remain OS-owned and are not themeable from renderer CSS.
- Settings now contains a Logs panel that loads bounded tails of Hive crash/runtime, scan, startup-debug, or combined logs and can copy the displayed log to the clipboard.

## UI / release verification pass — Build 9

Build 8 was re-audited against the immediately preceding feature requests. One
real integration bug was found: the moved Beta Lab surface was created inside
Settings, but its renderer was still looking for the old removed top-level Beta
Lab tab, so the Settings panel could be empty. Build 9 renders Beta Lab directly
into its Settings host.

The Lyrics editor's two synchronization radio controls are now themed as part
of the same control language as the tag-editor toggles. ReplayGain settings now
re-resolve the current track immediately when the mode/clipping option changes,
and the GStreamer VOLUME command continues to apply the current ReplayGain
multiplier instead of temporarily bypassing it.


## Custom theme CSS — Build 11

- Settings → General can load a user-selected `.css` stylesheet (maximum 1 MB).
- The stylesheet is copied into Hive's user data and reapplied on launch.
- Custom CSS is injected as CSS only; the file is never executed as JavaScript.
- Remove custom CSS restores the built-in Hive theme immediately.
- Keep this feature separate from the functional UI/theme variables so custom styling cannot alter playback architecture.

## Podcasts — first implementation

- Podcasts are a native Hive source, alongside Music and Spotify, using public podcast search plus RSS feeds.
- Episode entries are virtual `source: "podcast"` queue items with a remote `streamUrl`; Hive does not download episodes into the local music library.
- Podcast episodes use the same Hive queue/player controls and may be mixed with local and Spotify entries. Local files remain on GStreamer and Spotify remains on Spotify.
- Podcast discovery uses the public iTunes podcast directory for search and the publisher's RSS feed for episode metadata/audio URLs. Feed cards are collapsible and episodes can be played or queued.
- Remote podcast playback uses the existing hidden HTML media element only for podcast streams; it must not alter the local GStreamer transport.


## Podcasts — Build 12 verification fixes

- The podcast result card's `.podcast-episodes` element is itself the episode list. Do not query for a nested `.podcast-episodes` child when rendering a feed.
- The Podcasts content DOM remains mounted after first initialization so switching top-level tabs preserves search results and expanded feeds.
- Common RSS `<image><url>...</url></image>` artwork must be parsed in addition to `itunes:image`.

## Community integration pass — Build 13

- MPRIS remains a first-class Linux integration already present in the project; do not duplicate it or replace it with a second media-control path. The implementation exposes the standard `org.mpris.MediaPlayer2` / Player service and keeps GStreamer authoritative.
- Added ListenBrainz and Last.fm scrobbling with configurable completion thresholds and optional podcast scrobbling. Scrobbling is a reporting layer only and must never control local transport.
- Added shareable `.hive-theme` JSON theme packs and documented stable CSS variables. Custom CSS remains CSS-only.
- Added a small trusted-local renderer extension API with manifest, optional CSS, and optional `plugin.js`. Extensions may inspect renderer-safe library data, control the existing queue, and add UI styling, but must not replace playback engines.
- Artwork provider architecture is already modular; future provider additions should register with the provider layer rather than coupling network lookups to playback or scanning.

## Community Build 13 boot hardening — Build 14

- Fixed a release-blocking startup regression in the Spotify bridge: `app/main/main.js`
  now explicitly imports Node's `http` module before `startSpotifyBridge()` uses
  `http.createServer()`.
- Spotify is an optional integration. Bridge startup is guarded so an optional
  Spotify bridge failure cannot reject the `app.whenReady()` initialization path
  or prevent the core Hive window/library from booting.
- Do not make Spotify/Spicetify/SpotX, scrobbling, themes, or extensions fatal
  dependencies for the core local-library player.
## UI runtime hardening — Build 15

Build 14 was the first real runtime exercise since the earlier performance builds. Its startup log exposed a serious artwork-memory regression: the renderer retained decoded DOM Image objects in `coverMemoryCache`, reaching roughly 600+ MB after about 80-120 cover loads and producing long renderer tasks. The cache must never retain DOM Image objects; Chromium's own image/network cache remains authoritative.

Navigation is now user-owned: sidebar destinations can be reordered and hidden, built-in top tabs can be reordered and hidden from Settings → Navigation, and hidden built-ins can be restored there. Music remains the required primary top tab.

Settings is a fixed-height flex surface with an independently scrollable body so every settings section remains reachable on small windows. Song-list columns default to fit-to-screen and keep the right edge inside the Music viewer; horizontal overflow is only unavoidable when the selected columns' minimum widths physically exceed the available viewport.

Drag-and-drop uses explicit insertion indicators and consistent motion states across sidebar, top tabs, queue, and settings navigation editors. Keep these interactions smooth and avoid teleporting/rebuilding visible UI when an animated state can be preserved.


## Runtime crash / popup stacking hardening — Build 16

- Hive-rendered modal overlays use one stacking manager. If an action inside an
  open popup opens another Hive popup, the new popup must always receive a
  higher stacking layer and appear above its parent. Do not rely on scattered
  hard-coded z-index values for nested dialogs.
- Crash diagnostics must never crash themselves. stderr can be a closed terminal
  pipe; file logging remains authoritative and diagnostic writes must tolerate
  EPIPE without recursive exception handling.
- The persistent GStreamer helper is expected to survive for the life of the
  player. Unexpected helper exit is logged and surfaced to the renderer; Hive
  may perform a small bounded automatic restart instead of leaving playback
  permanently attached to a dead helper. Never create an unbounded respawn loop.
- Renderer process crashes are logged with Electron process metrics and may be
  recovered with a bounded window reload. Playback/session persistence remains
  the recovery mechanism; do not replace the native GStreamer transport.

## Stability / runtime diagnostics — Build 17

- Debug launches now keep a low-frequency runtime health stream after the original
  20-second startup profiler ends. Delayed renderer/GPU/GStreamer failures must be
  diagnosable from the period after a track has actually been playing for minutes,
  not only from startup.
- The themed alert/confirm/prompt surface is now instance-based. A child dialog gets
  its own overlay and therefore stacks above its parent rather than replacing it.
- Music track columns are fit-to-viewer by invariant. Resizing changes proportions,
  then the complete grid is normalized back to the exact available viewer width.
  There is no user mode that intentionally creates a second horizontal scroll surface.

## Smart playlist / modal UX — Build 19

- The Hive brand dropdown must remain open when the click originates anywhere inside `#brand-btn`; do not compare only `event.target === brandBtn`, because the brand contains nested spans.
- Hive modal close controls use delegated event handling so cloned/dynamically inserted dialogs always close. Escape closes the highest visible Hive modal.
- Create Smart Playlist uses one `#smart-playlist-rules` container only. Source selection uses distinct radio IDs (`smart-source-library`, `smart-source-playlist-option`, `smart-source-folder-option`) while the playlist/folder selects retain their own IDs.
- Smart playlist UI is intentionally progressive: Source → Rules → Results, with less-common description/display/duplicate/export options under Advanced. Existing save fields and semantics remain intact.
- On/off checkboxes should use a simple modern left-to-right switch. Source radio choices should be cards, not switch-shaped radio controls.
