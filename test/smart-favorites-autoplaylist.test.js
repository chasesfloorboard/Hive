'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');


test('Star Favorites is persisted as a normal-looking Smart/Auto Playlist example', () => {
  assert.match(main, /systemKey:\s*['"]star-favorites['"]/);
  assert.match(main, /smart:\s*true/);
  assert.match(main, /rules:\s*\[\{\s*field:\s*['"]love['"],\s*op:\s*['"]is['"],\s*value:\s*['"]Loved['"]\s*\}\]/);
  assert.match(main, /ensure.*Star.*Favorites|star-favorites/i);
});

test('Favorites sidebar resolves the persisted Star Favorites smart playlist through the shared playlist tab', () => {
  assert.match(renderer, /function\s+starFavoritesPlaylist\s*\(/);
  assert.match(renderer, /function\s+favoritesTracks\s*\(/);
  const start = renderer.indexOf("if(nav==='pl-favorites')");
  const end = renderer.indexOf("if(nav==='pl-explorer')", start);
  assert.ok(start >= 0 && end > start);
  const sidebarBlock = renderer.slice(start, end);
  assert.match(sidebarBlock, /starFavoritesPlaylist\(\)/);
  assert.match(sidebarBlock, /openPlaylistFromSidebar\(pl, nav\)/);
  assert.doesNotMatch(sidebarBlock, /showLibraryView\([^\n]*['"]favorites['"]\)/);
});

test('Smart playlist editor can edit an existing Auto Playlist without replacing its identity', () => {
  assert.match(renderer, /let\s+editingSmartPlaylistId\s*=\s*null/);
  assert.match(renderer, /function\s+openSmartPlaylistModal\s*\(pl\s*=\s*null\)/);
  const saveStart = renderer.indexOf("el.smartPlaylistSave.addEventListener('click',async()=>");
  const saveEnd = renderer.indexOf("document.querySelectorAll('input[name=\"tag-lyrics-align\"]')", saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  const saveBlock = renderer.slice(saveStart, saveEnd);
  assert.match(saveBlock, /editingSmartPlaylistId/);
  assert.match(saveBlock, /existing/);
  assert.match(saveBlock, /playlists=playlists\.map/);
  assert.match(saveBlock, /if\(existing\)\s*playlists=playlists\.map/);
  assert.match(saveBlock, /else\s+playlists\.push\(pl\)/);
});

test('Smart playlist rows expose editing and renaming through the same Auto Playlist editor', () => {
  assert.match(renderer, /function\s+openSmartPlaylistModal\s*\(pl\s*=\s*null\)/);
  const rowStart = renderer.indexOf('function makePlaylistRow');
  const rowEnd = renderer.indexOf('function updatePlaylistVirtualRows', rowStart);
  const rowBlock = renderer.slice(rowStart, rowEnd);
  assert.match(rowBlock, /openSmartPlaylistModal\(pl\)/);
  assert.match(rowBlock, /AUTO PLAYLIST/);
  assert.match(renderer, /showPlaylistContextMenu[\s\S]*label:'Edit smart playlist'/);
});

// Real bug, confirmed: an unset/empty "Include up to" field was coerced to a
// default of 25 (renderer) or 500 (main.js's playlists:save persistence),
// and any limit -- including "no limit" -- was hard-capped at 5000 in both
// places. A user trying to get an uncapped Auto Playlist had no way to do
// so; maxing out the field just hit the same 5000 ceiling, which is what
// made 5000 look like an enforced default rather than a coincidental max.
// 0/unset must mean unlimited end-to-end: the modal leaves the field blank
// by default, evaluateSmartPlaylist() treats a non-positive limit as
// Infinity (the same convention already used for Star Favorites), and
// playlists:save persists 0 as-is instead of substituting 500.
test('a smart/auto playlist has no track limit by default, and none is silently imposed when saved', () => {
  assert.match(renderer, /el\.smartPlaylistLimit\.value=Number\(pl\?\.limit\) > 0 \? Number\(pl\.limit\) : '';/);
  const evalStart = renderer.indexOf('function evaluateSmartPlaylist(pl)');
  const evalEnd = renderer.indexOf('\n  }\n', evalStart);
  const evalBlock = renderer.slice(evalStart, evalEnd);
  assert.match(evalBlock, /const hasLimit = Number\(pl\.limit\) > 0;/);
  assert.match(evalBlock, /const limit=isStarFavorites \|\| !hasLimit \? Infinity/);
  assert.doesNotMatch(evalBlock, /Math\.min\(5000/);
  assert.match(main, /limit: Number\(playlist\.limit\) > 0 \? Math\.max\(1, Math\.floor\(Number\(playlist\.limit\)\)\) : 0,/);
  assert.doesNotMatch(main, /Number\(playlist\.limit\) \|\| 500/);
});

test('Smart Favorites edits remain dynamic and are not converted to a static track list', () => {
  const editStart = renderer.indexOf('function openSmartPlaylistModal');
  const saveStart = renderer.indexOf("el.smartPlaylistSave.addEventListener('click',async()=>");
  const saveEnd = renderer.indexOf("document.querySelectorAll('input[name=\"tag-lyrics-align\"]')", saveStart);
  const editor = renderer.slice(editStart, saveStart);
  const saveBlock = renderer.slice(saveStart, saveEnd);
  assert.match(editor, /pl\.rules/);
  assert.match(editor, /pl\.smart/);
  assert.match(saveBlock, /smart:true/);
  assert.match(saveBlock, /rules/);
  assert.match(saveBlock, /sourceType/);
});
