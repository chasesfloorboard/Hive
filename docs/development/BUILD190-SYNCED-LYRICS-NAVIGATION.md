# Build 190 — synchronized lyrics priority + navigation defaults

- Made synchronized lyric payloads the preferred online lyrics result whenever a provider returns both synchronized and plain lyrics.
- Changed the LRCLIB lookup to preserve its `syncedLyrics` payload and return it to the renderer instead of discarding timestamps.
- Kept Genius as the plain-lyrics fallback when LRCLIB has no synchronized result.
- Renderer lyric payload handling now checks `syncedLyrics` before `plainLyrics`, while embedded/local lyrics remain the first source of truth.
- Online lyric results are cached separately from embedded/local metadata so provider results do not become the authoritative embedded-lyrics value.
- Added regression coverage for synchronized-vs-plain selection.
- New users now receive the requested compact sidebar order: Music, Playlists, divider, Top 25 Most Played, Podcasts, History, Recently Added, divider, Now Playing/plugin sandbox, Yearly Wrap. Canonical Favorites migration inserts Favorites directly beneath Playlists.
- Blank dividers render as a continuous solid rule without the centered gap/dot.
- Navigation renaming still rejects blank normal destination labels, but blank divider labels are explicitly valid.
- Navigation editor now calls the item `Divider` and uses `+ Add divider`.

## Scope notes

- The protected Build 188 volume coalescing/native ramp path is preserved; the remaining audible volume-pop report was not claimed as fixed in this build.
- Device transfer (`Send to >`) is not implemented in this build; it remains a separate integration task because it needs a platform device-provider boundary and destination UI rather than a renderer-only patch.

## Validation

- `node --check` passed for the modified JavaScript entry points.
- Build 190 targeted regression tests pass.
- `scripts/check.js`, the Build 190 tests, and the targeted regression suite pass.
- The full unit suite reports 378 passing / 1 failing; the existing failure is `test/artwork-payload.test.js`, which requires `node_modules/music-metadata/lib/index.js` that is not present in the source package.
- Electron GUI runtime validation is not available in this build environment.
