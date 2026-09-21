'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'app/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app/renderer/styles.css'), 'utf8');

test('Now Playing stays frosted without a dedicated Settings checkbox', () => {
  assert.match(html, /data-glass-area="playbar"/);
  assert.match(html, /id="setting-player-glass"/);
  assert.match(renderer, /playbar:document\.getElementById\('playbar'\)/);
  assert.match(renderer, /playbar:\s*true/);
  assert.match(css, /#playbar\.player-glass-surface[\s\S]*?backdrop-filter:\s*blur\(var\(--blur\)\)/);
  assert.match(css, /#playbar\.player-glass-surface[\s\S]*?border:\s*1px solid color-mix\(in srgb,var\(--accent\)/);
});

test('Now Playing glass follows the master preference rather than an area-specific setting', () => {
  const start = renderer.indexOf('function applyPlayerGlass()');
  const end = renderer.indexOf('function savePlayerGlassPrefs()', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /playbar:document\.getElementById\('playbar'\)/);
  assert.match(block, /const frosted=playerGlassEnabled\s*&&\s*glassAreaPrefs\[area\]!==false/);
  assert.match(block, /glassAreaPrefs\[area\]!==false/);
});
