'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { keepUnseen, phoneSees } = require('../app/main/playlist-merge');

const lib = new Set(['/m/a.mp3', '/m/b.mp3', '/m/c.mp3'].map(p => path.resolve(p)));

test('a phone edit keeps the radio, podcast and outside songs it never saw, where they were', () => {
  const old = ['radio:first', '/m/a.mp3', 'podcast:ep1', '/m/b.mp3', '/elsewhere/x.mp3', '/m/c.mp3', 'ytm:apple:9'];
  // The phone removed b and moved c to the front.
  const incoming = ['/m/c.mp3', '/m/a.mp3', 'ytm:apple:9'];
  assert.deepEqual(keepUnseen(old, incoming, lib), ['radio:first', '/m/c.mp3', '/m/a.mp3', 'podcast:ep1', 'ytm:apple:9', '/elsewhere/x.mp3']);
});

test('nothing unseen: the phone\'s list as sent', () => {
  assert.deepEqual(keepUnseen(['/m/a.mp3', '/m/b.mp3'], ['/m/b.mp3'], lib), ['/m/b.mp3']);
  assert.deepEqual(keepUnseen(undefined, ['/m/a.mp3'], lib), ['/m/a.mp3']);
});

test('a Windows drive path is a song, not a link', () => {
  assert.equal(phoneSees('ytm:spotify:1', lib), true);
  assert.equal(phoneSees('radio:x', lib), false);
  assert.equal(phoneSees('C:\\Music\\a.mp3', new Set([path.resolve('C:\\Music\\a.mp3')])), true);
});

test('random playlists: the phone\'s list comes through in its order, every entry it couldn\'t see is kept once, nothing else appears', () => {
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const songs = ['/m/a.mp3', '/m/b.mp3', '/m/c.mp3'];
  const unseenPool = ['radio:1', 'podcast:2', '/elsewhere/x.mp3', 'radio:3'];
  for (let round = 0; round < 3000; round++) {
    const old = [];
    for (let i = 0; i < rand(8); i++) old.push(rand(2) ? songs[rand(3)] : unseenPool[rand(4)]);
    const incoming = [];
    for (let i = 0; i < rand(5); i++) incoming.push(rand(4) ? songs[rand(3)] : 'ytm:apple:' + rand(3));
    const out = keepUnseen(old, incoming, lib);
    // The phone's entries, in its order.
    assert.deepEqual(out.filter(r => phoneSees(r, lib)), incoming.filter(r => phoneSees(r, lib)), JSON.stringify({ old, incoming, out }));
    // Every unseen entry once per time it was in the old list (minus any the phone sent back itself).
    const unseenOld = old.filter(r => !phoneSees(r, lib) && !incoming.includes(r));
    const unseenOut = out.filter(r => !phoneSees(r, lib) && !incoming.includes(r));
    assert.deepEqual([...unseenOut].sort(), [...unseenOld].sort(), JSON.stringify({ old, incoming, out }));
    assert.equal(out.length, incoming.length + unseenOld.length);
  }
});
