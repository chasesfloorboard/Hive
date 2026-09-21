# Build 118 — Artwork progress restored without the Build 116 freeze path

## User-facing goal

Artwork changes should feel immediate like MusicBee: the selected artwork is applied to Hive's live UI first, while the physical tag/container write continues in the background. The existing sidebar progress surface is restored so the user can see that persistence is still happening.

## Root cause of the Build 116 regression

Build 116 correctly removed the post-write full-library reconciliation because it reread changed media, rebuilt the library graph/database, and repainted the application after the final artwork write. That work caused the playback/UI freeze reported after artwork changes.

The progress indicator was removed at the same time because metadata operations had been using the same `scan-progress` surface. The actual progress events, however, are independent of the library scan and can safely drive that existing visual surface.

## Build 118 design

- Restore metadata progress to the existing sidebar `scan-progress` UI, preserving its established location above Lyrics.
- Treat the progress UI as display-only. It does not call `scanLibrary`, `scanChangedLibrary`, `applyLibrary`, or any other library reconciliation operation.
- Keep the optimistic artwork update immediate; the progress bar reports the physical background persistence separately.
- Prevent metadata progress from overwriting a real library scan if the two ever overlap.
- Leave the completion state visible briefly so very fast one-file artwork writes are still visible to the user.
- Keep the Build 116 lightweight post-write path: successful metadata writes do not trigger a full library refresh.

## Faster-than-before artwork path

The UI-side cover change is already optimistic and therefore does not need to wait for the container write. The remaining physical write can still be expensive because FLAC/MP3/M4A/MP4 containers must be safely rewritten. Build 118 deliberately does not compromise playback safety by rewriting a currently-playing file in place merely to shave milliseconds off the disk operation.

The target user experience is therefore: **instant visual change, visible background progress, no post-write library freeze**.

## Verification

The renderer regression suite verifies that metadata progress uses the existing sidebar progress elements and that an active library scan has priority. Full project tests/checks and archive integrity are required before packaging.
