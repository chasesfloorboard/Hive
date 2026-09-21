# Architecture

`app/main/main.js` owns Electron lifecycle, protocols, IPC validation/orchestration, library
cache reconciliation, workers, and the GStreamer helper lifecycle. `app/main/preload.js`
exposes the approved IPC surface; `app/renderer/renderer.js` owns presentation and follows
native playback events rather than inventing transport state.

`app/native/gstreamer-player.c` owns the audio pipeline, clock, seek, EOS, and anti-pop ramp.
`app/workers/scanner-worker.js` parses changed media files and emits compact progressive records.
`app/workers/database-worker.py` maintains SQLite library records and the durable metadata-job
journal. `app/workers/metadata-worker.js` performs background physical writes.

The shared `app/main/wav-id3.js` reader is the authoritative WAV Love/rating compatibility
implementation for scanner, main-process reads, and metadata worker reads. It walks
all valid RIFF ID3 chunks and supports Latin-1, UTF-8, UTF-16 BOM, and UTF-16BE.

## Source layout

Hive keeps application internals under `app/`: `app/main` contains the Electron main process and shared Node modules, `app/renderer` contains the UI, `app/workers` contains background workers, and `app/native` contains native playback sources. Bundled Python/integration resources live under `resources/`. Runtime session logs live under `logs/` when the installation directory is writable, with a user-data fallback for read-only packaged installs.

## End-game ownership boundaries

Build 222 establishes the following ownership rules for finalization: local audio transport is exclusively the persistent native GStreamer helper; provider-specific remote playback remains isolated; ordinary output volume belongs to the active GStreamer output element when it exposes `GstStreamVolume`; transport ramps remain native transition behavior; MPRIS is a projection/command boundary; and scrobble submissions have a durable service-level retry queue. Legacy renderer Web Audio helpers remain in source only as cleanup debt until target-machine runtime validation permits their complete removal without affecting provider-specific code.
