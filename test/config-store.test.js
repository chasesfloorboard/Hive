'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfigStore } = require('../app/main/config-store');

// An in-memory json-store stand-in with a single serialized write lock per path.
function fakeJsonLayer(initial) {
  const files = new Map(Object.entries(initial || {}));
  const queues = new Map();
  let reads = 0, writes = 0;
  return {
    reads: () => reads, writes: () => writes,
    peek: (p) => files.get(p),
    readJsonSafe: async (p, fallback) => { reads++; return files.has(p) ? JSON.parse(files.get(p)) : fallback; },
    writeJsonSafe: async (p, data) => { writes++; files.set(p, JSON.stringify(data)); },
    withJsonFileLock: (p, fn) => {
      const prev = queues.get(p) || Promise.resolve();
      const next = prev.catch(() => {}).then(fn);
      queues.set(p, next.catch(() => {}));
      return next;
    },
  };
}

const CONFIG = '/cfg/config.json';

test('normalize coerces non-objects and a missing folders list', () => {
  const store = createConfigStore({ configPath: () => CONFIG, ...fakeJsonLayer() });
  assert.deepEqual(store.normalize(null), { folders: [] });
  assert.deepEqual(store.normalize([1, 2]), { folders: [] }, 'an array is not a valid config');
  assert.deepEqual(store.normalize({ a: 1 }), { a: 1, folders: [] });
  assert.deepEqual(store.normalize({ folders: ['/music'] }), { folders: ['/music'] });
});

test('readConfig returns the normalised current config', async () => {
  const layer = fakeJsonLayer({ [CONFIG]: JSON.stringify({ scrobbling: { on: true } }) });
  const store = createConfigStore({ configPath: () => CONFIG, ...layer });
  assert.deepEqual(await store.readConfig(), { scrobbling: { on: true }, folders: [] });
});

test('updateConfig applies the mutation, persists it, and returns the mutate result', async () => {
  const layer = fakeJsonLayer();
  const store = createConfigStore({ configPath: () => CONFIG, ...layer });
  const ret = await store.updateConfig(c => { c.folders.push('/a'); c.embedPlayCounts = true; return c.embedPlayCounts; });
  assert.equal(ret, true);
  assert.deepEqual(JSON.parse(layer.peek(CONFIG)), { folders: ['/a'], embedPlayCounts: true });
});

test('concurrent updateConfig calls do not drop each other (serialized read-modify-write)', async () => {
  const layer = fakeJsonLayer({ [CONFIG]: JSON.stringify({ folders: [] }) });
  const store = createConfigStore({ configPath: () => CONFIG, ...layer });
  await Promise.all([
    store.updateConfig(c => { c.folders.push('A'); }),
    store.updateConfig(c => { c.folders.push('B'); }),
    store.updateConfig(c => { c.folders.push('C'); }),
  ]);
  const folders = JSON.parse(layer.peek(CONFIG)).folders.sort();
  assert.deepEqual(folders, ['A', 'B', 'C'], 'all three folder adds survive; none lost to a stale snapshot');
});
