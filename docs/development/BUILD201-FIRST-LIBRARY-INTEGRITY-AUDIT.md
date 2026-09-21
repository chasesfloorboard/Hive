# Build 201 — First-Library Integrity Audit

## Behavior

Build 201 adds a one-time deep integrity audit to the first successful library scan.

- The normal library scan remains incremental after the initial library has been established.
- On the first scan that discovers local audio tracks, Hive automatically audits every enumerated audio path with the existing full audio integrity checker.
- The audit checks decoder readability and metadata/Love integrity without modifying the user's media files.
- A timestamped TXT report is automatically written under Hive's portable `data/reports/audio-integrity/` directory.
- The report separates decoder corruption, files that could not be scanned, metadata inspection failures, and Love metadata conflicts.
- Hive displays a completion notice with the counts and report path.
- A durable first-audit state prevents the deep audit from running again after successful completion.
- If the first audit is interrupted, its existing checkpoint is retained and a later normal library scan resumes it rather than starting a new deep audit.
- The checkpoint now also remains valid when zero files have completed, so an interruption immediately after audit startup is recoverable.

## Safety

This build does not automatically repair audio or metadata. The report is intentionally diagnostic so the real-world failure set can be analyzed before designing repair rules.

The existing manual Audio Integrity controls remain available, including Love metadata repair and corrupt-audio repair paths. Those repair operations are not invoked by the automatic first-library audit.

## Regression boundary

Normal incremental library scanning is unchanged: filesystem stat/mtime/size checks determine what needs metadata work, and unchanged records are retained. The first-library audit is scheduled after the normal full first scan result is ready so the library can become usable without waiting for the deep decoder sweep.
