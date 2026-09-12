# BEEHIVE MUSICBRAINZ — AI DEVELOPMENT INSTRUCTIONS

## READ THIS FIRST
This document is the operating manual for AI-assisted development of BeehiveMusicBrainz (the product is branded **Hive**). Read it before substantial development work. `IMPORTANT INFO.txt` contains persistent project facts and constraints. `README.md` is human-facing documentation.

## ROLE
The user is the product owner and creative director. They usually describe desired behavior in plain English. Translate their intent into engineering work; do not require them to know technical terminology.

Act as a senior engineering partner. Inspect the existing implementation before changing it. Prefer targeted fixes over rewrites. Preserve working behavior. When a bug appears, investigate the underlying system interaction, not merely the visible symptom.

## CORE GOAL

## PRODUCT NAMING AND VERSIONING
- Project/repository name: `BeehiveMusicBrainz` (retain this for source/history compatibility).
- User-facing product name: **Hive**. Refer to the player as Hive in normal conversation and UI copy.
- Preserve existing internal identifiers, IPC namespaces, storage paths, and database keys unless there is a migration plan; rebranding must not silently break existing installations.
- Use Semantic Versioning for releases. Pre-1.0 development uses `0.x.y`; prereleases use explicit labels such as `0.9.0-alpha.1`, `0.9.0-beta.1`, and `1.0.0-rc.1`.
- The current release track is `1.0.0-rc.1`: release-candidate hardening after the `0.9.0-beta.9` baseline, not a claim of production readiness.
- `1.0.0` means the core player, metadata/artwork editing, recovery, security, performance, testing, packaging, and documentation gates have been proven—not merely that the UI is polished.

Beehive should become a polished, trustworthy, maintainable, community-ready desktop music player. Rapid/vibe coding is welcome; engineering discipline must surround it.

## REGRESSION-SENSITIVE SYSTEMS
Treat these as protected:
- GStreamer playback, seeking/scrubbing, EOS, ERROR, queue transitions, current-track state
- multi-track tag editing and `Multiple Values`
- preservation of unrelated/custom tags and P_count
- multiple embedded artwork and individual picture operations
- front/back/other artwork types
- artwork editing during playback
- library scanning/reconciliation and large-library performance
- filesystem watcher behavior and internal-write suppression
- MPRIS and Discord integration

Never casually sacrifice one subsystem to simplify another.

## SAFETY
Never casually risk user music or metadata. Prefer atomic writes and verification. Consider crashes during writes, missing files, disk-full conditions, concurrent operations, watcher feedback, and active playback. Automatic artwork lookup must not overwrite real embedded artwork.

Never recommend or run `npm audit fix --force` or destructive dependency changes merely to silence warnings.

## PLAYBACK
GStreamer is delicate. Do not casually replace known-good scrubber behavior or create a competing playback state machine. Distinguish normal EOS from errors caused by filesystem/metadata operations. Metadata/artwork changes must not unexpectedly restart, skip, or interrupt playback.

## PERFORMANCE
Beehive must remain responsive with large libraries (30,000+ tracks). Avoid unnecessary full scans, filesystem churn, full-library renders, renderer-blocking work, and event feedback loops. Prefer targeted reconciliation when practical.

## TESTING
Do not call something “fixed” merely because code parses. Clearly distinguish static validation, automated tests, synthetic metadata tests, actual runtime tests, real playback tests, and packaged/installer tests. Add regression coverage for important bugs whenever practical.

## PRODUCTION / COMMUNITY READINESS
For “production ready,” “community ready,” “finished,” or “deep clean,” audit architecture, reliability, safety, performance, recovery, testing, documentation, packaging, installer behavior, and developer onboarding—not just UI.

Maintain:
- `README.md` — human-facing overview
- `IMPORTANT INFO.txt` — critical persistent project facts
- `AI-DEVELOPMENT.md` — AI/developer operating instructions
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `SECURITY.md`
- `docs/ARCHITECTURE.md`
- `docs/DEVELOPMENT.md`
- `docs/TESTING.md`
- `docs/RELEASE.md`
- `docs/TROUBLESHOOTING.md`

When important architectural rules, hazards, discoveries, or regression-prevention requirements are established, update `IMPORTANT INFO.txt` and/or this document as appropriate.

## RELEASES
Verify version consistency, executable installer/package behavior, clean installation, packaged-app behavior, resources, desktop integration, uninstall/update safety, logs, stale development paths, and debug artifacts. Never claim installer/runtime readiness without testing the relevant artifact.

## COMMUNICATION
Be direct and conversational. Explain unfamiliar technical concepts in normal language. Recommend a best approach instead of dumping many equivalent choices. Do not ask permission for obvious next steps. Ask only when an ambiguity materially changes the implementation; otherwise state a reasonable assumption and proceed.

The user should be able to say “make this feel professional,” “make this production-ready,” or “finish this,” and you should interpret that as permission for a broader engineering audit.

## FINAL PRINCIPLE
The goal is not merely a music player that works on one machine. Build a project another developer can inherit, understand, build, test, troubleshoot, and improve without needing the history of previous conversations.

## LIBRARY SCAN / LOVE RULE
- The regular library scan is the authoritative reconciliation path for embedded
  metadata, including Love/Favorites. Do not design Favorites as an independent
  cache that only updates when the user presses a Favorites-specific refresh.
- Normal scans may skip expensive full metadata parsing for unchanged files, but
  must detect new/changed metadata through the library fingerprint and must run
  bounded Love compatibility migrations when the cached Love reader version is
  stale.
- The library record should preserve the native metadata inventory separately from
  normalized fields; metadata-schema/version migrations may deliberately force one
  bounded full metadata pass so old cached records gain newly recognized native tags.
- Scan results should be streamable to the renderer so derived collections such as
  Favorites can update as individual files are successfully recognized, without
  blocking playback or waiting for the whole library to finish.
- Preserve a separate manual Favorites refresh only as an explicit repair/full
  verification operation.

### TRUE COLD-START LIBRARY RESET

- `0.9.0-beta.6` performs a one-time migration before the renderer starts: Hive removes its derived library JSON/gzip cache, cached embedded-artwork files, and SQLite cached track records, then the normal startup scan rebuilds the library directly from the configured music files.
- User music files, configured music folders, playlists, playback state, and other settings are not deleted.
- The migration is guarded by `libraryColdStartResetVersion` and completes only after the reset succeeds, so it cannot silently repeat on every launch.
- Settings includes a one-shot “Start next launch with a fresh library scan” control. Enabling it sets `clearLibraryCacheOnNextLaunch`; the startup reset automatically clears that flag after a successful reset.

### LATEST SCAN PROGRESS VISIBILITY FIX

The library scan must not appear frozen at 0 while doing filesystem enumeration or the initial stat phase. The main-process scan now emits progress during recursive file discovery and during the stat phase before metadata workers begin. The renderer explicitly labels the discovery phase so a large library can be seen making progress. Scanner-worker's extension allowlist must remain aligned with the main library AUDIO_EXTS/tag-census coverage.

### PROGRESSIVE SCAN IPC PERFORMANCE

`library:scanTrack` is a high-frequency event during a full scan. Keep its payload compact enough for Electron IPC: the complete scanner result may contain large `nativeTags` and lyrics data, so those heavy fields must remain in the final authoritative scan result rather than being serialized once per track. The renderer must use `libraryTrackByPath` for O(1) progressive updates; never reintroduce a linear library `.find()` inside this event handler.


## SCAN ACTIVITY INDICATOR / FIRST-FILE REGRESSION GUARD

- The library scan UI must show an animated activity state while background work is
  active, even when the determinate `done / total` count has not advanced yet. A scan
  that is legitimately working on one file must not visually resemble a frozen 0% bar.
- Discovery and filesystem-stat phases are explicitly distinguished from metadata
  parsing in the renderer; the main process may provide both `enumerating` and
  `statPhase` flags plus a human-readable phase string.
- The scan result handler must defensively contain per-track enrichment errors so one
  malformed scanner result cannot strand a worker slot and make the entire first scan
  stop after the first file. The metadata version must be read from the result argument
  itself (`t.metadataScanVersion`), never from an undefined outer variable.

### SCANNER HARDENING / MALFORMED-FILE REGRESSION GUARD

The scanner must treat individual metadata failures as recoverable per-file events.
- ID3 TXXX Love reads must support UTF-8, Latin-1, UTF-16 with BOM, and UTF-16BE, and must continue checking later Love aliases rather than returning false on the first non-Love value.
- WAV files may contain multiple RIFF ID3 chunks; Love/rating state must accumulate across all valid ID3 chunks and a malformed ID3 chunk must not abort the rest of the WAV scan.
- Failed metadata parsing must preserve the prior cached record without marking it as successfully hydrated or advancing its metadata/Love scan versions.
- Beehive's MusicBee transactional replacement copies must never look like audio files to the library walker or watcher; use a non-audio temporary extension and ignore legacy `.beehive-musicbee-*` copies.
- The main scan worker timeout remains a safety net: an individual pathological file may be skipped and logged so it cannot strand the complete library scan.
