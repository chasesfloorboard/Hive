# Build 212 — Favorites Pipeline Diagnostic

Build 212 is a read-only diagnostic build for the discrepancy between the
physical Love audit and the Favorites auto-playlist count.

## Purpose

The current evidence is:

- the independent file audit found 6,188 Loved files;
- Build 209's Favorites UI showed 5,589 tracks;
- canonical Star Favorites is already exempt from the generic 5,000 smart-playlist cap.

This build does not rewrite Love metadata and does not alter Favorites
membership. After the normal startup reconciliation finishes, the renderer
logs one `FAVORITES PIPELINE DIAGNOSTIC` record containing the counts at each
stage:

- `libraryTrackCount`: tracks currently held by the renderer library;
- `libraryLovedCount`: tracks whose cached `loved` flag is true;
- `libraryUnhydratedLoveCount`: tracks whose Love state has not been hydrated;
- `favoriteInputTrackCount`: tracks entering the Favorites smart-playlist source;
- `favoriteRuleMatchCount`: tracks matching the persisted Favorites rules before sorting/deduplication/limits;
- `favoriteEvaluatorCount`: final result of the existing smart-playlist evaluator;
- `favoriteEvaluatorDelta`: difference between raw rule matches and evaluator output;
- canonical identity, limit, select-by mode, and persisted rules.

## How to test

1. Launch Build 212.
2. Let the normal library scan finish.
3. Open Favorites and note its track count.
4. Close Hive.
5. Provide the session TXT log from `logs/`.

The diagnostic is intentionally logged rather than displayed in the UI so it
cannot alter the established Favorites presentation or add another expensive
interactive surface.

## Expected interpretation

- `libraryLovedCount` near 5,589: the loss occurs during scan/Love hydration.
- `libraryLovedCount` near 6,188 but `favoriteRuleMatchCount` near 5,589: the persisted Favorites rules or smart comparison are excluding Loved records.
- `favoriteRuleMatchCount` near 6,188 but `favoriteEvaluatorCount` near 5,589: the evaluator's post-match processing is removing records.
- all three near 6,188 while the UI still reports ~5,589: the remaining problem is downstream presentation/counting rather than membership evaluation.

No music files are modified by this diagnostic.
