# Build 222 — Architecture Cohesion Audit

Build 222 is the first end-game architecture cleanup pass based on a direct comparison with Strawberry's mature subsystem boundaries.

## Changes

- Local playback remains a single transport: persistent native GStreamer owns local decoding, clock, seeking, output and queue handoff. The legacy renderer Web Audio path is no longer permitted to become a local fallback after native selection/failure.
- GStreamer volume now prefers the actual `GstStreamVolume` exposed by the configured audio sink, discovered through the sink's recursive element tree. Playbin soft-volume is disabled once a sink-owned stream-volume element is available, matching Strawberry's architecture. A fallback to playbin volume remains only when the output stack exposes no stream-volume interface.
- Transport anti-pop behavior remains native and 10 ms. Ordinary user volume remains a direct target and is not routed through a second smoothing loop.
- Scrobbling now has a durable pending queue. Each service submission is persisted independently, failures remain queued for later retry, and cache writes use a temporary file followed by atomic rename.
- MPRIS remains a projection of Hive state and sends commands back into Hive; it does not own playback.

## Strawberry-derived principles

Strawberry was used as a blueprint for ownership boundaries rather than copied wholesale. The useful patterns are: one authoritative playback pipeline, sink-owned volume when available, explicit reapplication/transport state around pipeline changes, durable scrobble caching, and clear separation between integrations and the core player.

## Deliberately deferred

- Removing every remaining legacy Web Audio helper/function from the renderer is deferred until native GStreamer runtime validation confirms there is no provider or UI dependency on that code. The active local fallback has already been blocked so the two transports cannot compete.
- Full MPRIS TrackList support is not introduced merely for parity; it remains a separate feature decision.
- The existing MusicBee-compatible metadata readers/writers are retained. A future metadata-authority cleanup should consolidate ownership without replacing proven format compatibility.

## Validation

Static/syntax validation is required before packaging. Native GStreamer compilation and GUI/audio runtime behavior require the target Linux environment and are not claimed from an environment without the development headers/device stack.
