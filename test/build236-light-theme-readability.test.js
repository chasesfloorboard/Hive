'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('Build 236 gives Light a brighter, higher-contrast default palette', () => {
  const start = renderer.indexOf("light:{name:'Light'");
  const end = renderer.indexOf("}},\n    ember:", start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /'--bg':'#f7f8fa'/);
  assert.match(block, /'--panel':'rgba\(255,255,255,.94\)'/);
  assert.match(block, /'--panel-strong':'rgba\(255,255,255,.985\)'/);
  assert.match(block, /'--text':'#171b22'/);
  assert.match(block, /'--text-dim':'#3f4651'/);
  assert.match(block, /'--text-dimmer':'#5f6875'/);
  assert.match(block, /'--ambient-a':'rgba\(83,102,216,.035\)'/);
  assert.match(block, /'--ambient-b':'rgba\(110,120,150,.025\)'/);
});

test('Build 236 makes Frosted Glass off use solid themed surfaces with no blur', () => {
  const start = css.indexOf('#main.player-glass-transparent,');
  const end = css.indexOf('}', start);
  assert.ok(start >= 0 && end > start);
  const block = css.slice(start, end + 1);
  assert.match(block, /background:var\(--panel-strong\) !important/);
  assert.match(block, /border:1px solid color-mix\(in srgb,var\(--accent\) 24%,var\(--border\)\) !important/);
  assert.match(block, /backdrop-filter:none !important/);
  assert.match(block, /-webkit-backdrop-filter:none !important/);
});

test('Build 236 uses white current-track artists in dark themes and dark artists in Light', () => {
  assert.match(css, /#queue-list li\.playing \.q-artist,[\s\S]*?#np-artist,[\s\S]*?#pb-artist \{ color:#fff; \}/);
  assert.match(css, /html\[data-hive-theme="light"\] #queue-list li\.playing \.q-artist,[\s\S]*?#np-artist,[\s\S]*?#pb-artist \{ color:#252a31; \}/);
});
