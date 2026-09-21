# Build 114 — Artwork editor audit

## Scope

Build 114 audits the embedded-artwork editor after regressions in blank-slot interaction, multi-picture editing, and the end of artwork writes.

## Design goals

- A blank artwork slot must be a first-class target, not a passive placeholder.
- The same core actions must be available whether a picture exists or not: choose a file, paste from clipboard, search online, and use the context menu.
- Front and back covers must be independent pictures. Adding/replacing the back cover must never use the front-cover replacement path.
- Common front/back changes should be one action rather than requiring the user to understand the underlying picture array.
- Drag-and-drop is a supported fast path for local artwork.
- The editor must not throw a renderer exception while persisting picture metadata.

## Professional-library-manager comparison

MusicBee's artwork workflow explicitly treats a blank artwork slot as an add target and provides Paste Add/Remove behavior; this is the model Hive is following for Build 114. foobar2000 likewise treats multiple embedded artwork types as separate properties/artwork entries rather than collapsing them into one cover.

## Implementation

- Blank slots now expose Choose Picture, Paste Picture, Search Internet, and right-click actions.
- Blank and filled cards accept image-file drag/drop.
- Front Cover and Back Cover quick actions provide a direct common path: replace the existing matching picture or create a matching blank slot when absent.
- Blank slot defaults are context-sensitive: Front Cover when no front picture exists; Back Cover when a front picture already exists.
- Renderer artwork metadata persistence no longer references an out-of-scope `slot` variable.
- Optimistic cover state always derives the displayed cover from the normalized Front picture before falling back to another picture.
- Native artwork additions remain append-only; the native helper reads all existing pictures, changes only the requested entry/list, and writes the complete retained picture set back.

## Validation

- Dedicated artwork-editor regression suite passes.
- Full JavaScript suite retains the two known environment-only failures: missing `music-metadata` test dependency fixture and missing MusicBee Wrapped archive.
- Renderer/main/preload JavaScript syntax passes.
- Native Python tag helper compiles with `py_compile`.
- Native GStreamer compilation is not claimed because GStreamer development headers are not installed in the build environment.
