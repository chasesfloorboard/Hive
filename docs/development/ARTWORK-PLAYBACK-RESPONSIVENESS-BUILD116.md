# Artwork playback responsiveness audit — Build 116

## User-reported symptoms

Build 115 still exhibited three related symptoms during artwork changes:

- the player could hitch heavily while cover images changed;
- a metadata progress bar remained in the lower-left library/lyrics boundary for a long time;
- the player could freeze or crash at the end of the artwork operation.

## Root-cause findings

The most important post-write path was doing substantially more work than the successful metadata operation required. After a batch completed, the renderer called `scanChangedLibrary()` for every successful path. That incremental scan rebuilt and persisted the complete cached library, returned the complete track list over IPC, and the renderer then called `applyLibrary()`, rebuilt album indexes, and scheduled another full view render. The current track was also reread once more. This all happened immediately after the final media rewrite, which is exactly the worst time to compete with the playback/rendering pipeline.

The cover rotator also targeted the playbar, Now Playing, the visible album card, and an expanded album cover simultaneously. A multi-picture album therefore caused several visible image elements to retarget to the same large image at every rotation.

Metadata progress was using the same `scan-progress` component as a real library scan, so a background tag operation visually looked like a long-running library scan.

## Build 116 changes

1. Successful background metadata operations no longer perform the redundant end-of-write library reconciliation. The renderer's optimistic state was already updated before the physical write and is kept in the long-lived library/queue objects. The next normal library scan still detects the changed file mtime and remains the disk-authoritative recovery path.
2. Removed redundant `reloadArtworkEditor()` calls from completed background artwork operations; reopening the editor performs its normal authoritative read when needed.
3. Metadata progress is displayed through the compact `selection-status` line above Lyrics instead of the library scan progress bar.
4. Only the playbar and Now Playing cover participate in multi-picture rotation. Album cards and expanded album covers remain static thumbnails.

## Protected behavior

- Artwork writes remain background and journaled.
- Existing front/back/secondary artwork preservation is unchanged.
- Failed writes are still reported separately and are not included in the successful-path no-reconciliation shortcut.
- The normal scanner remains authoritative when a file is later reconciled.
- GStreamer transport architecture is untouched by this renderer optimization.

## Validation

The new regression tests must prove that the end-of-write path does not call the full-library reconciliation, that the rotator has only the two active-player targets, and that metadata progress does not manipulate the scan-progress bar. Runtime validation on the user's Arch/Electron installation remains necessary to confirm the reported freeze/crash is gone under real playback.
