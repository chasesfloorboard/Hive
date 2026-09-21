# Build 213 — Favorites Pipeline Diagnostic

Build 213 corrects the Build 212 diagnostic hook. Build 212 only invoked the
renderer diagnostic after the startup-only background reconciliation, so a
manual **Scan entire library** did not emit the diagnostic that the test
required.

Build 213 runs the diagnostic after **every successful library scan** (manual,
startup reconciliation, full, or incremental) and sends the result through a
small dedicated IPC writer. The main process writes a standalone JSON report
next to the normal Hive session logs and also records its path in the session
log.

## Diagnostic stages

The report compares:

1. renderer library track count;
2. renderer `loved === true` count;
3. Favorites smart-playlist source count;
4. raw Favorites rule-match count;
5. final existing evaluator count;
6. canonical Favorites identity/rules/limit/select-by;
7. paths that are Loved in the renderer but absent from raw Favorites matches;
8. paths that match Favorites rules but are not currently Loved.

The diagnostic is read-only. It does not rewrite Love metadata, playlist
membership, or library files.

## Output

A report named like
`favorites-pipeline-diagnostic-YYYYMMDD-HHMMSS-<pid>.json` is written to Hive's
resolved `logs/` directory. The exact path is also recorded as
`FAVORITES PIPELINE DIAGNOSTIC REPORT` in the session log.

## Expected use

After a Build 213 library scan completes, the user can provide the small JSON
report directly. The report lets us determine whether the discrepancy occurs
in scanner/cache Love hydration, Favorites rule matching, evaluator processing,
or downstream presentation.
