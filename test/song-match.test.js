'use strict';
// Hive's copy of the phone's song matcher (app/main/song-match.js). The
// vectors are shared with Hive Mobile's TrackMatcherTest.kt so the two
// implementations can't drift apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, createIndex } = require('../app/main/song-match');
const vectors = require('./fixtures/song-match-vectors.json');

test('normalize agrees with the phone', () => {
  for (const [input, expected] of vectors.normalize) assert.equal(normalize(input), expected, input);
});

for (const c of vectors.cases) {
  test(`match: ${c.name}`, () => {
    const index = createIndex(c.candidates.map(([key, title, artist, albumArtist, durationMs]) => ({ key, title, artist, albumArtist, durationMs })));
    const [title, artist, albumArtist, durationMs] = c.query;
    assert.equal(index.match({ title, artist, albumArtist, durationMs })?.key ?? null, c.expect);
  });
}

test('a single and the same song on its album: the copy on the same album is matched (as on the phone)', () => {
  const { createIndex } = require('../app/main/song-match');
  const index = createIndex([
    { key: 'single', title: 'Music', artist: 'underscores', albumArtist: 'underscores', album: 'Music - Single', durationMs: 180000 },
    { key: 'album', title: 'Music', artist: 'underscores', albumArtist: 'underscores', album: 'U', durationMs: 180000 },
  ]);
  assert.equal(index.match({ title: 'Music', artist: 'underscores', durationMs: 180000, album: 'U' }).key, 'album');
  assert.equal(index.match({ title: 'Music', artist: 'underscores', durationMs: 180000, album: 'Music - Single' }).key, 'single');
  assert.ok(index.match({ title: 'Music', artist: 'underscores', durationMs: 180000 }));
});
