'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

test('Music view toggle has no artist release-date sort control', () => {
  assert.doesNotMatch(html, /id="artist-sort-btn"/);
  assert.doesNotMatch(html, /Sort: Release date/);
  assert.doesNotMatch(html, /id=\"album-sort-btn\"/);
  assert.doesNotMatch(source, /album-sort-btn/);
  assert.doesNotMatch(source, /artist-sort-btn/);
  assert.doesNotMatch(source, /artistSortTools/);
});

test('Music track header uses delegated sorting so draggable header cells cannot swallow sort clicks', () => {
  const start = source.indexOf('function bindSongHeader()');
  const end = source.indexOf('function renderSpecialAlbums(', start);
  const block = source.slice(start, end);
  assert.match(block, /table\.addEventListener\('click'/);
  assert.match(block, /closest\?\.\('\.song-header-btn'\)/);
  assert.match(block, /dataset\.sort/);
});


test('sortable header buttons cannot start column drag gestures', () => {
  const start = source.indexOf('function bindSongHeaderColumnReordering(');
  const end = source.indexOf('function bindSongHeader()', start);
  const block = source.slice(start, end);
  assert.match(block, /song-header-btn/);
  assert.match(block, /dragstart/);
  assert.match(block, /preventDefault\(\)/);
});

test('song column definitions declare semantic sort types and first click sorts naturally', () => {
  const start = source.indexOf('const SONG_COLUMN_DEFS = [');
  const end = source.indexOf('let songColumns = loadSongColumns();', start);
  const defs = source.slice(start, end);
  assert.match(defs, /key:'title',[\s\S]*type:'string'/);
  assert.match(defs, /key:'artist',[\s\S]*type:'string'/);
  assert.match(defs, /key:'album',[\s\S]*type:'string'/);
  assert.match(defs, /key:'plays',[\s\S]*type:'number'/);
  assert.match(defs, /key:'year',[\s\S]*type:'number'/);
  assert.match(defs, /key:'length',[\s\S]*type:'number'/);

  const bindStart = source.indexOf('function bindSongHeader()');
  const bindEnd = source.indexOf('function renderSpecialAlbums(', bindStart);
  const block = source.slice(bindStart, bindEnd);
  assert.match(block, /songSort\.dir = 1;/);
  assert.doesNotMatch(block, /songSort\.dir = \['plays','rating','length','year','track','disc','bitrate','sampleRate','dateAdded'\]\.includes\(key\) \? -1 : 1;/);
});

test('sort comparator uses declared column type so text is lexical and numeric fields are numeric', () => {
  const start = source.indexOf('function sortTracks(tracks)');
  const end = source.indexOf('function songHeader()', start);
  const block = source.slice(start, end);
  assert.match(block, /const def = songColumnDef\(key\);/);
  assert.match(block, /def\.type === 'number'/);
  assert.match(block, /Number\(sortValue\(a\)\)/);
  assert.match(block, /def\.type === 'string'/);
  assert.match(block, /songCollator\.compare/);
});


test('actual sortTracks implementation sorts text A-Z and Plays numerically low-to-high, then reverses', () => {
  const start = source.indexOf('function sortTracks(tracks)');
  const end = source.indexOf('function songHeader()', start);
  const fnSource = source.slice(start, end).match(/function sortTracks\(tracks\) \{[\s\S]*?\n  \}/)[0];
  const defs = {
    title: { type: 'string', sortGet: t => t.title },
    plays: { type: 'number', sortGet: t => t.playCount },
  };
  const context = {
    songSort: { key: 'title', dir: 1 },
    songColumnDef: key => defs[key],
    songCollator: new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' }),
  };
  vm.runInNewContext(`this.sortTracks = ${fnSource};`, context);
  const tracks = [
    { title: 'Zulu', playCount: 12, artist: 'A', album: 'A' },
    { title: 'alpha', playCount: 2, artist: 'B', album: 'B' },
    { title: 'Beta', playCount: 30, artist: 'C', album: 'C' },
  ];
  assert.deepEqual(Array.from(context.sortTracks(tracks), t => t.title), ['alpha', 'Beta', 'Zulu']);
  context.songSort.key = 'plays';
  context.songSort.dir = 1;
  assert.deepEqual(Array.from(context.sortTracks(tracks), t => t.playCount), [2, 12, 30]);
  context.songSort.dir = -1;
  assert.deepEqual(Array.from(context.sortTracks(tracks), t => t.playCount), [30, 12, 2]);
});

test('sort handler binding must not use cloneable DOM dataset state', () => {
  const start = source.indexOf('function bindSongHeader()');
  const end = source.indexOf('function renderSpecialAlbums(', start);
  const block = source.slice(start, end);
  assert.match(block, /table\.__beehiveSortHandlerBound/);
  assert.doesNotMatch(block, /el\.songsTable\.dataset\.sortHandlerBound/);
});

test('sort handler captures its own table node instead of the rebinding global element', () => {
  const start = source.indexOf('function bindSongHeader()');
  const end = source.indexOf('function renderSpecialAlbums(', start);
  const block = source.slice(start, end);
  assert.match(block, /const table = el\.songsTable;/);
  assert.match(block, /table\.addEventListener\('click'/);
  assert.match(block, /!table\.contains\(btn\)/);
  assert.doesNotMatch(block, /!el\.songsTable\.contains\(btn\)/);
});

test('manual column sorting explicitly overrides automatic sidebar/playlist visual shuffle', () => {
  const start = source.indexOf('function renderSpecialSongs(tracks)');
  const end = source.indexOf('function resetActiveMusicTabAlbum()', start);
  const block = source.slice(start, end);
  assert.match(block, /const manualSort = manualSongSortActive\(\);/);
  assert.match(block, /playlistVisualShuffleEnabled\(pl\) && !manualSort/);
  assert.match(block, /enabled && !manualSort/);
  assert.match(block, /: sortTracks\(ordered\)/);
});

test('automatic shuffle is reset when entering a sidebar destination so a later manual sort is not permanent', () => {
  const start = source.indexOf('function applySidebarAutoShuffle(key)');
  const end = source.indexOf('let uiStateSaveTimer', start);
  const block = source.slice(start, end);
  assert.match(block, /visualShuffleOrders\.delete\(visualShuffleKeyForSidebar\(key\)\)/);
  assert.match(block, /songSortOverrideContext = ''/);
});

test('header click records the current collection as the manual-sort override context', () => {
  const start = source.indexOf('function bindSongHeader()');
  const end = source.indexOf('function renderSpecialAlbums(', start);
  const block = source.slice(start, end);
  assert.match(block, /songSortOverrideContext = currentSongSortContextKey\(\);/);
  assert.match(block, /renderCurrentView\(\);/);
});
