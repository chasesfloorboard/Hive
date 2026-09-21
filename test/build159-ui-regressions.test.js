'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
const icons = fs.readFileSync(path.join(root, 'app/renderer/icons.js'), 'utf8');

test('Built-in Favorites is user-facing Favorites with a star, never Star Favorites', () => {
  assert.match(main, /systemKey:\s*['"]star-favorites['"]/);
  assert.match(main, /name:\s*['"]Favorites['"]/);
  assert.match(main, /label:\s*['"]Favorites['"]/);
  assert.match(main, /icon:\s*['"]★['"]/);
  assert.doesNotMatch(main, /name:\s*['"]Star Favorites['"]/);
  assert.doesNotMatch(main, /label:\s*['"]Star Favorites['"]/);
  assert.match(renderer, /systemKey\s*===\s*['"]star-favorites['"][\s\S]*?Favorites/);
  assert.match(renderer, /FAVORITES_SIDEBAR_MIGRATION_KEY/);
  assert.match(renderer, /playlistId:\s*canonicalId/);
  assert.match(renderer, /label:\s*'Favorites'/);
});

test('Built-in Favorites is normalized to one persisted smart-playlist identity', () => {
  assert.match(main, /matches\s*=\s*lists/);
  assert.match(main, /canonicalMatch\s*=\s*matches\.find/);
  assert.match(main, /systemKey:\s*'star-favorites'/);
  assert.match(main, /existing.*name:\s*['"]Favorites['"]/s);
  assert.match(main, /existing.*label:\s*['"]Favorites['"]/s);
  assert.match(renderer, /pl-favorites[\s\S]*starFavoritesPlaylist/);
});

test('Glass controls live in Settings rather than the bottom player', () => {
  assert.doesNotMatch(html, /id="playbar-glass-settings"/);
  assert.doesNotMatch(html, /id="playbar-glass-toggle"/);
  assert.match(html, /id="setting-player-glass"/);
  assert.match(renderer, /PLAYBAR_GLASS_KEY/);
  assert.match(renderer, /PLAYBAR_GLASS_AREAS_KEY/);
  assert.match(renderer, /glassAreaPrefs/);
});

test('Glass settings provide independent surface controls for the player bars', () => {
  for (const id of ['topbar','sidebar','queue']) {
    assert.match(html, new RegExp(`data-glass-area="${id}"`));
  }
  assert.match(renderer, /glassAreaDefaults/);
  assert.match(renderer, /glassAreaPrefs/);
  assert.match(renderer, /data-glass-area/);
  assert.match(css, /player-glass-transparent/);
});

test('Queue panel clips all queue content to its rounded bubble', () => {
  assert.match(css, /#queue-panel\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /#queue-panel::before[\s\S]*?border-radius:\s*var\(--radius\)/);
  assert.match(css, /#queue-list\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('Library folder right-click opens a context menu instead of Info', () => {
  const start = renderer.indexOf("div.addEventListener('contextmenu'");
  assert.ok(start >= 0);
  const block = renderer.slice(start, start + 1800);
  assert.match(block, /showContextMenu/);
  assert.match(block, /Rescan library/);
  assert.match(block, /showSidebarListInfo/);
});

test('Unknown Album placeholders never trigger automatic artwork lookup', () => {
  const start = renderer.indexOf('async function ensureAutomaticCoverVisual');
  const end = renderer.indexOf('function warmQueueAutomaticArtwork', start);
  const block = renderer.slice(start, end);
  assert.match(block, /isPlaceholderAlbum/);
  assert.match(block, /Unknown Album/);
  assert.match(block, /clearAutomaticCoverVisual/);
  const warmStart = renderer.indexOf('async function warmAlbumAutomaticArtwork');
  const warmEnd = renderer.indexOf('function warmQueueAutomaticArtwork', warmStart);
  const warm = renderer.slice(warmStart, warmEnd);
  assert.match(warm, /isPlaceholderAlbum/);
  const guardPos=warm.indexOf('isPlaceholderAlbum(albumName)');
  const searchPos=warm.indexOf('searchInternetCover({ album: albumName');
  assert.ok(guardPos >= 0 && searchPos > guardPos, 'placeholder guard must run before artwork search');
});
