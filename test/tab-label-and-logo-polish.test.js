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

// Requested directly: middle-click (mouse button 1) anywhere on a tab
// closes it, not just its small "x" -- a much bigger, easier target,
// matching how browser tabs behave. mousedown must also be preventDefault'd
// for a middle click, otherwise Chromium enters its middle-click
// autoscroll/pan mode before auxclick ever fires.
test('middle-clicking anywhere on a tab closes it', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  const mousedownStart = source.indexOf("el.topbarTabs.addEventListener('mousedown', e => {");
  assert.ok(mousedownStart >= 0);
  const mousedownEnd = source.indexOf('\n  });', mousedownStart);
  const mousedownBlock = source.slice(mousedownStart, mousedownEnd);
  assert.match(mousedownBlock, /if \(e\.button !== 1\) return;/);
  assert.match(mousedownBlock, /e\.preventDefault\(\);/);

  const auxStart = source.indexOf("el.topbarTabs.addEventListener('auxclick', e => {");
  assert.ok(auxStart >= 0);
  const auxEnd = source.indexOf('\n  });', auxStart);
  const auxBlock = source.slice(auxStart, auxEnd);
  assert.match(auxBlock, /if \(e\.button !== 1\) return;/);
  assert.match(auxBlock, /btn\.id === 'tab-add-btn'/, 'must not try to close the + add-tab button');
  assert.match(auxBlock, /closeTab\(id\);/);
});
