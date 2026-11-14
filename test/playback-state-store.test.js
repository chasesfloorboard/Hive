'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPlaybackStateStore } = require('../app/main/playback-state-store');

async function sandbox(now = () => 1000) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hive-pss-'));
  const statePath = () => path.join(dir, 'profile', 'playback-state.json');
  const store = createPlaybackStateStore({ fs, path, statePath, now });
  return { dir, statePath, store };
}

test('saveSnapshotSync writes the full versioned queue, normalising bad fields', async () => {
  const { dir, statePath, store } = await sandbox(() => 4242);
  try {
    store.saveSnapshotSync({
      paths: ['a.flac', '', null, 'b.flac'],
      currentIndex: 1, currentPath: 'b.flac', position: -5, shuffle: 1,
      repeat: 9, volume: 2, selectedQueueIndex: 0, selectedIndices: [0, 'x', 2], wasPlaying: 'yes'
    });
    const onDisk = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    assert.equal(onDisk.version, 3);
    assert.deepEqual(onDisk.paths, ['a.flac', 'b.flac'], 'blank/null paths dropped');
    assert.equal(onDisk.position, 0, 'negative position clamped to 0');
    assert.equal(onDisk.repeat, 0, 'out-of-range repeat falls back to 0');
    assert.equal(onDisk.volume, 1, 'out-of-range volume clamped into 0..1');
    assert.deepEqual(onDisk.selectedIndices, [0, 2], 'non-integer selection entries dropped');
    assert.equal(onDisk.wasPlaying, true);
    assert.equal(onDisk.savedAt, 4242);
    assert.equal(onDisk.queueSavedAt, 4242, 'queueSavedAt defaults to now on a queue save');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('updateTransportSync keeps the saved queue and overwrites only transport fields', async () => {
  const { dir, statePath, store } = await sandbox(() => 7000);
  try {
    store.saveSnapshotSync({ paths: ['x.flac', 'y.flac'], currentIndex: 0, queueSavedAt: 123 });
    store.updateTransportSync({ position: 42.5, currentIndex: 1, currentPath: 'y.flac', wasPlaying: true });
    const onDisk = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    assert.deepEqual(onDisk.paths, ['x.flac', 'y.flac'], 'queue survives a transport-only update');
    assert.equal(onDisk.queueSavedAt, 123, 'queueSavedAt preserved through the merge');
    assert.equal(onDisk.position, 42.5);
    assert.equal(onDisk.currentIndex, 1);
    assert.equal(onDisk.wasPlaying, true);
    assert.equal(onDisk.savedAt, 7000);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('updateTransportSync on a missing/corrupt file still writes a valid record', async () => {
  const { dir, statePath, store } = await sandbox();
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), '{ this is not json');
    store.updateTransportSync({ position: 10, volume: 0.5 });
    const onDisk = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    assert.equal(onDisk.position, 10);
    assert.equal(onDisk.volume, 0.5);
    assert.equal(onDisk.currentIndex, -1, 'defaults applied when there was no prior state');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('writeDurableSync leaves no temp file behind on success', async () => {
  const { dir, statePath, store } = await sandbox();
  try {
    store.saveSnapshotSync({ paths: ['z.flac'] });
    assert.equal(fs.existsSync(`${statePath()}.tmp`), false, 'temp file renamed away');
    assert.equal(fs.existsSync(statePath()), true);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
