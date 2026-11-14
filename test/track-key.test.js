'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PLAY_COUNT_QUALIFY_MS, playCountTrackKey, wrapTrackKey } = require('../app/renderer/track-key');

test('PLAY_COUNT_QUALIFY_MS is the 5s play-count threshold', () => {
  assert.equal(PLAY_COUNT_QUALIFY_MS, 5000);
});

test('playCountTrackKey prefers the local path, then stream URI/URL, else empty', () => {
  assert.equal(playCountTrackKey({ path: '/m/a.flac', spotifyUri: 'spotify:track:x' }), '/m/a.flac');
  assert.equal(playCountTrackKey({ spotifyUri: 'spotify:track:x' }), 'spotify:track:x');
  assert.equal(playCountTrackKey({ streamUrl: 'http://pc/stream?id=1' }), 'http://pc/stream?id=1');
  assert.equal(playCountTrackKey({}), '');
  assert.equal(playCountTrackKey(null), '');
  assert.equal(playCountTrackKey(undefined), '');
  // non-string coerces
  assert.equal(playCountTrackKey({ path: 42 }), '42');
});

test('wrapTrackKey joins the richer identity fields with | and coerces blanks', () => {
  assert.equal(wrapTrackKey({ path: '/a', title: 'T', artist: 'A', album: 'Al' }), '/a|||T|A|Al');
  assert.equal(wrapTrackKey({}), '|||||');
  assert.equal(wrapTrackKey(null), '|||||');
  // two different tracks must not collide
  assert.notEqual(
    wrapTrackKey({ path: '/a', title: 'One' }),
    wrapTrackKey({ path: '/a', title: 'Two' }),
  );
});
