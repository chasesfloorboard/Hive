# Build 152 — Corrupt Audio Preflight / Fail-Silent Recovery

## Reproduction

The uploaded `infinity (888) [feat. Joey Bada$$].m4a` produces AAC decoder errors when decoded by ffmpeg. Hive previously handed this file to the persistent GStreamer transport, which could leave the transport at 0:00/paused while the player remained unable to start subsequent tracks. Changing the volume knob could then expose audio, indicating a transport mute/state synchronization problem.

## Build 152 behavior

- Before local playback, Hive asynchronously preflights the first two seconds of the file through a separate ffmpeg process.
- A decoder error or bounded preflight timeout marks the file corrupt and prevents GStreamer `LOAD` from being issued.
- The renderer presents a themed `Corrupted audio file` dialog containing the full file location and decoder error.
- Hive waits for the user to acknowledge the dialog before advancing.
- After acknowledgement, the current corrupt track is skipped and the next queue item is played.
- The preflight process is asynchronous and bounded so decoder failures do not block the Electron event loop.
- Main-process results are cached by absolute path, file size, and modification time. Repaired/replaced files are therefore revalidated automatically.
- GStreamer runtime errors remain protected by the existing fail-silent path for corruption that occurs after the preflight window.
- Existing queue, persistent GStreamer, scrubber, volume, ReplayGain, and playback-protection architecture is otherwise unchanged.

## Important limitation

The preflight is intentionally a short prefix check rather than a full decode of every track during the library scan. A file can be valid for its first two seconds and contain corruption later. Such corruption is still handled by the existing GStreamer fatal-error path; the user-facing corrupt-file preflight can be expanded to a full background integrity scanner later if desired without putting a 30k-track library scan on the critical startup path.
