'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeFileDurable, fsyncDir, atomicReplace } = require('../app/main/atomic-file');

async function tempDir() { return fsp.mkdtemp(path.join(os.tmpdir(), 'hive-atomic-')); }

test('atomicReplace writes content and leaves no temp sibling', async () => {
  const dir = await tempDir();
  try {
    const f = path.join(dir, 'store.json');
    await atomicReplace(f, '{"a":1}');
    assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}');
    assert.deepEqual(fs.readdirSync(dir), ['store.json'], 'no leftover .tmp');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('atomicReplace overwrites in place and preserves the old file on no change of path', async () => {
  const dir = await tempDir();
  try {
    const f = path.join(dir, 'store.json');
    await atomicReplace(f, 'old');
    await atomicReplace(f, 'new value');
    assert.equal(fs.readFileSync(f, 'utf8'), 'new value');
    assert.deepEqual(fs.readdirSync(dir), ['store.json']);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('a leftover temp from a crashed write never corrupts the live file', async () => {
  const dir = await tempDir();
  try {
    const f = path.join(dir, 'store.json');
    await atomicReplace(f, 'good');
    fs.writeFileSync(path.join(dir, 'store.json.beehive-write-999-deadbeef.tmp'), 'half {');
    assert.equal(fs.readFileSync(f, 'utf8'), 'good', 'live file untouched by a stray temp');
    await atomicReplace(f, 'good2');
    assert.equal(fs.readFileSync(f, 'utf8'), 'good2');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('writeFileDurable writes + fsyncs; fsyncDir is best-effort and never throws', async () => {
  const dir = await tempDir();
  try {
    const f = path.join(dir, 'durable.bin');
    await writeFileDurable(f, Buffer.from('hello'));
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
    await fsyncDir(dir); // must not throw even where directory fsync is unsupported
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
