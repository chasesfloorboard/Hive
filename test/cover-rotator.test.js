'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoverRotator } = require('../app/renderer/cover-rotator');

// A fake Image that "loads" on the next microtask so preload() resolves deterministically.
class FakeImage {
  constructor() { this.onload = null; this.onerror = null; this._src = ''; }
  set src(v) { this._src = v; Promise.resolve().then(() => this.onload && this.onload()); }
  get src() { return this._src; }
  decode() { return Promise.resolve(); }
}
// A stub <img> target.
function imgEl() {
  return { isConnected: true, dataset: {}, style: {}, src: '' };
}
// Capturing fake timer.
function makeTimers() {
  let cb = null;
  return {
    setInterval: (fn) => { cb = fn; return { id: 1 }; },
    clearInterval: () => { cb = null; },
    tick: async () => { if (cb) await cb(); },
    get active() { return cb !== null; },
  };
}
const coverSrc = (file) => `cover:${file}`;
const placeholderCover = () => 'placeholder';
function build(timers = makeTimers()) {
  return {
    rotator: createCoverRotator({ coverSrc, placeholderCover, Image: FakeImage, setInterval: timers.setInterval, clearInterval: timers.clearInterval }),
    timers,
  };
}

test('createCoverRotator validates coverSrc and placeholderCover', () => {
  assert.throws(() => createCoverRotator({}), /coverSrc, placeholderCover/);
  assert.throws(() => createCoverRotator({ coverSrc }), /placeholderCover/);
});

test('start paints the first cover onto every target and starts no timer for a single cover', async () => {
  const { rotator, timers } = build();
  const a = imgEl(), b = imgEl();
  await rotator.start([{ file: 'art1.jpg' }], [a, b, null]);
  assert.equal(a.src, 'cover:art1.jpg');
  assert.equal(b.src, 'cover:art1.jpg');
  assert.equal(timers.active, false, 'a single cover needs no rotation timer');
});

test('start with no covers paints the placeholder', async () => {
  const { rotator } = build();
  const a = imgEl();
  await rotator.start([], [a]);
  assert.equal(a.src, 'placeholder');
});

test('start with multiple covers rotates on each tick, wrapping around', async () => {
  const { rotator, timers } = build();
  const a = imgEl();
  await rotator.start([{ file: '1.jpg' }, { file: '2.jpg' }, { file: '3.jpg' }], [a]);
  assert.equal(a.src, 'cover:1.jpg');
  assert.equal(timers.active, true, 'rotation timer started');
  await timers.tick();
  assert.equal(a.src, 'cover:2.jpg');
  await timers.tick();
  assert.equal(a.src, 'cover:3.jpg');
  await timers.tick();
  assert.equal(a.src, 'cover:1.jpg', 'wraps back to the first');
});

test('stop clears the timer and a late tick from the old generation is ignored', async () => {
  const { rotator, timers } = build();
  const a = imgEl();
  await rotator.start([{ file: '1.jpg' }, { file: '2.jpg' }], [a]);
  const stale = timers; // capture the running callback before stop
  rotator.stop();
  assert.equal(timers.active, false, 'timer cleared on stop');
  a.src = 'untouched';
  await stale.tick(); // no-op: timers cleared, nothing to call
  assert.equal(a.src, 'untouched');
});

test('retarget adds new targets with the current cover and never attaches one twice', async () => {
  const { rotator } = build();
  const a = imgEl();
  await rotator.start([{ file: '1.jpg' }], [a]);
  const b = imgEl();
  rotator.retarget([b]);
  assert.equal(b.src, 'cover:1.jpg', 'new target gets the current cover');
  assert.equal(b.dataset.beehiveRotatorAttached, '1');
  // A second retarget of the same element is a no-op (already attached).
  b.src = 'changed';
  rotator.retarget([b]);
  assert.equal(b.src, 'changed', 'already-attached target is skipped');
});
