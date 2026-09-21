# Build 78 — MPRIS session-bus recovery

## Reproduction

Music Presence could detect Hive successfully and publish Discord Rich Presence, then later report:

- `Remote peer disconnected` for `org.mpris.MediaPlayer2.Beehive`
- `ServiceUnknown` for subsequent MPRIS property reads
- Hive remained listed by `playerctl`, but no usable playback state was available

Restarting Music Presence did not reliably restore the connection. Re-applying Music Presence settings could cause it to observe Hive again, which initially made the integration look like a Music Presence startup problem.

## Root cause addressed

Hive's MPRIS implementation treated the D-Bus connection as permanent after registration. If the session-bus connection closed, the exported MPRIS interfaces disappeared with that connection and Hive did not re-register them. D-Bus removes names owned by a disconnected connection, so clients correctly saw `ServiceUnknown`.

## Build 78 fix

The existing MPRIS implementation remains the sole MPRIS path. It now:

1. Listens for D-Bus bus `error` and `close` events.
2. Marks the service unavailable without destroying the authoritative MPRIS state.
3. Reconnects after a bounded one-second delay.
4. Requests `org.mpris.MediaPlayer2.Beehive` with `DO_NOT_QUEUE`, avoiding stale-owner queues.
5. Re-exports the same Root and Player interfaces.
6. Calls `update(this.state)` immediately, restoring metadata/playback status/artwork.
7. Stops all reconnect work cleanly during Hive shutdown.

Music Presence remains the sole Discord Rich Presence publisher. No direct Discord IPC was added.

## Validation

- `node --check app/main/mpris.js`
- `node --check app/main/main.js`
- targeted MPRIS regression tests: 5/5 passed
- `node scripts/check.js` passed

Runtime testing of an actual D-Bus disconnect is still required on the target Linux desktop.
