'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');

function block(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `missing block start: ${startNeedle}`);
  assert.ok(end >= 0, `missing block end: ${endNeedle}`);
  return source.slice(start, end);
}

test('Playlist Details puts Save changes in the modal header beside Close', () => {
  const header = html.slice(html.indexOf('<div id="playlist-info-modal"'), html.indexOf('<!-- ============ SMART PLAYLIST'));
  const saveIndex = header.indexOf('id="playlist-info-save"');
  const closeIndex = header.indexOf('data-close');
  assert.ok(saveIndex >= 0 && closeIndex >= 0);
  assert.ok(saveIndex < closeIndex, 'save button must appear immediately before the close control');
  assert.match(header, /class="playlist-info-header-actions"/);
  assert.doesNotMatch(header, /class="playlist-info-actions"/);
});

test('Playlist Details uses the hero icon as the only icon picker trigger', () => {
  const modal = html.slice(html.indexOf('<div id="playlist-info-modal"'), html.indexOf('<!-- ============ SMART PLAYLIST'));
  assert.match(modal, /id="playlist-info-hero-icon"[^>]*aria-haspopup="menu"/);
  assert.match(modal, /id="playlist-info-icon-menu"/);
  assert.doesNotMatch(modal, /id="playlist-info-icons"/);

  const iconBlock = block(renderer, 'function renderPlaylistInfoIcons', 'function selectedPlaylistInfoIcon');
  assert.match(iconBlock, /playlistInfoIconMenu/);
  assert.match(iconBlock, /playlist-info-icon-menu-item/);
});

test('Saving a playlist info edit synchronizes rich label and icon to its sidebar entry', () => {
  const save = block(renderer, 'async function savePlaylistInfoChanges()', 'function duplicatePlaylistName');
  assert.match(save, /sidebarNavigation\.custom\.map/);
  assert.match(save, /playlistId/);
  assert.match(save, /updated\.label/);
  assert.match(save, /updated\.icon/);
});

test('Saving playlist info immediately repaints the sidebar and tab projections', () => {
  const save = block(renderer, 'async function savePlaylistInfoChanges()', 'function duplicatePlaylistName');
  const projectionSync = save.slice(0, save.indexOf('const key=playlistInfoEditingDynamicNav'));
  assert.match(projectionSync, /renderSidebarNavigation\(\)/);
  assert.match(projectionSync, /renderTabs\(\)/);
  assert.match(projectionSync, /updateActiveTabLabel\(\)/);
});

test('Canonical Favorites persistence does not overwrite a user-selected label or icon', () => {
  const save = block(main, "ipcMain.handle('playlists:save'", "ipcMain.handle('playlists:chooseImportFile'");
  assert.match(save, /isCanonicalFavorites/);
  assert.match(save, /label:\s*isCanonicalFavorites/);
  assert.match(save, /typeof playlist\.label === 'string'/);
  assert.match(save, /icon:\s*isCanonicalFavorites/);
  assert.match(save, /typeof playlist\.icon === 'string'/);
  assert.doesNotMatch(save, /label:\s*isCanonicalFavorites \? 'Favorites'/);
  assert.doesNotMatch(save, /icon:\s*isCanonicalFavorites \? '★'/);
});

test('Rainbow labels use an explicit animated text treatment instead of hue-filtering the text', () => {
  const rainbowStart = styles.lastIndexOf('@keyframes hiveRichRainbow');
  const rainbowCss = styles.slice(rainbowStart - 500, rainbowStart + 500);
  assert.match(rainbowCss, /background(?:-image)?:/);
  assert.match(rainbowCss, /background-clip:\s*text/);
  assert.match(rainbowCss, /-webkit-background-clip:\s*text/);
  assert.match(rainbowCss, /color:\s*transparent/);
  assert.doesNotMatch(rainbowCss, /filter:\s*hue-rotate/);
});


test('Favorites sidebar migration preserves persisted presentation and migrates its pinned state', () => {
  const migration = block(renderer, 'function migrateFavoritesSidebarToCanonicalPlaylist()', 'function sidebarMetaKey');
  assert.match(migration, /label:\s*typeof favorites\.label === 'string'/);
  assert.match(migration, /icon:\s*typeof favorites\.icon === 'string'/);
  assert.doesNotMatch(migration, /canonicalEntry\.label\s*=\s*'Favorites'/);
  assert.doesNotMatch(migration, /canonicalEntry\.icon\s*=\s*'★'/);
  assert.match(migration, /sidebarNavigation\.pinned\.add\(canonicalEntry\.id\)/);
  assert.match(migration, /sidebarNavigation\.pinnedOrder\.includes\(canonicalEntry\.id\)/);
});

test('Playlist Manager renders the saved Favorites icon instead of forcing the star icon', () => {
  const manager = block(renderer, 'async function renderPlaylistManager(tab = getActiveTab())', 'let editingPlaylistId');
  assert.match(manager, /const plIcon\s*=\s*String\(pl\.icon \|\| ''\)/);
  assert.doesNotMatch(manager, /pl\.systemKey\s*===\s*'star-favorites'\s*\?\s*'★'/);
});
