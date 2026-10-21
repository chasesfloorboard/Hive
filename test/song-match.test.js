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
