# Build 37 — Tray, Podcast Quick Access, Yearly Wrap & UI Audit

## Scope

Build 37 adds Linux system-tray integration, persistent podcast show favorites, a Yearly Wrap retrospective, safe rich text labels for sidebar/top tabs, Spotify playback diagnostics, and a second visual pass over Settings.

## Linux tray

- Uses Electron `Tray` on Linux with a bundled Hive tray icon.
- Uses StatusNotifierItem when the desktop provides it.
- Menu exposes current track, Play/Pause, Previous, Next, Show Hive, and Quit Hive.
- Tray state follows the existing MPRIS playback payload, so it does not create a second playback engine.
- Tray actions route through the existing MPRIS command path.

## Podcast favorites

- Podcast shows can be favorited from search results.
- Favorites persist in Hive `config.json` as `podcastFavorites`.
- The Podcasts page displays a Quick Access / Favorite shows section above search results.
- Opening a favorite fetches its RSS feed and expands its episodes.
- Favorites are capped at 50 entries.

## Yearly Wrap

- Adds a persistent sidebar destination named `Yearly Wrap`.
- Current-year history is summarized into listening time, play count, unique artists/albums, top artist, top track, top album, most-listened day, top tracks, and top artists.
- The presentation is intentionally calm and information-first, using the supplied MusicBee Wrapped project as conceptual reference rather than copying its implementation.

## Rich navigation labels

- Sidebar and top-tab labels accept a constrained, sanitized HTML-like subset.
- Allowed tags: `span`, `b`, `strong`, `i`, `em`, `u`, `small`, `code`, `br`.
- Allowed span classes: `hive-pulse`, `hive-rainbow`, `hive-glow`.
- Allowed inline styles are limited to color/weight/style/text decoration/shadow/spacing/opacity/font size.
- Script/event attributes, URLs, arbitrary tags, and unsafe CSS functions are discarded.
- Example:
  `<span class="hive-glow" style="color:#ffd84a">MUSIC</span>`

## Spotify diagnostics

- Spotify play requests log title, artist, album, URI, normalized duration, and artwork source.
- Bridge commands and results are logged.
- Unknown/mismatched Spotify state URIs are logged and ignored rather than painting stale metadata/artwork over the current queue item.
- Existing per-session TXT logging captures these events.

## Settings UI pass

- Settings tabs remain flat, always-visible wrapping buttons.
- Removed the old grid/mobile scrollbar behavior.
- Active/hover states now use the same control/background/border language as the main viewer.
- Settings surface, status cards, navigation rows, and podcast/yearly surfaces use the same Hive theme variables.

## Validation

- `node --check app/main/main.js` — PASS
- `node --check app/main/preload.js` — PASS
- `node --check app/renderer/renderer.js` — PASS
- `bash -n install.sh` — PASS
- `npm run check` — PASS
- `npm test` — 19/20 PASS; one existing environment-only artwork test fails because `node_modules/music-metadata/lib/index.js` is absent in this build workspace.
- Runtime Electron/Wayland tray playback was not available in this environment and is not claimed as runtime-tested.
