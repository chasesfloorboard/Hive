# Build 228 — Hive-native Love scanner recovery

## Problem
A completely empty-library cold boot was producing 5,597 Favorites even though independent embedded-metadata audits found substantially more Loved files. That proves the loss occurs before the Favorites autoplaylist: during metadata ingestion / Love interpretation.

## Design
Build 228 makes Love interpretation explicitly Hive-owned:

`embedded file -> metadata parser(s) -> Hive Love semantics -> track.loved -> Favorites`

The canonical embedded field remains `LOVE RATING=L`. POPM/star rating remains independent. Existing alternate Love field names are accepted as input compatibility, but they are not a second Favorites system.

The scanner first uses its format-specific binary reader where appropriate. If that reader cannot safely interpret the container's tag structure, the scanner now evaluates `music-metadata`'s native tag inventory through the same Hive Love semantics. This avoids silently losing a Loved file merely because one low-level parser stopped early.

The MP3 reader also clamps an over-declared ID3 payload to the bytes physically available rather than rejecting the entire tag before examining those bytes.

## Scope
No Favorites count is hard-coded. No database/cache state is promoted above embedded metadata. No playback architecture is changed. No Stable build is modified.
