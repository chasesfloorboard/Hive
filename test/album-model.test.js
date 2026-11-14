'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { albumKey, mediaPositionNumber, albumTrackCompare, buildAlbums } = require('../app/renderer/album-model');

test('albumKey keys by albumArtist+album, or the Spotify album URI when present', () => {
  assert.equal(albumKey({ albumArtist: 'Björk', album: 'Homogenic' }), 'björk||homogenic');
  assert.equal(albumKey({ artist: 'A', album: 'B' }), 'a||b', 'falls back to artist');
  assert.equal(albumKey({ source: 'spotify', spotifyUri: 'x', albumUri: 'spotify:album:Z9', album: 'Whatever' }), 'spotify||spotify:album:z9');
  // two spotify albums with the same display name but different URIs don't collide
  assert.notEqual(
    albumKey({ source: 'spotify', spotifyUri: 'x', albumUri: 'spotify:album:1', album: 'Greatest Hits' }),
    albumKey({ source: 'spotify', spotifyUri: 'y', albumUri: 'spotify:album:2', album: 'Greatest Hits' }),
  );
});

test('mediaPositionNumber parses a positive position from numbers, "3/12" strings and tag objects', () => {
  assert.equal(mediaPositionNumber('3'), 3);
  assert.equal(mediaPositionNumber('05/12'), 5);
  assert.equal(mediaPositionNumber(' 7 - bonus'), 7);
  assert.equal(mediaPositionNumber({ no: 4 }), 4);
  assert.equal(mediaPositionNumber({ position: 9 }), 9);
  assert.equal(mediaPositionNumber(0), 0);
  assert.equal(mediaPositionNumber(null), 0);
  assert.equal(mediaPositionNumber('x'), 0);
});

test('albumTrackCompare orders by disc, then track, then title, then path', () => {
  const sorted = [
    { disk: 2, track: 1, title: 'B' },
    { disk: 1, track: 2, title: 'A' },
    { disk: 1, track: 1, title: 'A' },
  ].sort(albumTrackCompare);
  assert.deepEqual(sorted.map(t => [t.disk, t.track]), [[1, 1], [1, 2], [2, 1]]);
  // disk ?? disc fallback
  const d = [{ disc: 2, track: 1 }, { disc: 1, track: 1 }].sort(albumTrackCompare);
  assert.deepEqual(d.map(t => t.disc), [1, 2]);
  // numeric collation on titles when disc/track tie
  const t = [{ title: 'Track 10' }, { title: 'Track 2' }].sort(albumTrackCompare);
  assert.deepEqual(t.map(x => x.title), ['Track 2', 'Track 10']);
});

test('buildAlbums groups by album, orders tracks, sorts albums by year then title, resolves covers', () => {
  const cover = t => (t.path ? `cover:${t.path}` : '');
  const tracks = [
    { path: '/b2', albumArtist: 'X', album: 'Later', year: 2010, track: 2 },
    { path: '/b1', albumArtist: 'X', album: 'Later', year: 2010, track: 1 },
    { path: '/a1', albumArtist: 'X', album: 'Early', year: 2001, track: 1 },
  ];
  const albums = buildAlbums(tracks, cover);
  assert.deepEqual(albums.map(a => a.title), ['Early', 'Later'], 'albums sorted by year');
  const later = albums.find(a => a.title === 'Later');
  assert.deepEqual(later.tracks.map(t => t.track), [1, 2], 'tracks ordered within the album');
  assert.equal(later.cover, 'cover:/b2', 'cover resolved from the first-encountered track via the injected resolver');
  assert.equal(later.tracks.length, 2);
});
