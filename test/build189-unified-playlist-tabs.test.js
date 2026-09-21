'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

function block(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `missing block start: ${startNeedle}`);
  assert.ok(end >= 0, `missing block end: ${endNeedle}`);
  return source.slice(start, end);
}

test('Favorites sidebar activation uses the canonical playlist Music-tab path only', () => {
  const blockText = block(renderer, 'async function showSpecialNavigation(nav)', 'function ensureContextMenu');
  assert.match(blockText, /if\(nav==='pl-favorites'\)/);
  const fav = block(blockText, "if(nav==='pl-favorites')", "if(nav==='pl-explorer')");
  assert.match(fav, /starFavoritesPlaylist\(\)/);
  assert.match(fav, /openPlaylistFromSidebar\(pl, nav\)/);
  assert.doesNotMatch(fav, /showLibraryView\([^\n]*['"]favorites['"]\)/);
});

test('The canonical Favorites playlist is opened with the shared playlist tab state', () => {
  const helper = block(renderer, 'function preparePlaylistMusicTab(tab, pl)', 'function openOrReusePlaylistMusicTab(pl)');
  assert.match(helper, /specialView:'playlist'/);
  assert.match(helper, /activePlaylistId:pl\.id/);
  assert.match(renderer, /function openOrReusePlaylistMusicTab\(pl\)/);
  assert.match(renderer, /tracksForPlaylist\(pl\)/);
});

test('Playlist tabs derive presentation from the playlist record', () => {
  const helper = block(renderer, 'function preparePlaylistMusicTab(tab, pl)', 'function openOrReusePlaylistMusicTab(pl)');
  assert.match(helper, /tab\.baseLabel = playlistLabel\(pl\)/);
  assert.match(helper, /tab\.baseIcon = String\(pl\.icon \|\| ''\)/);
});

test('Playlist Info save refreshes every open playlist tab for the edited playlist', () => {
  const blockText = block(renderer, 'async function savePlaylistInfoChanges()', 'function duplicatePlaylistName');
  assert.match(blockText, /playlists=playlists\.map\(p=>String\(p\.id\)===String\(updated\.id\)\?updated:p\)/);
  assert.match(blockText, /refreshPlaylistTabPresentation\(updated\)/);
  assert.match(renderer, /function refreshPlaylistTabPresentation\(pl\)/);
});

test('Playlist tab presentation refresh does not replace independent browser state', () => {
  const helper = block(renderer, 'function refreshPlaylistTabPresentation(pl)', 'function sidebarSize(id)');
  assert.match(helper, /activePlaylistId/);
  assert.match(helper, /baseLabel/);
  assert.match(helper, /baseIcon/);
  assert.doesNotMatch(helper, /scrollTop\s*=/);
  assert.doesNotMatch(helper, /openAlbumKey\s*=/);
});

test('Favorites no longer needs a separate favorites renderer for its canonical playlist tab', () => {
  const view = block(renderer, 'function renderCurrentView()', 'function getRecentlyAddedTracks');
  assert.match(view, /specialView === 'playlist'/);
  assert.doesNotMatch(view, /specialView === 'favorites'\) \{ const t=favoritesTracks\(\)/);
});
