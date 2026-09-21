# Build 146 — Favorites chronology, Playlist Info UI, and native audio fail-silent boundary

## Favorites chronology

- Star Favorites records `favoriteAddedAt` timestamps by track path.
- Favorites `#` sorting uses those timestamps instead of library `addedAt`.
- `# ↑` is oldest Favorite first; `# ↓` is newest Favorite first.
- Unloving removes the timestamp; loving again creates a new timestamp.
- Existing installations preserve any already-known timestamps; exact historical Favorite times that were never recorded cannot be reconstructed.

## Playlist Info

- Reworked the Playlist Info modal into a structured desktop-app editor.
- Preserved playlist name, display mode, shuffle-on-open, sidebar icon, rich label markup, and save behavior.
- Raw rich-label markup remains directly editable in its own field.
- The title/hero and Live Preview use Hive's real sanitized rich-label renderer, so markup is rendered rather than exposed as the visible playlist name.
- The preview updates live when name/style/markup/icon changes.

## Audio safety

- When native GStreamer is selected for a local file, a native load failure no longer falls through to the legacy Web Audio decoder.
- The failure is latched, the native path is muted/stopped, and the user must restart Hive to clear the audio safety latch.
- This closes the specific failure boundary where a GStreamer fault could otherwise be followed immediately by a second decoder path.

## Validation

- Targeted Build 146 regression tests: expected RED before implementation; GREEN after implementation.
- JavaScript syntax checks and project static checks run before packaging.
- Native GStreamer runtime compilation is environment-dependent and must be validated on the target Arch installation with its GStreamer development headers.
