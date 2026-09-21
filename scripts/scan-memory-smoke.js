'use strict';

// Controlled memory regression for the full-scan ownership model. This uses a
// temporary SQLite database and synthetic records; it never reads Hive config
// or the user's music library.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { canonicalize } = require('../canonical-metadata');
const { rendererTrackPayload } = require('../scan-payload');

const TOTAL = 30000;
const BATCH_SIZE = 64;

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-scan-memory-'));
  const db = path.join(dir, 'library.sqlite');
  const child = spawn(process.env.BEEHIVE_PYTHON || 'python3', [path.join(__dirname, '..', 'app', 'workers', 'database-worker.py'), db], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0;
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', data => {
    buffer += String(data);
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const request = pending.get(String(message.id));
      if (!request) continue;
      pending.delete(String(message.id));
      message.ok ? request.resolve(message.result) : request.reject(new Error(message.error));
    }
  });
  const request = (cmd, payload = {}) => new Promise((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n');
  });
  const compactTracks = [];
  let batch = [];
  let maxHeap = 0;
  const sample = () => { maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed); };
  try {
    for (let i = 0; i < TOTAL; i++) {
      // This deliberately makes nativeTags much heavier than a normal track so
      // accidental full-record retention fails the smoke test quickly.
      const full = {
        path: `/synthetic/${i}.flac`, title: `Track ${i}`, artist: 'Synthetic', album: 'Memory',
        lyrics: 'short lyrics', customTags: { VIRTUAL1: 'value' },
        nativeTags: { ID3: Array.from({ length: 80 }, (_, tag) => ({ id: `TXXX:${tag}`, value: `${i}-${tag}-${'x'.repeat(96)}` })) }
      };
      batch.push(canonicalize(full));
      compactTracks.push(rendererTrackPayload(full));
      if (batch.length === BATCH_SIZE) {
        await request('upsert_tracks', { tracks: batch });
        batch = [];
        if (global.gc) global.gc();
        sample();
      }
    }
    if (batch.length) await request('upsert_tracks', { tracks: batch });
    const health = await request('health_check');
    assert.equal(health.trackCount, TOTAL);
    assert.equal(compactTracks.length, TOTAL);
    assert.equal(compactTracks[0].nativeTags, undefined);
    if (global.gc) global.gc();
    sample();
    assert.ok(maxHeap < 512 * 1024 * 1024, `bounded scan working set exceeded 512 MiB: ${maxHeap}`);
    console.log(JSON.stringify({ ok: true, total: TOTAL, batchSize: BATCH_SIZE, sqliteTracks: health.trackCount, maxHeapBytes: maxHeap }, null, 2));
  } finally {
    child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Scan memory smoke test failed: ${error.stack || error}`);
  process.exitCode = 1;
});
