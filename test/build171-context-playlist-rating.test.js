'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');

test('Build 171 exposes Add to submenu with New Playlist, Favorites, and writable user playlists', () => {
  assert.match(renderer, /function buildAddToPlaylistSubmenu\(tracks\)/);
  assert.match(renderer, /label:\s*'\+ New Playlist'/);
  assert.match(renderer, /starFavoritesPlaylist\(\)/);
  assert.match(renderer, /String\(pl\.source \|\| ''\)\.toLowerCase\(\) === 'spotify'/);
  assert.match(renderer, /label:'Add to',(?:icon:'plus',)?submenu:buildAddToPlaylistSubmenu\(queueTracks\)/);
  assert.match(renderer, /label:'Add to', (?:icon:'plus', )?submenu:buildAddToPlaylistSubmenu\(albumTracks\)/);
});

test('Build 171 Add to submenu creates a playlist or appends selected tracks without duplicates', () => {
  // podcastEpisodes is a snapshot of any podcast episodes in the added
  // tracks (see collectPodcastEpisodeSnapshots): a podcast episode's
  // synthetic "podcast:<id>" path never resolves through the local library
  // index, so without this snapshot, adding an episode to a playlist
  // silently dropped it the next time the playlist was opened.
  assert.match(renderer, /window\.beehive\.savePlaylist\(\{ name: name\.trim\(\), tracks: paths, podcastEpisodes: podcastEpisodeSnapshots, smart: false \}\)/);
  assert.match(renderer, /const merged = \[\.\.\.new Set\(\[\.\.\.existing, \.\.\.paths\]\)\];/);
  assert.match(renderer, /const mergedPodcastEpisodes = \{ \.\.\.\(pl\.podcastEpisodes \|\| \{\}\), \.\.\.podcastEpisodeSnapshots \};/);
  assert.match(renderer, /window\.beehive\.savePlaylist\(\{ \.\.\.pl, tracks: merged, podcastEpisodes: mergedPodcastEpisodes \}\)/);
});

test('Build 171 rating flyout is symbol-only and keeps explanatory hover text outside the choices', () => {
  assert.match(renderer, /context-rating-item/);
  assert.match(renderer, /context-rating-help/);
  assert.match(renderer, /context-rating-item.*aria-label/s);
  assert.doesNotMatch(renderer, /context-rating-label/);
  assert.match(css, /\.context-rating-help/);
  assert.match(css, /\.context-rating-item \{[\s\S]*?width:100%/);
});

test('the rating hover help text cannot overflow its own box', () => {
  // Real bug: .context-rating-help was pinned to left:0; right:0 -- forced
  // to exactly the narrow rating submenu's width -- combined with
  // white-space:nowrap and no overflow handling. Help text longer than that
  // width (e.g. "Set 3 selected tracks to 5 stars" for a bulk selection)
  // spilled past the box's own edges instead of staying contained.
  const start = css.indexOf('.context-rating-help {');
  const end = css.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'expected to find .context-rating-help');
  const block = css.slice(start, end);
  assert.doesNotMatch(block, /\bleft\s*:\s*0\s*;/);
  assert.doesNotMatch(block, /\bright\s*:\s*0\s*;/);
  assert.match(block, /white-space\s*:\s*normal\s*;/);
  assert.match(block, /max-width\s*:/);
});

test('Build 171 adds spacing between Rating and its submenu arrow', () => {
  assert.match(css, /\.context-submenu-trigger \{[\s\S]*?gap:\s*\d+px/);
  assert.match(css, /\.context-submenu-trigger \.context-arrow/);
});

// A bulk selection where every track is already Loved must still leave every
// track Loved when the user clicks "Love" in the Rating submenu -- it is a
// "make sure these are Loved" action, not a toggle that can unlove everything
// just because the selection happened to already be all-Loved. Bulk gets
// exactly one heart action, labeled with the track count, never a toggle and
// never a separate Remove-Love button; a single-track selection keeps its own
// toggle since there is no ambiguity there.
test('bulk Love context-menu action is a single "Love N tracks" button that always loves, never a toggle', () => {
  const start = renderer.indexOf("label:'Rating',icon:'star',submenu:[");
  const end = renderer.indexOf("{label:'5 stars'", start);
  assert.ok(start >= 0 && end > start, 'Rating submenu must be present');
  const block = renderer.slice(start, end);
  assert.match(block, /bulk \? \[/, 'bulk selections must branch to a distinct menu entry');
  assert.match(block, /label:`\$\{allLoved \? 'Loved' : 'Love'\} \$\{selected\.length\} tracks`/, 'bulk Love must be labeled with the track count');
  assert.match(block, /action:\(\)=>applyLove\(true\)/, 'bulk Love must always apply true, never toggle');
  assert.doesNotMatch(block, /label:'Remove Love'/, 'bulk must not expose a separate unlove button');
  assert.doesNotMatch(block, /applyLove\(bulk \? !allLoved/, 'bulk Love must not toggle off when the selection is already all-Loved');
});

// The album context menu (right-click an album or multi-selected albums)
// follows the same single-button convention as the track context menu.
test('album context menu Love button is also a single "Love N tracks" button, no Remove Love', () => {
  const start = renderer.indexOf("async function showAlbumContextMenu(e, album)");
  const end = renderer.indexOf("\n\n  // click = preview panel", start);
  assert.ok(start >= 0 && end > start, 'showAlbumContextMenu must exist');
  const block = renderer.slice(start, end);
  assert.match(block, /label:`\$\{allLoved \? 'Loved' : 'Love'\} \$\{albumTracks\.length\} tracks`/);
  assert.match(block, /icon:allLoved \? '♥' : '♡', loved:true, active:allLoved/);
  assert.doesNotMatch(block, /label:'Remove Love'/);
});

// setTrackRating used to await window.beehive.setRating() before touching any
// UI state. The write path waits for the currently-playing track's file to be
// released by the native player (see love-playback-safety.test.js), which
// only happens on a track change -- so rating the song you are actively
// listening to would leave the stars visually frozen until you skipped to
// another track. Rating must be optimistic like Love: update the model/stars
// immediately, write in the background, and roll back on failure.
test('setTrackRating and applyBulkRating update the UI optimistically instead of awaiting the disk write first', () => {
  const singleStart = renderer.indexOf('async function setTrackRating(');
  const singleEnd = renderer.indexOf('\n  // Apply a Love/rating command', singleStart);
  assert.ok(singleStart >= 0 && singleEnd > singleStart, 'setTrackRating must exist');
  const singleBlock = renderer.slice(singleStart, singleEnd);
  assert.doesNotMatch(singleBlock, /const value = await window\.beehive\.setRating/, 'must not block the model update on the IPC round trip');
  assert.match(singleBlock, /applyRatingToTrackModel\(t, value\)/);
  const applyIndex = singleBlock.indexOf('applyRatingToTrackModel(t, value)');
  const renderCallIndex = singleBlock.indexOf('renderRatingUi();');
  const queueIndex = singleBlock.indexOf('queueRatingFileWrite(');
  assert.ok(applyIndex >= 0 && renderCallIndex > applyIndex && queueIndex > renderCallIndex,
    'model update and UI render must happen before the background write is queued');
  assert.match(singleBlock, /queueRatingFileWrite\(t\.path, value\)\.catch/, 'the background write must be able to fail without blocking the UI');
  assert.match(singleBlock, /applyRatingToTrackModel\(t, oldValue\)/, 'a failed write must roll back the optimistic rating');

  const bulkStart = renderer.indexOf('async function applyBulkRating(');
  const bulkEnd = renderer.indexOf('\n\n\n  function bindRatingClicks', bulkStart);
  assert.ok(bulkStart >= 0 && bulkEnd > bulkStart, 'applyBulkRating must exist');
  const bulkBlock = renderer.slice(bulkStart, bulkEnd);
  const renderIndex = bulkBlock.indexOf('renderCurrentView();');
  const setTimeoutIndex = bulkBlock.indexOf('setTimeout(async () => {');
  assert.ok(renderIndex >= 0 && setTimeoutIndex > renderIndex, 'the model update and render must happen before the background write is scheduled');
  assert.match(bulkBlock, /setTimeout\(async \(\) => \{\s*const result = await window\.beehive\.setRatings/, 'the bulk write must be deferred to a background task');
});
