'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

test('Music tab does not retain an expanded album label while a sidebar view is active', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.match(source, /const preserveMusicAlbumLabel = !specialView && tab\.kind === 'music' && tab\.navId === 'music'/);
});

test('top tabs remain individually readable and scroll instead of collapsing every label', () => {
  const css = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.tab\s*\{[\s\S]*?flex:\s*0\s+0\s+auto;/);
  assert.match(css, /\.tab\s*\{[\s\S]*?max-width:\s*220px;/);
});

test('a long tab title truncates with an ellipsis instead of disappearing entirely', () => {
  // Real bug: the actual title text lives inside the nested .tab-rich-label
  // (display: inline-flex, for the rich-text icon combos it shares with
  // sidebar labels), not as direct inline content of .tab-label. text-
  // overflow: ellipsis on .tab-label alone can't truncate a nested flex
  // box's own overflowing content -- when the whole atomic inline-flex box
  // doesn't fit, the browser drops it entirely and renders only the
  // ellipsis, so a long enough album title (opened via inline album
  // expansion, see updateActiveTabLabel) showed no text at all, just "...".
  const css = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.tab-label\s*\.tab-rich-label\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.tab-label\s*\.tab-rich-label\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(css, /\.tab-label\s*\.tab-rich-label\s*\{[\s\S]*?white-space:\s*nowrap;/);
});

test('Hive brand logo is rendered monochrome rather than accent-tinted', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.match(source, /function setHiveLogoTone\(palette\)/);
  assert.match(source, /root\.setProperty\('--hive-logo-grayscale', '1'\)/);
  assert.doesNotMatch(source, /applyHiveLogoAccent\(accent\)/);
});
