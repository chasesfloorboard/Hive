# Build 119 — Compact artwork embedding status

## User-facing goal
Artwork selection should feel instantaneous. The displayed cover is updated optimistically before the disk write. The physical tag/container rewrite continues in the background and should be represented by a small activity indicator rather than a large progress bar.

## Implementation
- Added `#metadata-embed-status` to the top bar, immediately before the search divider/search control.
- Added a lightweight spinner and concise `Embedding…` label.
- Artwork completion displays `Embedded` briefly; failures display `Embedding failed` briefly.
- Combined metadata jobs are marked `operation: 'artwork'` whenever an artwork change is present.
- The renderer only binds the compact status to `operation === 'artwork'`; ordinary tag/rating/love operations do not occupy the artwork indicator.
- The main-process failure event also preserves the operation classification so the indicator cannot remain stale after an artwork batch error.
- No library rescan, `applyLibrary`, album rebuild, or playback-path change was added.

## Performance rationale
The visible cover is already updated before `queueMetadataSave()`. Waiting for the container rewrite would recreate the latency the user specifically wants to avoid. The status is therefore observational only: it communicates persistence progress without making playback or the renderer wait.

## Regression protection
`test/artwork-editor-regression.test.js` verifies the top-bar DOM, spinner, renderer routing, artwork job classification, and main-process success/failure operation classification.
