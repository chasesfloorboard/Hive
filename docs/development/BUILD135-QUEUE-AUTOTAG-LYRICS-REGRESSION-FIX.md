# Build 135 — Queue, Auto-tag, and Lyrics Regression Fix

## Root causes

### Empty queue after the Build 133 virtualization work
`renderQueue()` replaces the queue's virtual DOM with a new spacer/window, but the reusable row pool remained populated with DOM nodes belonging to the old, detached window. `updateQueueVirtualRows()` saw a pool that was already large enough and therefore did not create or append rows to the new window.

Build 135 resets the pool whenever `renderQueue()` replaces the virtual DOM. The bounded reusable-row optimization remains in place.

### Auto-tag made the entire library disappear
The auto-tag completion path called `applyLibrary()` with no argument. The old implementation interpreted a missing library payload as `{tracks: []}`, replacing the entire in-memory library with an empty library after a successful album tag operation.

Build 135 makes the no-payload form preserve the current library and explicitly passes `library` from the auto-tag path.

### `[object Object]` lyrics
Older `library.json` snapshots and some scan/update paths can contain lyrics as structured objects rather than strings. Renderer code that coerced those values with `String(...)` displayed `[object Object]`.

Build 135 normalizes cached library lyrics, incremental scan lyrics, and scan-event lyrics through the existing lyric normalizer before they enter the renderer model.

## Validation

- Queue/lyrics regression tests: 6/6 passed.
- Queue performance tests: 9/9 passed.
- JavaScript syntax checks passed for renderer, main process, and scanner worker.
- Python compilation passed for the tag helper and database worker.
- `npm run check` passed.
- Shell syntax checks passed for the project launch/install scripts.
- Runtime desktop validation was not performed in this environment.
