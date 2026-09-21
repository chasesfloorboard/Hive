'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const start = source.indexOf("item.addEventListener('contextmenu', async e => {");
const end = source.indexOf("item.addEventListener('dragstart'", start);
const block = source.slice(start, end);
const helperStart = source.indexOf('function sidebarContextMenuItems(');
const helperEnd = source.indexOf('async function exportSidebarCollection', helperStart);
const helper = source.slice(helperStart, helperEnd);

test('all track-bearing sidebar destinations use the shared Play, Queue, Info and Export menu', () => {
  assert.ok(start >= 0 && end > start, 'sidebar context-menu block must exist');
  assert.match(block, /sidebarContextMenuItems\(nav, tracks, sidebarNames\[nav\]\)/);
  assert.match(helper, /function sidebarContextMenuItems\(nav, tracks, description/);
  assert.match(helper, /label:'Play'.*playSidebarCollection\(nav\)/s);
  assert.match(helper, /label:'Queue'.*addTracksToQueue\(tracks\)/s);
  assert.match(helper, /label:'Info'.*showSidebarListInfo/s);
  assert.match(helper, /label:'Export as M3U'.*exportSidebarCollection\(nav\)/s);
});

test('Favorites and other dynamic sidebar collections no longer use a special Add playlist to queue menu item', () => {
  assert.doesNotMatch(block, /dynamicSidebarPlaylist\(nav\)/);
  assert.doesNotMatch(block, /Add playlist to queue/);
  assert.match(block, /'pl-favorites':'Favorites'/);
  assert.match(block, /'pl-recent':'Recently Added'/);
  assert.match(block, /'pl-top':'Top 25 Most Played'/);
});
