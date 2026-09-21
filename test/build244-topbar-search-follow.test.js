const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const build = fs.readFileSync(path.join(root, 'BUILD'), 'utf8').trim();

test('Build 247 keeps the search in the themed navigation row flow', () => {
  const rule = css.match(/html\.theme-window-bar-enabled \.topbar-right\s*\{([^}]*)\}/);
  assert.ok(rule, 'themed topbar-right rule should exist');
  assert.match(rule[1], /position:\s*relative/);
  assert.match(rule[1], /align-self:\s*center/);
  assert.match(rule[1], /margin-left:\s*auto/);
  assert.doesNotMatch(rule[1], /position:\s*absolute/);
  assert.doesNotMatch(rule[1], /top:\s*10px/);
});

test('Build 247 removes the fixed search-position synchronization path', () => {
  assert.doesNotMatch(renderer, /syncThemedSearchPosition/);
  assert.doesNotMatch(renderer, /--hive-search-top/);
});

test('Build 247 keeps search and tabs inside the same fluid resized row', () => {
  const rows = [...css.matchAll(/html\.theme-window-bar-enabled \.topbar-app-row\s*\{([^}]*)\}/g)];
  const row = rows.at(-1);
  assert.ok(row, 'themed navigation row should exist');
  assert.match(row[1], /height:\s*auto/);
  assert.match(row[1], /min-height:\s*0/);
  assert.match(row[1], /flex:\s*1 1 auto/);
  assert.match(row[1], /align-items:\s*center/);
});

test('Build 247 preserves the topbar resize ownership', () => {
  assert.match(renderer, /const sizeProp\s*=\s*\{[^}]*topbar:\s*'height'/s);
  assert.match(renderer, /const limits\s*=\s*\{[\s\S]*?topbar:/);
});
