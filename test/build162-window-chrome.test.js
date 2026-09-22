const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('Build 162 places themed window controls in a dedicated title row above the app tabs', () => {
  assert.match(html, /class="window-titlebar-row"/);
  assert.match(html, /data-window-control="minimize"/);
  assert.match(html, /data-window-control="maximize"/);
  assert.match(html, /data-window-control="close"/);
  assert.match(html, /class="topbar-app-row"/);
});

test('Build 162 provides a real empty drag area above the tabs and keeps controls non-draggable', () => {
  assert.match(css, /html\.theme-window-bar-enabled #topbar[\s\S]*?-webkit-app-region:\s*drag/);
  assert.match(css, /\.window-control \{[\s\S]*?-webkit-app-region:\s*no-drag/);
  assert.match(css, /html\.theme-window-bar-enabled #topbar[\s\S]*?min-height:\s*(?:76|82)px/);
});

test('Build 162 only exposes custom window controls when the themed Electron bar is enabled', () => {
  assert.match(css, /html\.native-window-bar \.window-controls\s*\{\s*display:\s*none/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-controls\s*\{\s*display:\s*flex/);
});

test('themed double-click maximize is handled by the topbar without hijacking controls', () => {
  assert.match(renderer, /const themedTopbar=document\.getElementById\(['"]topbar['"]\);/);
  assert.match(renderer, /themedTopbar\?\.addEventListener\(['"]dblclick['"]/);
  assert.match(renderer, /event\.target\.closest\(['"]button,input,select,a,.window-controls,.search-box['"]\)/);
});

// Moved here from build241-window-volume-direct.test.js during the #12
// buildNNN consolidation pass -- a window-chrome CSS fix misfiled under a
// volume build name; this file is its real home.
test('the themed window titlebar row has its own dedicated hit-testable drag/no-drag breathing room', () => {
  assert.match(css, /html\.theme-window-bar-enabled #topbar\s*\{[\s\S]*?height:\s*82px[\s\S]*?min-height:\s*82px/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-titlebar-row\s*\{[\s\S]*?height:\s*32px[\s\S]*?pointer-events:\s*auto[\s\S]*?-webkit-app-region:\s*drag/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-titlebar-row > \.window-controls\s*\{[\s\S]*?pointer-events:\s*auto[\s\S]*?-webkit-app-region:\s*no-drag/);
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-app-row\s*\{[\s\S]*?height:\s*auto/);
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-app-row\s*\{[\s\S]*?min-height:\s*0/);
});
