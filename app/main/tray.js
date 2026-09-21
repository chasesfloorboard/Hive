'use strict';

// Linux system tray icon + menu. Reflects the current playback state (track,
// paused/playing) and offers transport controls without requiring the main
// window to be visible.
//
// Factory rather than a bare module: it needs a few Electron classes and a
// handful of main.js-level things (the MPRIS controller, a way to get/open
// the main window, a way to quit) — passing them in as `deps` keeps this
// file independently testable instead of reaching into main.js's shared
// closure state.
function createTrayController(deps) {
  const {
    Tray,
    Menu,
    nativeImage,
    runtimeResourcePath,
    mpris,
    getMainWindow,
    openMainWindow,
    quitApp,
  } = deps;

  const path = require('path');

  let hiveTray = null;
  let hiveTrayState = { track: null, paused: true, volume: 1 };

  function hiveLogoPath() {
    return runtimeResourcePath(path.join('resources', 'hive-logo-glass.png'));
  }
  function trayIconPath() {
    return hiveLogoPath();
  }

  function rebuildHiveTrayMenu() {
    if (!hiveTray) return;
    const track = hiveTrayState.track || {};
    const title = String(track.title || 'Nothing playing');
    const artist = String(track.artist || '');
    const status = hiveTrayState.paused ? 'Paused' : 'Playing';
    const label = artist ? `${title} — ${artist}` : title;
    const menu = Menu.buildFromTemplate([
      { label: label.slice(0, 180), enabled: false },
      { label: status, enabled: false },
      { type: 'separator' },
      { label: hiveTrayState.paused ? 'Play' : 'Pause', click: () => mpris.command(hiveTrayState.paused ? 'PLAY' : 'PAUSE') },
      { label: 'Previous', click: () => mpris.command('PREVIOUS') },
      { label: 'Next', click: () => mpris.command('NEXT') },
      { type: 'separator' },
      { label: 'Show Hive', click: () => { const mainWindow = getMainWindow(); if (!mainWindow || mainWindow.isDestroyed()) { openMainWindow(); return; } mainWindow.show(); mainWindow.focus(); } },
      { label: 'Quit Hive', click: () => quitApp() }
    ]);
    hiveTray.setContextMenu(menu);
    hiveTray.setToolTip(artist ? `${title} — ${artist}` : 'Hive');
  }

  function createHiveTray() {
    if (hiveTray || process.platform !== 'linux') return;
    try {
      const icon = nativeImage.createFromPath(trayIconPath());
      hiveTray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
      hiveTray.on('click', () => {
        const mainWindow = getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) { openMainWindow(); return; }
        if (mainWindow.isVisible()) { mainWindow.focus(); } else { mainWindow.show(); mainWindow.focus(); }
      });
      rebuildHiveTrayMenu();
      console.info('[Hive] Linux system tray initialized');
    } catch (err) {
      console.warn('[Hive] Linux system tray unavailable:', err?.message || err);
    }
  }

  function updateHiveTrayState(payload = {}) {
    const next = { track: payload.track || null, paused: !!payload.paused, volume: Number(payload.volume) || 0 };
    const oldTrack = hiveTrayState.track || {};
    const nextTrack = next.track || {};
    const changed = String(oldTrack.path || '') !== String(nextTrack.path || '') ||
      String(oldTrack.title || '') !== String(nextTrack.title || '') ||
      String(oldTrack.artist || '') !== String(nextTrack.artist || '') ||
      hiveTrayState.paused !== next.paused;
    hiveTrayState = next;
    if (changed) rebuildHiveTrayMenu();
  }

  return { createHiveTray, updateHiveTrayState, hiveLogoPath };
}

module.exports = { createTrayController };
