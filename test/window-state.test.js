'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWindowStateTracker, visibleBounds } = require('../app/main/window-state');

// Minimal BrowserWindow stand-in: holds geometry and mode, and emits the
// events the tracker listens to.
function fakeWindow({ bounds = { x: 100, y: 80, width: 1200, height: 800 } } = {}) {
  const handlers = {};
  const win = {
    bounds: { ...bounds }, full: false, max: false, min: false, destroyed: false,
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    emit(event) { for (const fn of handlers[event] || []) fn(); },
    getBounds() { return { ...this.bounds }; },
    isFullScreen() { return this.full; },
    isMaximized() { return this.max; },
    isMinimized() { return this.min; },
    isDestroyed() { return this.destroyed; }
  };
  return win;
}

// Runs settle timers immediately on flush() instead of after 500 ms.
function manualTimers() {
  let pending = null;
  return {
    setTimeout(fn) { pending = fn; return { unref() {} }; },
    clearTimeout() { pending = null; },
    flush() { const fn = pending; pending = null; fn?.(); }
  };
}

function tracker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-window-state-'));
  const timers = manualTimers();
  const file = path.join(dir, 'window-state.json');
  const make = () => createWindowStateTracker({ fs, path, filePath: () => file, ...timers });
  return { make, timers, file };
}

test('windowed size and position survive a restart', () => {
  const { make, timers } = tracker();
  const first = make();
  first.load();
  const win = fakeWindow();
  first.attach(win);
  win.bounds = { x: 300, y: 1200, width: 1500, height: 900 };
  win.emit('move');
  timers.flush();
  win.emit('close');

  const restored = make().load();
  assert.deepEqual(restored, { bounds: { x: 300, y: 1200, width: 1500, height: 900 }, maximized: false, fullScreen: false });
});

test('closing while fullscreen remembers fullscreen and keeps the windowed bounds', () => {
  const { make, timers } = tracker();
  const t = make();
  t.load();
  const win = fakeWindow({ bounds: { x: 2560, y: 0, width: 1000, height: 1600 } });
  t.attach(win);
  win.emit('resize');
  timers.flush();

  // Entering fullscreen: the WM resizes to the whole screen. Some of those
  // events arrive before isFullScreen() reports true; a settled capture must
  // not record the screen size as the windowed size.
  win.bounds = { x: 2560, y: 0, width: 1440, height: 2560 };
  win.emit('resize');
  win.full = true;
  win.emit('enter-full-screen');
  timers.flush();
  win.emit('close');

  const restored = make().load();
  assert.equal(restored.fullScreen, true);
  assert.deepEqual(restored.bounds, { x: 2560, y: 0, width: 1000, height: 1600 });
});

test('leaving fullscreen before closing restores the windowed state', () => {
  const { make, timers } = tracker();
  const t = make();
  t.load();
  const win = fakeWindow();
  t.attach(win);
  win.full = true;
  win.emit('enter-full-screen');
  timers.flush();
  win.full = false;
  win.emit('leave-full-screen');
  timers.flush();
  win.emit('close');

  const restored = make().load();
  assert.equal(restored.fullScreen, false);
  assert.deepEqual(restored.bounds, { x: 100, y: 80, width: 1200, height: 800 });
});

test('maximized state is remembered separately from the windowed bounds', () => {
  const { make, timers } = tracker();
  const t = make();
  t.load();
  const win = fakeWindow();
  t.attach(win);
  win.max = true;
  win.bounds = { x: 0, y: 0, width: 2560, height: 1440 };
  win.emit('maximize');
  timers.flush();
  win.emit('close');

  const restored = make().load();
  assert.equal(restored.maximized, true);
  assert.deepEqual(restored.bounds, { x: 100, y: 80, width: 1200, height: 800 });
});

test('closing while minimized keeps the mode the window would restore to', () => {
  const { make, timers } = tracker();
  const t = make();
  t.load();
  const win = fakeWindow();
  t.attach(win);
  win.full = true;
  win.emit('enter-full-screen');
  timers.flush();
  win.min = true;
  win.full = false;  // some WMs report fullscreen off while iconified
  win.emit('close');

  assert.equal(make().load().fullScreen, true);
});

test('a missing or corrupt state file falls back to defaults', () => {
  const { make, file } = tracker();
  assert.deepEqual(make().load(), { bounds: null, maximized: false, fullScreen: false });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(make().load(), { bounds: null, maximized: false, fullScreen: false });
});

test('saved bounds on a disconnected monitor are not reused', () => {
  const displays = [{ x: 0, y: 1120, width: 2560, height: 1440 }, { x: 2560, y: 0, width: 1440, height: 2560 }];
  assert.deepEqual(visibleBounds({ x: 2700, y: 100, width: 1000, height: 1600 }, displays), { x: 2700, y: 100, width: 1000, height: 1600 });
  assert.equal(visibleBounds({ x: 2700, y: 100, width: 1000, height: 1600 }, displays.slice(0, 1)), null);
  assert.equal(visibleBounds({ x: -5000, y: -5000, width: 800, height: 600 }, displays), null);
  assert.equal(visibleBounds(null, displays), null);
});

test('on Windows a locked state file is replaced instead of silently not saving', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-window-state-'));
  const file = path.join(dir, 'window-state.json');
  fs.writeFileSync(file, JSON.stringify({ bounds: { x: 1, y: 1, width: 500, height: 500 } }));
  let attempts = 0;
  // fs whose first rename-over-existing fails the way Windows does while the
  // indexer or antivirus holds the target open.
  const lockedFs = {
    ...fs,
    renameSync(from, to) {
      if (++attempts === 1 && fs.existsSync(to)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    }
  };
  const timers = manualTimers();
  const t = createWindowStateTracker({ fs: lockedFs, path, filePath: () => file, platform: 'win32', ...timers });
  t.load();
  const win = fakeWindow({ bounds: { x: 40, y: 50, width: 1300, height: 900 } });
  t.attach(win);
  win.emit('move');
  timers.flush();

  assert.equal(attempts, 2, 'first rename refused, retried after removing the old file');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).bounds, { x: 40, y: 50, width: 1300, height: 900 });
  assert.deepEqual(fs.readdirSync(dir), ['window-state.json'], 'no temp file left behind');
});
