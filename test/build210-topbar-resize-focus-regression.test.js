const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');

test('Build 210 keeps the library search focus ring visible outside its rounded field', () => {
  assert.match(css, /\.search-box\s*\{[\s\S]*?overflow:\s*visible/);
  assert.match(css, /\.search-box:focus-within\s*\{[\s\S]*?box-shadow:\s*0 0 0 3px var\(--accent-soft\)/);
  assert.match(css, /#search-input:focus\s*\{[\s\S]*?border-color:\s*var\(--accent-soft\)/);
});

test('Build 210 lets the topbar app row expand when the topbar is vertically resized', () => {
  assert.match(css, /\.topbar-app-row\s*\{[\s\S]*?min-height:\s*46px[\s\S]*?flex:\s*1 1 auto/);
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-app-row\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-titlebar-row\s*\{[\s\S]*?-webkit-app-region:\s*drag/);
  const themedTabsRule = css.match(/html\.theme-window-bar-enabled \.topbar-tabs\s*\{([^}]*)\}/);
  assert.ok(themedTabsRule, 'themed topbar tab rule should exist');
  assert.doesNotMatch(themedTabsRule[1], /transform:\s*translateY\(-11px\)/);
});

test('Build 210 keeps the topbar resize target wired to the topbar height', () => {
  assert.match(renderer, /const sizeProp\s*=\s*\{[^}]*topbar:\s*'height'/s);
  assert.match(html, /id="topbar-resize"[^>]*data-target="topbar"/);
});
