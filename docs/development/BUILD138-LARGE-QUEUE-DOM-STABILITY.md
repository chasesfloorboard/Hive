# Build 138 — Large Queue DOM Stability Fix

## Root cause

The right-side queue still contained the intermediate `div.queue-virtual-window` that earlier queue work had identified as an avoidable DOM/parser boundary. The queue itself is a `<ul>`, while the pooled rows are `<li>` elements. Keeping the pool inside a `<div>` child of that list produced invalid list structure and left Chromium responsible for repairing the DOM. That is especially fragile when the queue is large and `renderQueue()` repeatedly replaces the virtual DOM.

## Fix

Build 138 keeps the existing bounded virtualization model but removes the wrapper completely:

- `#queue-list` owns the virtual spacer and pooled `<li>` rows directly.
- The spacer continues to represent the complete queue height.
- Pooled rows remain absolutely positioned at their real queue indices.
- The reusable pool is still bounded to the viewport/overscan window.
- Delegated click, double-click, drag/drop, selection, and artwork behavior remain unchanged.
- GStreamer/local playback architecture is untouched.
- Build 137's compact transport persistence remains intact.

## Regression coverage

Added a test requiring virtual rows to be appended directly to `el.queueList` and rejecting `queue-virtual-window` in both render/update paths. The test was run before the production change and failed for the expected reason; it passes after the change.

## Validation

- Targeted queue tests: 17/17 passed.
- Full Node suite: 190/192 passed. Two pre-existing environment failures remain: the unpacked `music-metadata` dependency is absent from the supplied archive, and the MusicBee Wrapped fixture is absent.
- `npm run check`: passed.
- Renderer, main-process, and scanner-worker JavaScript syntax checks: passed.
- Python worker compilation: passed.
- Installer/launcher shell syntax checks: passed.
- Runtime desktop/40k-queue validation: not performed in this environment.
