'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

test('album playback always derives canonical album track order before entering the queue', () => {
  assert.match(source, /function albumTracksForPlayback\(album\)\s*\{[\s\S]*?Number\(a\?\.disk\)[\s\S]*?Number\(a\?\.track\)[\s\S]*?songCollator\.compare/);
  assert.match(source, /function playAlbum\(album\)\s*\{[\s\S]*?const tracks = albumTracksForPlayback\(album\);[\s\S]*?playQueue\(tracks, 0, true\);/);
});

test('album playback uses only the actual player Shuffle state, never sidebar visual shuffle', () => {
  const blockStart = source.indexOf('function playAlbum(album)');
  const blockEnd = source.indexOf('function playQueue(', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  const block = source.slice(blockStart, blockEnd);
  assert.doesNotMatch(block, /shuffleOnEnter|visualShuffleTracks|visualShuffleOrders/);
  assert.match(block, /playQueue\(tracks, 0, true\)/);
});

test('album context menu and album-card playback routes all use isolated album playback', () => {
  assert.match(source, /\{label:'Play album',(?: icon:'play',)? action:\(\)=>playAlbum\(album\)\}/);
  assert.match(source, /if \(m\?\.tracks\?\.length\) playAlbum\(m\);/);
  assert.match(source, /if\(m\?\.tracks\?\.length\)playAlbum\(m\);/);
  assert.doesNotMatch(source, /playQueue\(album\.tracks,\s*0\)/);
  assert.doesNotMatch(source, /playQueue\(m\.tracks,\s*0\)/);
});

test('album and artist searches clear the originating collection visual permutation', () => {
  const albumSearch = source.slice(source.indexOf('function showAlbumFromTrack'), source.indexOf('function restoreAlbumSearchContext'));
  const artistSearch = source.slice(source.indexOf('function searchForArtist'), source.indexOf('let autoTagAlbumModal'));
  assert.match(albumSearch, /visualShuffleOrders\.delete\(visualShuffleKeyForSidebar\(sourceNav\)\)/);
  assert.match(artistSearch, /visualShuffleOrders\.delete\(visualShuffleKeyForSidebar\(sourceNav\)\)/);
});

test('searching an artist from within a playlist/Favorites view actually shows the artist filter, not the unfiltered playlist', () => {
  // Real bug, confirmed: searchForArtist used to keep specialView ===
  // 'playlist' active whenever activePlaylistId was set (keepPlaylistContext).
  // setView('albums') has an early-return branch specifically for
  // specialView === 'playlist' that just re-renders THAT playlist's own
  // tracks and never reaches the renderAlbums() call that applies
  // artistSearchTerm -- so right-clicking a track inside a playlist (this
  // includes Favorites, which is a playlist) and choosing "Search artist"
  // silently did nothing, leaving the playlist's own tracks on screen
  // instead of the artist-filtered album view. artistSearchReturnState
  // (captured just above in the same function) already remembers the
  // playlist/specialView for the Back button to restore, so specialView
  // must unconditionally clear here for the actual search to render.
  const start = source.indexOf('function searchForArtist(value, sourceTrack = null) {');
  const end = source.indexOf('\n  }\n\n  let autoTagAlbumModal', start);
  assert.ok(start >= 0 && end > start, 'searchForArtist must exist');
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /keepPlaylistContext/);
  assert.match(block, /specialView = null;/);
  assert.match(block, /setView\('albums'\);/);
  // Restoring on Back must still work: it reads its own saved copy, not the
  // live specialView this function just cleared.
  const restoreStart = source.indexOf('function restoreArtistSearchContext()');
  const restoreBlock = source.slice(restoreStart, restoreStart + 800);
  assert.match(restoreBlock, /specialView = saved\.specialView \|\| null;/);
  assert.match(restoreBlock, /activePlaylistId = saved\.activePlaylistId \?\? null;/);
});

test('the Years toggle stays visible for an artist search but defaults off, and never shows for Tracks/Artists', () => {
  const start = source.indexOf('function searchForArtist(value, sourceTrack = null) {');
  const end = source.indexOf('\n  }\n\n  let autoTagAlbumModal', start);
  const block = source.slice(start, end);
  // Defaults off every time a search starts; artistSearchReturnState (saved
  // just above in this same function) already keeps the pre-search value for
  // the Back button, so this doesn't lose the user's normal Albums setting.
  assert.match(block, /albumYearDividers = false;/);

  for (const fn of ['function setView(mode) {', 'function syncTabControls() {']) {
    const fnStart = source.indexOf(fn);
    assert.ok(fnStart >= 0, `expected to find ${fn}`);
    const fnBlock = source.slice(fnStart, fnStart + 600);
    assert.match(fnBlock, /const yearsVisible = (?:mode|viewMode) === 'albums' && specialView !== 'yearly-wrap'/, fn);
    assert.doesNotMatch(fnBlock, /!artistSearchTerm/, fn);
  }
});

// Right-clicking one of several Ctrl/Shift-selected albums used to silently
// collapse the selection down to just that one album (showAlbumContextMenu
// unconditionally rebuilt the song selection from only the clicked album's
// tracks). It must instead act on every selected album's tracks -- the same
// precedent beginAlbumDrag already established for drag-and-drop
// (selectedAlbumKeys.has(album.key) ? selectedAlbumModelsInOrder() : [album]).
test('right-clicking a selected album acts on every selected album, not just the clicked one', () => {
  const start = source.indexOf('async function showAlbumContextMenu(e, album)');
  const end = source.indexOf('\n\n  // click = preview panel', start);
  assert.ok(start >= 0 && end > start, 'showAlbumContextMenu must exist');
  const block = source.slice(start, end);
  assert.match(block, /const bulk = selectedAlbumKeys\.has\(String\(album\.key\)\);/);
  assert.match(block, /const albums = bulk \? selectedAlbumModelsInOrder\(\) : \[album\];/);
  // A previously-selected multi-album set must not be destroyed by the
  // right-click the way the single-album path still intentionally does.
  const bulkBranch = block.slice(block.indexOf('if (!bulk) {'), block.indexOf('const playlistContext'));
  assert.match(bulkBranch, /clearSongSelection\(\);/, 'the non-bulk branch must still replace the selection with just the clicked album');
  assert.doesNotMatch(bulkBranch.slice(bulkBranch.indexOf('} else {')), /clearSongSelection\(\)/, 'the bulk branch must not clear the existing album selection');
});

test('the album context menu adds Add to queue and a Rating/Love submenu that apply to every selected album, matching the track-row context menu convention', () => {
  const start = source.indexOf('async function showAlbumContextMenu(e, album)');
  const end = source.indexOf('\n\n  // click = preview panel', start);
  const block = source.slice(start, end);
  assert.match(block, /label:`Add to queue\$\{countLabel\}`, icon:'queue', action:\(\)=>addTracksToQueue\(albumTracks\)/);
  assert.match(block, /label:'Rating',icon:'star',submenu:\[/);
  assert.match(block, /action:\(\)=>applyLove\(true\)/);
  assert.match(block, /action:\(\)=>applyLove\(false\)/);
  assert.match(block, /action:\(\)=>applyRating\(5\)/);
  // Reuses the existing shared bulk helpers rather than duplicating
  // showTrackContextMenu's optimized selective-write Love logic.
  assert.match(block, /const applyRating = value => applyBulkRating\(albumTracks\.map\(t => t\.path\), value\);/);
  assert.match(block, /const applyLove = value => applyBulkTrackAction\(albumTracks, t => setTrackLove\(t, value, false\)\);/);
});

// Auto-tag, album/artist search, and single-album Play only make sense for
// one specific release; they must not appear when multiple different albums
// are selected (2+), but must still appear for a single selected album (a
// one-album Ctrl-click selection, or an unselected right-click).
test('single-album-only actions are hidden once more than one album is selected', () => {
  const start = source.indexOf('async function showAlbumContextMenu(e, album)');
  const end = source.indexOf('\n\n  // click = preview panel', start);
  const block = source.slice(start, end);
  assert.match(block, /bulk && albums\.length > 1 \? \[\] : \[\s*\{label:'Auto-tag album…'/);
  assert.match(block, /\{label:'Play album', icon:'play', action:\(\)=>playAlbum\(album\)\},\s*\]\)/);
});
