# Build 215 — Volume + Library Integrity

## Purpose

Build 215 supersedes the Build 214 cubic volume UI mapping with a simpler provider boundary and strengthens native Love/Favorites durability.

## Volume architecture

The Hive volume slider remains a visible 0–100 percentage control. The renderer converts that value directly to a canonical 0–1 provider volume. Persisted/MPRIS/provider volume is projected directly back to the slider. GStreamer remains responsible for native transport gain and retains the protected 10 ms start/stop ramps.

The cubic/cbrt renderer mapping from Build 214 is removed. This avoids making UI geometry responsible for an audio-engine curve and matches the mature boundary pattern found in Strawberry: UI percentage is state, while the engine owns its native gain conversion.

## Love/Favorites architecture

SQLite now stores a structured `tracks.loved` field alongside the lossless track payload. Existing databases migrate the new field from the stored payload without touching music files. The database exposes a targeted `get_loved_paths` query and `set_loved` projection update.

Compressed library snapshots remain a startup transport optimization. When a snapshot is decoded, the durable SQLite Loved-path projection is applied so stale JSON cache Love state cannot hide native-tag state. Native file tags remain authoritative; SQLite/cache are projections of that state.

Metadata Love writes update the native file first, verify the file, then update cache and durable database state.

## Strawberry-derived lesson

The change interprets Strawberry's separation of UI/player state, engine state, and durable collection state rather than copying Strawberry source code.
