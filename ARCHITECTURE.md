# Hive — Architecture

A map of where things live, so you can find the code for a feature without
reading the whole tree. Hive is two apps that talk to each other:

- **Hive (desktop)** — an Electron app with native GStreamer playback, for Linux
  (and Windows). It owns your library on disk and writes metadata into the files.
- **Hive Mobile** — an Android app (Jetpack Compose + Media3) that plays the music
  already on your phone and stays in step with the desktop.

They pair over your LAN (or Tailscale) through **Hive Link** and keep favourites,
play counts and playlists in sync. Neither needs an account or the cloud.

---

## Desktop (`app/`)

Electron, split across a main process and a renderer. Two files are still large
and being broken into modules (see *Known structure debt* below).

### Main process — `app/main/`
The Node side: windows, IPC, the library scan/cache, metadata writes, and the
bridge to the native player.

- `main.js` — the entry point and still the biggest file (~8.9k lines): window
  and tray lifecycle, protocol registration, and most IPC handlers.
- **Playback** — `gstreamer-bridge.js` talks to the native C helper over a small
  protocol; `audio-output-manager.js` chooses the output device;
  `playback-protection.js` keeps a playing file from being rewritten mid-stream.
- **Library & metadata** — `canonical-metadata.js` is the canonical tag model;
  `metadata-writer.js` writes tags through the bundled Python/Mutagen backend;
  `love-integrity.js` resolves Love/Favorite tags; `file-organiser.js`,
  `file-converter.js`, `file-mirror.js` are the library tools; audio-integrity
  (corruption scan + repair) lives in `main.js`.
- **Providers** — `apple-music.js`, `artwork-providers.js`, `artist-images.js`,
  `musicbrainz.js`, `lyrics-provider.js`, `scrobbling.js`, Soulseek and the
  Spotify/Spicetify bridge.
- **Sync & updates** — `hive-link.js` (the pairing server the phone talks to),
  `directory-tree-watcher.js`, `update-checker.js` / `portable-updater.js`.
- **Desktop integration** — `mpris.js` (Linux media keys), `discord-presence.js`,
  `device-manager.js` (MTP sync).

### Renderer — `app/renderer/`
The UI, a single-page app. `renderer.js` (~22k lines) is the monolith; several
concerns are already peeled into modules beside it:

- `index.html` / `styles.css` — markup and styling.
- `colorExtract.js`, `accent-contrast.js`, `theme-schedule.js` — theming that
  tints the window from the playing cover.
- `equaliser.js`, `keyboard-access.js`, `duplicates.js`, `tag-tools.js`,
  `soulseek-downloads.js`, `yearly-wrap-view.js`, `icons.js` — feature modules.
- `plugin-frame.js` / `plugin-sandbox.js` — the sandboxed plugin runtime
  (each plugin runs in an isolated `<iframe sandbox>`).
- `mini.js` / `mini.html` — the mini-player window.

### Native & Python
- `app/native/gstreamer-player.c` — the C playback helper (links libgstreamer);
  sample-accurate volume ramping lives here.
- `resources/python/` + bundled `resources/mutagen/` — the tag read/write backend.

---

## Mobile (`mobile/android/app/src/main/java/com/local/hive/mobile/`)

Jetpack Compose UI over a Media3 (ExoPlayer) player, reading the phone's own
MediaStore library.

- `ui/` — every screen, in Compose. `HomeScreen`, `PlayerScreens`, `LockPlayer`,
  `StreamingScreens`, `Welcome` (first-run), `YearlyWrap`, `Editing`,
  `MainViewModel` (the screen state holder), and `Components.kt` (the shared
  widgets). `ui/theme/` holds colours, type, shapes and motion curves.
- `data/` — the library and metadata layer: `LibraryScanner`, `LibraryDatabase`
  (Room), `EmbeddedPictures` (cover parsing for every format), `AlbumArt` (the
  Coil fetchers — embedded art, then an Apple Music match, never a folder image),
  `TagWriter`, `Mp4Tags`, `WavTags`, `SmartPlaylists`.
- `stream/` — streaming browse without an account: `AppleMusic`, `Spotify`,
  `YouTubeMusic`, `Lyrics`, `Radio`, `Podcasts`, `Scrobbler`, and the signed-in
  `*Account` variants.
- `playback/` — the Media3 service: `PlaybackService`, `PlayerConnection`,
  `CoverProvider` (notification artwork).
- `soulseek/` — Soulseek download and Google-Drive import.
- `HiveApp.kt` / `MainActivity.kt` — app wiring and the single activity.

---

## How the two talk — Hive Link

The desktop runs a small HTTP server (`app/main/hive-link.js`); the phone is a
trusted client. Loves, ratings, play counts, playlists and Yearly Wrap sync both
ways, and the desktop also serves the latest mobile APK so the phone can offer
"Update available" over the same connection. A phone edit applies on the PC, and
vice-versa.

---

## Known structure debt

`app/main/main.js` and `app/renderer/renderer.js` are the two files still doing
too much. Extracting cohesive subsystems (the dependency-injection pattern used
by `metadata-writer.js` / `update-checker.js` is the template) is the main
ongoing refactor. A caveat for contributors: much of the desktop test suite
asserts against source *text* rather than behaviour, so moving code between files
can trip tests that aren't checking correctness — converting those to behavioural
tests is a prerequisite for safely splitting the monoliths further.

## Building & testing

- Desktop tests: `node --test test/*.test.js`.
- Mobile: `cd mobile/android && ./gradlew testDebugUnitTest assembleDebug`.
- Desktop app: Electron; the native helper is built from `app/native/`.
