# Build 227 — Playback / Queue Regression Recovery

Build 227 addresses the major local playback regression reported after the architecture cohesion pass.

## Root cause

Build 222 introduced recursive sink-owned `GstStreamVolume` discovery and disabled playbin soft-volume when a volume-capable sink appeared. That changed the proven native volume/transport path even though the user-visible requirement was already satisfied by the persistent playbin implementation. Build 227 removes that experiment and returns the native helper to the established direct playbin volume path.

The renderer remains GStreamer-only for local files; the historical Web Audio decoder is not re-enabled as a fallback.

## Queue artwork

A full scan replaces the renderer's library model. Persisted queue entries can therefore retain older object references. Queue virtualization now resolves each visible queue row by path through `libraryTrackByPath`, allowing newly scanned embedded artwork and metadata to replace stale queue presentation without rebuilding the queue or introducing a second artwork cache.

## Preserved invariants

- Persistent playbin/playbin3.
- GStreamer-authoritative local playback.
- Seamless `about-to-finish` queue handoff.
- Native seeking.
- 10 ms transport anti-pop ramp only for transport transitions.
- Direct ordinary volume control.
- Queue virtualization and bounded DOM.
- Embedded artwork remains authoritative over temporary artwork.

## Validation

Runtime desktop/audio validation requires the user's Arch machine and is not claimed from this environment.
