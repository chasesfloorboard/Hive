# Build 216 — In-App Diagnostics

Build 216 adds a terminal-free diagnostic session to **Settings → Logs**.

## How to use it

1. Open **Settings**.
2. Open **Logs**.
3. Click **Start diagnostic session**.
4. Reproduce the problem normally in Hive. Do not worry about console output.
5. Return to **Settings → Logs**.
6. Click **Finish & save report**.
7. Click **Open report folder** when you need to locate the report.

The generated file is a timestamped TXT report under Hive's local data directory:

`reports/diagnostics/hive-diagnostic-YYYYMMDD-HHMMSS.txt`

Hive does not upload the report. Music-library paths and credential-like values are redacted from copied log/evidence sections. The diagnostic collector is observational: it does not change tags, favorites, queue state, playback state, settings, or provider state.

## What the report contains

- Hive/Electron/Node/platform information.
- Process and memory snapshot.
- Recent Hive session and library-scan log tails.
- Existing environment and security audit results.
- Database health status and cached library-track count.
- GStreamer/playbin3 and PipeWire host capability probes when installed.
- Session start/end timestamps and collection warnings.

## Recommended manual crash-course

For a general Hive health pass, use one diagnostic session and perform these actions in order:

1. Start Hive and wait for the library view to settle.
2. Open **Favorites** and confirm whether loved tracks appear.
3. Select an ordinary album and start playback.
4. Pause and resume once.
5. Drag the scrubber to several positions and release it normally.
6. Change volume through low, medium, and high positions without moving any other controls.
7. Inspect the queue, advance to the next track, and return to the previous track.
8. Open an album with artwork and switch views/tabs if those features are relevant to the problem.
9. If testing MPRIS, use the desktop media controls while Hive is playing.
10. Finish the diagnostic session and save the report.

For a specific bug, reproduce **only the relevant behavior** rather than deliberately disturbing unrelated settings. The report is most useful when the failure occurs during the active session.

## Runtime-validation boundary

Build-time and automated checks can verify that the diagnostic bridge, report formatter, redaction, UI controls, and packaging are present. The manual session above is the authoritative runtime test of the end-to-end user workflow on the target Linux desktop.
