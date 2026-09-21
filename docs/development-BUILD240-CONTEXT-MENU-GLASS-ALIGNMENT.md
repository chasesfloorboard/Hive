# Build 240 — Context-menu glass and alignment

## Canonical behavior

- Right-click Auto-tag is a single-target operation. The album context menu passes only the album that was explicitly right-clicked. The auto-tag entry point rejects array/multi-target input so collection selections cannot become an auto-tag target.
- Track context menus use the same inline SVG icon language as album context menus where an existing Hive icon exists.
- Context-menu action contents are centered by default. The Add to submenu is the deliberate exception: playlist destinations are left-aligned for readability.
- The root context menu and all nested submenus use the Hive frosted surface: translucent accent-tinted panel, border, backdrop blur/saturation, and matching shadow. Rating is not a separate transparent surface.
- Build 239 transport anti-pop behavior and Light playback-time contrast are unchanged.
