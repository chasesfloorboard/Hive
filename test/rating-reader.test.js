'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRatingReader } = require('../app/main/rating-reader');

const synchsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

// Build a minimal ID3v2.4 tag holding one or more POPM frames. popms: [{email, rating}]
function mp3WithPopm(popms) {
  const frames = popms.map(({ email, rating }) => {
    const body = Buffer.concat([Buffer.from(email, 'latin1'), Buffer.from([0x00, rating, 0x00])]);
    return Buffer.concat([Buffer.from('POPM'), synchsafe(body.length), Buffer.from([0, 0]), body]);
  });
  const payload = Buffer.concat(frames);
  const header = Buffer.concat([Buffer.from('ID3'), Buffer.from([0x04, 0x00, 0x00]), synchsafe(payload.length)]);
  return Buffer.concat([header, payload]);
}

async function tmpFile(name, buf) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hive-rate-'));
  const p = path.join(dir, name);
  if (buf) await fsp.writeFile(p, buf);
  return { dir, p };
}

test('readMp3PopmRaw/Rating read the MusicBee POPM byte and convert to stars', async () => {
  const reader = createRatingReader({ ensureMM: async () => { throw new Error('mp3 path must not call ensureMM'); } });
  const { dir, p } = await tmpFile('song.mp3', mp3WithPopm([{ email: 'MusicBee', rating: 255 }]));
  try {
    assert.equal(await reader.readMp3PopmRaw(p), 255);
    assert.equal(await reader.readMp3PopmRating(p), 5);
    assert.equal(await reader.readEmbeddedRating(p), 5, 'dispatches .mp3 to the POPM reader');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("a foreign player's POPM never overrides MusicBee's rating", async () => {
  const reader = createRatingReader({ ensureMM: async () => ({}) });
  // Windows Media Player rating 0 sits before MusicBee's 242 (4.5 stars): must return MusicBee's.
  const { dir, p } = await tmpFile('song.mp3', mp3WithPopm([
    { email: 'Windows Media Player 9 Series', rating: 1 },
    { email: 'MusicBee', rating: 242 },
  ]));
  try {
    assert.equal(await reader.readMp3PopmRaw(p), 242);
    assert.equal(await reader.readMp3PopmRating(p), 4.5);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('a file with no MusicBee POPM reads as 0 (foreign-only is ignored for display)', async () => {
  const reader = createRatingReader({ ensureMM: async () => ({}) });
  const { dir, p } = await tmpFile('song.mp3', mp3WithPopm([{ email: 'Winamp', rating: 196 }]));
  try {
    assert.equal(await reader.readMp3PopmRaw(p), 0);
    assert.equal(await reader.readEmbeddedRating(p), 0);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('readEmbeddedRating returns 0 for a missing path', async () => {
  const reader = createRatingReader({ ensureMM: async () => ({}) });
  assert.equal(await reader.readEmbeddedRating('/does/not/exist.flac'), 0);
  assert.equal(await reader.readEmbeddedRating(''), 0);
});

test('non-MP3 files read the portable FMPS_RATING via the injected metadata lib', async () => {
  // Fake music-metadata: a FLAC/Vorbis FMPS_RATING of 0.8 -> 4 stars; an MP4 namespaced id works too.
  const ensureMM = async () => ({
    parseFile: async () => ({ native: { vorbis: [
      { id: '----:com.apple.iTunes:FMPS_Rating', value: { description: 'FMPS_Rating', text: '0.8' } },
    ] } }),
  });
  const reader = createRatingReader({ ensureMM });
  const { dir, p } = await tmpFile('song.flac', Buffer.from('fLaC-not-real'));
  try {
    assert.equal(await reader.readEmbeddedRating(p), 4);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
