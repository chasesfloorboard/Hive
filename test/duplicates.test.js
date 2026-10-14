const test = require('node:test');
const assert = require('node:assert/strict');
const { normalise, findDuplicates } = require('../app/renderer/duplicates');

test('normalise ignores case, accents, version notes and featured artists', () => {
  assert.equal(normalise('Héllo (Remastered 2011)'), 'hello');
  assert.equal(normalise('Song [Deluxe Edition]'), 'song');
  assert.equal(normalise('Track feat. Somebody'), 'track');
  assert.equal(normalise('Rock & Roll'), 'rock and roll');
  assert.equal(normalise('Live (Remastered)', { ignoreVersions: false }), 'live remastered');
});

test('groups copies, keeps different lengths apart, ranks the best copy first', () => {
  const tracks = [
    { path: '/a.mp3', artist: 'Band', title: 'Song', duration: 200, bitrate: 128000, codec: 'MPEG 1 Layer 3' },
    { path: '/b.flac', artist: 'band', title: 'Song (Remastered)', duration: 201, bitrate: 900000, codec: 'FLAC' },
    { path: '/c.mp3', artist: 'Band', title: 'Song', duration: 199, bitrate: 320000, codec: 'MPEG 1 Layer 3' },
    { path: '/live.mp3', artist: 'Band', title: 'Song', duration: 320 },
    { path: '/other.mp3', artist: 'Band', title: 'Other', duration: 200 }
  ];
  const groups = findDuplicates(tracks);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map(t => t.path), ['/b.flac', '/c.mp3', '/a.mp3']);
  assert.equal(findDuplicates(tracks, { toleranceSeconds: 0 })[0].length, 4, 'tolerance 0 ignores length');
  assert.equal(findDuplicates(tracks, { matchAlbum: true }).length, 1);
});
