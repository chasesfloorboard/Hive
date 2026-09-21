# Hive Build 147 — GStreamer Startup and Fail-Silent Audio Audit

## Trigger
Build 146 on the user's Arch/Electron environment spawned the native GStreamer helper but produced no successful playback, while the reported earlier failure could produce an unsafe loud output during the same track.

## Root-cause findings
- The renderer sent `MUTE=0` immediately after `LOAD`, before the native helper had reported `STREAM_START` and `PLAYING`. A decoder/sink failure could therefore expose audio before the error was surfaced.
- The cached native helper was invalidated only by source mtime. A stale helper could survive a source change when timestamps did not force a rebuild.
- An unexpected helper exit could trigger an automatic replay attempt while the current track was still active.
- Readiness timeout left an unvalidated helper alive while the renderer could continue with another playback path.

## Build 147 changes
- Native playback starts muted at zero volume.
- The native backend only opens the sink after both `STREAM_START` and `PLAYING` have been observed.
- User unmute after validated playback uses the existing 10 ms ramp rather than jumping directly to target volume.
- Native helper cache is content-addressed with a SHA-256 source stamp.
- GStreamer READY events are surfaced in startup-debug logs.
- An unvalidated helper is killed after the readiness timeout instead of being left running.
- Active local playback treats unexpected native helper exit as an audio-path failure and does not automatically replay.
- Existing native GStreamer ERROR handling remains fail-silent: mute, stop/READY, then FATAL_ERROR.

## Validation
- Build 147 targeted startup/audio safety tests: 8/8 passed.
- Full Node test suite: 232/234 passed.
- Two pre-existing environment/fixture failures remain in the artwork payload test because `music-metadata` is absent from this build environment, and the MusicBee Wrapped fixture test because its archive fixture is absent.
- `scripts/check.js`: passed.
- Main/renderer JavaScript syntax: passed.
- Shell syntax: passed.
- Native GStreamer runtime compilation was not possible in this container because the GStreamer development pkg-config package/headers are not installed. Native runtime playback therefore remains explicitly unverified here.
