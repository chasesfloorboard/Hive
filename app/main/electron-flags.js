'use strict';

// Fixed Electron command-line switches applied at startup, before app ready. Extracted from main.js
// (QUALITY-ROADMAP, Window/lifecycle region). These are load-bearing workarounds for this project's target
// desktop (GNOME/Wayland via XWayland, AMD/Mesa) -- see CLAUDE.md -- not casual tuning, so they live in one
// named, testable place:
//
//   Linux only:
//     - ozone-platform=x11 + disable-features=UseOzonePlatform: keep the 0.9-era X11/XWayland path so the
//       native window-manager decorations match the user's desktop theme when Hive's own title bar is off.
//     - in-process-gpu: Electron 43-45's separate GPU process crashes repeatedly on X11 (XWayland, AMD/Mesa)
//       and falls back to software drawing; running GPU work in the browser process keeps full GPU drawing.
//   All platforms:
//     - disable-gpu-vsync: repeated GLSurfacePresentationHelper vsync-parameter failures on this desktop.
//     - js-flags --max-old-space-size=8192 --expose-gc: a large library cache is a big object graph; raise
//       the old-space ceiling and expose gc for deliberate post-scan collection.
//
// The conditional, user-configurable app.disableHardwareAcceleration() is a SEPARATE concern (it reads
// config) and intentionally stays in main.js.

const DISABLE_HW_JS_FLAGS = '--max-old-space-size=8192 --expose-gc';

function applyElectronStartupFlags({ app, nativeTheme, platform = process.platform }) {
  if (platform === 'linux') {
    try { nativeTheme.themeSource = 'system'; } catch {}
    app.commandLine.appendSwitch('ozone-platform', 'x11');
    app.commandLine.appendSwitch('disable-features', 'UseOzonePlatform');
    app.commandLine.appendSwitch('in-process-gpu');
  }
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('js-flags', DISABLE_HW_JS_FLAGS);
}

module.exports = { applyElectronStartupFlags };
