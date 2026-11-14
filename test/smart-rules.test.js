'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSmartRules } = require('../app/renderer/smart-rules');

// A fixed clock so relative-date rules are deterministic.
const NOW = 1_700_000_000_000;
const rules = createSmartRules({
  normalizeMetadataText: (v) => String(v || '').toLowerCase().trim(),
  playlistNamesFor: (p) => (p === '/in/pl' ? 'road trip' : ''),
  virtualValue: (t, key) => (key === 'virtual1' ? String(t.vibe || '') : ''),
  shuffleForPlayback: (a) => a.slice().reverse(), // deterministic stand-in
  now: () => NOW,
});
const { smartCompare, smartFieldValue, smartRelativeSpanMs, smartDeduplicate, sortSmartTracks } = rules;
const cmp = (track, field, op, value) => smartCompare(track, { field, op, value });

test('numeric fields compare as numbers; a non-finite target is always false', () => {
  assert.equal(cmp({ playCount: 10 }, 'plays', 'gt', '5'), true);
  assert.equal(cmp({ playCount: 10 }, 'plays', 'gte', '10'), true);
  assert.equal(cmp({ playCount: 10 }, 'plays', 'lt', '10'), false);
  assert.equal(cmp({ rating: 4 }, 'rating', 'eq', '4'), true);
  assert.equal(cmp({ playCount: 10 }, 'plays', 'gt', 'notanumber'), false);
});

test('string fields compare case-insensitively across contains/is/starts/ends/empty', () => {
  assert.equal(cmp({ artist: 'Björk' }, 'artist', 'contains', 'BJ'), true);
  assert.equal(cmp({ artist: 'Björk' }, 'artist', 'is', 'björk'), true);
  assert.equal(cmp({ artist: 'Björk' }, 'artist', 'starts', 'bj'), true);
  assert.equal(cmp({ artist: 'Björk' }, 'artist', 'ends', 'rk'), true);
  assert.equal(cmp({ artist: '' }, 'artist', 'empty', ''), true);
  assert.equal(cmp({ artist: 'x' }, 'artist', 'notempty', ''), true);
});

test('favorite is a boolean match; love matches the Loved/Not Loved label', () => {
  assert.equal(cmp({ loved: true }, 'favorite', 'is', 'true'), true);
  assert.equal(cmp({ loved: false }, 'favorite', 'is', 'true'), false);
  assert.equal(cmp({ loved: false }, 'favorite', 'is', 'false'), true);
  assert.equal(cmp({ loved: true }, 'love', 'is', 'Loved'), true);
  assert.equal(cmp({ loved: false }, 'love', 'is', 'Loved'), false);
  assert.equal(cmp({ loved: false }, 'love', 'is', 'Not Loved'), true);
});

test('relative-date rules (inLast/notInLast) use the injected clock; bare number = days', () => {
  const recent = NOW - 2 * 86400e3;    // 2 days ago
  const old = NOW - 40 * 86400e3;      // 40 days ago
  assert.equal(cmp({ addedAt: recent }, 'addedAt', 'inLast', '7d'), true);
  assert.equal(cmp({ addedAt: old }, 'addedAt', 'inLast', '7d'), false);
  assert.equal(cmp({ addedAt: old }, 'addedAt', 'notInLast', '7d'), true);
  assert.equal(cmp({ addedAt: recent }, 'addedAt', 'inLast', '3'), true, 'bare number means days');
  assert.equal(cmp({ addedAt: recent }, 'addedAt', 'inLast', 'garbage'), false, 'unparseable span -> false');
});

test('smartRelativeSpanMs parses h/d/w/m/y and fails closed', () => {
  assert.equal(smartRelativeSpanMs('12h'), 12 * 3600e3);
  assert.equal(smartRelativeSpanMs('2w'), 2 * 7 * 86400e3);
  assert.equal(smartRelativeSpanMs('5'), 5 * 86400e3, 'default unit = days');
  assert.equal(smartRelativeSpanMs('nope'), 0);
});

test('smartFieldValue: custom tag wins, then field getter, incl. injected playlist/virtual resolvers', () => {
  assert.equal(smartFieldValue({ customTags: { mood: 'Hype' }, mood: 'Calm' }, 'mood'), 'Hype', 'custom tag overrides');
  assert.equal(smartFieldValue({ path: '/in/pl' }, 'playlist'), 'road trip', 'injected playlist resolver');
  assert.equal(smartFieldValue({ vibe: 'Sunny' }, 'virtual1'), 'Sunny', 'injected virtual resolver');
  assert.equal(smartFieldValue({ year: 1999 }, 'year'), 1999, 'numeric getter');
});

test('smartDeduplicate collapses by title|artist|duration identity', () => {
  const out = smartDeduplicate([
    { path: '/a', title: 'T', artist: 'A', duration: 100 },
    { path: '/b', title: 'T', artist: 'A', duration: 100 },
    { path: '/c', title: 'T', artist: 'A', duration: 101 },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(t => t.path), ['/a', '/c']);
});

test('sortSmartTracks handles each mode and defaults to addedDesc; random uses the injected shuffle', () => {
  const t = [{ addedAt: 1 }, { addedAt: 3 }, { addedAt: 2 }];
  assert.deepEqual(sortSmartTracks(t.slice(), 'addedDesc').map(x => x.addedAt), [3, 2, 1]);
  assert.deepEqual(sortSmartTracks(t.slice(), undefined).map(x => x.addedAt), [3, 2, 1], 'default = addedDesc');
  assert.deepEqual(sortSmartTracks([{ playCount: 1 }, { playCount: 5 }], 'playsDesc').map(x => x.playCount), [5, 1]);
  assert.deepEqual(sortSmartTracks([{ title: 'b' }, { title: 'a' }], 'title').map(x => x.title), ['a', 'b']);
  assert.deepEqual(sortSmartTracks([1, 2, 3].map(n => ({ n })), 'random').map(x => x.n), [3, 2, 1], 'injected shuffle');
});
