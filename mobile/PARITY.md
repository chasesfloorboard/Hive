# Hive Mobile: parity with Hive

The goal is a 1:1 port of Hive's features with a Hive-designed mobile UI.
Each row is a Hive feature (taken from the desktop app's 215 IPC handlers and
renderer views) and its state on mobile.

**Status:** ✅ done · 🟡 partial · ❌ missing · 🖥️ runs on the PC, driven from the phone over Hive Link · ➖ desktop-only, no mobile meaning

## Library and browsing

| Feature | Hive (desktop) | Mobile |
|---|---|---|
| Scan library, watch for changes | `library:scan`, `scanChanged`, directory watcher | ✅ MediaStore scan + observer |
| Albums grid | album cards, sort | ✅ sort by year (sections), A–Z, artist, added |
| Albums grouped by year with dividers | `album-year-section` | ✅ (Years: on/off) |
| Inline album expansion (cover + tracklist in the grid) | `inline-album-dropdown` | ✅ |
| Tracks table: sortable columns, column chooser | `song-header`, column drag | 🟡 one sort, no columns |
| Artists, artist images, artist info | `artist:info`, `artwork:artistImage` | 🟡 list and pages with artist photos (Deezer, exact match, as on the PC); no bio |
| Similar artists | `music:similarArtists` | ❌ |
| Genres, folders | | ✅ |
| Column browser (genre › artist › album) | `column-browser` | ❌ |
| Search (library database) | `library:searchDatabase` | ✅ artists, albums, songs |
| History, Top 25 Most Played, Recently Added | sidebar views, `history:get` | ✅ sidebar views |
| Navigation editor (pin/reorder views, rich animated labels) | `navigation-editor`, `hiveRich*` | ❌ |
| Multiple top tabs (open views as tabs) | topbar tabs | ❌ |

## Favorites, ratings, play counts

| Feature | Hive | Mobile |
|---|---|---|
| Love (embedded `LOVE RATING`) | `track:toggleLove`, `tracks:setLove` | ✅ in-app, synced via Hive Link |
| Love written into the phone's own files | | ❌ |
| Album Favorites (separate from loving songs, as in Samsung Music) | | ✅ phone only |
| Phone Love applied on the PC | `acceptPhoneChanges` | ⏸️ held on purpose until Hive Mobile is stable; PC → phone works |
| Star ratings (POPM) | `track:setRating`, `tracks:setRatings` | 🟡 rate on the phone (Track info), PC ratings come to matched songs, Top Rated playlist; not written into files |
| Play counts and skip counts | `track:recordPlay`, `stats:*` | 🟡 counted locally, not synced |
| Favorites sync phone ↔ PC | Hive Link | ✅ |

## Playlists

| Feature | Hive | Mobile |
|---|---|---|
| Playlists: create, edit, reorder, delete, custom image | `playlists:*`, `playlist:chooseImage` | 🟡 create, add (song, album, artist, playlist), reorder, remove, rename, delete; no custom image |
| Playlist info page (header, stats) | `playlist-info` | ✅ |
| Smart / auto playlists | `smart-source` | 🟡 four fixed auto playlists |
| Import M3U, export M3U | `playlists:chooseImportFile`, `exportM3U` | ✅ import (file name, then artist and title), export as .m3u8 |
| Import Spotify playlists | `playlists:importSpotify` | ❌ |
| Playlist sync phone ↔ PC | | 🟡 PC → phone: Hive's playlists read only, played from the phone's copies or through the PC, "Copy to this phone"; phone playlists stay on the phone |

## Playback

| Feature | Hive | Mobile |
|---|---|---|
| Playback engine | GStreamer, gapless | ✅ Media3 ExoPlayer, gapless |
| Queue: view, jump, remove | `#queue-list` | ✅ |
| Queue: drag to reorder, multi-select | queue drop targets | 🟡 drag to reorder, remove; no multi-select |
| Auto DJ (a mix grown from songs, an album, an artist or a playlist) | | ✅ hold an artist or playlist, ⋮ on a song or page, or the selection bar: seeds first, then their artists, collaborators and same-genre artists, weighted by plays and Favorites, artists spaced out; Play or Save as playlist (`playback/AutoDj.kt`) |
| Pick albums: hold, then drag across the grid | album multi-select | ✅ hold a cover and drag (the list scrolls at its edges); tap to add or remove while picking; the selection bar acts on all their songs |
| Shuffle, repeat | | ✅ |
| Playback state restored on launch | `playback-state:*` | ✅ queue, track, position, shuffle, repeat; Bluetooth resume |
| Equaliser with presets, import presets | `equaliser:*` | ✅ 10 bands + preamp, MusicBee presets, auto by genre, save/delete; no .sde import UI yet |
| ReplayGain | `replaygain:analyse` | ✅ reading tags: Off/Track/Album/Smart, clipping guard, as on the PC · 🖥️ analysis stays on the PC |
| Audio output selection | `audio-output:*` | ➖ Android's output switcher |
| Lock screen, notification, Bluetooth controls | MPRIS, tray | ✅ MediaSession |
| Mini player window | `miniplayer:*` | ✅ mini player bar |
| Sleep timer | | ✅ 15–90 min with fade-out, end of song |
| Crossfade (length, not within an album, when skipping) | `crossfade.*` | ✅ companion player fades the outgoing song out while the next fades in, as on the PC; no per-song "Do not crossfade" (that tag isn't readable on the phone) |

## Now playing

| Feature | Hive | Mobile |
|---|---|---|
| Now playing art, track details panel | `now-playing-card` | 🟡 |
| Accent colour from the cover | `colorExtract.js`, 900 ms glide | ✅ aura + accent |
| Lyrics (search, synced, edit) | `lyrics:search`, `lyrics-editor` | 🟡 LRCLIB synced (exact, then search) and Genius plain, highlighted and tap-to-seek; no editor, no embedded lyrics |
| Visualiser plugin (Monstercat) | `plugins:*` | ❌ |
| Track info popup | `hivebee:trackPopup` | ✅ tags, format/bitrate/sample rate from the file, plays, size, location, share |

## Metadata and artwork

| Feature | Hive | Mobile |
|---|---|---|
| Tag editor (single and bulk) | `track:writeTags`, `metadata:saveBatch` | ❌ / 🖥️ |
| Auto-tag album from MusicBrainz | `musicbrainz:*`, `auto-tag` | ❌ / 🖥️ |
| Cover picker: search internet, iTunes, paste, file | `cover:*` | ❌ / 🖥️ |
| Artwork library, remove/replace art | `artwork-library`, `track:modifyArtwork` | ❌ / 🖥️ |
| Delete from disk, show in folder | `tracks:deleteFromDisk` | ❌ |

## Online sources

| Feature | Hive | Mobile |
|---|---|---|
| Internet radio (search, now playing) | `radio:*` | ✅ radio-browser.info popular and search (name or genre), add by URL (.pls/.m3u), saved stations, live song titles |
| Podcasts (search, feeds, favorites) | `podcast:*`, `podcasts:favorites:*` | ✅ Apple directory search (ranked as on the PC), feed URLs, follow, episodes with progress, resume, mark played, speed |
| YouTube Music page, downloads | `ytmusic:*` | 🟡 Apple Music and Spotify songs the phone lacks play in full from YouTube Music through Hive on the PC (falls back to previews); no YouTube Music page or downloads |
| Spotify page and library | `spotify:*` | ✅ editorial playlists, shared links, previews, library matches, import; sign-in (own developer app) for your playlists, Liked Songs, private playlists and search. No playback control of the Spotify app |
| Apple Music page | `applemusic:*` | ✅ Browse shelves, search, playlists and albums, links; library matches play in full, others as previews; import as playlist |
| Scrobbling: ListenBrainz, Last.fm | `scrobble:*` | ✅ token / own API key + browser sign-in, now playing, half-or-4-min rule, offline queue |
| Discord presence | `discord-presence:*` | ➖ (shown by the PC) |

## Yearly Wrap and stats

| Feature | Hive | Mobile |
|---|---|---|
| Yearly Wrap views, export image | `yearly-wrap:*` | ✅ from phone plays: the PC's seven slides, year picker, share a slide as a picture |
| MusicBee Wrapped import | `yearly-wrap:importMusicBee` | 🖥️ |
| Phone plays counted toward Wrapped | | ❌ |

## Appearance

| Feature | Hive | Mobile |
|---|---|---|
| Themes, `.hive-theme` import/export, stock themes | `themes:*`, `theme:*` | ✅ your Hive theme + Hive's six stock themes, .hive-theme/CSS import; no export |
| Custom CSS | `custom-css:*` | ➖ mapped to theme variables |
| MusicBee skin import | `themes:importMusicBeeSkins` | 🖥️ |
| Glass panels, art-tinted accent, rich labels | `.glass`, `hiveRich*` | 🟡 glass, ambient and art accent done; no rich labels |

## Library tools (run on the PC)

| Feature | Hive | Mobile |
|---|---|---|
| File organiser | `organise:*` | 🖥️ |
| File converter | `convert:*` | 🖥️ |
| Audio Integrity scan and repair | `audio:integrity-*` | 🖥️ |
| Library health, diagnostics | `beta:*`, `diagnostics:*` | 🖥️ |
| MusicBee library import | `musicbee:*` | 🖥️ |
| Devices: send tracks to a phone | `devices:*` | 🖥️ (becomes "send to Hive Mobile") |
| Plugins | `plugins:*` | ❌ |

## Hive Link (new)

| Feature | Mobile |
|---|---|
| Pair over Wi-Fi with a code | ✅ |
| Favorites sync both ways, newest change wins | ✅ phone changes stay pending until Hive applies (or the user discards) them in its inbox |
| Song sync: songs on one side only are copied to the other | ✅ both ways, on Wi-Fi, in the background (`link/SongSync.kt`, Hive's `PUT /api/songs`). Tag matching shared with Hive (`test/fixtures/song-match-vectors.json`); a ledger of songs seen on both keeps deletions deleted. First run shows the plan and waits for "Start song sync". Verified end to end on the emulator against the real Hive Link server: both directions byte-identical, automatic pickup of a new phone song, a phone deletion not re-downloaded |
| Play from the PC library on the phone (streaming) | ✅ PC library page: albums with covers, songs, search, album pages; streams from Hive; kept on the phone, refreshed by ETag |
| Hand off playback between phone and PC | 🟡 PC → phone ("Play on this phone": same song and position, the phone's copy or streamed; the PC pauses). Phone → PC needs a small change in Hive's renderer |
| Remote control Hive on the PC | ✅ now playing, play/pause, skip, seek, volume; off until allowed in Hive's settings |
| Android Auto (browse, search, play) | ✅ library tree, songs play their list from there, search |
| Home-screen widget | ✅ |
| Away from home via Tailscale | ❌ |

---

# Design language (from `app/renderer/styles.css`)

The mobile UI translates these, scaled for touch (desktop's 13 px base becomes
~15–17 sp).

- **Type:** Inter (bundled), dense and confident; titles 600 weight; small
  uppercase column labels at 10 px with 0.5 px tracking.
- **Tokens:** `--bg #0a0a0d`, `--panel rgba(22,22,28,.55)`,
  `--panel-strong rgba(18,18,24,.72)`, `--border rgba(255,255,255,.08)`,
  `--text #ece9f2`, `--text-dim #9a97a8`, `--text-dimmer #6f6c7c`,
  `--radius 16px`, `--blur 28px`; accent and its soft/glow variants follow the
  cover.
- **Glass (`.glass`):** accent 7% into the panel, 1 px border of accent 14%
  into `--border`, blur 28 px with saturate 140%, background and border glide
  over 900 ms.
- **Tabs:** pill, radius 10; active tab = vertical gradient accent-soft →
  transparent, border, glow `0 0 18px -6px accent-glow`.
- **Album cards:** art radius 10, shadow `0 12px 28px -16px rgba(0,0,0,.62)`,
  art fades in over 260 ms, selected ring = inset 2 px accent; title 12.5 px
  600 clamped to two lines, artist 11.5 px dim.
- **Year sections:** heading 13 px 650 weight followed by a hairline rule.
- **Inline album:** the album opens inside the grid: cover beside the
  tracklist in an accent-tinted (7–9%) panel, radius 10–12, deep soft shadow.
- **Rows:** radius 8; selected = control-bg with a 2 px inset accent bar on
  the left; the playing queue row is filled accent-soft with an accent dot.
- **Menus:** glass with an accent glow, `inlineDropIn` (fade, 5 px rise,
  scale .985 → 1) over 120–160 ms.
- **Motion:** quick (120–180 ms) for interaction, slow (900 ms) for colour.
