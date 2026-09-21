'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

test('Podcasts is not part of the default pinned navigation and is never auto-pinned on open', () => {
  assert.match(source, /let pinned = new Set\(\['music'\]\);/);
  assert.match(source, /let pinnedOrder = \['music'\];/);
  assert.doesNotMatch(source, /if\(!tab\)\{ sidebarNavigation\.pinned\.add\('podcasts'\)/);
});

test('sidebar Info stores display view and shuffle together per navigation destination', () => {
  assert.match(source, /sidebarNavigation\.meta\[key\]=\{.*shuffleOnEnter.*displayView.*icon.*\}/);
  assert.match(source, /function sidebarDisplayView\(nav, fallback='albums'\)/);
  assert.match(source, /sidebarNavigation\?\.meta\?\.\[key\]\?\.displayView/);
});

test('sidebar automatic shuffle applies to the Tracks view without changing Albums ordering', () => {
  assert.match(source, /currentSidebarContextNav\(\)/);
  assert.match(source, /manualSongSortActive\(\)/);
  assert.match(source, /sidebarVisualShuffleEnabled\(nav\)/);
  assert.match(source, /function renderSpecialAlbums\(tracks\)/);
  assert.match(source, /if \(albumYearDividers\) \{/);
});

test('Podcasts has a right-click Info path', () => {
  assert.match(source, /if\(nav==='podcasts'\).*showContextMenu/s);
  assert.match(source, /if\(nav==='podcasts'\)\{\s+const favorites = await loadPodcastFavorites\(\)/s);
});

test('Years control is present in the Music view toolbar while Release Date sorting remains removed', () => {
  assert.match(source, /data-action=['"]toggle-years['"]/);
  assert.match(source, /albumYearDividers\s*=\s*!albumYearDividers/);
  assert.doesNotMatch(source, /albumSortBtn/);
  assert.doesNotMatch(source, /album-sort-btn/);
});

// The Settings > Navigation tab's separate "Top bar" editor section (a
// reorderable list of pinned destinations) and "Add playlists" section were
// both removed as redundant: any sidebar row's own Pin button already
// toggles top-bar pinning, and right-clicking a playlist already offers
// "Add to sidebar" (see showPlaylistContextMenu), from where it can then be
// pinned the same way as any other sidebar destination.
test('Settings > Navigation no longer duplicates the Top bar editor or the Add playlists section', () => {
  const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /navigation-topbar-editor/);
  assert.doesNotMatch(html, /<strong>Top bar<\/strong>/);
  assert.match(html, /id="navigation-sidebar-editor"/);
  assert.doesNotMatch(source, /navigation-playlist-section/);
  assert.doesNotMatch(source, /Add playlists/);
  assert.match(source, /function renderNavigationEditors\(\) \{\s*const sideHost=document\.getElementById\('navigation-sidebar-editor'\);\s*if\(!sideHost\) return;/);
  // Pin/unpin per sidebar row and "Add to sidebar" from a playlist's
  // context menu remain the surviving paths to the same functionality.
  assert.match(source, /pin:sidebarNavigation\.pinned\.has\(id\)/);
  assert.match(source, /playlistIsInSidebar\(pl\) \? 'Remove from sidebar' : 'Add to sidebar'/);
});

