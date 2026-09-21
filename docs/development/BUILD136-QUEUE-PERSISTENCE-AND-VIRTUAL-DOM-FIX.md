# Build 136 — Queue persistence hitch and virtual DOM hardening

## Root causes addressed

### 1. Periodic playback persistence serialized the entire queue
`savePlaybackSession()` was documented as a lightweight transport update, but it still called `buildPlaybackState()`. That function mapped and serialized every queue entry and therefore scaled with queue size every 500 ms. With a ~40,000-track queue this produced the repeated ~700–850 ms renderer long tasks seen in the runtime log.

Build 136 adds `buildTransportPlaybackState()` containing only the current transport fields. The 500 ms persistence path uses that compact state. The full queue snapshot remains reserved for explicit queue/session mutations and forced shutdown persistence.

### 2. Queue virtualization used an unnecessary wrapper inside `<ul>`
The virtual queue placed pooled `<li>` rows inside a `<div>` child of the `<ul>`. Although Chromium can tolerate this malformed list structure, it introduced an avoidable DOM/parser boundary around the virtual pool.

Build 136 removes the virtual-window wrapper. The spacer and pooled `<li>` rows are direct children of the queue list, with rows absolutely positioned against the list itself. The pool is still bounded and reusable.

## Preserved behavior

- 40k queue virtualization remains bounded; no one-DOM-node-per-track regression.
- Absolute queue-index positioning remains intact.
- Delegated queue interactions remain intact.
- Queue selection, drag/drop, artwork, and playback behavior remain on the existing paths.
- Full queue persistence still occurs when queue contents actually change.
- Startup restore continues to restore the saved queue and transport state.
- Lyrics normalization and auto-tag/library safety fixes from Builds 134–135 remain intact.
- Stable builds were not modified.

## Verification

- Queue/lyrics regression suite: 8/8 passed.
- Full suite: 190/192 passed.
- Remaining 2 failures are environment-only: missing `node_modules/music-metadata` and missing MusicBee Wrapped fixture.
- `npm run check`: passed.
- Renderer/main JavaScript syntax checks: passed.
- Python worker compilation: passed.
- Shell syntax checks: passed.

Runtime 40k-queue validation is intentionally not claimed here; the supplied user runtime log was used for root-cause analysis, while desktop reproduction requires the user's environment.
