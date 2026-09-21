# Build 166 — Favorites Love-tag completeness fix

## Problem

A canonical Favorites autoplaylist can be configured with `limit = Infinity`. The generic smart-playlist evaluator previously sent that unlimited result through its non-track selection branch. When an older Favorites record retained `selectBy: artist` or `selectBy: album`, the evaluator kept only one track per artist/album. That can reduce a library with thousands of Loved files to roughly a thousand visible results.

## Fix

Build 166 keeps the canonical Favorites collection out of the generic `selectBy` reduction path. Favorites remains unlimited and track-complete while ordinary smart playlists retain their configured track/artist/album selection behavior.

The MP3 MusicBee Love reader also now recognizes the exact historical `MUSICBEE LOVE RATING` TXXX description as an alias. The previous expression used the JavaScript comma operator and returned a truthy string unconditionally, so it did not perform the intended field-name comparison.

## Validation

- Added `test/build166-favorites-love-regression.test.js`.
- Confirmed the new regression test fails against Build 165 before the production change.
- Confirmed the regression test passes after the change.
- `npm run check` is run as the static/syntax gate before packaging.
- Relevant Love/Favorites tests are run separately because the source archive does not contain installed `node_modules` or the external MusicBee Wrapped fixture required by two unrelated baseline tests.

## Packaging

Build number: **166**

Installer shell entrypoints are packaged with mode `0755`, including `install.sh`.
