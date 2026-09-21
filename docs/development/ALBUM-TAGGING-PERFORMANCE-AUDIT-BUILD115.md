# Album Tagging Performance Audit — Build 115

## Finding

The existing multi-track editor already had the correct safety model: selected files are read from disk, differing values render as `Multiple Values`, untouched fields are preserved, writes happen in the background, and native tags remain authoritative. The performance problem was in the physical write pipeline rather than the editor model.

A Save that changed both ordinary tags and artwork could enqueue two independent jobs for the same file. Each job copied the entire audio file to a temporary path, invoked the native writer, verified it, and atomically replaced the original. That could turn one album edit into two complete media rewrites per track.

The metadata batch also verified ordinary tag writes with `music-metadata` using `skipCovers: false`, unnecessarily decoding embedded artwork, and inserted a 75 ms delay after every completed file. Finally, the filesystem watcher was protected only by per-file internal-write suppression rather than a guard spanning the whole batch.

## Build 115 design

1. The renderer coalesces all tag and artwork changes for each path into one `kind: metadata` job.
2. The native helper opens each MP3, FLAC, or M4A/MP4 container once, applies tags and artwork to that same in-memory object, and saves once.
3. Existing generic Mutagen tag support remains available for other formats; artwork continues to use the established native artwork support boundary.
4. Text-tag verification uses `skipCovers: true`. Artwork operations still verify the requested image/removal result explicitly.
5. Metadata batches hold `beginLibraryBulkWrite()` until every job has completed, so filesystem notifications cannot cause a redundant scan halfway through a large album operation.
6. The artificial inter-file delay was removed. Progress remains event-driven from actual job completion.
7. Artwork additions are idempotent by image hash so recovery after an interrupted committed job cannot duplicate an added picture.

## Protected behavior

- `Multiple Values` semantics remain unchanged.
- Untouched per-file values are not replaced by the first selected track's value.
- Existing Love/rating/native tags remain outside the renderer cache as the source of truth.
- Existing artwork is preserved for append operations; front/back artwork remains independent.
- Writes remain background, journaled, retryable, and atomically committed.
- The filesystem watcher remains suppressed during the complete bulk operation.

## Validation

- Native combined MP3 write regression: **passed**; tags and existing front + new back artwork survived a single native `ID3.save()` call.
- Native combined FLAC exercise: **passed**; album/album artist/genre plus front/back artwork survived the combined writer.
- Dedicated album-batch/coalescing tests: **passed**.
- Full `npm test`: **135 passed, 2 failed**. The two failures are existing environment-only tests: the artwork payload test cannot find the installed `music-metadata` module in this source environment, and the MusicBee Wrapped importer test lacks its expected Wrapped archive fixture.
- `node scripts/check.js`: **passed**.
- JavaScript syntax checks: **passed**.
- Python `py_compile` for `resources/python/tag_helper.py`: **passed**.

Runtime testing in the user's Arch/Electron environment was **not performed in this container**.
