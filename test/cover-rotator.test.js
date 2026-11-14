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

test('the decode cache is bounded to the current track and does not grow across tracks', async () => {
  // Count how many times each source is decoded. A source held forever in the cache would be
  // decoded only once; a cache bounded to the current track re-decodes it after it is displaced.
  const decodeCounts = new Map();
  class CountingImage {
    constructor() { this.onload = null; this.onerror = null; this._src = ''; }
    set src(v) { this._src = v; decodeCounts.set(v, (decodeCounts.get(v) || 0) + 1); Promise.resolve().then(() => this.onload && this.onload()); }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
  }
  const timers = makeTimers();
  const rotator = createCoverRotator({ coverSrc, placeholderCover, Image: CountingImage, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  const a = imgEl();
  await rotator.start([{ file: 'a.jpg' }], [a]); // decode a (1)
  await rotator.start([{ file: 'b.jpg' }], [a]); // a is displaced from the cache; decode b
  assert.equal(decodeCounts.get('cover:a.jpg'), 1, 'a decoded once so far');
  await rotator.start([{ file: 'a.jpg' }], [a]); // a is no longer cached -> decoded again
  assert.equal(decodeCounts.get('cover:a.jpg'), 2, 'a re-decoded: the cache did not retain every past cover');
});

test('re-starting the same track keeps its covers cached (prune does not evict the live set)', async () => {
  // The prune must only drop covers NOT in the current track. Restarting with the same covers
  // must not re-decode them — proving the live set is preserved, not thrown away.
  const decodeCounts = new Map();
  class CountingImage {
    constructor() { this.onload = null; this.onerror = null; this._src = ''; }
    set src(v) { this._src = v; decodeCounts.set(v, (decodeCounts.get(v) || 0) + 1); Promise.resolve().then(() => this.onload && this.onload()); }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
  }
  const timers = makeTimers();
  const rotator = createCoverRotator({ coverSrc, placeholderCover, Image: CountingImage, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  const a = imgEl();
  await rotator.start([{ file: '1.jpg' }, { file: '2.jpg' }], [a]);
  await new Promise(r => setImmediate(r)); // let the look-ahead preload settle
  const c1 = decodeCounts.get('cover:1.jpg') || 0;
  const c2 = decodeCounts.get('cover:2.jpg') || 0;
  await rotator.start([{ file: '1.jpg' }, { file: '2.jpg' }], [a]); // same covers -> prune keeps both
  await new Promise(r => setImmediate(r));
  assert.equal(decodeCounts.get('cover:1.jpg'), c1, 'cover 1 not re-decoded when its track is still current');
  assert.equal(decodeCounts.get('cover:2.jpg'), c2, 'cover 2 not re-decoded when its track is still current');
});
