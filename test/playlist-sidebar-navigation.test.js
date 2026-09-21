'use strict';
// Canonical, stable home for playlist-sidebar navigation/presentation tests:
// how Favorites and user playlists are represented in the sidebar, how
// clicking/pinning them opens Music tabs, and how Playlist Info edits
// propagate back to that presentation. Edit this file in place when this
// architecture legitimately changes.
//
// This consolidates ~13 previously-separate buildNNN-*.test.js files that
// were nominally about "Favorites" but were mostly about playlist-sidebar
// navigation/tab plumbing, not Love metadata itself (see
// test/love-metadata.test.js for that). See CHANGELOG.md builds
// 146/154/165/166/172/185/186/191/194/212/213 for the history.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/renderer/../main/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');

function block(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `missing block start: ${startNeedle}`);
  assert.ok(end >= 0, `missing block end: ${endNeedle}`);
  return source.slice(start, end);
}

// --- Favorites as a canonical, uncapped autoplaylist ---

test('Favorites is represented by one canonical autoplaylist sidebar entry, not a special sidebar navigation entry', () => {
  assert.doesNotMatch(renderer, /\{\s*id:'pl-favorites',\s*type:'playlist'/);
  assert.match(renderer, /function migrateFavoritesSidebarToCanonicalPlaylist/);
  assert.match(renderer, /playlistId: canonicalId/);
  assert.match(renderer, /FAVORITES_SIDEBAR_MIGRATION_KEY/);
});

test('Favorites remains a normal editable autoplaylist while preserving its canonical identity', () => {
  const b = block(main, 'async function ensureStarFavoritesPlaylist', "ipcMain.handle('playlists:get'");
  assert.match(b, /rules: Array\.isArray\(canonical\.rules\).*canonical\.rules/);
  assert.match(b, /deduped/);
  assert.match(b, /name: 'Favorites'/);
  assert.match(b, /systemKey: 'star-favorites'/);
});

test('Star Favorites is never capped at 5000 tracks', () => {
  const b = main.slice(main.indexOf('const STAR_FAVORITES_PLAYLIST_ID'), main.indexOf('function parseM3UEntries'));
  assert.match(b, /systemKey:\s*['"]star-favorites['"]/);
  assert.doesNotMatch(b, /limit:\s*5000/);
  const evaluator = block(renderer, 'function evaluateSmartPlaylist(pl)', 'function normalizePlaylistPath');
  assert.match(evaluator, /star-favorites/);
  assert.match(evaluator, /Infinity/);
});

test('canonical Favorites cannot collapse Loved tracks by artist or album', () => {
  const evaluator = block(renderer, 'function evaluateSmartPlaylist(pl)', 'function normalizePlaylistPath');
  assert.match(evaluator, /const isStarFavorites\s*=\s*pl\?\.systemKey\s*===\s*['"]star-favorites['"]/);
  assert.match(evaluator, /if\s*\(!isStarFavorites\)/);
  assert.doesNotMatch(evaluator, /if\s*\(selectBy==='track'\s*&&\s*Number\.isFinite\(limit\)\)/);
  assert.match(evaluator, /if\s*\(pl\.filterDuplicates\)\s*out=smartDeduplicate\(out\)/);
  assert.match(evaluator, /const limit=isStarFavorites\s*\|\|\s*!hasLimit\s*\?\s*Infinity/);
});

// --- Favorite-added timestamps ---

test('Favorites # sorting uses the time each track was added to Favorites', () => {
  assert.match(renderer, /function favoriteAddedAtForTrack\(pl, track\)/);
  assert.match(renderer, /favoriteAddedAtForTrack\(pl, a\)/);
  assert.match(renderer, /favoriteAddedAtForTrack\(pl, b\)/);
  assert.match(renderer, /key === 'position' && specialView === 'playlist' && activePlaylistId/);
  assert.match(renderer, /favoriteAddedAtForTrack\(pl, a\)[\s\S]*?favoriteAddedAtForTrack\(pl, b\)[\s\S]*?songSort\.dir/);
});

test('Favorite timestamps are persisted on the Star Favorites playlist and survive playlist saves', () => {
  assert.match(main, /favoriteAddedAt/);
  assert.match(main, /existing\?\.favoriteAddedAt/);
  assert.match(main, /favoriteAddedAt,\s*\n/);
  assert.match(renderer, /starPlaylist\.favoriteAddedAt.*Date\.now\(\)/s);
  assert.match(renderer, /queueFavoriteTimestampSave\(starPlaylist\)/);
});

test('Unloving removes the favorite-added timestamp so re-loving creates a new favorite date', () => {
  assert.match(renderer, /if \(value\) starPlaylist\.favoriteAddedAt\[String\(t\.path\)\] = Date\.now\(\);/);
  assert.match(renderer, /else delete starPlaylist\.favoriteAddedAt\[String\(t\.path\)\];/);
});

test('Favorite timestamp saves are serialized so rapid Love clicks cannot overwrite one another', () => {
  assert.match(renderer, /favoriteTimestampSaveQueue\s*=\s*Promise\.resolve\(\)/);
  assert.match(renderer, /favoriteTimestampSaveQueue\s*=\s*favoriteTimestampSaveQueue\.catch/);
  assert.match(renderer, /queueFavoriteTimestampSave\(starPlaylist\)/);
});

// --- Sidebar -> Music-tab navigation for playlists (Favorites included) ---

test('Clicking a playlist opens a new independent Music tab using the same playlist id', () => {
  assert.match(renderer, /function openPlaylistInNewMusicTab\(pl\)/);
  const clickStart = renderer.indexOf("row.addEventListener('click',async()=>{", renderer.indexOf('function renderPlaylistManager'));
  const dbl = renderer.indexOf("row.addEventListener('dblclick'", clickStart);
  assert.ok(clickStart >= 0 && dbl > clickStart);
  const clickBlock = renderer.slice(clickStart, dbl);
  assert.match(clickBlock, /openPlaylistInNewMusicTab\(pl\)/);
  assert.match(renderer, /specialView: 'playlist'/);
  assert.match(renderer, /activePlaylistId: pl\.id/);
});

test('Sidebar playlist activation opens the canonical playlist object in a reusable Music tab', () => {
  const b = block(renderer, 'function openPlaylistFromSidebar', '  async function showSpecialNavigation');
  assert.match(b, /openOrReusePlaylistMusicTab\(pl\)/);
  assert.doesNotMatch(b, /sidebar-favorites/);
});

test('Favorites sidebar opens one canonical reusable music tab', () => {
  const sidebar = block(renderer, 'async function openPlaylistFromSidebar(pl, navId)', 'async function showSpecialNavigation(nav)');
  assert.match(sidebar, /openOrReusePlaylistMusicTab\(pl\)/);
  assert.match(renderer, /function openOrReusePlaylistMusicTab\(pl\)/);
  assert.match(renderer, /t\.kind === 'music' && String\(t\.state\?\.activePlaylistId \|\| ''\)/);
  assert.match(renderer, /systemKey\s*===\s*['"]star-favorites['"][\s\S]*playlistLabel\(pl\)/);
});

test('Custom playlist sidebar double-click plays the canonical playlist', () => {
  const b = block(renderer, 'function renderSidebarNavigation()', 'async function renameSidebarEntry');
  assert.match(b, /if \(def\.type === 'playlist'\)/);
  assert.match(b, /await playPlaylist\(pl\)/);
  assert.match(renderer, /async function playPlaylist\(pl\)/);
});

test('Opening a custom playlist keeps the clicked sidebar destination selected', () => {
  const helper = block(renderer, 'async function openPlaylistFromSidebar(pl, navId)', 'async function showSpecialNavigation(nav)');
  assert.match(helper, /item\.dataset\.nav === String\(navId \|\| ''\)/);
  assert.match(helper, /classList\.toggle\('active'/);
  assert.match(helper, /openOrReusePlaylistMusicTab\(pl\)/);
});

test('Playlist sidebar navigation opens the playlist viewer rather than the Playlists manager', () => {
  const b = block(renderer, 'function renderSidebarNavigation', 'async function renameSidebarEntry');
  assert.match(b, /if \(def\.type === 'playlist'\)/);
  assert.match(b, /return openPlaylistFromSidebar\(pl, nav\)/);
});

test('Legacy Favorites navigation also resolves to the canonical playlist viewer', () => {
  const b = block(renderer, "if(nav==='pl-favorites')", "if(nav==='pl-explorer')");
  assert.match(b, /const pl = starFavoritesPlaylist\(\)/);
  assert.match(b, /openPlaylistFromSidebar\(pl, nav\)/);
});

// --- Pinned playlist tabs ---

test('Pinned playlist tabs open their playlist state instead of falling through to the Playlists manager', () => {
  const start = renderer.indexOf("el.topbarTabs.addEventListener('click'");
  const end = renderer.indexOf("el.tabAddBtn.addEventListener('click'", start);
  assert.ok(start >= 0 && end > start);
  const b = renderer.slice(start, end);
  assert.match(b, /tab\?\.kind === 'music'/);
  assert.match(b, /entry\?\.type === 'playlist'/);
  assert.match(b, /entry\.playlistId/);
  assert.match(b, /preparePlaylistMusicTab\(tab, pl\)/);
  assert.match(b, /renderCurrentView\(\)/);
  assert.doesNotMatch(b, /openOrReusePlaylistMusicTab\(pl\)/);
});

test('Pinned playlist tabs use the saved playlist icon and label', () => {
  assert.match(renderer, /function preparePlaylistMusicTab\(tab, pl\)/);
  const helper = renderer.slice(renderer.indexOf('function preparePlaylistMusicTab'), renderer.indexOf('function openOrReusePlaylistMusicTab'));
  assert.match(helper, /tab\.baseLabel = playlistLabel\(pl\)/);
  assert.match(helper, /tab\.baseIcon = String\(pl\.icon/);
});

test('Pinned playlist tabs are normalized to their playlist browser before activation', () => {
  assert.match(renderer, /function preparePlaylistMusicTab\(tab, pl\)/);
  const start = renderer.indexOf('function switchTab');
  const end = renderer.indexOf('function closeTab', start);
  const b = renderer.slice(start, end);
  assert.match(b, /entry\?\.type === 'playlist'/);
  assert.match(b, /preparePlaylistMusicTab\(tab, pl\)/);
  assert.match(b, /renderCurrentView\(\)/);
});

test('User-added sidebar playlists can be pinned to the top bar and persist', () => {
  const navigation = block(renderer, 'function syncPinnedTabs()', 'function syncMpris(');
  assert.match(navigation, /sidebarEntry\(id\)/);
  assert.match(renderer, /saved\.pinned\.filter\(id => validIds\.includes\(id\)\)/);
  assert.match(renderer, /pinnedTabId\(nav\)/);
  const editors = block(renderer, 'function renderNavigationEditors()', '// ---------------- settings modal tabs ----------------');
  assert.match(editors, /d\.type===['"]playlist['"]/);
  assert.match(editors, /Pin to top bar|Unpin/);
  assert.match(editors, /sidebarNavigation\.pinned/);
  assert.match(editors, /syncPinnedTabs\(\)/);
  assert.match(editors, /saveNavigationPrefs\(\)/);
});

// --- Sidebar presentation (label/icon) derivation and persistence ---

test('playlist sidebar presentation derives from the persisted playlist record', () => {
  assert.match(renderer, /function sidebarPlaylistForEntry\(id\)/);
  assert.match(renderer, /function syncPlaylistSidebarPresentation\(\)/);
  assert.match(renderer, /custom\?\.type === 'playlist'/);
  assert.match(renderer, /return playlistLabel\(sidebarPlaylistForEntry\(id\)\)/);
  assert.match(renderer, /return String\(pl\?\.icon \|\| custom\.icon \|\| ''\)/);
});

test('Favorites migration prefers canonical persisted presentation over stale sidebar copies', () => {
  const start = renderer.indexOf('function migrateFavoritesSidebarToCanonicalPlaylist');
  const end = renderer.indexOf('function sidebarMetaKey', start);
  const b = renderer.slice(start, end);
  assert.match(b, /typeof favorites\.label === 'string'/);
  assert.match(b, /typeof favorites\.icon === 'string'/);
  assert.match(b, /const nextLabel = \(typeof favorites\.label/);
  assert.match(b, /const nextIcon = \(typeof favorites\.icon/);
});

test('Favorites recovers a rich sidebar label when its playlist record is still plain', () => {
  assert.match(renderer, /playlistIsDefault = !playlistLabel \|\| playlistLabel === 'Favorites'/);
  assert.match(renderer, /projectionIsRich = \/<span\\b\[\^>\]\*class=/);
  assert.match(renderer, /window\.beehive\.savePlaylist\(\{ \.\.\.favorites, label: projectedLabel \}\)/);
});

test('recovered Favorites presentation becomes the canonical playlist label', () => {
  const start = renderer.indexOf('function migrateFavoritesSidebarToCanonicalPlaylist()');
  const end = renderer.indexOf('function sidebarLabel(id)', start);
  const b = renderer.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(b, /favorites\.label = projectedLabel/);
  assert.match(b, /const nextLabel = \(typeof favorites\.label === 'string'/);
});

// --- Playlist Info save propagates to sidebar/tab presentation ---

test('Playlist Info save synchronizes sidebar presentation and persists UI state immediately', () => {
  const start = renderer.indexOf('async function savePlaylistInfoChanges');
  const end = renderer.indexOf('function showPlaylistContextMenu', start);
  const b = renderer.slice(start, end);
  assert.match(b, /sidebarNavigation\.custom = sidebarNavigation\.custom\.map/);
  assert.match(b, /syncPlaylistSidebarPresentation\(\)/);
  assert.match(b, /await window\.beehive\.saveUiState\?\.\(serializeUiState\(\)\)/);
});

test('Playlist Info save rebuilds pinned navigation projections after a live playlist edit', () => {
  const b = block(renderer, 'async function savePlaylistInfoChanges()', 'function duplicatePlaylistName');
  assert.match(b, /refreshPlaylistTabPresentation\(updated\)/);
  assert.match(b, /syncPinnedTabs\(\)/);
  assert.match(b, /renderSidebarNavigation\(\)/);
});

test('Playlist Info has a professional structured editor and a live preview surface', () => {
  assert.match(html, /playlist-info-header/);
  assert.match(renderer, /playlist-info-stat-grid/);
  assert.match(html, /playlist-info-appearance/);
  assert.match(html, /playlist-info-live-preview/);
  assert.match(html, /playlist-info-label-html/);
  assert.match(renderer, /playlistInfoLabelPreview.*innerHTML|setRichLabel\(.*playlistInfoLabelPreview/s);
  const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
  assert.match(css, /\.playlist-info-modal\s*\{[\s\S]*?width:min\(700px/);
  assert.match(css, /\.playlist-info-live-preview/);
});

test('Playlist Info title uses rendered label text rather than exposing raw HTML markup', () => {
  assert.match(renderer, /richLabelText\(.*name/);
  assert.doesNotMatch(renderer, /playlistInfoTitle\.textContent=pl\.name\|\|'Untitled Playlist'/);
});

// --- The old "Colored Now Playing background" setting the sidebar work touched in passing ---

test('Colored Now Playing background remains user-toggleable while the duplicate frosted control stays removed', () => {
  assert.match(html, /id="setting-playbar-now-playing-bg"/);
  assert.match(renderer, /const PLAYBAR_NOW_PLAYING_BG_KEY/);
  assert.match(renderer, /function setPlaybarNowPlayingBg\(enabled\)/);
  assert.match(renderer, /localStorage\.setItem\(PLAYBAR_NOW_PLAYING_BG_KEY/);
});

// --- Favorites pipeline diagnostics (dedup of build212's/build213's near-identical scan-hook test) ---

test('the Favorites pipeline diagnostic logs full pipeline counts without changing membership', () => {
  const start = renderer.indexOf('function logFavoritesPipelineDiagnostics');
  const end = renderer.indexOf('\n  function ', start + 10);
  assert.ok(start >= 0, 'Favorites pipeline diagnostic helper must exist');
  assert.ok(end > start, 'Favorites pipeline diagnostic helper must be bounded');
  const b = renderer.slice(start, end);
  for (const key of [
    'libraryTrackCount', 'libraryLovedCount', 'libraryUnhydratedLoveCount',
    'favoriteRuleMatchCount', 'favoriteEvaluatorCount', 'favoriteLimit',
    'favoriteSystemKey', 'favoriteRules'
  ]) assert.match(b, new RegExp(key));
  assert.match(b, /evaluateSmartPlaylist\(favorites\)/);
  assert.match(b, /console\.info\('\[Beehive\] FAVORITES PIPELINE DIAGNOSTIC'/);
  assert.match(renderer, /FAVORITES PIPELINE DIAGNOSTIC/);
});

test('the Favorites pipeline diagnostic runs from the shared scan-completion path, not a startup-only hook', () => {
  const scanStart = renderer.indexOf("startupMark('SCAN RESULT APPLIED'");
  const baseline = renderer.indexOf('establishRecentlyAddedScanBaseline', scanStart);
  assert.ok(scanStart >= 0 && baseline > scanStart, 'shared scan completion block must exist');
  const b = renderer.slice(scanStart, baseline);
  assert.match(b, /await logFavoritesPipelineDiagnostics\(/);
  assert.doesNotMatch(renderer, /logFavoritesPipelineDiagnostics\('startup-scan-complete'\)/);
  assert.match(renderer, /libraryLovedNotMatchedPaths/);
  assert.match(renderer, /favoriteEvaluatorLostPaths/);
});

test('the Favorites pipeline diagnostic writes a dedicated report through preload IPC', () => {
  assert.match(preload, /writeFavoritesPipelineDiagnostic/);
  assert.match(preload, /diagnostics:writeFavoritesPipeline/);
  assert.match(main, /ipcMain\.handle\('diagnostics:writeFavoritesPipeline'/);
  assert.match(main, /favorites-pipeline-diagnostic-/);
  assert.match(main, /FAVORITES PIPELINE DIAGNOSTIC REPORT/);
});

test('playlist reads/writes are serialized so two near-simultaneous mutations cannot silently drop one', () => {
  // Real bug: playlists:save/playlists:delete/ensureStarFavoritesPlaylist each
  // independently did readJsonSafe(PLAYLISTS_PATH()) -> mutate -> writeJsonSafe
  // with no coordination. Two near-simultaneous calls -- even touching
  // different playlists entirely, e.g. renaming playlist A while a Favorites-
  // timestamp autosave for playlist B lands -- could each read the same
  // "before" snapshot; whichever writes last silently discards the other's
  // change. This exact class of bug was already fixed for play-stats.json
  // (withStatsMutation) but never applied to playlists.json.
  assert.match(main, /function withJsonFileLock\(filePath, fn\)/);

  const saveStart = main.indexOf("ipcMain.handle('playlists:save'");
  const saveEnd = main.indexOf("\n});", saveStart);
  assert.match(main.slice(saveStart, saveEnd), /withJsonFileLock\(PLAYLISTS_PATH\(\)/);

  const deleteStart = main.indexOf("ipcMain.handle('playlists:delete'");
  const deleteEnd = main.indexOf('\n}));', deleteStart);
  assert.match(main.slice(deleteStart, deleteEnd), /withJsonFileLock\(PLAYLISTS_PATH\(\)/);

  const ensureStart = main.indexOf('async function ensureStarFavoritesPlaylist()');
  const ensureEnd = main.indexOf('\n}', ensureStart);
  assert.match(main.slice(ensureStart, ensureEnd), /withJsonFileLock\(PLAYLISTS_PATH\(\)/);
});

test('podcast episodes added to a playlist are resolvable, not silently dropped', () => {
  // Real bug: a podcast episode's synthetic "podcast:<id>" path never
  // appears in libraryTrackByPath (podcasts aren't part of the scanned
  // library) or in a Spotify-style spotifyTracks snapshot. tracksForPlaylist
  // silently skipped any path it couldn't resolve, so adding an episode to a
  // playlist appeared to work but the episode vanished the next time the
  // playlist was opened. podcastEpisodes is a { path: track } snapshot,
  // mirroring how spotifyTracks already solves this for Spotify.
  assert.match(renderer, /function collectPodcastEpisodeSnapshots\(tracks\)/);
  const tfpStart = renderer.indexOf('function tracksForPlaylist(pl){');
  const tfpEnd = renderer.indexOf('\n  }', tfpStart);
  const tfp = renderer.slice(tfpStart, tfpEnd);
  assert.match(tfp, /podcastEpisodes/);
  assert.match(tfp, /libraryTrackByPath\.get\(key\) \|\| \(podcastEpisodes \? podcastEpisodes\[key\] : null\)/);

  // Main process must actually persist the field, the same way it already
  // persists spotifyTracks.
  const saveStart = main.indexOf("ipcMain.handle('playlists:save'");
  const saveEnd = main.indexOf('\n}));', saveStart);
  assert.match(main.slice(saveStart, saveEnd), /podcastEpisodes:/);
});

test('the track context menu hides file-only actions (rating, delete from disk, edit tags, reveal in browser) for non-local tracks', () => {
  // Real bug: right-clicking the now-playing bar while a podcast episode
  // was playing showed Rating/Love, "Show file in browser", "Delete file
  // from disk", and "Edit tags" -- all of which require a real local audio
  // file. Against a synthetic "podcast:<id>" path these either failed
  // silently or surfaced a confusing raw IPC error.
  const start = renderer.indexOf('async function showTrackContextMenu(x,y,t){');
  const end = renderer.indexOf('\n  function parseTimeValue', start);
  assert.ok(start >= 0 && end > start, 'expected to find showTrackContextMenu');
  const block = renderer.slice(start, end);
  assert.match(block, /const isLocal = isLocalPlaybackTrack\(t\);/);
  assert.match(block, /\.\.\.\(isLocal \? \[\{label:'Rating'/);
  assert.match(block, /\.\.\.\(isLocal \? \[\{label:'Show file in browser'/);
  assert.match(block, /\.\.\.\(isLocal \? \[\{label:bulk \? `Delete files from disk/);
  assert.match(block, /\.\.\.\(isLocal \? \[\{label:editLabel,icon:'edit'/);
  // Play/Queue/Add to/search must remain available for every track type,
  // podcast included -- this is not supposed to gate everything.
  assert.match(block, /\{label:'Play',icon:'play'/);
  assert.match(block, /\{label:'Add to',icon:'plus',submenu:buildAddToPlaylistSubmenu\(queueTracks\)\}/);
});

test('opening a favorited podcast show does not destroy the current search results', () => {
  // Real bug: clicking "Open" on a Podcast Favorites card replaced the
  // entire .podcast-results panel's innerHTML with just that one show,
  // silently discarding the user's current search and any other shows they
  // already had expanded.
  const start = renderer.indexOf("host.querySelectorAll('.podcast-favorite-open')");
  const end = renderer.indexOf("host.querySelectorAll('.podcast-favorite-remove')", start);
  assert.ok(start >= 0 && end > start, 'expected to find the Podcast Favorites open-button handler');
  const block = renderer.slice(start, end);
  assert.doesNotMatch(block, /results\.innerHTML\s*=\s*`<article/);
  assert.match(block, /results\.querySelector\(`\.podcast-card\[data-podcast-feed=/);
  assert.match(block, /results\.prepend\(target\)/);
});
