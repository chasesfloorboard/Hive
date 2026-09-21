# Build 51 — Playlist Info naming themes and choice-control theming

## Changes
- Moved playlist renaming into the existing right-click **Info** flow; the standalone playlist Rename context-menu action is removed.
- Playlist Info now exposes the same premade safe rich-label naming themes used by playlist creation: Plain, Glow, Pulse, Rainbow, and Bold.
- Playlist Info also exposes a Custom HTML field and live preview using Hive's existing sanitized rich-label renderer.
- Saving Playlist Info persists the rich label alongside the plain playlist name.
- Sidebar collection Info dialogs can update their display label through the same rich-label editor; filesystem folder names remain non-editable.
- Dropdown/select controls receive a consistent Hive glass/accent appearance, custom chevron, focus state, and themed option/optgroup colors while retaining native select semantics.

## Validation
- renderer/main/preload JavaScript syntax: PASS
- install.sh shell syntax: PASS
- scripts/check.js: PASS
- ZIP integrity: PASS

## Runtime
Not performed in the build container. Targeted manual validation should cover playlist right-click -> Info -> rename -> style preview -> Save, rich label persistence after relaunch, sidebar Info rename, and all Settings/playlist select controls.
