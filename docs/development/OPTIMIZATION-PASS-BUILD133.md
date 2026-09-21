# Build 133 — Large Queue Optimization Pass

## Problem

A queue of roughly 40,000 tracks remained noticeably choppy while scrolling even after Build 132 introduced basic virtualization. The queue was still maintaining one DOM node per visible queue index and appending those nodes back into the virtual window on each virtualization-boundary update. The current-track artwork retarget also queried the queue DOM on every update, including when the playing row was outside the viewport.

## Changes

- Replaced the index-keyed queue row map with a bounded reusable row pool.
- The pool is capped at 64 rows and normally contains only viewport + overscan rows.
- Pooled rows stay attached to the virtual window while scrolling; their `data-idx`, text, artwork source, and state are updated only when the assigned queue index changes.
- Rows are positioned with transforms rather than repeatedly moving them through the DOM.
- Cached the virtual spacer/window nodes after each queue render so scroll updates do not query them repeatedly.
- Current-track artwork retargeting only runs when the current queue row is within the active virtual window, and passes the pooled row directly to the shared artwork rotator.
- Preserved delegated queue interactions, queue artwork, selection, drag/drop, playback, and the shared cover-rotation architecture.
- No playback engine or GStreamer behavior was changed.

## Expected performance behavior

A 40,000-track queue should have approximately the same queue-row DOM footprint as a much smaller queue. Large queue length still affects the logical scroll range and queue operations, but not the number of rendered row elements.

## Validation

- Queue/performance regression tests: PASS.
- Full Node test suite: 182/184 PASS; the two failures are environment-only because `music-metadata` is absent from the supplied test environment.
- `npm run check`: PASS.
- Renderer JavaScript syntax: PASS.
- Python syntax compilation: PASS.
- Shell syntax checks: PASS.
- `install.sh` executable bit: PASS.
- ZIP integrity: PASS after packaging.
- Desktop runtime scrolling on a 40,000-track queue was not available in this environment; user runtime testing remains required.
