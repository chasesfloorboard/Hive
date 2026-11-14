'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('database worker persists library records and recovers incomplete jobs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-db-test-'));
  const db = path.join(dir, 'library.sqlite');
  const child = spawn(process.env.BEEHIVE_PYTHON || 'python3', [path.join(__dirname, '..', 'app', 'workers', 'database-worker.py'), db], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0; let buffer = ''; const pending = new Map();
  child.stdout.on('data', data => { buffer += data; for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const p = pending.get(String(message.id)); if (p) { pending.delete(String(message.id)); message.ok ? p.resolve(message.result) : p.reject(new Error(message.error)); } } });
  const request = (cmd, payload = {}) => new Promise((resolve, reject) => { const id = String(++sequence); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n'); });
  try {
    await request('replace_library', { tracks: [{ path: '/synthetic/a.flac', artist: 'Artist', album: 'Album', title: 'Song', nativeTags: { ID3: [{ id: 'TXXX:KEEP', value: 'preserved' }] } }] });
    assert.equal((await request('search_tracks', { text: 'Song' })).length, 1);
    assert.deepEqual((await request('get_library')).tracks[0].nativeTags, { ID3: [{ id: 'TXXX:KEEP', value: 'preserved' }] });
    await request('upsert_job', { job: { id: 'job-1', status: 'running', job: { path: '/synthetic/a.flac' }, attempts: 1, createdAt: 1 } });
    const recovered = await request('recover_jobs');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'queued');
    assert.equal((await request('health_check')).healthy, true);
  } finally { child.kill(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('database worker indexes Loved lookups and compacts a mostly-free database without losing rows', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-db-compact-'));
  const db = path.join(dir, 'library.sqlite');
  const child = spawn(process.env.BEEHIVE_PYTHON || 'python3', [path.join(__dirname, '..', 'app', 'workers', 'database-worker.py'), db], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0; let buffer = ''; const pending = new Map();
  child.stdout.on('data', data => { buffer += data; for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const p = pending.get(String(message.id)); if (p) { pending.delete(String(message.id)); message.ok ? p.resolve(message.result) : p.reject(new Error(message.error)); } } });
  const request = (cmd, payload = {}) => new Promise((resolve, reject) => { const id = String(++sequence); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n'); });
  try {
    const bulky = 'x'.repeat(4000);
    const tracks = Array.from({ length: 3000 }, (_, i) => ({ path: `/synthetic/${i}.flac`, title: `Song ${i}`, loved: i % 3 === 0, lyrics: bulky }));
    await request('upsert_tracks', { tracks });
    await request('remove_tracks', { paths: tracks.slice(10).map(t => t.path) });
    const result = await request('compact');
    assert.equal(result.vacuumed, true);
    assert.ok(result.pagesAfter < result.pagesBefore / 4, `expected the file to shrink, got ${JSON.stringify(result)}`);
    assert.equal((await request('compact')).vacuumed, false, 'a compact database is left alone');
    assert.deepEqual(await request('get_track_paths').then(r => r.paths.length), 10);
    assert.deepEqual(await request('get_loved_paths'), ['/synthetic/0.flac', '/synthetic/3.flac', '/synthetic/6.flac', '/synthetic/9.flac']);
  } finally { child.kill(); await fs.rm(dir, { recursive: true, force: true }); }
});

// Incremental watcher/download scans now persist only the DELTA (upsert_tracks the changed/new rows +
// remove_tracks the removed ones) instead of replace_library'ing all ~30k rows. This proves the delta
// leaves an end state identical to a full replace: unchanged rows (and their nativeTags) are untouched,
// changed rows update in place, removed rows are gone, and new rows appear.
test('incremental delta persist (upsert + remove) matches a full library replace', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-db-delta-'));
  const db = path.join(dir, 'library.sqlite');
  const child = spawn(process.env.BEEHIVE_PYTHON || 'python3', [path.join(__dirname, '..', 'app', 'workers', 'database-worker.py'), db], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0; let buffer = ''; const pending = new Map();
  child.stdout.on('data', data => { buffer += data; for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const p = pending.get(String(message.id)); if (p) { pending.delete(String(message.id)); message.ok ? p.resolve(message.result) : p.reject(new Error(message.error)); } } });
  const request = (cmd, payload = {}) => new Promise((resolve, reject) => { const id = String(++sequence); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n'); });
  try {
    await request('replace_library', { tracks: [
      { path: '/m/a.flac', title: 'A', artist: 'X', loved: true, nativeTags: { ID3: [{ id: 'TXXX:KEEP', value: 'keepme' }] } },
      { path: '/m/b.flac', title: 'B old', artist: 'X' },
      { path: '/m/c.flac', title: 'C', artist: 'X' },
    ] });
    // Incremental event: b changed (new title), c deleted from disk, d is a fresh download.
    await request('upsert_tracks', { tracks: [
      { path: '/m/b.flac', title: 'B new', artist: 'X' },
      { path: '/m/d.flac', title: 'D', artist: 'X' },
    ] });
    await request('remove_tracks', { paths: ['/m/c.flac'] });

    const lib = await request('get_library');
    const byPath = Object.fromEntries(lib.tracks.map(t => [t.path, t]));
    assert.deepEqual(Object.keys(byPath).sort(), ['/m/a.flac', '/m/b.flac', '/m/d.flac'], 'c removed, d added, a/b kept');
    assert.equal(byPath['/m/b.flac'].title, 'B new', 'changed row updated in place');
    assert.equal(byPath['/m/d.flac'].title, 'D', 'new row added');
    // The untouched row must keep everything a full replace would have kept — including nativeTags and Love.
    assert.deepEqual(byPath['/m/a.flac'].nativeTags, { ID3: [{ id: 'TXXX:KEEP', value: 'keepme' }] }, 'unchanged row untouched');
    assert.equal(byPath['/m/a.flac'].loved === true || byPath['/m/a.flac'].loved === 1, true, 'unchanged Love preserved');
  } finally { child.kill(); await fs.rm(dir, { recursive: true, force: true }); }
});
