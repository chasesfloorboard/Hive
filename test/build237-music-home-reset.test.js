const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');

function block(start, end) {
  const a = renderer.indexOf(start);
  assert.notStrictEqual(a, -1, `missing ${start}`);
  const b = renderer.indexOf(end, a + start.length);
  assert.notStrictEqual(b, -1, `missing ${end}`);
  return renderer.slice(a, b);
}

test('Build 237 resets the active Music Home destination to a clean Albums view', () => {
  const fn = block('function resetMusicHomeView(tab)', 'let navigationRequestSeq = 0;');
  assert.match(fn, /searchTerm = ''/);
  assert.match(fn, /artistSearchTerm = ''/);
  assert.match(fn, /specialView = null/);
  assert.match(fn, /activeFolderPath = ''/);
  assert.match(fn, /activePlaylistId = null/);
  assert.match(fn, /viewMode = 'albums'/);
  assert.match(fn, /el\.search\.value = ''/);
  assert.match(fn, /tab\.returnState = null/);
  assert.match(fn, /applyTabView\('music', tab\)/);
  assert.match(fn, /getActiveViewport\(\)\.scrollTop = 0/);
});

test('Build 237 only applies the Home reset when Music is already active', () => {
  const nav = block('async function showSpecialNavigation(nav)', 'function ensureContextMenu()');
  assert.match(nav, /if \(nav === 'music'\)/);
  assert.match(nav, /if \(activeTabId === tab\.id\) \{\s*resetMusicHomeView\(tab\);\s*return true;/);
  assert.match(nav, /restoreMusicBrowserState\(\);/);
});

test('Build 237 gives the top-bar Music tab the same second-click reset behavior', () => {
  const tabs = block("el.topbarTabs.addEventListener('click'", "el.tabAddBtn.addEventListener('click'");
  assert.match(tabs, /tab\?\.kind === 'music' && tab\?\.navId === 'music' && activeTabId === tab\.id/);
  assert.match(tabs, /resetMusicHomeView\(tab\);/);
});
