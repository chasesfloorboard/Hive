# Testing

Run `npm test` for synthetic Node tests and `npm run check` for JavaScript syntax
and key Electron boundary assertions. Tests create only temporary directories under
the OS temp location; they must not scan or write configured music folders.

The current automated suite covers WAV RIFF/ID3 multi-chunk Love/rating behavior,
all required text encodings, malformed-chunk continuation, and SQLite library/job
recovery. It does not replace desktop testing.

Manual release checks are required for GStreamer playback, seeking, pause/resume,
EOS, session restore, MPRIS, Discord IPC, packaging, and real format write/readback.
