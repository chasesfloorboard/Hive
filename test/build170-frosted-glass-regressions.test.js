'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('Build 170 retains removal of the redundant Glass surfaces appearance toggle', () => {
  assert.doesNotMatch(html, /id="theme-option-glass"/);
  assert.doesNotMatch(renderer, /theme-option-glass/);
  assert.doesNotMatch(renderer, /opts\.glass/);
  assert.doesNotMatch(renderer, /themeOptionDefaults\s*=\s*\{[^}]*glass/);
});

test('Build 170 makes the Left sidebar glass toggle remove the sidebar glass pseudo-surface', () => {
  assert.match(css, /#sidebar\.player-glass-transparent::before\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?backdrop-filter:\s*none\s*!important;/);
});

test('Build 170 makes the Lyrics glass toggle remove the lyrics inner surface too', () => {
  assert.match(css, /#lyrics-section\.player-glass-transparent\s+\.sidebar-lyrics\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?border-color:\s*transparent\s*!important;/);
});


test('Build 170 removes the frosted surface from the section toolbar', () => {
  assert.doesNotMatch(html, /data-glass-area="toolbar"/);
  assert.doesNotMatch(renderer, /toolbar:document\.getElementById\('albums-toolbar'\)/);
  assert.doesNotMatch(css, /#albums-toolbar\.player-glass-surface/);
});
