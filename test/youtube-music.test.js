const test = require('node:test');
const assert = require('node:assert/strict');
const { normalise, similarity, containment, scoreCandidate, acceptable, urlExpiry } = require('../app/main/youtube-music');

test('titles are compared without featuring credits and edition notes', () => {
  assert.equal(normalise('Melody Day (Four Tet Remix) [feat. Luke Lalonde, Adem & One Little Plane] [Mixed]'), 'melody day four tet remix');
  assert.equal(normalise('Back to Basics (feat. Skepta)'), 'back to basics');
  assert.equal(normalise('Song - Remastered 2011'), 'song');
  assert.equal(similarity('Locked', 'locked'), 1);
  assert.equal(containment('Caribou', 'Caribou, Luke Lalonde, Adem'), 1);
});

test('YouTube Music candidates must match title, artist and roughly the length', () => {
  const want = { title: 'Locked', artist: 'Four Tet', duration: 509.5 };
  assert.ok(acceptable(scoreCandidate(want, { title: 'Locked', artist: 'Four Tet', duration: 510 })));
  assert.ok(!acceptable(scoreCandidate(want, { title: 'Locked', artist: 'Someone Else', duration: 510 })));
  assert.ok(!acceptable(scoreCandidate(want, { title: 'Locked Out', artist: 'Four Tet', duration: 200 })));
  // A DJ-mix edit: exact title and artist, different length.
  const mixed = { title: 'Melody Day (Four Tet Remix) [Mixed]', artist: 'Caribou', duration: 200 };
  assert.ok(acceptable(scoreCandidate(mixed, { title: 'Melody Day (Four Tet Remix) (feat. Adem)', artist: 'Caribou, Adem', duration: 286 })));
});

test('stream links expire when googlevideo says so', () => {
  assert.equal(urlExpiry('https://rr1---sn.googlevideo.com/videoplayback?expire=1800000000&x=1'), 1800000000 * 1000);
  assert.ok(urlExpiry('https://example.com/a') > Date.now());
});
