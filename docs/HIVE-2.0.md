# Hive 2.0 — MusicBee's features in Hive

Hive 2.0 brings MusicBee's features and settings into Hive, in Hive's own UI.
Where Hive had a weaker version of something MusicBee does well, 2.0 replaces
it with MusicBee's structure. It was developed on the `musicbee` branch.

## Testing a copy beside a real install

These environment variables let a second copy run without touching the real
one: `HIVE_DATA_ROOT` (data folder), `HIVE_MPRIS_NAME` (MPRIS bus name),
`HIVE_DISABLE_UPDATES=1` (no release updater), and
`HIVEBEE_IMPORT_DRY_FILE_WRITES=1` (MusicBee import and volume analysis
don't write the music files). Don't start a test copy with
`scripts/hive-launcher.sh`: its cleanup kills processes matching
`/Hive-*/app/workers/database-worker.py`, which includes the real Hive's
worker. Launch Electron directly instead.

Headless recipe (no sound, no window, no Discord/MPRIS):

```
HIVEBEE_IMPORT_DRY_FILE_WRITES=1 HIVE_DISABLE_UPDATES=1 HIVE_DISABLE_SPOTIFY_BRIDGE=1 HIVE_DATA_ROOT=<copy of data> \
HIVE_PORTABLE_ROOT=$PWD DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent xvfb-run -a \
  node_modules/electron/dist/electron . --remote-debugging-port=9333
```

with `audioOutputDevice: "null"` in that copy's config.json. `null` is a
test-only fakesink output in the native helper that keeps the full DSP chain
(`alsa:null` is bit-perfect, which bypasses it). Drive the window over CDP.

## How MusicBee was studied

MusicBee.exe (3.x, .NET, obfuscated) was decompiled with ilspycmd for
reference only; names are scrambled but strings, enums and file formats are
readable. REA (MCP) read the plugin API (`mb_*.dll` interface copies) and the
native `MusicBeeBass.dll`. No MusicBee code is copied; formats and behaviour
are reimplemented.

Key facts:
- Library `MusicBeeLibrary.mbl`: Int32 header (version 1 in the low byte,
  record count above), then records (see `app/main/musicbee-library.js`).
  Tag codes are MusicBee's `TagCode` enum. Paths are relative to the drive
  root, Windows separators, case-insensitive.
- Playlists: `.mbp` (header + Int32 count + (path, Int32) pairs),
  `.xautopf` (XML auto playlist).
- Equaliser presets `.sde`: INI `[Equalizer]` with per-channel Left/Right
  gains, preamp and `Bands=10|15`. Band centres: 10-band 31.25 Hz–16 kHz in
  octaves; 15-band 31.25, 49.2, 77.5, 122, 192.3, 302.9, 477, 751.3, 1183.3,
  1863.7, 2935.3, 4623.1, 7281.4, 11468.3, 18062.5 Hz. Modes: Manual,
  Auto-Select by Genre, named presets.
- Settings: `AppData/MusicBee3Settings.ini` is XML (984 keys).

## Feature status

Settings for these live in `config.hivebee` (`prefs` flat keys, `dsp`); any Settings control with `data-hivebee-pref="<key>"` binds itself (`bindHiveBeePrefControls`).

| MusicBee feature | Hive | Where |
|---|---|---|
| Import MusicBee library (plays, skips, last played, date added, rating, Love) | Done | `app/main/musicbee-library.js`, Settings → Listening history |
| Import static + auto playlists | Done | same |
| Auto playlist "in the last" / "does not contain" rules | Done | `smartCompare` in renderer.js |
| Equaliser: 10/15 band, preamp, presets (.sde), Manual, Auto-Select by Genre | Done | `app/renderer/equaliser.js`, helper `EQ` command, player bar EQ button |
| Stereo balance | Done | helper `BALANCE` command, equaliser panel |
| ReplayGain Smart mode | Done | `smartReplayGainUsesAlbum` in renderer.js, Settings → Playback |
| Stop after current / sleep timer (stop or close) | Done | right-click Play; helper `NEXT_CLEAR` |
| Track-change pop-up notification | Done | `hivebee:trackPopup`, Settings → Playback |
| Hotkeys (configurable) | Done | `HOTKEY_ACTIONS` in renderer.js, Settings → Hotkeys |
| Resume position for long tracks | Done | pref `player.resumeMinutes`, localStorage `hive:resume-positions` |
| Theater mode with Up Next and artist bio | Done | `toggleTheaterMode` (F11, player bar button), `artist:info` IPC (Wikipedia summary) |
| Internet radio (directory search, saved stations, stream links, now playing) | Done | `app/main/internet-radio.js` (radio-browser.info, .pls/.m3u, ICY titles), Hive menu → Internet radio… |
| Spotify playlist import (resumed from 1.0's pause) | Done | `SPOTIFY_DEVELOPMENT_PAUSED = false`; bridge reads playlists with `Spicetify.Platform.PlaylistAPI` (whole/private playlists while Spotify is open), public embed fallback (first 100 tracks) |
| Apple Music browser (not a MusicBee feature) | Done | `app/main/apple-music.js`: public music.apple.com pages + iTunes lookup previews; library matches play in full, the rest as 30 s previews; Hive menu → Apple Music… |
| Full songs for Apple Music / Spotify playlists via YouTube Music | Done | `app/main/youtube-music.js`: yt-dlp search on YouTube Music (title/artist/length match, cached in `youtube-music-matches.json`), time-limited audio URL played by the media element (`source: 'youtube'`, paths `ytm:apple:<id>` / `ytm:spotify:<id>`); tags from the source + MusicBrainz recording lookup (1 req/s). yt-dlp from PATH, `~/.local/bin` or Hive's own `bin/` (Install button in the Apple Music dialog). Debug: `HIVE_SPOTIFY_DEBUG_PORT` opens a localhost DevTools port on the hidden Spotify. |
| Shuffle by track/album/artist/grouping/work, spread same artist | Done | `hivebeeShuffleQueue`, Settings → Playback |
| Auto-DJ options (source, keep N queued, artist gap, similar artists, skip recently played, min rating) | Done | Settings → Playback → Auto-DJ |
| Fade on pause/resume | Done | helper `PAUSE_FADE`/`PLAY_FADE` (reuse the LOAD transport fade); Settings → Playback → Sound |
| Crossfade (period, not within an album, on skip, per-track Do-not-crossfade) | Done | helper `XFADE` companion pipeline + LOAD fade-in field; Settings → Playback → Crossfade |
| Tag tools (find & replace incl. regex/whole word, Title/Sentence/UPPER/lower case, copy/swap/fill fields) | Done | `app/renderer/tag-tools.js`, track menu → Tag tools |
| Analyse volume (ReplayGain 2.0 track + album tags via ffmpeg EBU R128) | Done | `app/main/replaygain-analyser.js`, track menu → Analyse volume |
| File converter (MP3/AAC/Opus/Vorbis/FLAC, tags + cover kept, template naming) | Done | `app/main/file-converter.js`, track menu → Convert; Ogg/Opus cover via tag_helper `embed_ogg_cover` |
| Find duplicates (artist+title[+album], version-noise aware, length tolerance, keep best copy, playlist or delete) | Done | `app/renderer/duplicates.js`, Hive menu → Find duplicates |
| Updater can be turned off for a test copy | Done | `HIVE_DISABLE_UPDATES=1` |
| Mini player (always-on-top toggle, cover, transport, love, seek) | Done | `app/renderer/mini.html`/`mini.js`, player bar button or Hive menu |
| Tempo / pitch (SoundTouch, opt-in; helper restarts with HIVE_DSP_PITCH=1; positions scaled by tempo; crossfade skipped while tempo != 1) | Done | Equaliser panel → Tempo & pitch |
| Column browser (Genre → Album Artist → Album, ctrl multi-select, double-click plays) | Done | Tracks view → Browser |
| File organisation (MusicBee templates with $If/$IsNull/$Upper/$Lower/$Left, preview, remaps stats/playlists/history/DB, undo log) | Done | `app/main/file-organiser.js`, track menu → Organise files |
| Import MusicBee settings (EQ presets + active preset, balance, ReplayGain, shuffle, pop-up) | Done | part of the MusicBee library import |
| Virtual tags (3 formula fields, MusicBee template syntax) used in smart playlists and the column browser; choosable browser columns | Done | Settings → Library; `file-organiser.js` doubles as `window.HiveTemplates` |
| Right-click menus regrouped (Play / Edit / Rating / Add to / Send to / Find / Tools / Remove / Delete), an icon per entry | Done | `showTrackContextMenu`, `showAlbumContextMenu`; new icons in `icons.js` |
| Hide/show right-click menu sections | Done | Settings → Appearance → Right-click menu (`menu.hidden`; items carry `menuKey`) |
| MusicBee skins → Hive themes (38 XML skins incl. overlay skins; compiled .xmlc can't be read) | Done | `app/main/musicbee-skins.js`, Settings → Appearance → Theme files → MusicBee skin… |
| Panel arrangement (left/right panel, lyrics, playing list, now playing, swap sides, player bar on top) | Done | Settings → Appearance → Panels (`layout.*`, classes on `<html>`) |
| Track list: +11 columns (Last Played, Skips, Love, Grouping, Mood, BPM, Format, File Size, Virtual 1-3); row density; cover thumbnails toggle | Done | `SONG_COLUMN_DEFS`, header right-click; `layout.density` keeps `songVirtualState.rowHeight` = CSS row height |
| Interface size (zoom 80-150%) | Done | `hivebee:setZoom` → `webContents.setZoomFactor` |
| Lyrics dock left or right | Done | `layout.lyricsSide` moves `#lyrics-section` |
| Colour editor (live preview, save as theme) | Done | Settings → Appearance → Theme → Customise colours; `themes:saveCustom` |
| Player bar buttons can be hidden (Love, Shuffle, Repeat, Equaliser, Mini player, Volume) | Done | Settings → Layout → Player bar, or right-click the player bar's buttons |
| Settings grouped like MusicBee's Preferences (Player, Library, Tags, File Organisation, Layout, Appearance, ...) with search | Done | `organiseSettingsLikeMusicBee` in renderer.js moves existing sections at startup |
