'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');

test('Tracks view starts every new column in natural ascending order', () => {
  const blockStart = renderer.indexOf('function bindSongHeader()');
  const blockEnd = renderer.indexOf('function renderSpecialAlbums(', blockStart);
  const block = renderer.slice(blockStart, blockEnd);
  assert.match(block, /songSort\.dir = 1;/);
});

test('Tracks view declares Plays and Length as numeric sort fields', () => {
  const blockStart = renderer.indexOf('function sortTracks(tracks)');
  const blockEnd = renderer.indexOf('function songHeader()', blockStart);
  const block = renderer.slice(blockStart, blockEnd);
  assert.match(block, /const def = songColumnDef\(key\);/);
  assert.match(block, /def\.type === 'number'/);
  assert.match(block, /Number\(sortValue\(a\)\)/);
});

test('Tracks view uses deterministic metadata tie-breakers for numeric sorts', () => {
  const blockStart = renderer.indexOf('function sortTracks(tracks)');
  const blockEnd = renderer.indexOf('function songHeader()', blockStart);
  const block = renderer.slice(blockStart, blockEnd);
  assert.match(block, /const title = songCollator\.compare/);
  assert.match(block, /songCollator\.compare/);
});

test('Tracks view aligns the Plays stat to the left like the other metadata columns', () => {
  const match = css.match(/\.song-row \.s-plays[^\{]*\{([^}]*)\}/);
  assert.ok(match, 'Plays row styling must exist');
  assert.match(match[1], /text-align:\s*left/);
  assert.doesNotMatch(match[1], /text-align:\s*right/);
});

test('Tracks view keeps Length right-aligned while Plays is left-aligned', () => {
  const match = css.match(/\.song-row \.s-plays[^\{]*\{([^}]*)\}/);
  assert.ok(match);
  assert.match(match[1], /text-align:\s*left/);
  const lengthMatch = css.match(/\.song-row \.s-dur[^\{]*\{([^}]*)\}/);
  assert.ok(lengthMatch);
  assert.match(lengthMatch[1], /text-align:\s*right/);
});
