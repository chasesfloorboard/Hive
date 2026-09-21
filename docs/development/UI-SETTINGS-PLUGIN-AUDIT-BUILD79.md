# Build 79 — Settings, UI, Themes, and Plugin API Audit

## Settings direction

- Appearance now focuses on built-in themes and a small set of interface controls.
- Community now owns importable `.hive-theme` packs and advanced custom CSS.
- Custom CSS remains available for power users but is no longer presented as the primary theme workflow.
- Navigation copy and control styling were simplified to make the destination list easier to scan.

## Light theme

The Light preset now explicitly switches the browser color scheme and overrides common dark-only surfaces, inputs, popups, badges, scrollbars, and the ambient backdrop.

## Plugin standard

Build 79 defines Hive Plugin API v2 with:

- manifest `format` / `apiVersion`
- explicit permission declarations
- plugin-owned persistent settings
- track/playback events
- native GStreamer spectrum events
- Now Playing panel registration
- lifecycle cleanup
- an installable reference plugin

The extension system remains trusted-local renderer code. It is not presented as a sandbox.

## Reference plugin

`resources/hive-plugins/spectrum-example/` is a complete working example. It renders a live spectrum inside the left-side Now Playing destination and exposes Bars, Smoothing, and Mirror settings in Settings → Community.

The visualizer consumes Hive's existing native GStreamer spectrum stream; it does not create a second audio path.

## UI research basis

The plugin boundary follows Electron's documented main/renderer separation and contextBridge principle: privileged APIs should be narrowly exposed through explicit functions rather than exposing the whole IPC surface. See Electron's preload/context isolation and IPC documentation.
