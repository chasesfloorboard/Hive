const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('window theme preference is persisted and exposed through IPC', () => {
  assert.match(main, /window:theme-bar:get/);
  assert.match(main, /window:theme-bar:set/);
  assert.match(preload, /getThemeBar/);
  assert.match(preload, /setThemeBar/);
});

test('Settings contains an Electron window bar theme toggle', () => {
  assert.match(html, /id="setting-theme-window-bar"/);
  assert.match(html, /Theme Electron window bar/);
  assert.match(html, /custom title bar.*drag.*minimize.*maximize.*close/i);
});

test('renderer wires the Electron window bar toggle to the window mode', () => {
  assert.match(renderer, /setting-theme-window-bar/);
  assert.match(renderer, /setThemeBar/);
  assert.match(renderer, /theme-window-bar-enabled/);
});

test('custom window bar has a dedicated taller drag region and isolated controls', () => {
  assert.match(css, /html\.theme-window-bar-enabled #topbar \{[\s\S]*?height:\s*(?:76|82)px/);
  assert.match(css, /\.window-drag-region/);
  assert.match(css, /\.window-control[^}]*-webkit-app-region:\s*no-drag/s);
});

test('themed window mode is the default and custom mode uses a frameless BrowserWindow', () => {
  assert.match(main, /DEFAULT_THEME_WINDOW_BAR\s*=\s*true/);
  assert.match(main, /frame:\s*themeWindowBarEnabled\s*\?\s*false\s*:\s*true/);
});
