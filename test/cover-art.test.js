'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSpotifyTrack, normalizeSpotifyArtworkSource, spotifyArtworkUrl,
  spotifyCachedArtworkSrc, placeholderCover, coverSrc,
} = require('../app/renderer/cover-art');

// The mbcover: resolver the renderer injects (preload's window.beehive.coverUrl).
const coverUrl = (f) => (f ? `mbcover://${encodeURIComponent(f)}` : null);

test('isSpotifyTrack requires source=spotify AND a spotifyUri', () => {
  assert.equal(isSpotifyTrack({ source: 'spotify', spotifyUri: 'spotify:track:x' }), true);
  assert.equal(isSpotifyTrack({ source: 'Spotify', spotifyUri: 'x' }), true);
  assert.equal(isSpotifyTrack({ source: 'spotify' }), false, 'no uri');
  assert.equal(isSpotifyTrack({ source: 'local', spotifyUri: 'x' }), false);
  assert.equal(isSpotifyTrack(null), false);
});

test('normalizeSpotifyArtworkSource maps spotify:image:<id> to its CDN URL, passes others through', () => {
  assert.equal(normalizeSpotifyArtworkSource('spotify:image:ab12_CD-34'), 'https://i.scdn.co/image/ab12_CD-34');
  assert.equal(normalizeSpotifyArtworkSource('https://x/y.jpg'), 'https://x/y.jpg');
  assert.equal(normalizeSpotifyArtworkSource('  /local/a.jpg  '), '/local/a.jpg', 'trimmed');
  assert.equal(normalizeSpotifyArtworkSource('spotify:image:bad id!'), 'spotify:image:bad id!', 'invalid id untouched');
  assert.equal(normalizeSpotifyArtworkSource(null), '');
});

test('spotifyArtworkUrl returns the first http(s) art URL, else empty', () => {
  assert.equal(spotifyArtworkUrl({ source: 'spotify', spotifyUri: 'x', artworkUrl: 'spotify:image:zz' }), 'https://i.scdn.co/image/zz');
  assert.equal(spotifyArtworkUrl({ source: 'spotify', spotifyUri: 'x', cover: 'https://c/img' }), 'https://c/img');
  assert.equal(spotifyArtworkUrl({ source: 'spotify', spotifyUri: 'x' }), '');
  assert.equal(spotifyArtworkUrl({ source: 'local', cover: 'https://c/img' }), '', 'non-spotify -> empty');
});

test('coverSrc is idempotent for already-resolved URLs and wraps bare paths via the resolver', () => {
  for (const u of ['https://x/a.jpg', 'data:image/png;base64,AA', 'blob:abc', 'mbcover://x', 'mbfile://y']) {
    assert.equal(coverSrc(u, coverUrl), u, `${u} returned unchanged`);
    assert.equal(coverSrc(coverSrc(u, coverUrl), coverUrl), coverSrc(u, coverUrl), `${u} idempotent`);
  }
  assert.equal(coverSrc('/music/a.jpg', coverUrl), 'mbcover://' + encodeURIComponent('/music/a.jpg'), 'bare path wrapped');
  assert.equal(coverSrc('spotify:image:zz', coverUrl), 'https://i.scdn.co/image/zz', 'spotify URI normalised first');
});

test('coverSrc falls back to the placeholder when there is nothing to resolve', () => {
  const ph = coverSrc('', () => null);
  assert.equal(ph, placeholderCover());
  assert.match(ph, /^data:image\/svg\+xml/);
});

test('spotifyCachedArtworkSrc resolves the cache file via the resolver, else empty', () => {
  assert.equal(
    spotifyCachedArtworkSrc({ source: 'spotify', spotifyUri: 'x', spotifyArtworkCacheFile: '/c/z.jpg' }, coverUrl),
    'mbcover://' + encodeURIComponent('/c/z.jpg'),
  );
  assert.equal(spotifyCachedArtworkSrc({ source: 'spotify', spotifyUri: 'x' }, coverUrl), '', 'no cache file');
  assert.equal(spotifyCachedArtworkSrc({ source: 'local', spotifyArtworkCacheFile: '/c/z.jpg' }, coverUrl), '', 'non-spotify');
});
