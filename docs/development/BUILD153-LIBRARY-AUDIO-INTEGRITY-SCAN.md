# Build 153 — Full Library Audio Integrity Scan

## Purpose

Add a permanent Settings → Library tool for checking every local library track for decoder-level audio corruption without routing the scan through Hive's playback transport.

## Behavior

- Runs from Settings → Library as **Scan entire library**.
- Uses a bounded asynchronous FFmpeg worker pool (2 files at a time).
- Decodes the complete audio stream to a null sink with `-xerror`; it is not the two-second playback preflight.
- Reports progress, current file, corrupted files, and files that could not be scanned.
- Does not modify music files or the library metadata.
- Supports cancellation and terminates active FFmpeg scan workers.
- Caches completed full-scan results by absolute path + file size + modification time so unchanged files do not needlessly repeat work during the same Hive session.
- The normal playback preflight remains separate and continues to protect the playback path from known corruption before GStreamer LOAD.

## Limitations

The scan requires `ffmpeg` to be available on the system. A full 30k-track library scan can take substantial time because every audio stream is decoded. Two concurrent FFmpeg processes are used to balance throughput against desktop responsiveness. Files that change after scanning are automatically eligible for another full scan because their cache key changes.

## Validation

- Build 153 targeted tests: 3/3 passed.
- Full test suite: 252/254 passed; the two failures are the existing `music-metadata` fixture/module and MusicBee Wrapped fixture environment failures.
- Exact Joey Bada$$ M4A full decode exits 183 and reports AAC decoder errors, confirming the scan detects the known bad file.
