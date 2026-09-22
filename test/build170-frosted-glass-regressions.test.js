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

// Build 170 made the lyrics inner surface fully transparent when Frosted
// Glass was off, leaving #lyrics-section itself borderless too -- no
// visible bubble at all. A later fix moved the border/background onto
// #lyrics-section itself instead, which created a NEW, different bug: since
// #lyrics-section has no padding and .sidebar-lyrics is inset from it by
// its own 10px/6px margin, the visible bubble grew to fill the larger
// outer box, a real, user-reported size change between Frosted Glass on
// and off. Fixed by keeping the border/background on .sidebar-lyrics in
// BOTH states (mirroring the glass-on structure) so the bubble's footprint
// never changes -- only its blur/tint does. See the comment directly above
// this rule in styles.css.
test('turning off Frosted Glass keeps the lyrics bubble on .sidebar-lyrics, not on the larger outer #lyrics-section box', () => {
  assert.match(css, /#lyrics-section\.player-glass-transparent\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?border-color:\s*transparent\s*!important;/);
  assert.match(css, /#lyrics-section\.player-glass-transparent\s+\.sidebar-lyrics\s*\{[\s\S]*?background:\s*var\(--panel-strong\)\s*!important;[\s\S]*?border:\s*1px solid color-mix\(in srgb, var\(--accent\) 24%, var\(--border\)\)\s*!important;/);
});


test('Build 170 removes the frosted surface from the section toolbar', () => {
  assert.doesNotMatch(html, /data-glass-area="toolbar"/);
  assert.doesNotMatch(renderer, /toolbar:document\.getElementById\('albums-toolbar'\)/);
  assert.doesNotMatch(css, /#albums-toolbar\.player-glass-surface/);
});
