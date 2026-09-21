# Build 199 — Edit Track UI / Lyrics Workspace

## Scope

This build redesigns the Edit Track Settings and Lyrics tabs without changing Hive's established tag-writing or playback architecture.

### Settings

- Removes the obsolete per-track iTunes compilation switch from Settings. Compilation remains a normal metadata field on the Tags page.
- Removes the per-track keep-in-sequence shuffle control and its effect on shuffle ordering. Legacy `BEEHIVE_KEEP_SEQUENCE` metadata is not edited or deleted by this dialog.
- Keeps the three supported per-track playback behaviors: exclude from normal playback, do not crossfade, and remember playback position.
- Start/end trim inputs use the same `00:00.00` placeholder format.
- Lyrics offset is one signed-seconds input. Positive values delay synchronized lyrics; a leading `-` moves the highlight earlier.
- ReplayGain track/album gain, peak, and R128 track gain remain editable as native metadata. Global ReplayGain settings continue to control playback normalization.

### Lyrics

- Embedded lyrics are shown first.
- If the track has no embedded lyrics, the editor automatically searches using the existing Highlighted Lyrics preference.
- Highlighted Lyrics ON: LRCLIB is queried first for synchronized lyrics, with Genius fallback for plain lyrics.
- Highlighted Lyrics OFF: Genius is used for plain lyrics only.
- The search result is shown in the editor, with provider and synchronization status.
- Saving explicitly writes the displayed lyrics to the file; automatic lookup alone does not replace existing embedded lyrics.

## Validation

- Build 199 targeted Edit Track tests: 5/5.
- Full JavaScript suite: 408/409. The one remaining failure is the known supplied-environment `music-metadata` module absence in `artwork-payload.test.js`; it is unrelated to this build's changes.
- `npm run check`: passed.
- Main/preload/renderer syntax checks: passed.
- No GUI/Electron runtime test was performed in this environment.
