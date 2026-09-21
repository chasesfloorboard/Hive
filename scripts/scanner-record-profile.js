'use strict';

// Profile a bounded prefix of an existing scan log. This intentionally does not
// invoke Hive or enumerate the configured library; it only asks the packaged
// scanner worker to parse a small, explicit set of paths.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const worker = path.join(root, 'dist', 'linux-unpacked', 'resources', 'app.asar.unpacked', 'app', 'workers', 'scanner-worker.js');
const logPath = process.argv[2] || path.join(os.homedir(), 'Logs', 'BeehiveMusicBrainz', 'scan-live.log');
const limit = Math.min(300, Math.max(1, Number(process.argv[3] || 250)));

function pathsFromLog(text) {
  const paths = [];
  for (const line of text.split('\n')) {
    const marker = ' SCAN START ';
    const start = line.indexOf(marker);
    if (start < 0) continue;
    try {
      const payload = JSON.parse(line.slice(line.indexOf('{', start)));
      if (payload.file && !paths.includes(payload.file)) paths.push(payload.file);
      if (paths.length >= limit) break;
    } catch {}
  }
  return paths;
}

async function main() {
  const paths = pathsFromLog(await fs.readFile(logPath, 'utf8'));
  assert.ok(paths.length, `no scan paths found in ${logPath}`);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-record-profile-'));
  const coversDir = path.join(temp, 'covers');
  await fs.mkdir(coversDir);
  const child = fork(worker, [], { cwd: path.dirname(worker), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const records = [];
  let cursor = 0;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('scanner record profile timed out')), 120000);
      const dispatch = () => {
        if (cursor >= paths.length) { clearTimeout(timer); resolve(); return; }
        const index = cursor++;
        child.once('message', message => {
          if (message?.type === 'result' && message.track) records.push(message.track);
          dispatch();
        });
        child.send({ type: 'scan', id: index, filePath: paths[index], coversDir });
      };
      child.once('error', error => { clearTimeout(timer); reject(error); });
      dispatch();
    });
  } finally {
    child.kill();
    await fs.rm(temp, { recursive: true, force: true });
  }
  assert.equal(records.length, paths.length);
  const rows = records.map(track => {
    const size = value => Buffer.byteLength(JSON.stringify(value ?? null));
    return {
      path: track.path,
      total: size(track),
      nativeTags: size(track.nativeTags),
      lyrics: size(track.lyrics),
      customTags: size(track.customTags),
      covers: size(track.covers)
    };
  }).sort((a, b) => b.total - a.total);
  console.log(JSON.stringify({ count: rows.length, totalBytes: rows.reduce((sum, row) => sum + row.total, 0), largest: rows.slice(0, 10) }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
