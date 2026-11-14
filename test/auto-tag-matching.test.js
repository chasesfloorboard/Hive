'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoTagMatching } = require('../app/renderer/auto-tag-matching');

// A deterministic stand-in for the renderer's search normaliser: lowercase, drop
// anything but [a-z0-9]. Enough to exercise every matching branch.
const normalizeForSearch = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const m = createAutoTagMatching({ normalizeForSearch });

test('createAutoTagMatching validates its dependency', () => {
  assert.throws(() => createAutoTagMatching({}), /normalizeForSearch/);
});

test('autoTagNeedsMetadata is true when any of title/artist/album/albumArtist is blank', () => {
  assert.equal(m.autoTagNeedsMetadata({ title: 'T', artist: 'A', album: 'Al', albumArtist: 'AA' }), false);
  assert.equal(m.autoTagNeedsMetadata({ title: 'T', artist: 'A', album: 'Al' }), true, 'missing albumArtist');
  assert.equal(m.autoTagNeedsMetadata({}), true);
});

test('autoTagFilenameStem strips path, extension and a leading track number', () => {
  assert.equal(m.autoTagFilenameStem({ path: '/music/Band/03 - Great Song.flac' }), 'greatsong');
  assert.equal(m.autoTagFilenameStem({ path: 'C:\\m\\Song.mp3' }), 'song');
  assert.equal(m.autoTagFilenameStem({}), '');
});

test('autoTagTrackNumber takes the leading integer of "3" or "3/12", else 0', () => {
  assert.equal(m.autoTagTrackNumber('3'), 3);
  assert.equal(m.autoTagTrackNumber('3/12'), 3);
  assert.equal(m.autoTagTrackNumber('0'), 0);
  assert.equal(m.autoTagTrackNumber(''), 0);
  assert.equal(m.autoTagTrackNumber(null), 0);
});

test('autoTagMatchScore: exact title is 100; stem match is 80; numbers/artist/duration add', () => {
  // Exact normalised title.
  assert.equal(m.autoTagMatchScore({ title: 'Hello World' }, { title: 'hello world' }), 100);
  // No title tag -> filename stem vs remote title = 80, plus matching track number +45.
  const stem = m.autoTagMatchScore({ path: '/m/01 Hello World.mp3', track: '1' }, { title: 'Hello World', position: '1' });
  assert.equal(stem, 80 + 45);
  // Full stack: exact title + track + disc + artist + near duration.
  const full = m.autoTagMatchScore(
    { title: 'Song', track: '2', disk: '1', artist: 'Band', duration: 200 },
    { title: 'Song', position: '2', disc: '1', artist: 'Band', duration: 201 },
  );
  assert.equal(full, 100 + 45 + 10 + 12 + 25);
  // A >2.5s duration gap gives no duration bonus.
  const noDur = m.autoTagMatchScore({ title: 'X', duration: 200 }, { title: 'X', duration: 210 });
  assert.equal(noDur, 100);
});

test('autoTagChangedFields returns only non-empty desired values that differ', () => {
  const local = { path: '/m/a.mp3', album: 'Old Album', artist: 'Band', title: 'Song', track: '1' };
  const remote = { title: 'Song', artist: 'Band', position: '1' };
  const release = { title: 'New Album', artist: 'Band', year: '1999' };
  const changed = m.autoTagChangedFields(local, remote, release);
  assert.deepEqual(Object.keys(changed).sort(), ['album', 'albumArtist', 'year']);
  assert.equal(changed.album, 'New Album', 'album differs -> changed');
  assert.ok(!('title' in changed), 'title unchanged -> omitted');
  assert.ok(!('artist' in changed), 'artist unchanged -> omitted');
  // No path or no remote -> nothing.
  assert.deepEqual(m.autoTagChangedFields({}, remote, release), {});
  assert.deepEqual(m.autoTagChangedFields(local, null, release), {});
});

test('buildAutoTagMapping pairs by best score, each used once, refusing weak guesses', () => {
  const locals = [
    { path: '/m/1.mp3', title: 'Alpha', track: '1' },
    { path: '/m/2.mp3', title: 'Beta', track: '2' },
  ];
  const remotes = [
    { title: 'Beta', position: '2' },
    { title: 'Alpha', position: '1' },
  ];
  const map = m.buildAutoTagMapping(locals, remotes);
  assert.equal(map.length, 2);
  const byLocal = Object.fromEntries(map.map((x) => [x.local.title, x.remote.title]));
  assert.equal(byLocal.Alpha, 'Alpha');
  assert.equal(byLocal.Beta, 'Beta');
});

test('buildAutoTagMapping uses safe by-elimination for a lone leftover file/track pair', () => {
  // One incomplete file whose title matches nothing (score 0 -> no candidate), and one
  // leftover remote track: elimination pairs them and flags byElimination.
  const locals = [{ path: '/m/mystery.mp3', title: '' }];
  const remotes = [{ title: 'The Only Track', position: '1' }];
  const map = m.buildAutoTagMapping(locals, remotes);
  assert.equal(map.length, 1);
  assert.equal(map[0].byElimination, true);
  assert.equal(map[0].score, 50);
});

test('buildAutoTagMapping does NOT eliminate when more than one file or track is left', () => {
  const locals = [{ path: '/m/a.mp3', title: '' }, { path: '/m/b.mp3', title: '' }];
  const remotes = [{ title: 'One', position: '1' }, { title: 'Two', position: '2' }];
  assert.deepEqual(m.buildAutoTagMapping(locals, remotes), [], 'ambiguous -> no risky positional guess');
});

test('rankAutoTagReleases prefers a track-count-closest release and a matching single', () => {
  const results = [
    { collectionName: 'Deluxe', score: 10, trackCount: 20, releaseType: 'album' },
    { collectionName: 'Standard', score: 10, trackCount: 10, releaseType: 'album' },
  ];
  const ranked = m.rankAutoTagReleases(results, new Array(10).fill({ title: 'x' }));
  assert.equal(ranked[0].collectionName, 'Standard', 'closest track count to 10 wins');

  // A lone file whose title contains the single's name -> the +50 single bonus is
  // decisive when base scores are comparable (the realistic MusicBrainz case).
  const singleResults = [
    { collectionName: 'Big Album', score: 10, trackCount: 12, releaseType: 'album' },
    { collectionName: 'Hit Song', score: 10, trackCount: 1, releaseType: 'single' },
  ];
  const single = m.rankAutoTagReleases(singleResults, [{ title: 'Hit Song' }]);
  assert.equal(single[0].collectionName, 'Hit Song', 'matching single gets the +50 bonus');
});
