# Hive Build 86 — MusicBee Wrapped import and professional historical Wrap

## Scope

Build 86 imports historical MusicBee Wrapped archives without changing the local-player architecture. The importer accepts a ZIP containing one or more yearly `play_history.xml` + `year_metadata.xml` pairs. `play_history_backup.xml` files are recognized as backups by the archive layout but are intentionally not imported separately.

## Data handling

- MusicBee `Duration` is treated as milliseconds; `PlayDuration` is treated as seconds, matching the supplied MusicBeeWrapped source.
- Imported sessions are stored as `source: musicbee-wrapped` listening events.
- A deterministic SHA-256 event ID makes repeated imports idempotent.
- Original Windows `FileUrl` values are retained as `legacyFileUrl`; Hive does not rewrite them as local paths.
- Year metadata is retained in `yearly-wrap-imports.json` for provenance.
- Existing Hive listening events are preserved.
- Imported artwork is resolved against the current Hive library by filename first, then title/artist/album, so historical Wraps can use the current embedded/cache artwork without modifying music files.

## UI

Settings → Statistics contains `Import MusicBee Wrapped archive…`. The Yearly Wrap window now exposes a year selector so imported historical years can be viewed directly. Imported Wraps are marked as such while statistics remain calculated from the imported play sessions rather than blindly trusting summary metadata.

## Validation

- Real supplied archive parsed successfully: 2025 = 410 plays / 1,155 minutes; 2026 = 1,647 plays / 3,520 minutes.
- The supplied archive contains matching `play_history.xml` and `year_metadata.xml` pairs for both years plus backup XMLs; backup files are not imported independently.
- Synthetic importer tests passed.
- JavaScript syntax checks passed.
- Hive security/static checker passed.
