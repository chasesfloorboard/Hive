'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'app/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app/renderer/styles.css'), 'utf8');

test('Frosted surfaces keeps Now Playing / player as the single area control', () => {
  assert.match(html, /<div class="settings-subsection-title">Frosted surfaces<\/div>[\s\S]*?data-glass-area="playbar"/);
  assert.doesNotMatch(html, /id="setting-playbar-frosted"/);
  assert.doesNotMatch(html, />Frosted Now Playing bar</);
});

test('Now Playing glass still honors its area preference and master preference', () => {
  assert.match(renderer, /playbar:document\.getElementById\('playbar'\)/);
  const start = renderer.indexOf('function applyPlayerGlass()');
  const end = renderer.indexOf('function savePlayerGlassPrefs()', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /const frosted=playerGlassEnabled && glassAreaPrefs\[area\]!==false/);
  assert.match(renderer, /playbar:true/);
});

test('Now Playing glass uses the established accented frosted surface treatment', () => {
  const start = css.indexOf('#playbar.player-glass-surface {');
  const end = css.indexOf('}', start);
  assert.ok(start >= 0 && end > start);
  const playbar = css.slice(start, end + 1);
  assert.match(playbar, /background:color-mix\(in srgb,var\(--accent\) 7%,var\(--panel\)\)/);
  assert.match(playbar, /border:1px solid color-mix\(in srgb,var\(--accent\) 14%,var\(--border\)\)/);
  assert.match(playbar, /backdrop-filter:blur\(var\(--blur\)\) saturate\(140%\)/);
  assert.match(playbar, /border-radius:var\(--radius\)/);
  assert.doesNotMatch(css, /#playbar\.playbar-frosted/);
});

test('New-tab control stays a compact circle rather than a large oval', () => {
  const start = css.indexOf('.tab-add {');
  const end = css.indexOf('}', start);
  const block = css.slice(start, end + 1);
  assert.match(block, /width:\s*22px/);
  assert.match(block, /height:\s*22px/);
  assert.match(block, /border-radius:\s*50%/);
  assert.doesNotMatch(block, /width:\s*34px|height:\s*34px/);
});
