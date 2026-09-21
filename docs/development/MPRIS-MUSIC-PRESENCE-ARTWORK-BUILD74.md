# MPRIS / Music Presence Artwork Hardening — Build 74

Build 74 preserves the Build 73 localhost artwork proxy while hardening its lifecycle.

## Change

The Music Presence artwork proxy is an integration enhancement, not a prerequisite for MPRIS itself. If the localhost proxy cannot bind, Hive now logs the failure and still starts MPRIS, allowing its existing `file://` artwork fallback to remain available.

This prevents an optional artwork transport problem from disabling the entire MPRIS integration.

## Regression boundary

- Music Presence remains the sole Discord publisher.
- Hive does not connect directly to Discord IPC.
- Local playback remains GStreamer-owned.
- Build 72 legacy album-art sizing remains unchanged.
- Build 73 localhost artwork proxy behavior remains unchanged when it starts successfully.
