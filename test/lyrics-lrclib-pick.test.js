'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickLrcLibCandidate } = require('../app/main/lrclib-pick');

const c = (o) => ({ artistName: 'Sampha', duration: 316, syncedLyrics: '', plainLyrics: 'words', instrumental: false, ...o });

test('LRCLIB fuzzy search picks the same artist within the length tolerance, synced first', () => {
  const list = [c({ id: 1 }), c({ id: 2, syncedLyrics: '[00:01.00] hi', duration: 318 }), c({ id: 3, artistName: 'Someone Else', syncedLyrics: '[00:01.00] x' })];
  assert.equal(pickLrcLibCandidate(list, { artist: 'Sampha', duration: 316 }).id, 2);
});

test('LRCLIB fuzzy search rejects other lengths, other artists and instrumentals', () => {
  assert.equal(pickLrcLibCandidate([c({ duration: 200 })], { artist: 'Sampha', duration: 316 }), null);
  assert.equal(pickLrcLibCandidate([c({ artistName: 'Nobody' })], { artist: 'Sampha', duration: 316 }), null);
  assert.equal(pickLrcLibCandidate([c({ instrumental: true })], { artist: 'Sampha', duration: 316 }), null);
});

test('LRCLIB fuzzy search tolerates accents and "feat." credits in the artist', () => {
  assert.equal(pickLrcLibCandidate([c({ id: 9, artistName: 'Beyoncé feat. JAY-Z' })], { artist: 'Beyonce', duration: 0 }).id, 9);
});
