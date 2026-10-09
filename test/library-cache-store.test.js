'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLibraryCacheStore } = require('../app/main/library-cache-store');

// Manual timers so tests decide when a delayed flush/evict fires.
function fakeTimers() {
  const timers = new Set();
  return {
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.add(t); return t; },
    clearTimer: (t) => { timers.delete(t); },
    fire(ms) { for (const t of [...timers]) if (t.ms === ms) { timers.delete(t); t.fn(); } },
    pending: (ms) => [...timers].filter(t => t.ms === ms).length
  };
}

function makeStore(initial, overrides = {}) {
  const timers = fakeTimers();
  const io = { reads: 0, writes: [], disk: initial };
  const store = createLibraryCacheStore({
    read: async () => { io.reads++; return io.disk ? JSON.parse(JSON.stringify(io.disk)) : null; },
    write: async (data) => { io.writes.push(JSON.parse(JSON.stringify(data))); io.disk = data; },
    flushDelayMs: 100,
    idleEvictMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides
  });
  return { store, timers, io };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('repeated reads parse the cache file once and share the object', async () => {
  const { store, io } = makeStore({ tracks: [{ path: '/a.flac' }] });
  const [a, b] = await Promise.all([store.get(), store.get()]);
  const c = await store.get();
  assert.equal(io.reads, 1);
  assert.equal(a, b);
  assert.equal(a, c);
});

test('a burst of edits is written once, after the delay', async () => {
  const { store, timers, io } = makeStore({ tracks: [{ path: '/a.flac', loved: false }, { path: '/b.flac', loved: false }] });
  for (const p of ['/a.flac', '/b.flac']) {
    const cache = await store.get();
    cache.tracks.find(t => t.path === p).loved = true;
    store.set(cache);
  }
  assert.equal(io.writes.length, 0);
  assert.equal(store.needsFlush(), true);
  timers.fire(100);
  await settle();
  assert.equal(io.writes.length, 1);
  assert.deepEqual(io.writes[0].tracks.map(t => t.loved), [true, true]);
  assert.equal(store.needsFlush(), false);
});

test('flush() writes pending edits immediately and is a no-op when clean', async () => {
  const { store, timers, io } = makeStore({ tracks: [] });
  store.set({ tracks: [{ path: '/new.mp3' }] });
  await store.flush();
  assert.equal(io.writes.length, 1);
  assert.equal(timers.pending(100), 0);
  await store.flush();
  assert.equal(io.writes.length, 1);
});

test('a failed write stays pending and is retried by the next flush', async () => {
  let fail = true;
  const written = [];
  const { store } = makeStore(null, {
    write: async (data) => { if (fail) throw new Error('disk full'); written.push(data); }
  });
  store.set({ tracks: [{ path: '/x.ogg' }] });
  await assert.rejects(store.flush(), /disk full/);
  assert.equal(store.needsFlush(), true);
  fail = false;
  await store.flush();
  assert.equal(written.length, 1);
  assert.equal(store.needsFlush(), false);
});

test('clear() drops memory and a pending save so the deleted cache is not written back', async () => {
  const { store, timers, io } = makeStore({ tracks: [{ path: '/old.flac' }] });
  const cache = await store.get();
  store.set(cache);
  await store.clear();
  timers.fire(100);
  await store.flush();
  assert.equal(io.writes.length, 0);
  io.disk = null;
  assert.equal(await store.get(), null);
});

test('clear() during an in-flight read does not let that read repopulate memory', async () => {
  let release;
  let reads = 0;
  const { store } = makeStore(null, {
    read: () => (++reads === 1
      ? new Promise(resolve => { release = () => resolve({ tracks: [{ path: '/stale.mp3' }] }); })
      : Promise.resolve({ tracks: [] }))
  });
  const pending = store.get();
  await settle();
  await store.clear();
  release();
  await pending;
  assert.deepEqual(await store.get(), { tracks: [] });
});

test('an idle cache is evicted from memory, but never with an unsaved edit', async () => {
  const { store, timers, io } = makeStore({ tracks: [] });
  await store.get();
  timers.fire(1000);
  await store.get();
  assert.equal(io.reads, 2);

  const cache = await store.get();
  store.set(cache);
  timers.fire(1000);
  assert.equal(await store.get(), cache);
});

test('an edit made while a write is in progress is saved by a later flush', async () => {
  let finishFirst;
  const written = [];
  const { store } = makeStore(null, {
    write: (data) => new Promise(resolve => {
      const copy = JSON.parse(JSON.stringify(data));
      if (!finishFirst) finishFirst = () => { written.push(copy); resolve(); };
      else { written.push(copy); resolve(); }
    })
  });
  store.set({ tracks: [{ path: '/a', loved: false }] });
  const first = store.flush();
  await settle();
  assert.equal(store.needsFlush(), true);
  store.set({ tracks: [{ path: '/a', loved: true }] });
  finishFirst();
  await first;
  await store.flush();
  assert.deepEqual(written.map(w => w.tracks[0].loved), [false, true]);
});
