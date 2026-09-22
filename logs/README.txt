This directory holds Hive's own runtime session logs and diagnostic
snapshots (session-*.txt, favorites-pipeline-diagnostic-*.json, etc.),
written next to the application in a portable install so a checkout or
extracted release always has a writable log location regardless of
install mode.

Nothing in here is source-controlled except this file -- see .gitignore.
Log contents are local-only diagnostics; they are never uploaded or sent
anywhere by Hive itself.
