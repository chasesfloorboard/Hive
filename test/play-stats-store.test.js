'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayStatsStore } = require('../app/main/play-stats-store');

const STATS = '/data/play-stats.json';

function fakeLayer(initial) {
  const files = new Map(initial ? [[STATS, JSON.stringify(initial)]] : []);
  return {
    files,
    readJsonSafe: async (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    writeJsonSafe: async (p, data) => { files.set(p, JSON.stringify(data)); },
  };
}

test('withStatsMutation returns the task result', async () => {
  const store = createPlayStatsStore({ statsPath: () => STATS, ...fakeLayer() });
  assert.equal(await store.withStatsMutation(async () => 42), 42);
});

test('withStatsMutation serializes: tasks never interleave', async () => {
  const store = createPlayStatsStore({ statsPath: () => STATS, ...fakeLayer() });
  const order = [];
  const mk = (id, delay) => () => new Promise(res => {
    order.push(`start-${id}`);
    setTimeout(() => { order.push(`end-${id}`); res(id); }, delay);
  });
  // Launch three with decreasing delays; serialization must keep them strictly ordered anyway.
  const p1 = store.withStatsMutation(mk('A', 15));
  const p2 = store.withStatsMutation(mk('B', 1));
  const p3 = store.withStatsMutation(mk('C', 1));
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ['start-A', 'end-A', 'start-B', 'end-B', 'start-C', 'end-C'],
    'each mutation fully completes before the next starts');
});

test('a rejected mutation still advances the chain (one failure cannot wedge later writers)', async () => {
  const store = createPlayStatsStore({ statsPath: () => STATS, ...fakeLayer() });
  const bad = store.withStatsMutation(async () => { throw new Error('boom'); });
  await assert.rejects(bad, /boom/);
  const good = await store.withStatsMutation(async () => 'ok');
  assert.equal(good, 'ok', 'the next mutation runs after a failed one');
});

test('readStats/writeStats go through the injected safe JSON layer at the stats path', async () => {
  const layer = fakeLayer({ counts: { 'a.flac': 3 } });
  const store = createPlayStatsStore({ statsPath: () => STATS, ...layer });
  assert.deepEqual(await store.readStats(), { counts: { 'a.flac': 3 } });
  assert.deepEqual(await store.readStats({ counts: {} }), { counts: { 'a.flac': 3 } });
  await store.writeStats({ counts: { 'b.flac': 1 } });
  assert.deepEqual(JSON.parse(layer.files.get(STATS)), { counts: { 'b.flac': 1 } });
  // a read on a missing file returns the fallback
  const empty = createPlayStatsStore({ statsPath: () => '/nope.json', ...fakeLayer() });
  assert.deepEqual(await empty.readStats({ counts: {} }), { counts: {} });
});
