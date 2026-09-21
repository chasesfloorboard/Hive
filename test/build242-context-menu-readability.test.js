const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('Build 242 truncates only displayed album context labels at 15 characters', () => {
  assert.match(renderer, /function contextAlbumLabel\(value\)/);
  assert.match(renderer, /text\.length > 15 \? `\$\{text\.slice\(0,15\)\}…` : text/);
  assert.match(renderer, /Search album: \$\{contextAlbumLabel\(t\.album\)\}/);
  assert.match(renderer, /Search album: \$\{contextAlbumLabel\(album\.title\)\}/);
});

test('Build 242 keeps context menus compact and left-aligned', () => {
  assert.match(css, /#context-menu, \.context-submenu \{[\s\S]*?width:min\(340px, calc\(100vw - 12px\)\);/);
  assert.match(css, /\.context-item \{[\s\S]*?justify-content:flex-start;[\s\S]*?text-align:left;/);
  assert.match(css, /\.context-item-label, \.context-submenu-label \{[\s\S]*?text-align:left;/);
  assert.match(css, /\.context-submenu \.context-item \{ width:100%; max-width:100%; \}/);
});

test('Build 242 keeps Light-mode queue and track durations readable', () => {
  assert.match(css, /html\[data-hive-theme="light"\] #queue-list li\.selected \.q-dur,[\s\S]*?color: #252a31;/);
  assert.match(css, /html\[data-hive-theme="light"\] #queue-list li\.playing \.q-dur/);
  assert.match(css, /html\[data-hive-theme="light"\] \.song-row\.selected \.s-dur/);
  assert.match(css, /html\[data-hive-theme="light"\] \.inline-track-row\.selected \.inline-track-dur/);
});
