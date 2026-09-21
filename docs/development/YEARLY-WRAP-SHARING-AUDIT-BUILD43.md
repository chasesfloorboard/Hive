# Yearly Wrap artwork + sharing audit — Build 43

## Request

Extend the dedicated Yearly Wrap window with:

- album/cover artwork throughout the presentation
- social-media-friendly share cards
- image save/copy fallbacks on Linux desktop
- an optional Hive icon/brand mark that the user can remove

## Implementation

### Artwork

`yearly-wrap:getData` now resolves representative artwork for the top artists and top albums from the same listening-event/history artwork already recorded by Hive. No new library-wide artwork scan is triggered.

The Wrap presentation now uses artwork for:

- intro album collage
- top track
- top artist
- ranked top albums
- share-card variants

### Sharing

The dedicated Wrap window can generate a 1080×1080 PNG for the current slide. The share image is rendered locally in the renderer from the already loaded Wrap statistics/artwork.

The Share action uses `navigator.canShare()`/`navigator.share()` when the current Electron/OS environment exposes file sharing. The Web Share API requires user activation and feature support, so Hive also provides desktop-safe fallbacks rather than claiming universal social-media integration. See MDN's Web Share documentation for those platform constraints.

Fallback order:

1. Native file-share mechanism when supported.
2. Copy the generated PNG to the system clipboard.
3. Save the PNG through Hive's native Save dialog if sharing/copying fails.

The generated PNG can therefore be pasted directly into supported social-media/web compose interfaces even when Linux does not expose a native share sheet.

### Hive icon

A `Hive icon` checkbox is provided in the Wrap window. It defaults to enabled and is persisted locally for the Wrap window. Disabling it removes the Hive mark from both the presentation and generated share cards.

The mark uses Hive's existing bundled tray icon; no new branding asset is introduced.

### Privacy

Share generation is local. Hive does not upload Wrapped statistics, listening events, artwork, or generated images to a Hive server. The user explicitly chooses when/where a generated image leaves the machine.

## Validation targets

- `node --check app/main/main.js`
- `node --check app/main/preload.js`
- `bash -n install.sh`
- `npm run check`
- ZIP integrity
- static assertions for artwork fields, share IPC, native clipboard/save fallback, optional icon state, and no remote upload endpoint.

Runtime social-share behavior remains platform-dependent and must be verified on the user's Linux desktop. The implementation must not claim native share-sheet support unless Electron exposes it at runtime.
