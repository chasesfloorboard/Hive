# Hive 1.0 Metadata Backend Canon

**Status: CANONICAL**  
**Introduced: Build 258**  
**Extended: post-258 corruption-risk audit** — added the per-path write lock, the playback-protection wait, and the same-filesystem atomic temp path to section 4; see `app/main/metadata-writer.js` and `test/metadata-writer-module.test.js`.

This document is the authoritative implementation contract for Hive's local music metadata, artwork, rating, Love, and identification subsystems. It exists to prevent the project from repeatedly replacing one fragile implementation with another and to keep future AI-assisted work aligned with mature community practice.

## 1. Product boundary

Hive's existing Electron UI, library browser, tag editor, artwork editor, queue, playlists, Favorites, playback, MPRIS, provider integrations, and portable-library behavior remain the product surface. Backend modernization must reconnect to those surfaces; it must not recreate them as competing UIs or parallel data models.

## 2. Community-backed responsibilities

Hive uses proven community technology according to responsibility:

- **GStreamer** — authoritative local playback and transport. Never replace it with a metadata or tagging tool.
- **Mutagen** — bundled local file metadata backend for read/write operations that Hive performs directly. It is mature, cross-platform, Unicode-aware, and already used by established projects including Quod Libet and beets.
- **music-metadata** — read-side media parsing where Hive's normalized renderer/library metadata contract already depends on it. It is not a second write backend.
- **MusicBrainz** — canonical community metadata and release/recording identity.
- **Chromaprint/AcoustID** — the preferred fingerprint-identification extension for files whose embedded metadata is missing or unreliable. It must be optional and non-fatal to offline playback/library use.
- **Picard/beets** — behavioral references for album/release clustering, candidate matching, confidence, and human review. Do not copy their application code or replace Hive's UI with their workflows.
- **TagLib** — an important native reference and future candidate for platform-native metadata work. It must not be introduced as a second live writer merely because it is mature; any migration must be proven against Hive's format/preservation test corpus first.
- **Kid3/puddletag/Quod Libet** — UX and edge-case references for serious bulk editing, multiple values, artwork, Unicode, and non-destructive editing.

## 3. Single-writer rule

For every metadata field operation there must be one authoritative Hive write path.

The Electron layer must not reconstruct containers itself and must not use FFmpeg or `metaflac` as an alternate metadata writer for ordinary tag/rating/Love changes.

The bundled `resources/python/tag_helper.py` is the current file-metadata write backend. Its protocol is long-lived JSON-lines IPC and its operations are format-aware but backend-consistent.

Current canonical write operations include:

- `write_metadata`
- `write_tags`
- `write_rating`
- `write_love`
- `modify_artwork`
- `replace_front`
- `remove_front`
- `clear_artwork`

If a new metadata operation is needed, extend this backend rather than adding a renderer-side writer or another native atom/FFmpeg path.

On the Electron side, the orchestration of this sequence (temp path, backup, lock, playback wait, commit) for rating, artwork, and general tag-editor writes lives in `app/main/metadata-writer.js` — a dependency-injected module extracted out of `main.js` specifically so it can be unit tested directly (see `test/metadata-writer-module.test.js`) instead of only checked by grepping `main.js`'s source text. A new writer of this kind belongs in that module, constructed with `createMetadataWriter(deps)`, not written inline in `main.js`. The Love writer (`app/workers/metadata-worker.js`, run in a forked child process for I/O isolation) and the play-count writer (`main.js`) follow the same contract described below but are not yet part of this module; do not let that split become an excuse for a third, divergent implementation of it.

## 4. Transaction and recovery invariant

No metadata operation may destroy the user's only recoverable copy.

The permanent write sequence is:

1. Wait for the target file to be released by the native player (`waitForPlaybackProtectionRelease`) before touching it at all. A write that begins while the file is protected must wait, not proceed; there is no timeout on this wait — see invariant 4a for why. Every writer under this canon must call it, including ones that don't otherwise reference this file (e.g. `performWriteMetadata`, the general tag-editor save path, which is hit far more often than rating/artwork).
2. Acquire the shared per-path write lock (`withMusicBeeWriteLock`) for the entire remainder of this sequence, through commit or failure. Rating, Love, artwork, and general metadata writes for the *same file* must serialize through this one lock, because each writer independently snapshots the file, edits its own copy, and renames it back — without the lock, liking a track and rating it 5 stars moments apart could race, and whichever rename lands second would silently discard the other edit in its entirety, with no error surfaced anywhere.
3. Create a Hive-owned recovery backup before replacement.
4. Copy the original to a staged temporary file *on the same filesystem/device as the original* — a sibling `.beehive-tmp` directory next to the target, not the OS temp dir. A music library commonly lives on a different filesystem than the OS temp dir (a `tmpfs` `/tmp` vs. a library on a separate drive or NAS mount is not a rare edge case — it is this project's own dev machine's actual layout). Getting this wrong means the final replace-the-original step below silently falls back to a non-atomic copy+delete on every write, which is the one path by which a crash or force-quit mid-write can truncate the real audio file. The library scanner and filesystem watcher both already recognize and skip the `.beehive-tmp` convention, so nothing staged there is ever indexed as a track.
5. Apply the requested change only to the staged file.
6. Reopen and verify the requested value.
7. Verify protected metadata/artwork invariants appropriate to the operation.
8. Replace the original atomically where possible (see 4a below for what "atomically" depends on).
9. Leave the recovery backup and manifest available inside Hive's portable data area.
10. On any failure before commit, delete the staged file and leave the original untouched.

A successful process exit is never sufficient evidence of a successful metadata operation.

### 4a. Why the playback wait has no timeout, and what that costs

`waitForPlaybackProtectionRelease` (`app/main/playback-protection.js`) only resolves when the protected path is explicitly released — by a track change, a full stop, or a fatal-error path — never by a wall-clock timeout. A timeout would let an active playback path silently become writable, which is exactly the corruption class this mechanism exists to prevent.

The direct consequence: writing metadata for the *currently loaded* track (playing or paused) does not complete until you skip to another track or stop playback. Any UI that surfaces rating/Love state must therefore be optimistic (update the in-memory model and the visible control immediately, queue the actual write in the background, roll back on failure) exactly like `setTrackLove`/`setTrackRating` in `renderer.js` already do — never `await` the write before updating the UI. A UI that blocks on the write will appear to freeze on the song you are actively listening to.

## 5. Protected metadata rules

An operation must preserve every field outside its declared scope.

Examples:

- Rating changes must not change embedded artwork, title, artist, album, lyrics, Love, or unrelated custom fields.
- Love changes must not change embedded artwork or unrelated metadata.
- Artwork replacement must not change tags, rating, Love, lyrics, or other artwork slots unless explicitly requested.
- A manual tag edit must change only the fields the user edited.
- Multi-file editing must use `Multiple Values` for divergent values and must preserve each file's untouched value.

## 6. Artwork model

Embedded artwork is the preferred durable artwork source.

Album-level front-cover replacement is a first-class operation:

`album context menu -> Change Photo -> one image payload -> safe per-track replacement -> verify -> commit`

The same image bytes are used for every selected album track. Each track is independently staged, verified, backed up, and committed. A failure on one file must not silently report success for that file.

Temporary/network artwork is cache data, not a silent substitute for embedded artwork.

## 7. Auto-tag model

Auto-tagging is an identification-and-review operation, not a blind metadata overwrite.

Preferred evidence order:

1. Existing MusicBrainz recording/release IDs.
2. Strong existing metadata and filename evidence.
3. Audio fingerprint via Chromaprint/AcoustID when available.
4. MusicBrainz release/recording lookup.
5. Candidate scoring and ambiguity detection.
6. Human review when the mapping is not unambiguous.

Album selection must map local tracks to individual remote recordings. An album-level match must never cause every local file to receive the first remote song.

Already-correct or explicitly locked local tracks must not be reassigned merely because another track is incomplete.

## 8. Unicode and portability

All metadata strings cross the JS/Python boundary as UTF-8 JSON. Do not introduce `latin-1` conversions for ordinary Unicode metadata. File paths must remain Unicode-safe on Linux and Windows.

For MP4/M4A freeform (`----`) metadata, the four-byte atom identifier remains ASCII,
but the `mean` and `name` components are UTF-8 text. The bundled Mutagen backend must
round-trip Unicode freeform field names instead of encoding those components as latin-1.

The bundled backend remains portable with Hive. System-only helpers may be used for optional discovery/fingerprinting, but core local metadata editing must not require a user to install a Python package manually.

## 9. Regression corpus

Metadata work must include representative tests for at least:

- MP3 with ID3v2 and multiple artwork types.
- M4A/MP4 with iTunes atoms/freeform fields and artwork.
- FLAC with Vorbis comments and FLAC pictures.
- WAV/AIFF metadata where supported.
- Unicode metadata and Unicode file paths.
- Files with existing MusicBrainz IDs.
- Files with Love and rating fields.
- Files with unrelated custom fields.
- Files with no artwork.
- Files with multiple artwork items.
- A write that fails verification: the original file must be byte-for-byte untouched afterward (`test/metadata-writer-module.test.js`).
- A completed write's recovery backup: must be byte-identical to the pre-write original and its manifest's recorded hash must match, i.e. copying the backup back over the file must reproduce the untouched original exactly (`test/metadata-writer-module.test.js`).
- Two same-file writers racing (e.g. Rating and Love within moments of each other): must serialize through the shared write lock rather than one silently discarding the other (`test/love-playback-safety.test.js`, `test/metadata-writer-module.test.js`).

The uploaded Brain Stew M4A regression is a required investigation fixture when available. A future metadata backend change is not complete until it can prove that a rating/Love/tag/artwork operation does not reproduce the destructive behavior that motivated this architecture.

## 10. What not to do

- Do not add another metadata writer beside Mutagen.
- Do not use FFmpeg for ordinary tag edits when the bundled metadata backend can perform the operation.
- Do not hand-edit MP4 atoms from JavaScript for ordinary metadata changes.
- Do not trust a network metadata result without mapping it to the correct local recording.
- Do not make renderer caches authoritative over native tags.
- Do not rewrite the UI to compensate for backend defects.
- Do not create another `.md` decision document that contradicts this one. Update this canon and the end-game prompt instead.

## 11. Migration rule

Backend modernization is incremental. A proven existing Hive feature may be retained temporarily while a replacement is tested, but there must be one intended end-state and one owner for each operation. Every migration must remove the superseded path after the replacement is verified.

The objective is not maximum dependency count. The objective is fewer bespoke implementations, fewer competing writers, stronger preservation guarantees, and a codebase whose behavior can be explained from this document plus the source/tests.
