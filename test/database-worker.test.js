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
  const child = spawn(process.env.BEEHIVE_PYTHON || 'python3', [path.join(__dirname, '..', 'database-worker.py'), db], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0; let buffer = ''; const pending = new Map();
  child.stdout.on('data', data => { buffer += data; for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const p = pending.get(String(message.id)); if (p) { pending.delete(String(message.id)); message.ok ? p.resolve(message.result) : p.reject(new Error(message.error)); } } });
  const request = (cmd, payload = {}) => new Promise((resolve, reject) => { const id = String(++sequence); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n'); });
  try {
    await request('replace_library', { tracks: [{ path: '/synthetic/a.flac', artist: 'Artist', album: 'Album', title: 'Song' }] });
    assert.equal((await request('search_tracks', { text: 'Song' })).length, 1);
    await request('upsert_job', { job: { id: 'job-1', status: 'running', job: { path: '/synthetic/a.flac' }, attempts: 1, createdAt: 1 } });
    const recovered = await request('recover_jobs');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'queued');
    assert.equal((await request('health_check')).healthy, true);
  } finally { child.kill(); await fs.rm(dir, { recursive: true, force: true }); }
});
