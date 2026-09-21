const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('themed window chrome keeps tabs interactive while lifting them into the title area', () => {
  assert.match(html, /id="topbar-tabs"/);
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-tabs[\s\S]*?-webkit-app-region:\s*no-drag/);
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-tabs[\s\S]*?align-items:\s*center/);
});

test('themed window close control has a larger usable hit target', () => {
  assert.match(css, /html\.theme-window-bar-enabled \.window-control-close[\s\S]*?width:\s*34px/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-control-close[\s\S]*?height:\s*28px/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-control-close[\s\S]*?font-size:\s*16px/);
});

test('themed search field is not clipped and has a complete rounded focus outline', () => {
  assert.match(css, /\.search-box[\s\S]*?overflow:\s*visible/);
  assert.match(css, /html\.theme-window-bar-enabled \.search-box[\s\S]*?transform:\s*translateY\(-/);
  assert.match(css, /#search-input:focus[\s\S]*?border-color:\s*var\(--accent-soft\)[\s\S]*?border-radius:\s*10px/);
});
