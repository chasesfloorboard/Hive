# Build 258 — Metadata Backend Consolidation

## Purpose

Build 258 is the first backend-consolidation step after the metadata safety regression audit. It keeps the existing Hive UI and metadata IPC surface while reducing competing file writers.

## Canonical changes

- Local rating writes now go through `resources/python/tag_helper.py` and the bundled Mutagen backend.
- Local Love writes now go through the same backend.
- The Electron layer no longer uses FFmpeg, `metaflac`, or handwritten MP4 atom reconstruction for these one-field metadata operations.
- Existing staged-file, recovery-backup, protected-artwork verification, and atomic-commit behavior remains in the Electron transaction layer.
- A permanent metadata backend canon was added at `docs/ai/HIVE-METADATA-BACKEND-CANON.md` and referenced by both authoritative AI engineering prompts.

## Validation

Static:
- `node --check app/main/main.js`
- `python3 -m py_compile resources/python/tag_helper.py`
- Build 258 metadata-backend regression test: PASS (3/3)

Runtime/backend fixture:
- A copy of the supplied `Brain Stew.m4a` was opened by the bundled helper.
- Rating 5 and Love=L were written and read back successfully.
- Embedded artwork remained absent, matching the supplied file's current state.
- The original supplied file was not modified.

Not runtime-tested:
- Electron renderer interaction.
- GStreamer playback.
- Full packaged application launch.
- Windows runtime.

## Migration rule

This build is intentionally a consolidation step, not a wholesale TagLib migration. TagLib remains a researched native candidate and must not be introduced as a competing live writer until a representative preservation corpus proves the migration. Mutagen remains the bundled single writer for this build.
