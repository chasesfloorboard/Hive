# Architecture

`main.js` owns Electron lifecycle, protocols, IPC validation/orchestration, library
cache reconciliation, workers, and the GStreamer helper lifecycle. `preload.js`
exposes the approved IPC surface; `src/renderer.js` owns presentation and follows
native playback events rather than inventing transport state.

`gstreamer-player.c` owns the audio pipeline, clock, seek, EOS, and anti-pop ramp.
`scanner-worker.js` parses changed media files and emits compact progressive records.
`database-worker.py` maintains SQLite library records and the durable metadata-job
journal. `metadata-worker.js` performs background physical writes.

The shared `wav-id3.js` reader is the authoritative WAV Love/rating compatibility
implementation for scanner, main-process reads, and metadata worker reads. It walks
all valid RIFF ID3 chunks and supports Latin-1, UTF-8, UTF-16 BOM, and UTF-16BE.
