# Hive Build 20 — Bug-Fix & Integration Audit

## Fixed in this build

### 1. Hive → Settings dead click path
The Hive brand dropdown now owns its open/close behavior directly and is bound immediately after DOM element discovery, before late optional renderer initialization. A later feature error therefore cannot make the Hive → Settings entry dead. The Settings action explicitly opens the Settings modal and focuses the General tab. Escape closes the brand menu.

### 2. Smart Playlist close button
Modal close handling is installed immediately after DOM discovery and runs in the capture phase for pointer/click events, so nested content cannot stop propagation before a close control sees the event. All modal close buttons are marked `data-close`, including the themed dialog and artwork picker. Escape closes the topmost Hive modal.

### 3. Modal stacking
The existing modal z-index stack is retained. New Hive-rendered dialogs are placed above their parent rather than behind it.

### 4. Spotify / Spicetify bridge
Static inspection identified a concrete integration defect: the loopback server allowed CORS only for `https://open.spotify.com`, while Spotify desktop's XPUI can run from `https://xpui.app.spotify.com`. Chromium therefore rejects the extension's `127.0.0.1:43872` requests as a cross-origin failure.

Build 20 allows only the two known Spotify origins and keeps the bridge loopback-only. The bridge now logs a throttled warning when the loopback server is unavailable instead of silently swallowing every failure.

The installer also searches the common Linux Spotify `prefs` locations and configures Spicetify `prefs_path` automatically when the file exists. This directly addresses the previous installer message `Cannot detect Spotify "prefs" file location`.

### 5. Smart Playlist controls
The existing smart-playlist data model was audited against the renderer evaluator. Source selection, all/any matching, rule operators, duplicate filtering, result limits, grouping by track/album/artist, ordering, and shuffle are wired consistently. The controls remain compatible with the stored playlist format.

## Validation

- `node --check main.js` — pass
- `node --check preload.js` — pass
- `node --check src/renderer.js` — pass
- `bash -n install.sh` — pass
- HTML duplicate-id audit — pass
- Modal close-control audit — pass
- Project tests — 19/20 pass; the single failure is the known test-environment dependency omission for `node_modules/music-metadata/lib/index.js`, not a Build 20 code failure.

## Remaining audit items

The previously identified large-library performance architecture issues remain separate work: full album-grid DOM rendering, some whole-library cache serialization paths, and renderer work around playback transitions. They were not mixed into this bug-fix build because changing those paths at the same time would make the modal/Spotify fixes harder to isolate.
