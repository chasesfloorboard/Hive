# Contributing to Hive

Start with `AI-DEVELOPMENT.md`, `IMPORTANT INFO.txt`, and the architecture and
testing guides. Preserve the beta.9 baseline commit as a rollback point.

Before submitting a change, run `npm test`, `npm run check`, and `git diff --check`.
Use synthetic temporary media fixtures; never point automated tests at personal
music folders. Changes touching playback require manual GStreamer regression checks:
play/pause, seek while playing and paused, next/previous, shuffle transitions,
and close/reopen session restore.

Do not replace the GStreamer transport, bypass metadata journaling, weaken Electron
security settings, or turn queue removal into disk deletion.
