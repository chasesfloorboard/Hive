'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { rendererTrackPayload } = require('../app/main/scan-payload');

function synchsafe(value) {
  return Buffer.from([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);
}

function id3Frame(id, payload) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.alloc(2), payload]);
}

function id3Tag(frames) {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'binary'), synchsafe(body.length), body]);
}

function apicFrame(image) {
  // UTF-8 encoding, MIME, Cover (Front), empty description, then image bytes.
  return id3Frame('APIC', Buffer.concat([
    Buffer.from([3]), Buffer.from('image/jpeg\0', 'ascii'), Buffer.from([3, 0]), image
  ]));
}

async function scanFixture(filePath, coversDir) {
  const worker = fork(path.join(__dirname, '..', 'app', 'workers', 'scanner-worker.js'), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.kill();
      reject(new Error('artwork scanner fixture timed out'));
    }, 15000);
    const finish = (error, value) => {
      clearTimeout(timer);
      worker.kill();
      error ? reject(error) : resolve(value);
    };
    worker.once('error', error => finish(error));
    worker.once('message', message => {
      if (message?.type !== 'result') return finish(new Error(message?.error || 'scanner returned no result'));
      finish(null, message.track);
    });
    worker.send({ type: 'scan', id: 'artwork-fixture', filePath, coversDir });
  });
}

test('embedded artwork becomes a cached reference without entering renderer payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-artwork-test-'));
  const file = path.join(root, 'fixture.mp3');
  const coversDir = path.join(root, 'covers');
  const image = Buffer.from('synthetic-jpeg-payload');
  try {
    await fs.writeFile(file, id3Tag([apicFrame(image)]));
    const track = await scanFixture(file, coversDir);
    assert.equal(track.covers.length, 1);
    assert.equal(track.cover, track.covers[0].file);
    assert.match(track.cover, /^[a-f0-9]{40}\.jpg$/);
    assert.equal(track.nativeTags?.['ID3v2.3'], undefined);

    const cached = await fs.readFile(path.join(coversDir, track.cover));
    assert.deepEqual(cached, image);

    const payload = rendererTrackPayload(track);
    assert.equal(payload.cover, track.cover);
    assert.deepEqual(payload.covers, track.covers);
    assert.equal(payload.nativeTags, undefined);
    assert.equal(JSON.stringify(payload).includes(image.toString()), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
