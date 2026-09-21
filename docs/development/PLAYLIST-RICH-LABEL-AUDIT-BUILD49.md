# Hive — Playlist Rename / Rich Label Audit — Build 49

## Changes

- Right-click menus now call the playlist details action **Info** rather than “Playlist info”.
- Sidebar collection context menus retain **Rename** where the destination is user-renamable.
- Playlist Explorer right-click **Rename playlist** now opens the dedicated rename modal instead of the information modal.
- Playlist rename/create modal now provides safe HTML label style presets: Plain, Glow, Pulse, Rainbow, and Bold.
- A custom safe HTML label field provides direct control using the same sanitizer as rich navigation labels.
- Rename modal includes a live rendered preview.
- Playlist display labels are persisted separately from the plain playlist `name`, keeping playlist matching, exports, and internal metadata text-based while allowing rich visual labels.
- Playlist Explorer rows and the playlist top tab render the rich label.
- Existing playlists without a rich `label` transparently fall back to `name`.
- The renderer sanitizer remains the security boundary; scripts, event handlers, URLs, and unsupported markup are not accepted.

## Validation

- `node --check app/renderer/renderer.js` — PASS
- `node --check app/main/main.js` — PASS
- `node --check app/main/preload.js` — PASS
- `bash -n install.sh` — PASS
- `bash -n run.sh` — PASS
- `node scripts/check.js` — PASS
- `npm test` — not run because `node_modules` is not present in the source tree used for packaging.
- Native GStreamer compilation — not applicable to this UI/data-only change.

## Runtime status

Not runtime-tested in the container. The intended targeted test is: create/rename a playlist, choose each HTML style, confirm the live preview, save, confirm the Playlist Explorer row and playlist tab render the selected label, then right-click sidebar destinations and verify the details action reads **Info** and Rename remains available where appropriate.
