'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readWavMusicBeeTags } = require('../wav-id3');

function synchsafe(value) { return Buffer.from([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]); }
function frame(id, payload) { const size = Buffer.alloc(4); size.writeUInt32BE(payload.length); return Buffer.concat([Buffer.from(id), size, Buffer.alloc(2), payload]); }
function encode(text, encoding) {
  if (encoding === 0) return Buffer.from(text, 'latin1');
  if (encoding === 3) return Buffer.from(text, 'utf8');
  const le = Buffer.from(text, 'utf16le');
  if (encoding === 1) return Buffer.concat([Buffer.from([0xff, 0xfe]), le]);
  const be = Buffer.from(le); for (let i = 0; i + 1 < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1], be[i]]; return be;
}
function loveFrame(value, encoding = 3, name = 'LOVE RATING') {
  const separator = encoding === 1 || encoding === 2 ? Buffer.from([0, 0]) : Buffer.from([0]);
  return frame('TXXX', Buffer.concat([Buffer.from([encoding]), encode(name, encoding), separator, encode(value, encoding)]));
}
function popmFrame(raw) { return frame('POPM', Buffer.concat([Buffer.from('MusicBee\0', 'latin1'), Buffer.from([raw]), Buffer.alloc(4)])); }
function id3(frames) { const body = Buffer.concat(frames); return Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'binary'), synchsafe(body.length), body]); }
function chunk(id, payload) { const head = Buffer.alloc(8); head.write(id, 0, 'ascii'); head.writeUInt32LE(payload.length, 4); return Buffer.concat([head, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); }
function wav(chunks) { const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]); const out = Buffer.alloc(8); out.write('RIFF'); out.writeUInt32LE(body.length, 4); return Buffer.concat([out, body]); }

async function withFixture(buffer, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-wav-test-'));
  const file = path.join(dir, 'fixture.wav');
  try { await fs.writeFile(file, buffer); return await fn(file); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('WAV scanner accumulates Love and rating from later RIFF ID3 chunks', async () => {
  await withFixture(wav([chunk('id3 ', id3([loveFrame('NO') ])), chunk('ID3 ', id3([loveFrame('L'), popmFrame(196)]))]), async file => {
    assert.deepEqual(await readWavMusicBeeTags(file), { loved: true, rating: 4, ratingRaw: 196 });
  });
});

for (const [name, encoding] of [['latin-1', 0], ['utf-8', 3], ['utf-16-le-bom', 1], ['utf-16-be', 2]]) {
  test(`WAV scanner reads ${name} Love TXXX fields`, async () => {
    await withFixture(wav([chunk('id3 ', id3([loveFrame('L', encoding)]))]), async file => {
      assert.equal((await readWavMusicBeeTags(file)).loved, true);
    });
  });
}

test('WAV scanner ignores malformed ID3 chunks and continues to a valid chunk', async () => {
  await withFixture(wav([chunk('id3 ', Buffer.from('not an ID3 tag')), chunk('ID3 ', id3([loveFrame('YES'), popmFrame(255)]))]), async file => {
    assert.deepEqual(await readWavMusicBeeTags(file), { loved: true, rating: 5, ratingRaw: 255 });
  });
});

test('WAV scanner returns safe defaults when no recognized Love/rating exists', async () => {
  await withFixture(wav([chunk('id3 ', id3([loveFrame('NO'), frame('TIT2', Buffer.from('\x03Untitled', 'binary'))]))]), async file => {
    assert.deepEqual(await readWavMusicBeeTags(file), { loved: false, rating: 0, ratingRaw: 0 });
  });
});
