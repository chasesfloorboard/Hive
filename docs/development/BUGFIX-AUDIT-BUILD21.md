# Build 21 — Settings / Spotify Bug-Fix Audit

## User-reported failures

1. Now Playing bar was not frosted by default.
2. Beta Lab content could visually escape the Settings tab surface.
3. Settings had no explicit save action.
4. Imported Spotify tracks had absurd runtimes and produced no audio.

## Root cause

The supplied Build 20 log contains the decisive renderer error:

`Uncaught TypeError: Cannot read properties of undefined (reading 'appendChild')` at `renderer.js:10686`.

`renderNavigationEditors()` declared `makeRow(..., orderHost, orderKey)` but its callers omitted `orderHost`/`orderKey`. The first sidebar row therefore attempted `orderHost.appendChild(row)` with `orderHost === undefined`. This stopped renderer initialization after the core shell was created. As a result, later setup—including the runtime application of the frosted playbar class and Settings event wiring—never ran.

The same log shows the Spotify bridge itself did start successfully on port 43872, but the installer had not applied the Spicetify extension because Spicetify reported that a backup was required. Therefore the metadata fallback could create a playlist without providing the control bridge needed to make Spotify play.

## Fixes

### Settings initialization
- Passed `sideHost, 'sidebar'` and `topHost, 'top'` into the navigation-row factory.
- Kept Settings tab binding after the repaired editor initialization.

### Frosted Now Playing
- Added `playbar-frosted` directly to the playbar HTML class list.
- Retained the existing localStorage default of `true`, so both pre-JavaScript and normal startup states are frosted.

### Settings save UI
- Added a persistent footer with **Save settings** and **Close**.
- Save synchronizes the appearance, ReplayGain, and layout preference values currently shown in the modal.
- Existing immediate per-control persistence is intentionally preserved.

### Beta Lab containment
- Beta Lab settings now use a dedicated settings surface instead of inheriting the top-level `.tab-content-host` sizing/overflow contract.
- Settings tabs/footer receive explicit stacking priority.

### Spotify durations
- Added `spotifyDurationSeconds()` in the renderer and equivalent normalization in the public Spotify fallback.
- Values above 10,000 are treated as millisecond payloads and converted to seconds.
- Spotify bridge state durations are normalized before queue/runtime display.

### Spotify playback
- Hive no longer marks Spotify playback as authoritative merely because it queued a command.
- The Spicetify state event remains the source of truth for PLAYING/PAUSED state.
- If Hive cannot queue the command, it reports that the Spicetify bridge needs repair.

### Spicetify installer
- If `spicetify apply --no-restart` fails specifically because no backup exists, installer now falls back to `spicetify backup apply --no-restart`.
- Existing prefs-path detection remains in place.

## Validation

- `node --check src/renderer.js` — PASS
- `node --check main.js` — PASS
- `bash -n install.sh` — PASS
- `npm test` — 19/20 PASS; the same known environment-only artwork test cannot load `node_modules/music-metadata/lib/index.js` because the source archive intentionally has no installed dependencies.

## Build 20 log evidence

The uploaded runtime log reports the renderer crash at startup and later shows the main/renderer processes continuing without completing normal renderer initialization. It also reports Spotify bridge startup and the Spicetify backup/apply failure.
