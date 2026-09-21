const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'styles.css'), 'utf8');

function block(start, end) {
  const a = renderer.indexOf(start);
  const b = renderer.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `could not locate ${start}`);
  return renderer.slice(a, b);
}

test('Build 192 routes every sidebar playlist, including Favorites, directly to its independent Music tab', () => {
  const nav = block('async function showSpecialNavigation(nav)', 'function ensureContextMenu');
  assert.match(nav, /playlistEntry\?\.type === 'playlist'/);
  assert.match(nav, /sidebarPlaylistForEntry\(nav\)/);
  assert.match(nav, /openPlaylistFromSidebar\(pl, nav\)/);
});

test('Build 192 sidebar playlist clicks resolve the playlist object and use the Music-tab path', () => {
  const sidebar = block("item.addEventListener('click', async () =>", "item.addEventListener('dblclick'");
  assert.match(sidebar, /if \(def\.type === 'playlist'\) \{[\s\S]*sidebarPlaylistForEntry\(nav\)/);
  assert.match(sidebar, /return openPlaylistFromSidebar\(pl, nav\)/);
});

test('Build 192 playlist tabs preserve independent Albums/Tracks/Artists state while following Playlist Info on first open', () => {
  const helper = block('function preparePlaylistMusicTab(tab, pl)', 'function openOrReusePlaylistMusicTab(pl)');
  assert.match(helper, /configuredView/);
  assert.match(helper, /viewMode:view/);
  assert.match(helper, /specialView:'playlist'/);
  assert.match(helper, /activePlaylistId:pl\.id/);
});

test('Build 192 live Playlist Info edits update every already-open playlist tab view', () => {
  const helper = block('function refreshPlaylistTabPresentation(pl)', 'function sidebarSize(id)');
  assert.match(helper, /viewMode:\['albums','songs','artists'\]\.includes\(pl\.displayView\)/);
});

test('Build 192 Add Tab control is a centered 22px circle', () => {
  const start = css.indexOf('.tab-add {');
  const end = css.indexOf('}', start);
  const rule = css.slice(start, end);
  assert.match(rule, /width:\s*22px/);
  assert.match(rule, /min-width:\s*22px/);
  assert.match(rule, /height:\s*22px/);
  assert.match(rule, /flex:\s*0 0 22px/);
  assert.match(rule, /align-self:\s*center/);
  assert.match(rule, /margin-top:\s*1px/);
  assert.match(rule, /border-radius:\s*50%/);
});

// Moved here from build172-navigation-favorites-lyrics.test.js (consolidated
// into test/playlist-sidebar-navigation.test.js) -- this is about the
// Albums-browser Years toolbar control, not Favorites/playlists.
test('Years control is visible only on the main Albums browser and stays after toggling', () => {
  const controls = block('function syncTabControls()', 'function tabContextLabel()');
  assert.match(controls, /viewMode\s*===\s*['"]albums['"]/);
  assert.match(controls, /specialView/);
  assert.match(controls, /yearsToggle\.classList\.toggle\(['"]hidden['"],\s*!yearsVisible\)/);
  assert.match(controls, /yearsToggle\.textContent\s*=\s*`Years:/);
  const binding = block('function bindTabToolbar(tab)', 'function bindActiveTabDom(tab)');
  assert.match(binding, /albumYearDividers\s*=\s*!albumYearDividers/);
  assert.match(binding, /renderCurrentView\(\)/);
  assert.match(binding, /syncTabControls\(\)/);
});
