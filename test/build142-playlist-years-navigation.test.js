'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');

test('Music toolbar restores the Years toggle while keeping Release Date sort removed', () => {
  assert.match(html, /data-action="toggle-years"/);
  assert.match(renderer, /data-action=['"]toggle-years['"]/);
  assert.match(renderer, /albumYearDividers\s*=\s*!albumYearDividers/);
  assert.match(renderer, /saveActiveTabState\(\)/);
  assert.doesNotMatch(html, /Sort:\s*Release Date/i);
  assert.doesNotMatch(renderer, /album-sort-btn/);
});

test('Years toggle remains wired to the existing grouped album/year renderer', () => {
  assert.match(renderer, /function renderAlbums\(\)[\s\S]*?albumYearDividers/);
  assert.match(renderer, /albumYearDividers\s*!==\s*false/);
  assert.match(renderer, /album-years-grouped/);
  assert.match(renderer, /album-year-section/);
});

test('Playlist duplication uses Copy suffixes without duplicating system identity', () => {
  assert.match(renderer, /function duplicatePlaylistName\(/);
  assert.match(renderer, /Copy/);
  assert.match(renderer, /window\.beehive\.savePlaylist\(/);
  assert.match(renderer, /delete\s+copy\.systemKey|systemKey\s*:/);
  assert.match(renderer, /showPlaylistContextMenu[\s\S]*Duplicate playlist/);
});

test('Playlists can be added to persistent sidebar navigation', () => {
  assert.match(renderer, /type:\s*['"]playlist['"]/);
  assert.match(renderer, /playlistId/);
  assert.match(renderer, /addPlaylistToSidebar/);
  assert.match(renderer, /removePlaylistFromSidebar/);
  assert.match(renderer, /function sidebarEntry\(/);
  assert.match(renderer, /entry\.type\s*===\s*['"]playlist['"]/);
  assert.match(renderer, /sidebarNavigation\.custom/);
});

// The dedicated "Add playlists" list inside Settings > Navigation was
// removed as redundant with a playlist's own right-click "Add to sidebar"
// (see test/sidebar-navigation-settings.test.js for that regression
// coverage). Playlists already in the sidebar can still be reordered,
// pinned, or removed from the same Settings > Navigation sidebar editor.
test('Settings Navigation lets an already-sidebarred playlist be removed, without a separate playlist-adding list', () => {
  const start = renderer.indexOf('function renderNavigationEditors()');
  const end = renderer.indexOf('// ---------------- settings modal tabs ----------------', start);
  const block = renderer.slice(start, end);
  assert.doesNotMatch(block, /availablePlaylists/);
  assert.doesNotMatch(block, /navigation-playlist-section/);
  assert.match(block, /removePlaylistFromSidebar/);
});

test('Star Favorites renders with the actual star icon while remaining an Auto Playlist', () => {
  assert.match(main, /systemKey:\s*['"]star-favorites['"]/);
  assert.match(main, /smart:\s*true/);
  assert.match(main, /icon:\s*['"]★['"]/);
  assert.match(renderer, /systemKey\s*===\s*['"]star-favorites['"][\s\S]*?★/);
});
