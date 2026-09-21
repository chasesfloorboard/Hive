# Build 211 — standalone Love validation and volume regression correction

## Love validator

Build 211 replaces the previous dependency-bearing Love validator with a genuinely standalone audit tool at `scripts/hive-love-validator.js`.

The audit uses Node's standard library for MP3/WAV ID3 and MP4/M4A inspection, `metaflac` for FLAC comments, and `ffprobe` as the read-only fallback for other supported audio containers. It does not import `music-metadata` and does not require `node_modules`.

Approved writes are still delegated to Hive's existing `app/workers/metadata-worker.js`, preserving the established format-specific MusicBee representation:

- Loved: exactly one `LOVE RATING=L` field.
- Unloved: all recognized Hive Love fields removed; absence is authoritative.
- Existing star rating / POPM / FMPS metadata is not used to infer Love state.
- Every applied file receives a byte-for-byte backup and manifest before modification.
- Unsupported formats remain audit-only rather than receiving an unverified write.

This is deliberately a manual workflow. The audit never decides that a conflicting file should be Loved or Unloved on the user's behalf.

## Volume

The Build 211 source had regressed from the established Build 207 volume architecture: renderer slider writes were being held behind a 24 ms timer instead of the intended animation-frame coalescing.

Build 211 restores the established path:

- UI range input remains immediate.
- Native GStreamer volume writes are coalesced to one update per renderer animation frame.
- A pending value is flushed immediately when pointer interaction ends.
- Pointer capture and `pointercancel` are handled so a lost pointerup cannot strand the final value.
- The native 10 ms transport ramp remains separate and unchanged.

No competing playback engine or second volume smoothing loop is introduced.

## Validation

- Build 211 targeted regression suite: 3/3 passed.
- Standalone WAV conflict audit: detected duplicate `LOVE RATING=L` + `LOVE RATING=0` without `music-metadata`.
- Standalone WAV normalization smoke test: manual Loved decision wrote one canonical `LOVE RATING=L`, with backup and post-write verification.
- `node --check app/renderer/renderer.js`: passed.
- Build 188 legacy volume regression expectation updated to the Build 207 animation-frame architecture.
- Full project test/static validation must be reported separately; no Electron/GStreamer GUI runtime validation was performed in this build environment.
