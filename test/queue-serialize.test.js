'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeQueueTrack, restoreQueueItems, pickQueueSnapshot } = require('../app/renderer/queue-serialize');

test('serializeQueueTrack drops a track with no path', () => {
  assert.equal(serializeQueueTrack(null), null);
  assert.equal(serializeQueueTrack({}), null);
  assert.equal(serializeQueueTrack({ title: 'x' }), null);
});

test('serializeQueueTrack produces the minimal stable shape with coerced types', () => {
  const out = serializeQueueTrack({ path: '/m/a.mp3', title: 'A', duration: '203', loved: 1, rating: '4' });
  assert.equal(out.path, '/m/a.mp3');
  assert.equal(out.source, 'local', 'defaults to local');
  assert.equal(out.duration, 203, 'duration coerced to number');
  assert.equal(out.loved, true, 'loved coerced to bool');
  assert.equal(out.rating, 4);
  assert.equal(out.title, 'A');
  assert.equal(out.album, '', 'missing strings become empty');
  // Optional streamed-origin fields are omitted unless present.
  assert.ok(!('appleMusicUrl' in out));
  assert.ok(!('ytVideoId' in out));
  assert.ok(!('genre' in out));
});

test('serializeQueueTrack keeps streamed-origin fields only when set, and cross-fills context uris', () => {
  const out = serializeQueueTrack({ path: 'spotify:x', source: 'spotify', spotifyContextUri: 'ctx:1', appleMusicUrl: 'https://music.apple/x', genre: 'Jazz' });
  assert.equal(out.appleMusicUrl, 'https://music.apple/x');
  assert.equal(out.genre, 'Jazz');
  assert.equal(out.contextUri, 'ctx:1', 'contextUri back-filled from spotifyContextUri');
  assert.equal(out.spotifyContextUri, 'ctx:1');
});

const byPathOf = (tracks) => new Map(tracks.map((t) => [t.path, t]));

test('restoreQueueItems: serialized items re-resolve local tracks against byPath; streamed carry own data', () => {
  const lib = byPathOf([{ path: '/m/a.mp3', title: 'A (live)' }]);
  const items = [
    { path: '/m/a.mp3', title: 'A (stale)', source: 'local' },
    { path: 'spotify:z', source: 'spotify', title: 'Z' },
  ];
  const out = restoreQueueItems(items, null, lib, true);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'A (live)', 'local re-resolved to the live library track');
  assert.equal(out[1].title, 'Z', 'streamed entry kept as-is');
});

test('restoreQueueItems: a local item missing from the library is dropped unless allowSerializedLocal', () => {
  const emptyLib = byPathOf([]);
  const items = [{ path: '/gone.mp3', source: 'local', title: 'Gone' }];
  assert.deepEqual(restoreQueueItems(items, null, emptyLib, false), [], 'dropped when serialized-local not allowed');
  const kept = restoreQueueItems(items, null, emptyLib, true);
  assert.equal(kept.length, 1, 'kept when allowSerializedLocal');
  assert.equal(kept[0].title, 'Gone');
});

test('restoreQueueItems: paths-only snapshot keeps minimal local entries with a filename title', () => {
  const emptyLib = byPathOf([]);
  const out = restoreQueueItems(null, ['/music/Songs/Great Track.flac', ''], emptyLib, true);
  assert.equal(out.length, 1, 'empty path skipped');
  assert.equal(out[0].source, 'local');
  assert.equal(out[0].title, 'Great Track', 'filename without extension or dirs');
  // Without allowSerializedLocal and an empty library, a paths-only snapshot yields nothing.
  assert.deepEqual(restoreQueueItems(null, ['/music/x.mp3'], emptyLib, false), []);
});

test('pickQueueSnapshot: ignores snapshots without usable paths', () => {
  assert.equal(pickQueueSnapshot([]), null);
  assert.equal(pickQueueSnapshot([{ paths: [] }, { savedAt: 9 }]), null);
});

test('pickQueueSnapshot: a snapshot is clocked by its queueSavedAt, ignoring its own larger savedAt', () => {
  // The whole point: savedAt is bumped by every position save, so it must NOT drive the
  // choice. A has a huge savedAt but an older queueSavedAt; B's newer queueSavedAt wins.
  const a = { paths: ['/a'], queueSavedAt: 300, savedAt: 9999, queueItems: [{ path: '/a' }] };
  const b = { paths: ['/b'], queueSavedAt: 400, savedAt: 1, queueItems: [{ path: '/b' }] };
  assert.equal(pickQueueSnapshot([a, b]), b);
});

test('pickQueueSnapshot: savedAt is used as the clock only when queueSavedAt is absent', () => {
  const noQueueTime = { paths: ['/a'], savedAt: 500, queueItems: [{ path: '/a' }] };
  const older = { paths: ['/b'], queueSavedAt: 400, queueItems: [{ path: '/b' }] };
  assert.equal(pickQueueSnapshot([noQueueTime, older]), noQueueTime, 'falls back to savedAt');
});

test('pickQueueSnapshot: on an equal time, the snapshot carrying queueItems wins', () => {
  const pathsOnly = { paths: ['/a'], queueSavedAt: 100 };
  const withItems = { paths: ['/a'], queueSavedAt: 100, queueItems: [{ path: '/a' }] };
  assert.equal(pickQueueSnapshot([pathsOnly, withItems]), withItems);
});

test('pickQueueSnapshot: a paths-only winner borrows queueItems from a same-queue donor', () => {
  // Winner (newer time) is paths-only; a donor with identical paths carries the items
  // and the pre-shuffle base. The result is the winner merged with the donor's items.
  const winner = { paths: ['/a', '/b'], queueSavedAt: 300 };
  const donor = { paths: ['/a', '/b'], queueSavedAt: 100, queueItems: [{ path: '/a' }, { path: '/b' }], shuffleBaseItems: [{ path: '/b' }], shuffleBasePaths: ['/b', '/a'] };
  const picked = pickQueueSnapshot([winner, donor]);
  assert.equal(picked.queueSavedAt, 300, 'kept the winner identity/time');
  assert.deepEqual(picked.queueItems, donor.queueItems, 'borrowed the donor items');
  assert.deepEqual(picked.shuffleBaseItems, donor.shuffleBaseItems, 'borrowed the pre-shuffle base');
});

test('pickQueueSnapshot: no donor when paths differ -> returns the paths-only winner unchanged', () => {
  const winner = { paths: ['/a', '/b'], queueSavedAt: 300 };
  const other = { paths: ['/a', '/c'], queueSavedAt: 100, queueItems: [{ path: '/a' }] };
  const picked = pickQueueSnapshot([winner, other]);
  assert.equal(picked, winner, 'different queue is not a valid donor');
  assert.ok(!picked.queueItems);
});
