'use strict';

// Remembers the main window's size, position and maximized/fullscreen mode
// across restarts (and across the themed-title-bar BrowserWindow recreation).
//
// The saved `bounds` are always the *windowed* geometry. Maximize and
// fullscreen are stored as separate flags and re-applied on top of those
// bounds, so leaving fullscreen after a restart returns the window to the
// size and place the user last had it, on the same monitor. Bounds are only
// captured once the window has settled in the normal state: during an
// enter-fullscreen/maximize transition the window manager emits resize/move
// events while isFullScreen()/isMaximized() still report false, and capturing
// those would save the whole screen as the "windowed" size.
//
// Factory with injected deps (like tray.js) so it can be tested without
// Electron.

const SETTLE_MS = 500;
const MIN_VISIBLE_PX = 100;

function isUsableBounds(b) {
  return !!b && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(Number(b[k])))
    && Number(b.width) > 0 && Number(b.height) > 0;
}

// Saved bounds are only reused when a meaningful part of the window lands on a
// connected display; a monitor that was unplugged since must not strand Hive
// off-screen.
function visibleBounds(bounds, workAreas, minVisible = MIN_VISIBLE_PX) {
  if (!isUsableBounds(bounds)) return null;
  const b = { x: Number(bounds.x), y: Number(bounds.y), width: Number(bounds.width), height: Number(bounds.height) };
  const onScreen = (workAreas || []).some(a => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= minVisible && h >= minVisible;
  });
  return onScreen ? b : null;
}

function createWindowStateTracker({ fs, path, filePath, platform = process.platform, setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout }) {
  let state = { bounds: null, maximized: false, fullScreen: false };
  let settleTimer = null;

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath(), 'utf8')) || {};
      state = {
        bounds: isUsableBounds(saved.bounds) ? saved.bounds : null,
        maximized: saved.maximized === true,
        fullScreen: saved.fullScreen === true
      };
    } catch {}
    return snapshot();
  }

  function snapshot() {
    return { bounds: state.bounds ? { ...state.bounds } : null, maximized: state.maximized, fullScreen: state.fullScreen };
  }

  function capture(win) {
    try {
      if (!win || win.isDestroyed()) return;
      const fullScreen = win.isFullScreen();
      const maximized = win.isMaximized();
      if (win.isMinimized()) return;  // keep the mode the window will restore to
      state.fullScreen = fullScreen;
      state.maximized = maximized;
      if (!fullScreen && !maximized) {
        const b = win.getBounds();
        if (isUsableBounds(b)) state.bounds = b;
      }
    } catch {}
  }

  function saveSync() {
    let tmp = null;
    try {
      const target = filePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 2), 'utf8');
      try {
        fs.renameSync(tmp, target);
      } catch (err) {
        // Windows can refuse to rename over a file the Search indexer or an
        // antivirus scan briefly has open (same fallback as main.js's
        // writeJsonSafe). The new file is complete, so drop the old one.
        if (platform !== 'win32' || !['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
        fs.rmSync(target, { force: true });
        fs.renameSync(tmp, target);
      }
      tmp = null;
    } catch {
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    }
  }

  function attach(win) {
    // A new window starts out windowed (maximize/fullscreen are applied later,
    // at ready-to-show), so its creation bounds are a valid windowed size even
    // if the user maximizes before ever moving or resizing it.
    if (!state.bounds) {
      try {
        const b = win.getBounds();
        if (isUsableBounds(b)) state.bounds = b;
      } catch {}
    }
    const settle = () => {
      if (settleTimer) clearTimer(settleTimer);
      settleTimer = setTimer(() => { settleTimer = null; capture(win); saveSync(); }, SETTLE_MS);
      settleTimer?.unref?.();
    };
    for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      win.on(event, settle);
    }
    win.on('close', () => {
      if (settleTimer) { clearTimer(settleTimer); settleTimer = null; }
      capture(win);
      saveSync();
    });
  }

  return { load, snapshot, capture, saveSync, attach };
}

module.exports = { createWindowStateTracker, visibleBounds, isUsableBounds };
