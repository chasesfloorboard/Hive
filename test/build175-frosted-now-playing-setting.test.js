'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'app/renderer/renderer.js'), 'utf8');


test('Frosted Glass settings keeps Now Playing frosted without a dedicated surface control', () => {
  assert.match(html, /data-glass-area="playbar"/);
  assert.doesNotMatch(html, /id="setting-playbar-frosted"/);
  assert.doesNotMatch(html, />Frosted Now Playing bar</);
});

test('renderer does not maintain a separate Frosted Now Playing preference', () => {
  assert.doesNotMatch(renderer, /PLAYBAR_FROSTED_KEY/);
  assert.doesNotMatch(renderer, /playbarFrostedToggle/);
  assert.doesNotMatch(renderer, /setPlaybarFrosted\(/);
});

test('playbar frosted appearance remains controlled by the master glass preference', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app/renderer/styles.css'), 'utf8');
  assert.match(renderer, /playbar:document\.getElementById\('playbar'\)/);
  assert.match(renderer, /data-glass-area/);
  assert.match(css, /#playbar\.player-glass-surface/);
  assert.match(css, /#playbar\.player-glass-surface[\s\S]*?border:1px solid color-mix\(in srgb,var\(--accent\)/);
  assert.doesNotMatch(css, /#playbar\.playbar-frosted/);
  assert.doesNotMatch(html, /playbar-frosted/);
});
