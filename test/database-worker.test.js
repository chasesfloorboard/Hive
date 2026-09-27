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
