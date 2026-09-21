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

test('Music restore targets the Music navigation tab instead of the first music-kind tab', () => {
  const fn = block('function restoreMusicBrowserState()', 'function makeTabDom(');
  assert.match(fn, /tabs\.find\(t => t\.navId === 'music' && t\.kind === 'music'\)/);
  assert.doesNotMatch(fn, /tabs\.find\(t => t\.kind === 'music'\)/);
});

test('sidebar playlist activation reuses its own pinned Music tab when one exists', () => {
  const fn = block('async function openPlaylistFromSidebar(pl, navId)', 'async function showSpecialNavigation(nav)');
  assert.match(fn, /tabs\.find\(t => t\.navId === String\(navId \|\| ''\) && t\.kind === 'music'\)/);
  assert.match(fn, /openOrReusePlaylistMusicTab\(pl\)/);
});

test('Favorites does not create a second unpinned Music tab when its pinned tab exists', () => {
  const fn = block('async function openPlaylistFromSidebar(pl, navId)', 'async function showSpecialNavigation(nav)');
  assert.match(fn, /const pinned = tabs\.find\(t => t\.navId === String\(navId \|\| ''\) && t\.kind === 'music'\);/);
  assert.match(fn, /const tab = pinned \|\| openOrReusePlaylistMusicTab\(pl\);/);
});

// Real bug, confirmed: serializeUiState() already saved every closable
// "extra" tab (opened via + or by entering a Favorites/playlist from the
// sidebar) with its full state, including which album was expanded
// (state.openAlbumKey) and scroll position (state.scrollTop) -- but
// hydrateUiStateFromConfig()'s restore loop only ever patched state onto
// tabs that already existed in the freshly rebuilt `tabs` array (the
// canonical/pinned sidebar tabs). An extra tab never re-exists on a fresh
// launch, so the saved entry was silently dropped and the tab vanished on
// every restart, even though nothing ever "closed" it.
test('closable extra tabs are recreated from saved UI state, not just patched onto tabs that already exist', () => {
  const fn = block('async function hydrateUiStateFromConfig()', 'function sidebarDef(id)');
  assert.match(fn, /const existingIds = new Set\(tabs\.map\(t => t\.id\)\);/);
  assert.match(fn, /if \(!saved\?\.id \|\| !saved\.closable \|\| saved\.kind !== 'music' \|\| existingIds\.has\(saved\.id\)\) continue;/);
  assert.match(fn, /tabs\.push\(\{/);
  assert.match(fn, /state: saved\.state,/);
  // syncCanonicalNavigationTabs() must run AFTER the recreation, not before,
  // so its own extras-preservation filter (`t.id.startsWith('tab-extra-')`)
  // actually finds the newly recreated tabs instead of an empty array.
  const recreateIdx = fn.indexOf('tabs.push({');
  const syncIdx = fn.indexOf('syncCanonicalNavigationTabs();');
  assert.ok(recreateIdx >= 0 && syncIdx > recreateIdx, 'recreation must happen before syncCanonicalNavigationTabs()');
  // Restoring a previously-active extra tab as the active tab only works if
  // it already exists in `tabs` by the time this lookup runs.
  const activeIdx = fn.indexOf('if(savedActive&&tabs.some(t=>t.id===savedActive)) activeTabId=savedActive;');
  assert.ok(activeIdx > syncIdx, 'active-tab restoration must happen after recreation');
});

// Real bug, confirmed: serializeUiState() only ever saved baseLabel (a tab's
// generic default, e.g. "Music"), never the live `label` that
// updateActiveTabLabel() keeps in sync with what the tab actually shows (a
// search term, an expanded album's title, a playlist name). Every restored
// tab therefore showed its generic default instead of where it was left.
test('saved UI state carries each tab\'s live label/icon, not just its generic base label', () => {
  const serializeFn = block('function serializeUiState()', 'function persistUiStateSoon()');
  assert.match(serializeFn, /label:t\.label\|\|t\.baseLabel\|\|''/);
  assert.match(serializeFn, /icon:t\.icon\|\|t\.baseIcon\|\|''/);

  const hydrateFn = block('async function hydrateUiStateFromConfig()', 'function sidebarDef(id)');
  assert.match(hydrateFn, /if\(saved\?\.label\)t\.label=saved\.label;/);
  assert.match(hydrateFn, /if\(saved\?\.icon!=null\)t\.icon=saved\.icon;/);
  assert.match(hydrateFn, /label: saved\.label \|\| saved\.baseLabel \|\| 'Untitled',/);
  assert.match(hydrateFn, /icon: saved\.icon \|\| saved\.baseIcon \|\| '',/);
});

// Real bug, confirmed: nothing in the normal tab-render path ever read
// openAlbumKey to re-expand a matching album card on a freshly built grid --
// that reopen logic existed only for the album/artist search "Back" button
// (restoreAlbumSearchContext/restoreArtistSearchContext), never for a plain
// tab restore. So even though tab.state.openAlbumKey was captured and
// restored correctly, the album itself never actually reopened.
test('restoring a tab re-expands the album it had open', () => {
  const fn = block('function restoreTabState(tab)', 'function reopenTabAlbumWhenReady(tab, reopenKey');
  assert.match(fn, /const reopenKey = tab\.state\?\.openAlbumKey \? String\(tab\.state\.openAlbumKey\) : null;/);
  assert.match(fn, /reopenTabAlbumWhenReady\(tab, reopenKey && viewMode === 'albums' \? reopenKey : null\)\.then\(reopenedCard => \{/);
});

// A raw saved scrollTop is only a best guess -- new/removed albums or a
// different sort since the tab was last open can shift exactly where the
// reopened album now sits, so restoring the old pixel offset alone doesn't
// guarantee it's actually visible. Once the album is confirmed reopened,
// scroll straight to it instead of trusting the stale offset.
test('once the album is reopened, the tab scrolls straight to it rather than trusting the old saved scrollTop', () => {
  const fn = block('function restoreTabState(tab)', 'function reopenTabAlbumWhenReady(tab, reopenKey');
  assert.match(fn, /if \(reopenedCard\) \{/);
  assert.match(fn, /reopenedCard\.scrollIntoView\(\{ block: 'center', inline: 'nearest', behavior: 'instant' \}\);/);
});

// Album cards render progressively, 12 per frame (see renderAlbums()), so on
// a large/unfiltered library the target card may not exist for many frames.
// A single-frame guess (the original version of this fix) silently failed
// to reopen the album whenever it wasn't already rendered by the next
// frame -- the underlying openAlbumKey was still remembered correctly, it
// just never got a chance to act on it. Poll instead of guessing, bounded so
// a since-deleted album's key can't spin forever.
test('the album reopen polls across frames instead of giving up after one, bounded against a since-deleted album', () => {
  const fn = block('function reopenTabAlbumWhenReady(tab, reopenKey', 'function switchTab(id)');
  assert.match(fn, /attemptsLeft = 600/);
  assert.match(fn, /if \(!reopenKey \|\| activeTabId !== tab\.id\) return Promise\.resolve\(null\);/);
  assert.match(fn, /if \(attemptsLeft <= 0\) return Promise\.resolve\(null\);/);
  assert.match(fn, /return new Promise\(resolve => requestAnimationFrame\(\(\) => resolve\(reopenTabAlbumWhenReady\(tab, reopenKey, attemptsLeft - 1\)\)\)\);/);
});
