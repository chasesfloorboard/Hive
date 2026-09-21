# Yearly Wrap Audit — Build 41

## Source review

The uploaded MusicBeeWrapped 1.0.0 source is the correct reference project. Its `TrackingService` records actual active play duration, excludes pause time, and uses a five-second rule to record a play. Its `SlideManager` and UI slide classes generate a dedicated multi-slide presentation. Hive Build 41 follows those behaviors while using Hive's native Electron architecture and local JSON/IPC services.

## Hive issue found

The previous Hive Yearly Wrap read `history.json`. Hive's History intentionally stores only the latest entry for each track, and `recordPlay()` did not store a duration. Consequently the previous Wrap could report a play count based on unique history entries while summing zero duration, producing `0 min` even when listening had occurred.

## Build 41 fix

- `listening-events.json` stores one event per actual play session.
- Renderer measures active listening time with `performance.now()` and pauses are excluded.
- A session is recorded after at least 5 seconds, matching the supplied MusicBeeWrapped tracking threshold.
- Repeated plays remain separate events.
- Existing History behavior is untouched.
- Legacy users receive a clearly labeled duration estimate from saved history + real library track durations until exact Wrap tracking has accumulated.
- Yearly Wrap opens in its own native Electron window and uses a slide-based presentation.

## Validation

- `node --check app/main/main.js` PASS
- `node --check app/main/preload.js` PASS
- `node --check app/renderer/renderer.js` PASS
- `bash -n install.sh` PASS
- `node scripts/check.js` PASS
- `npm test`: 19/20 PASS; one existing environment failure due missing `node_modules/music-metadata/lib/index.js`.
- Runtime Electron/Spotify test not performed in the build environment.
