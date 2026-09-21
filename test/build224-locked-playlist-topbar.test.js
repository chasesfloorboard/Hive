const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

test('Build 224 locks Playlists into the fixed top-bar position', () => {
  assert.match(renderer, /sidebarNavigation\.pinned\.add\('pl-explorer'\)/);
  assert.match(renderer, /sidebarNavigation\.pinnedOrder = \['music', 'pl-explorer'\]/);
  assert.match(renderer, /favoritesId.*sidebarNavigation\.pinnedOrder/);
});

test('Build 224 prevents the locked Playlists tab from pin-editor changes and top-bar drag', () => {
  assert.match(renderer, /id==='music'\}\);/);
  assert.match(renderer, /lockedPin/);
  assert.match(renderer, /Core destination/);
});
