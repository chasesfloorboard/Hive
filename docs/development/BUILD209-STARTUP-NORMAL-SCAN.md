# Build 209 — Startup Uses Normal Library Scan Only

## Purpose

Hive no longer launches the one-time full/thorough audio-integrity audit automatically during startup.

Startup continues to use the established normal library reconciliation path. This preserves the cached-library-first startup flow and the normal changed-file metadata scan without adding a second whole-library FFmpeg decode pass.

## Integrity scanner behavior

The full audio-integrity scanner remains available as an explicit user action from Settings. Its decoder behavior, progress handling, checkpointing, reporting, cancellation, and repair workflow are unchanged.

The legacy first-library-audit state/helper remains dormant for compatibility with existing persisted state and UI plumbing; the normal library scan no longer schedules or invokes it.

## Validation

- Build 209 regression test verifies the normal library scan does not invoke `maybeRunFirstLibraryIntegrityAudit(...)`.
- Explicit integrity-scan IPC and full decoder path remain present.
- No playback, queue, artwork, navigation, or GStreamer code was changed.
