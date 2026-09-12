## 0.9.0-beta.9 — scanner hardening / pathological-file recovery

- Hardened MP3/WAV MusicBee Love scanning for UTF-16/UTF-16BE and multiple embedded Love aliases.
- Fixed WAV scanning so multiple RIFF ID3 chunks are accumulated instead of returning after the first chunk.
- Failed metadata parses now preserve the previous cached record without falsely marking metadata/Love as successfully hydrated.
- Excluded legacy `.beehive-musicbee-*` transactional copies from library discovery and changed new MusicBee replacement temps to `.tmp` so they cannot be mistaken for audio.
- Retained the per-file worker timeout as a final containment guard against a pathological file stranding the full scan.

## 0.9.0-beta.8 — scan activity indicator / first-file hang guard

- Fixed a first-file scan failure in the main-process enrichment path where the metadata scan version referenced an undefined variable.
- Contained per-track enrichment errors so one malformed result cannot strand the scanner worker pool.
- Added a continuously animated scan activity sheen so background work remains visibly active even when the determinate file count is temporarily unchanged.
- Corrected renderer handling of discovery/stat progress flags so preparation work is shown with the appropriate phase instead of looking like an idle `0 / N` scan.

## 0.9.0-beta.7 — first-scan hang / progressive IPC fix

- Fixed a large-library first-scan stall caused by sending the full scanner record, including heavy native-tag/lyrics data, over Electron IPC for every track.
- Progressive scan events now carry only the fields needed to update the live library/Favorites view; the authoritative final scan result remains complete.
- Fixed progressive renderer updates to use the library path index instead of an O(n) search per scanned file.
- Added persistent regression guidance for compact scan IPC and 30k+ renderer performance.

# CHANGELOG

## 0.9.0-beta.6
- Added a one-time true cold-start library cache reset migration.
- Added a Settings option to request the same reset on the next launch.
- Fixed scan progress handling so discovery progress is rendered from the actual scan phase.
- Preserved music files, folders, playlists, playback state, and configuration during cache resets.

## 0.9.0-beta.2

- Expanded the library scanner's recognized audio/container extensions to match the tag-census coverage.
- Added a native-tag inventory to scanned library records so arbitrary native fields, TXXX descriptions, and multi-valued tags are retained for future tag-editor work.
- Added a one-time metadata scan-version migration so existing cached tracks are reparsed and learn the expanded native-tag inventory.
- Streamed successful scan records into the renderer so Favorites can populate progressively as embedded Love tags are recognized.


## 0.9.0-beta.2 — Favorites Love scanner correction

- Fixed the full-library scanner path so MPEG-4/M4A MusicBee/iTunes freeform `LOVERATING=L` tags are read directly from the container instead of depending on the metadata library's native-tag representation.
- Fixed WAV MusicBee Love scanning to use the same accepted Love-field aliases as the authoritative reader.
- Hardened generic native-tag scanning to recognize Love fields exposed in an identifier suffix and array-valued metadata.
- This specifically prevents a valid embedded Love tag from being rescanned as `loved:false` and then cached as successfully hydrated.

## 0.9.0-beta.2 — Favorites Love compatibility fix

- Fixed Favorites hydration so MusicBee/iTunes Love field spellings including `LOVERATING` and `MUSICBEE/LOVE RATING` are recognized during cold-boot/library scanning.
- Preserved the existing Love value compatibility set (`L`, `Y`, `YES`, `TRUE`, `1`, `LOVE`, `LOVED`, `FAVORITE`, `FAVOURITE`).
- Beehive continues to write the canonical `LOVE RATING=L` representation.

# Changelog

## 0.9.0-beta.2 — Discord Presence / Settings Polish

- Kept Discord Rich Presence visible when the current track is paused instead of clearing the activity.
- Paused presence removes playback timestamps while retaining the track, artist/album state, and activity.
- Hardened Discord presence synchronization so failed pause/resume updates are retried rather than being marked as already synchronized.
- Added the usable Settings organization for General, Library, Statistics, and Discord controls.
- Added embedded P_count import and additive play-count embedding controls.

> This remains a beta designation, not a claim that Hive is already production-ready.

## 0.9.0-beta.1 — Professional Beta Track

- Rebranded the user-facing music player to **Hive**.
- Kept `BeehiveMusicBrainz` as the project/repository and legacy internal identity where compatibility depends on it.
- Adopted Semantic Versioning for the professional release track.
- Established `0.9.0-beta.1` as the current near-1.0 beta-hardening baseline.
- Documented the distinction between product branding, internal compatibility names, and release readiness.

> This is a beta designation, not a claim that Hive is already production-ready.

## 0.9.0-beta.2 — library-scan Love reconciliation

- Made embedded Love/Favorites part of the normal library reconciliation path.
- Library fingerprints now include filesystem ctime alongside mtime and size so
  typical external metadata rewrites are recognized as changed files.
- Added a Love scan compatibility version so caches created by older Love readers
  are repaired during the next normal scan instead of depending on a separate
  Favorites refresh.
- Unchanged records with stale Love compatibility are reconciled through the
  authoritative on-disk Love reader with bounded concurrency.
- Failed Love reads preserve the previous cache state and remain eligible for a
  later retry.
- The manual Favorites refresh remains available for explicit full verification,
  but it is no longer required for ordinary library metadata synchronization.

## 0.9.0-beta.2 — scan progress visibility

- Fixed the library scan UI appearing stuck at `0 / N` while the filesystem walk and initial stat phase were still running.
- The scan now reports live file-discovery progress during recursive enumeration and live stat progress before metadata parsing begins.
- Expanded the scanner-worker's format extension set to stay aligned with the main library walker and tag-census coverage.
