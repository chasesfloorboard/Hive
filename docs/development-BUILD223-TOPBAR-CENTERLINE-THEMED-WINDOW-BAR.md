# Build 223 — Top Bar Centerline + Themed Window Bar Default

## Scope

Build 223 addresses two small end-game UI consistency issues:

1. The Hive brand and the Music/Favorites tab strip must share one vertical centerline.
2. The renderer-owned themed Electron window bar should be the default on first boot when no prior window-bar preference exists.

## Implementation

- `app/renderer/styles.css` keeps `.topbar-app-row` as the shared flex alignment container and removes the themed `.topbar-left` vertical transform.
- The themed tab strip continues to use `align-items: center`.
- `app/main/main.js` changes `DEFAULT_THEME_WINDOW_BAR` from `false` to `true`.
- Explicitly persisted `themeWindowBarEnabled: false` remains respected; changing the default does not override a deliberate user preference.

## Regression boundaries

This is presentation/window-shell work only. It does not change GStreamer transport, queue handoff, scrubber behavior, playback persistence, metadata, artwork, providers, MPRIS, scrobbling, or Music Presence.

## Validation

- Syntax/static checks and targeted regression tests are required before packaging.
- Runtime window alignment and first-boot custom chrome still require validation on the target Electron/Linux desktop.
