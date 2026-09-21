const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('Build 240 keeps Auto-tag single-target at the album context boundary', () => {
  const start = renderer.indexOf('async function openAutoTagAlbum');
  const end = renderer.indexOf('function showAlbumContextMenu', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /Array\.isArray\(album\)/);
  assert.match(block, /context action passes the one album/i);
  assert.match(renderer, /label:'Auto-tag album…', icon:'tag', action:\(\)=>openAutoTagAlbum\(album\)/);
});

// MusicBee's per-track right-click menu has "Auto-Tag by Album" near the
// bottom; Hive previously only exposed Auto-tag from the album context menu
// (showAlbumContextMenu), not from an individual track row. It must reuse
// the same single-target, album-scoped openAutoTagAlbum() entry point --
// built from every library track sharing the clicked track's album key --
// rather than duplicating the MusicBrainz-matching logic.
test('track context menu offers Auto-tag album, built from the clicked track\'s own album', () => {
  const start = renderer.indexOf('function showTrackContextMenu');
  const end = renderer.indexOf('function parseTimeValue', start);
  const block = renderer.slice(start, end);
  assert.match(block, /label:'Auto-tag album…', icon:'tag', action:\(\)=>\{/);
  assert.match(block, /const key = albumKey\(t\);/);
  assert.match(block, /library\.tracks\.filter\(track => albumKey\(track\) === key\)\.sort\(albumTrackCompare\)/);
  assert.match(block, /openAutoTagAlbum\(\{ title: t\.album, artist: t\.albumArtist \|\| t\.artist, tracks: albumTracks \}\)/);
});

// "Play Artist" and "Play Similar" were explicitly requested to sit under a
// "Play More" submenu (matching MusicBee's layout), single-track only (a
// bulk selection has no one artist to build either action from).
test('track context menu offers Play Artist and Play Similar under a Play More submenu', () => {
  const start = renderer.indexOf('function showTrackContextMenu');
  const end = renderer.indexOf('function parseTimeValue', start);
  const block = renderer.slice(start, end);
  assert.match(block, /isLocal && !bulk && t\.artist \? \[\{label:'Play More',icon:'play',submenu:\[/);
  assert.match(block, /action:\(\)=>playArtistShuffled\(t\.artist\)/);
  assert.match(block, /action:\(\)=>playSimilarArtist\(t\.artist\)/);
});

test('playArtistShuffled and playSimilarArtist use the shared shuffle-play pipeline, not a second transport', () => {
  const artistStart = renderer.indexOf('function playArtistShuffled(artistName)');
  const artistEnd = renderer.indexOf('\n  }', artistStart);
  const artistBlock = renderer.slice(artistStart, artistEnd);
  assert.match(artistBlock, /library\.tracks\.filter\(t => String\(t\?\.artist \|\| ''\)\.trim\(\)\.toLowerCase\(\) === name\)/);
  assert.match(artistBlock, /playQueue\(shuffleForPlayback\(tracks\), 0, false\)/);

  const similarStart = renderer.indexOf('async function playSimilarArtist(artistName)');
  const similarEnd = renderer.indexOf('\n  }', similarStart);
  const similarBlock = renderer.slice(similarStart, similarEnd);
  assert.match(similarBlock, /window\.beehive\.getSimilarArtists\(name\)/);
  assert.match(similarBlock, /playQueue\(shuffleForPlayback\(matches\), 0, false\)/);
  // Only artists Last.fm actually returns AND that exist locally are ever
  // queued -- no invented "similar" fallback when Last.fm has nothing.
  assert.match(similarBlock, /None of Last\.fm's similar artists for \$\{name\} were found in your library\./);
});

test('Build 240 gives track context actions the same existing Hive icon language', () => {
  const start = renderer.indexOf('function showTrackContextMenu');
  const end = renderer.indexOf('function parseTimeValue', start);
  const block = renderer.slice(start, end);
  for (const icon of ['play', 'queue', 'plus', 'search', 'edit']) assert.match(block, new RegExp(`icon:'${icon}'`));
});

test('Build 240 established context-menu alignment, updated to the canonical left-aligned layout in Build 242', () => {
  assert.match(css, /\.context-item \{[\s\S]*?justify-content:flex-start;[\s\S]*?text-align:left;/);
  assert.match(css, /\.context-add-to \.context-submenu \.context-item \{[\s\S]*?justify-content:flex-start;[\s\S]*?text-align:left;/);
});

test('Build 240 applies frosted glass to the root and nested context menus', () => {
  assert.match(css, /#context-menu, \.context-submenu \{[\s\S]*?backdrop-filter:blur\(var\(--blur\)\) saturate\(140%\);/);
  assert.match(css, /#context-menu, \.context-submenu \{[\s\S]*?-webkit-backdrop-filter:blur\(var\(--blur\)\) saturate\(140%\);/);
  const rating = css.slice(css.indexOf('.context-submenu-wrap:has(.context-rating-item) > .context-submenu {'), css.indexOf('.context-submenu-wrap:has(.context-rating-item) > .context-submenu-trigger'));
  assert.match(rating, /background:color-mix\(in srgb,var\(--accent\) 7%,var\(--panel\)\)/);
  assert.match(rating, /backdrop-filter:blur\(var\(--blur\)\) saturate\(140%\)/);
});

test('album and track context menus never await Android device discovery', () => {
  // refreshAndroidDevices() round-trips to the main process, which shells out
  // to `gio mount -li` with up to a 5s timeout. Awaiting it before opening the
  // menu made every right-click feel unresponsive whenever no Android device
  // was already known (the common case). It must be fired-and-forgotten, the
  // same way the Settings > Devices tab already refreshes in the background.
  const albumStart = renderer.indexOf('async function showAlbumContextMenu');
  const albumEnd = renderer.indexOf('\n  }', albumStart);
  const albumBlock = renderer.slice(albumStart, albumEnd);
  assert.doesNotMatch(albumBlock, /await refreshAndroidDevices\(\)/);
  assert.match(albumBlock, /void refreshAndroidDevices\(\)/);

  const trackStart = renderer.indexOf('async function showTrackContextMenu');
  const trackEnd = renderer.indexOf('function parseTimeValue', trackStart);
  const trackBlock = renderer.slice(trackStart, trackEnd);
  assert.doesNotMatch(trackBlock, /await refreshAndroidDevices\(\)/);
  assert.match(trackBlock, /void refreshAndroidDevices\(\)/);
});
