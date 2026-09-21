# Hive Settings UI Standards Audit — Build 110

## Purpose

Build 110 revisits the entire Settings surface rather than treating the Plugins/Visualizer request as isolated UI work. The authoritative Hive charter requires Settings to be a permanent, organized, scrollable, coherent application surface and requires reuse of the established themed control language.

## Hive-specific standards applied

- Settings remains a single themed application surface with persistent behavior and no native-looking secondary UI.
- Existing left/right slider controls remain the standard for Settings checkboxes.
- Navigation remains user-owned: sidebar order, visibility, labels, and top-bar pinning stay persistent.
- Podcasts remains a normal sidebar destination by default and is not silently promoted into the top bar.
- Local playback remains GStreamer-authoritative; the visualizer consumes the existing native spectrum stream and does not create another playback engine.
- Plugin settings remain owned by the plugin and persisted through the existing plugin-settings store.
- Podcast metadata remains provider-native and is presented in the existing Lyrics rail without altering local music lyrics behavior.

## Accessibility / interaction corrections

The Settings navigation now follows the WAI-ARIA Tabs pattern: a labeled `tablist`, `tab` controls with `aria-selected`/`aria-controls`, associated `tabpanel` elements, and keyboard navigation with arrow keys plus Home/End. The W3C guidance explicitly defines these relationships and keyboard behaviors.

Reference: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/

The implementation also preserves visible focus and does not use ARIA as a substitute for native semantics where native controls already provide the correct behavior.

## Visual / information architecture corrections

- Added a dedicated Plugins Settings destination instead of hiding extension management inside Community.
- Added concise per-tab descriptions so users understand the scope of each Settings section before scanning individual controls.
- Grouped high-impact plugin actions into cards and separated plugin settings from the installed-plugin inventory.
- Kept Settings dense enough for a desktop music player while increasing hierarchy and scanability.
- Reworked podcast show/episode rows to match the information density and hierarchy of Hive's album/track surfaces.

## Visualizer architecture

The bundled Spectrum Visualizer is now treated as a first-party Hive plugin. Its data source is the native GStreamer `spectrum` element already present in the protected playback architecture. The plugin receives spectrum events through `Hive.events.on('spectrum', ...)` and exposes its bar count, smoothing, and mirroring settings through the normal plugin settings API.

No second playback engine, microphone input, Web Audio replacement path, or decorative timer-driven animation was introduced.
