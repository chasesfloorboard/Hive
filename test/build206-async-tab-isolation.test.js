const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');

function block(start, end) {
  const a = renderer.indexOf(start);
  assert.notStrictEqual(a, -1, `missing ${start}`);
  const b = renderer.indexOf(end, a + start.length);
  assert.notStrictEqual(b, -1, `missing ${end}`);
  return renderer.slice(a, b);
}

test('playlist manager cannot render into a non-playlists active tab', () => {
  const fn = block('async function renderPlaylistManager(tab = getActiveTab())', 'let editingPlaylistId = null;');
  assert.match(fn, /if\s*\(!tab \|\| tab\.kind !== 'playlists' \|\| getActiveTab\(\)\?\.id !== tab\.id\) return false;/);
});

test('sidebar navigation resolves one canonical destination tab before any destination renderer can paint', () => {
  const fn = block('async function showSpecialNavigation(nav)', 'function ensureContextMenu()');
  assert.match(fn, /const navigationRequest = \+\+navigationRequestSeq;/);
  assert.match(fn, /const tab = tabs\.find\(t => t\.navId === nav\);/);
  assert.match(fn, /if \(activeTabId !== tab\.id\) switchTab\(tab\.id\);/);
  assert.match(fn, /navigationRequest !== navigationRequestSeq \|\| activeTabId !== tab\.id/);
  assert.match(fn, /applyTabView\('playlists', tab\)/);
});

test('sidebar Music activation invalidates any pending async navigation before returning to Music', () => {
  const fn = block("item.addEventListener('click', async () => {", "item.addEventListener('dblclick', async e => {");
  assert.match(fn, /if\s*\(nav === 'music'\)\s*\{[\s\S]*?await showSpecialNavigation\('music'\);[\s\S]*?return;/);
  assert.doesNotMatch(fn, /if\s*\(nav === 'music'\)\s*\{[\s\S]*?restoreMusicBrowserState\(\);/);
});
