'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'dist', 'linux-unpacked', 'resources');
const worker = path.join(resources, 'app.asar.unpacked', 'app', 'workers', 'scanner-worker.js');
const unpackedNodeModules = path.join(resources, 'app.asar.unpacked', 'node_modules');
const metadataEntry = path.join(unpackedNodeModules, 'music-metadata', 'lib', 'index.js');

function wavFixture() {
  const sampleRate = 8000;
  const samples = Buffer.alloc(sampleRate / 10 * 2);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const chunk = (id, body) => {
    const header = Buffer.alloc(8);
    header.write(id, 0, 'ascii');
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', samples)]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function main() {
  const packagePath = path.join(unpackedNodeModules, 'music-metadata', 'package.json');
  await fs.access(worker);
  await fs.access(packagePath);
  await fs.access(metadataEntry);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-packaged-scanner-'));
  const audioPath = path.join(temp, 'fixture.wav');
  const coversDir = path.join(temp, 'covers');
  await fs.mkdir(coversDir);
  await fs.writeFile(audioPath, wavFixture());

  const child = fork(worker, [], {
    cwd: path.join(resources, 'app.asar.unpacked', 'app', 'workers'),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_PATH: unpackedNodeModules }
  });
  let settled = false;
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('packaged scanner smoke test timed out')), 15000);
      child.on('message', message => {
        if (message?.type !== 'result' && message?.type !== 'error' && message?.type !== 'fatal') return;
        clearTimeout(timer);
        if (message.type === 'result') resolve(message);
        else reject(new Error(message.error || `scanner worker returned ${message.type}`));
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.send({ type: 'scan', id: 'packaged-smoke', filePath: audioPath, coversDir });
    });
    assert.equal(result.type, 'result');
    assert.equal(result.id, 'packaged-smoke');
    assert.equal(result.track.path, audioPath);
    console.log(JSON.stringify({
      ok: true,
      worker,
      musicMetadata: packagePath,
      musicMetadataEntry: metadataEntry,
      parsed: { path: result.track.path, codec: result.track.codec, duration: result.track.duration }
    }, null, 2));
  } finally {
    if (!child.killed) child.kill();
    settled = true;
    await fs.rm(temp, { recursive: true, force: true });
  }
  return settled;
}

main().catch(error => {
  console.error(`Packaged scanner smoke test failed: ${error.stack || error}`);
  process.exitCode = 1;
});
