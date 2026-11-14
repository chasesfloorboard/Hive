'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  foldSearchText, normalizeForSearch, normalizeMusicText,
  normalizeArtistSearchValue, normalizeTypeaheadText, buildTrackSearchIndex,
} = require('../app/renderer/search-text');

test('foldSearchText lowercases, strips accents/ligatures/punctuation, and space-pads', () => {
  assert.equal(foldSearchText('Björk'), ' bjork ');
  assert.equal(foldSearchText('Mötley Crüe'), ' motley crue ');
  assert.equal(foldSearchText('Encyclopædia'), ' encyclopaedia ', 'æ -> ae');
  assert.equal(foldSearchText('Cœur'), ' coeur ', 'œ -> oe');
  assert.equal(foldSearchText('Mø'), ' mo ', 'ø -> o');
  assert.equal(foldSearchText('Straße'), ' strasse ', 'ß -> ss');
  assert.equal(foldSearchText('(It Goes Like) Nanana [Edit]'), ' it goes like nanana edit ');
  assert.equal(foldSearchText(''), '  ');
  assert.equal(foldSearchText(null), '  ');
});

test('normalizeForSearch folds to single-spaced [a-z0-9] words', () => {
  assert.equal(normalizeForSearch('Björk — Jóga (Remix!)'), 'bjork joga remix');
  assert.equal(normalizeForSearch('  A.B..C  '), 'a b c');
  assert.equal(normalizeForSearch(''), '');
});

test('normalizeMusicText is like normalizeForSearch without a final whitespace collapse', () => {
  assert.equal(normalizeMusicText('Café  del  Mar'), 'cafe del mar');
  assert.equal(normalizeMusicText(''), '');
});

test('normalizeArtistSearchValue trims, single-spaces and lowercases but keeps punctuation', () => {
  assert.equal(normalizeArtistSearchValue('  AC/DC  '), 'ac/dc');
  assert.equal(normalizeArtistSearchValue('Tyler,  The   Creator'), 'tyler, the creator');
});

test('normalizeTypeaheadText keeps Unicode letters, maps punctuation to spaces', () => {
  assert.equal(normalizeTypeaheadText('Café!!!  Tacvba'), 'café tacvba');
  assert.equal(normalizeTypeaheadText('a_b-c'), 'a b c');
});

test('buildTrackSearchIndex folds every tag value (recursing arrays/objects), skipping internals', () => {
  const idx = buildTrackSearchIndex({
    title: 'Jóga', artist: 'Björk', genres: ['Art Pop', 'Electronic'],
    extra: { label: 'One Little Indian' }, _searchText: 'IGNORED', covers: ['IGNORED'],
  });
  assert.match(idx, / joga /);
  assert.match(idx, / bjork /);
  assert.match(idx, / art pop /);
  assert.match(idx, / one little indian /);
  assert.doesNotMatch(idx, /ignored/, 'internal _searchText/covers fields are excluded');
  assert.equal(buildTrackSearchIndex(null), '  ');
});
