# Build 154 — Favorites and Love Metadata Integrity

## Favorites

The built-in Star Favorites smart playlist remains the authoritative `Love is Loved` collection. Its evaluator is no longer limited to 5,000 tracks, so a library with more than 5,000 Loved files exposes the complete collection. Normal user-created smart playlists retain their existing 5,000-track safety limit.

## Love metadata audit

Settings → Library → Audio integrity now performs two checks for each local audio file:

1. A full FFmpeg decode integrity check.
2. A native metadata inspection for duplicate/conflicting Love fields.

Recognized historical Love field names are normalized case-insensitively. Multiple Love values in one field are also considered. A file is flagged when more than one Love value is present. If both Loved and unloved values are present, Loved wins.

## Repair policy

Repair is never silent. After the scan, Hive asks for confirmation before editing any flagged file. For each repair:

1. Hive waits until the playback protection layer releases the file.
2. Hive copies the complete original audio file into the user-data `Tag Backups` directory.
3. Hive writes a manifest containing the original path, backup path, SHA-256, detected Love tags, and canonical decision.
4. Hive removes recognized historical Love aliases and writes one canonical `LOVE RATING` value.
5. `L` wins whenever `L` conflicts with `U`, `0`, or equivalent unloved values.

The backup is a complete file copy rather than only a JSON tag dump so the original media can be manually restored if a future writer regression ever affects unrelated metadata.

## Safety

Repair is isolated from active playback by the existing playback-protection boundary. A repair failure leaves the original file untouched if the writer fails before replacement. Corrupt audio remains separately reported by the FFmpeg integrity check and retains the existing fail-silent playback behavior.

## Validation

Build 154 targeted tests cover the Favorites limit, Love precedence, repair UI, and backup-before-edit contract. Full project validation and runtime testing are reported with the build artifact.
