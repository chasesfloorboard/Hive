<p align="center">
  <img src="resources/hive-logo-glass.png" alt="Hive" width="96" />
</p>

<h1 align="center">Hive</h1>

<p align="center">
  An offline-first Linux desktop music library manager and player.
</p>

Hive plays music from your own local library through native GStreamer
playback, with a focused Electron interface built for large collections,
embedded metadata, multi-picture artwork, and playlists. It keeps Favorites
and ratings inside your actual music files instead of a database only Hive
can read, so your library stays yours no matter what you use to play it
later.

## Features

- **Native local playback** via GStreamer — gapless, ReplayGain-aware, no
  unrelated audio-server dependency beyond PulseAudio/PipeWire.
- **Embedded metadata is authoritative.** Favorites, ratings, and tags are
  written into the files themselves (via a bundled Mutagen backend), not
  locked in an app-only database.
- **Library scanning and management** for large local collections, with
  MusicBrainz-assisted matching and artwork lookup.
- **Playlists, queue, and a full tag editor**, including bulk multi-select
  album actions.
- **Yearly Wrap** — a local, private "your year in music" summary, with
  MusicBee Wrapped archive import for anyone migrating libraries.
- **Podcasts**, plus an optional Spotify/Spicetify integration bridge.
- **A small, trusted-local plugin system** for extending the UI.
- **Portable by design** — the whole install, including your library
  database and settings, can live in one folder on a removable drive; see
  [Portable mode](#portable-mode) below.
- **Crash reporting (local only) and GitHub Releases auto-update**, both
  opt-respecting — Hive never installs an update without asking.

## Install

Grab the latest release from the
[Releases page](https://github.com/MADVlLLIAN/Hive/releases), extract it,
and run the installer:

```bash
tar -xzf Hive-*.tar.gz
cd Hive
./install.sh
```

`install.sh` installs Node dependencies, downloads Electron, compiles the
small native GStreamer helper for your machine, and sets up a desktop entry
and MPRIS (media-key) integration. It never runs a remote script as root —
the one `sudo` prompt it can show (Spicetify/Spotify filesystem access) is
explicit, described up front, and skippable.

### Portable mode

Hive's whole folder — code, settings, and library database — is designed to
be relocatable. Extract it anywhere writable, including an external or
removable drive, and it stores its data (`Hive Data/`) right next to itself
instead of a fixed system path. The one requirement: the extracted folder
must be named `hive` (any case) for Hive to recognize it as its own
portable root — a name like `Hive-1.0.0/` won't be detected, so rename it
to `Hive/` first if your download tool changed it.

## Requirements

- Linux
- Node.js and npm
- Python 3
- GStreamer 1.0 development/runtime packages and a C compiler
- `ffmpeg` and `metaflac` for the applicable metadata formats

## Development

```bash
npm ci --ignore-scripts
npm test
npm run check
npm start
```

Hive never needs access to a developer's real music library for automated
tests. Configure test folders in the app only when doing deliberate manual
testing.

## Safety model

- GStreamer is the sole native playback owner.
- Embedded metadata is authoritative for Favorites/Love.
- Metadata jobs are journaled in SQLite before writes and verified after
  writes; every write is confirmed against the file before it's considered
  done.
- Metadata/artwork writes and deletes are restricted to your configured
  library folders — nothing outside them is ever touched.
- Hive keeps metadata temporary files outside library folders and
  suppresses its own watcher events.
- The renderer is sandboxed with context isolation and a narrow preload
  bridge; there is no Node.js access from the UI.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system boundaries.

## Rich sidebar / tab labels

Hive navigation labels support a constrained safe HTML-like subset. For
example, paste this into a sidebar rename field:

`<span class="hive-glow" style="color:#ffd84a">MUSIC</span>`

The supported animated classes are `hive-pulse`, `hive-rainbow`, and
`hive-glow`.

## License

MIT — see [LICENSE](LICENSE).
