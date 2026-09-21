# Hive In-App Diagnostics Design

## Goal
Give non-technical Hive testers a Settings button that starts a diagnostic session and then generates a privacy-conscious report after they manually reproduce problems, without requiring a terminal or external debugging harness.

## User flow
1. Open Settings → Logs.
2. Click **Start diagnostic session**.
3. Perform the requested manual clicks/actions in Hive normally.
4. Return to Settings → Logs and click **Finish & save diagnostic report**.
5. Hive writes a timestamped TXT report under its existing user-data reports area and offers **Open report folder**.

The UI never requires a shell command. The report is generated locally and is never uploaded automatically.

## Architecture
- `app/main/diagnostics.js` owns report-session state, system/app snapshot collection, log redaction, and report formatting.
- `main.js` exposes narrow IPC handlers for starting/finalizing/opening reports and passes existing runtime state into the diagnostic collector.
- `preload.js` exposes only those diagnostic operations to the renderer.
- `index.html` adds a small diagnostics card to the existing Logs settings surface.
- `renderer.js` binds the buttons and displays session/report status.
- Existing session logs remain the source of runtime evidence; the diagnostic report consumes bounded tails and redacts music-library paths before writing the report.

## Captured evidence
- Hive version/build, Electron/Node/platform/architecture.
- Diagnostic session timestamps and elapsed time.
- Current process/app metrics and memory snapshot.
- Existing Hive session and scan logs, bounded to recent tails and redacted for user/music paths.
- Existing security/environment/library health audits where their current APIs are available.
- Runtime feature state that can be safely obtained from existing main-process state (without dumping library records or tag contents).
- Relevant host commands (`uname`, GStreamer version, PipeWire/WirePlumber availability) when available; command failure is recorded as a warning rather than aborting the report.

## Privacy and safety
- Never upload diagnostics.
- Never include full track metadata, tag contents, authentication tokens, Spotify credentials, or complete music-library listings.
- Redact configured music roots and `/home/<user>/.../Music/...` style paths from copied logs.
- Limit log tails and report size so a pathological session cannot create an enormous report.
- The diagnostic feature observes state only; it does not alter playback, library tags, favorites, queue, settings, or provider state.

## Error handling
- Starting a session must succeed even if optional diagnostics are unavailable.
- Finalization writes whatever evidence is available and records individual collection failures.
- Report-folder opening is best-effort and reports the path in the UI if the desktop opener fails.
- A second start while active is a no-op/status refresh; finalization without an active session creates a point-in-time report rather than failing.

## Testing
- Unit tests cover redaction, report formatting, bounded log collection, session lifecycle, and safe failure of optional host probes.
- Renderer/static checks verify the new buttons, preload bridge, and IPC names are wired consistently.
- Package validation confirms the diagnostic module and UI are included and shell entrypoints retain executable permissions.
- Runtime validation is limited to starting Hive/building the artifact here; the manual diagnostic flow is specifically the user's next test pass.
