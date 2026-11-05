const assert = require('assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');

test('Build 208 creates a canonical tab context for every sidebar destination, not only pinned destinations', () => {
  assert.match(renderer, /function syncCanonicalNavigationTabs\(\)/);
  assert.match(renderer, /const canonicalEntries = sidebarNavigation\.order/);
  assert.match(renderer, /const oldByNav = new Map/);
  assert.match(renderer, /tab\.hidden = !sidebarNavigation\.pinned\.has\(nav\)/);
});

test('Build 208 sidebar activation always resolves the canonical destination context before rendering', () => {
  const start = renderer.indexOf('async function showSpecialNavigation(nav)');
  const end = renderer.indexOf('  function ensureContextMenu()', start);
  const block = renderer.slice(start, end);
  assert.match(block, /const tab = tabs\.find\(t => t\.navId === nav\)/);
  assert.match(block, /if \(activeTabId !== tab\.id\) switchTab\(tab\.id\)/);
  assert.match(block, /applyTabView\('podcasts', tab\)/);
  assert.doesNotMatch(block, /const musicContexts = \{/);
});

test('Build 208 each canonical context gets its own persistent DOM host', () => {
  const start = renderer.indexOf('function ensureTabHost(tab)');
  const end = renderer.indexOf('  function bindTabToolbar(tab)', start);
  const block = renderer.slice(start, end);
  assert.match(block, /host\.dataset\.tabId = tab\.id/);
  assert.match(block, /el\.main\.appendChild\(host\)/);
  assert.match(block, /tab\.dom\.host = host/);
});

test('Build 208 playlist manager is scoped to the active canonical tab, never document-global', () => {
  const start = renderer.indexOf('async function renderPlaylistManager(tab = getActiveTab())');
  const end = renderer.indexOf('  let editingPlaylistId', start);
  const block = renderer.slice(start, end);
  assert.match(block, /function renderPlaylistManager\(tab = getActiveTab\(\)\)/);
  assert.match(block, /tab\.kind !== 'playlists'/);
  assert.match(block, /const placeholder = tab\.dom\?\.tabPlaceholder/);
  assert.doesNotMatch(block, /document\.getElementById\('playlist-manager-list'\)/);
});

test('Build 208 podcast renderer is scoped to the active canonical tab and has per-context initialization', () => {
  const start = renderer.indexOf('function renderPodcasts(tab = getActiveTab())');
  const end = renderer.indexOf('  function tabPlaceholderCopy', start);
  const block = renderer.slice(start, end);
  assert.match(block, /function renderPodcasts\(tab = getActiveTab\(\)\)/);
  assert.match(block, /tab\.kind !== 'podcasts'/);
  assert.match(block, /const contentTools = tab\.dom\?\.contentTools/);
  assert.doesNotMatch(block, /document\.querySelector\('\.podcast-favorites'\)/);
  assert.doesNotMatch(block, /el\.contentTools\.dataset\.podcastsInitialized/);
});

test('Yearly Wrap sidebar destination opens the slideshow inside the main window', () => {
  // The user asked for Yearly Wrap in the app instead of a separate window
  // (2026-11). The sidebar destination renders the slideshow view
  // (app/renderer/yearly-wrap-view.js) into the tab's own content area; the
  // standalone yearly-wrap.html window is no longer opened from the sidebar.
  const start = renderer.indexOf("if (nav === 'yearly-wrap')");
  const end = renderer.indexOf('\n    }', start);
  const block = renderer.slice(start, end);
  assert.match(block, /await renderYearlyWrap\(tab\)/);
  assert.doesNotMatch(block, /openYearlyWrap\(/);
  const fn = renderer.slice(renderer.indexOf('async function renderYearlyWrap'), renderer.indexOf('async function renderYearlyWrap') + 3000);
  assert.match(fn, /window\.HiveYearlyWrapView\.mount\(contentTools/);
});

// Clicking Music kept its sidebar row highlighted, but Playlists, Favorites,
// and any other pinned playlist did not: syncSidebarSelectionForContext()
// runs on every tab restore (including right after the click handler that
// had just set the correct highlight) and recomputed which row should stay
// active from a short, hardcoded list of specialView values. That list
// covered recent/top/history/sandbox/folder and the single shared Music tab,
// but not specialView 'playlist' (Favorites/any pinned playlist), 'podcasts',
// or the Playlists-manager tab -- so those destinations' highlight was
// cleared on the very same click that had just set it.
test('sidebar highlight context covers Playlists, playlist destinations (e.g. Favorites), and Podcasts, not only Music', () => {
  const start = renderer.indexOf('function syncSidebarSelectionForContext()');
  const end = renderer.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start, 'expected to find syncSidebarSelectionForContext()');
  const block = renderer.slice(start, end);
  assert.match(block, /specialView === 'podcasts' \? 'podcasts'/);
  assert.match(block, /specialView === 'playlist' \? sidebarNavIdForPlaylistId\(activePlaylistId\)/);
  assert.match(block, /active\?\.kind === 'playlists'\) \? 'pl-explorer'/);

  // The reverse lookup must resolve Favorites through the actual rendered
  // sidebar entries (sidebarNavigation.order/custom) FIRST, falling back to
  // the legacy literal 'pl-favorites' id only if nothing matches. Favorites
  // is normally a real custom playlist entry with a *generated* sidebar id
  // (see enforceLockedTopbarPins()'s "generated sidebar id" comment) -- an
  // earlier version of this helper checked the literal 'pl-favorites' first,
  // which doesn't match any row's data-nav once Favorites is a migrated
  // custom entry, so nothing ever got highlighted.
  const helperStart = renderer.indexOf('function sidebarNavIdForPlaylistId(playlistId)');
  assert.ok(helperStart >= 0, 'expected the sidebarNavIdForPlaylistId reverse-lookup helper to exist');
  const helperBlock = renderer.slice(helperStart, renderer.indexOf('\n  }', helperStart));
  assert.match(helperBlock, /starFavoritesPlaylist\(\)/);
  assert.match(helperBlock, /return 'pl-favorites'/);
  const orderLoopIndex = helperBlock.indexOf('for (const id of candidateIds)');
  const legacyFallbackIndex = helperBlock.indexOf("return 'pl-favorites'");
  assert.ok(orderLoopIndex >= 0, 'expected the candidateIds lookup loop');
  assert.ok(
    orderLoopIndex < legacyFallbackIndex,
    'the real sidebarNavigation.order/custom lookup must run before the legacy pl-favorites fallback, not after'
  );
});

test('Build 208 top-level context renderers use their own tab DOM instead of stale global element bindings', () => {
  for (const name of ['showSandboxView', 'showSandboxPlugin', 'renderYearlyWrap']) {
    const start = renderer.indexOf(`function ${name}`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = renderer.indexOf('\n  function ', start + 10);
    const block = renderer.slice(start, end > start ? end : renderer.length);
    assert.match(block, /getActiveTab\(\)/, `${name} should resolve its active context`);
  }
});

test('Yearly Wrap month detail counts that month only, top first', () => {
  const { monthDetail } = require('../app/renderer/yearly-wrap-view.js');
  const at = (m, d) => new Date(2026, m, d, 12).getTime();
  const rows = [
    { playedAt: at(1, 3), title: 'A', artist: 'X', album: 'One', duration: 200 },
    { playedAt: at(1, 4), title: 'A', artist: 'X', album: 'One', duration: 200 },
    { playedAt: at(1, 5), title: 'B', artist: 'Y', album: 'Two', duration: 100 },
    { playedAt: at(2, 5), title: 'C', artist: 'Z', album: 'Three', duration: 300 },
  ];
  const feb = monthDetail(rows, 2026, 1);
  assert.equal(feb.plays, 3);
  assert.equal(feb.seconds, 500);
  assert.equal(feb.tracks[0].title, 'A');
  assert.equal(feb.tracks[0].plays, 2);
  assert.deepEqual(feb.artists.map(a => a.name), ['X', 'Y']);
  assert.equal(monthDetail(rows, 2026, 0).plays, 0);
});
