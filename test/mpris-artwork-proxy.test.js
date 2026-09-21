const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { ArtworkProxy } = require('../app/main/artwork-proxy');

test('MPRIS artwork proxy serves only cached covers over localhost', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mpris-art-'));
  const cover = path.join(root, 'album.jpg');
  fs.writeFileSync(cover, Buffer.from([0xff,0xd8,0xff,0xd9]));
  const proxy = new ArtworkProxy(root);
  try {
    const port = await proxy.start();
    assert.ok(port > 0);
    const url = new URL(proxy.urlFor(cover));
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/cover/album.jpg');
    const response = await new Promise((resolve, reject) => {
      http.get(url, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(response.status, 200);
    assert.equal(response.type, 'image/jpeg');
    assert.deepEqual(response.body, fs.readFileSync(cover));
  } finally {
    proxy.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MPRIS artwork proxy rejects traversal and missing covers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mpris-art-'));
  const proxy = new ArtworkProxy(root);
  try {
    const port = await proxy.start();
    for (const pathname of ['/cover/../secret.jpg', '/cover/missing.jpg']) {
      const response = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${pathname}`, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
      });
      assert.equal(response, 404);
    }
  } finally {
    proxy.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('MPRIS artwork proxy failure is non-fatal to the integration startup path', async () => {
  const events = [];
  const proxy = { start: async () => { throw new Error('bind failed'); } };
  const mpris = { start: async () => { events.push('mpris'); return true; } };
  await Promise.resolve()
    .then(() => proxy.start())
    .catch(err => { events.push(`proxy:${err.message}`); return 0; })
    .then(() => mpris.start());
  assert.deepEqual(events, ['proxy:bind failed', 'mpris']);
});
