# Hive — Album Playback Context / Collection Shuffle Fix — Build 89

## Symptom

Album playback could inherit the ordering of the collection from which the album was opened. This is especially visible in History, where the source tracks are ordered by play time rather than album track number. Separately, a sidebar destination's `shuffleOnEnter` setting is a visual collection-order preference and must not become transport Shuffle when the user searches into an album.

## Root cause

Album cards carried the `buildAlbums()` track array directly into `playQueue()`. Although `buildAlbums()` canonicalizes its own track arrays, collection-derived album models can still represent a context whose presentation order is not the desired album playback contract. Album playback also had no single boundary separating collection presentation state from transport state.

## Fix

Build 89 adds `albumTracksForPlayback()` and `playAlbum()` in the renderer:

- album playback sorts by disk, track number, then title;
- album playback routes through one helper from context-menu, double-click, and play-badge actions;
- `playAlbum()` does not inspect `shuffleOnEnter` or visual shuffle state;
- `playQueue()` still applies the actual player Shuffle state normally.

Album Search and Artist Search also clear the originating collection's visual-shuffle permutation. Returning to that collection may therefore establish a fresh presentation permutation rather than treating the search result as part of the collection's randomized view.

## Validation

- `node --test test/album-playback-context.test.js`: 4/4 passed.
- `node scripts/check.js`: passed.
- Full `npm test`: 77/78 passed. The only failure is the pre-existing artwork payload smoke test because this source checkout does not contain `node_modules/music-metadata/lib/index.js`; the failure is unrelated to Build 89's changes.
- No Electron runtime test was performed in this environment; the package should therefore be treated as statically validated, not runtime-certified.
