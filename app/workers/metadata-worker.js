const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { readWavMusicBeeLove: readSharedWavMusicBeeLove, readWavMusicBeePopmRaw: readSharedWavMusicBeePopmRaw } = require('../main/wav-id3');
const { spawn } = require('child_process');
const { replaceFile } = require('../main/replace-file');

// Metadata work should yield to playback and UI activity on Linux.
try { if (typeof process.setPriority === 'function') process.setPriority(process.pid, 10); } catch {}

// Per-file write serialization for metadata operations performed by this worker.
// This must live in the worker because bulk Love writes run here rather than in main.js.

async function metadataTempPath(target, label='media') {
  const filename = `media-${process.pid}-${Date.now()}-${label}-${crypto.randomBytes(8).toString('hex')}${path.extname(target).toLowerCase()}`;
  // Same reasoning as createMetadataTempPath in main.js: a sibling directory on
  // the target's own filesystem makes the rename below a real atomic rename
  // instead of the non-atomic copy+unlink EXDEV fallback, which a music
  // library living on a different filesystem/device than the OS temp dir
  // (tmpfs /tmp, a separate drive, a NAS mount) hits routinely, not rarely.
  // ".beehive-tmp" is the naming convention the library scanner and
  // filesystem watcher already recognize and skip.
  const siblingDir = path.join(path.dirname(target), '.beehive-tmp');
  try {
    await fsp.mkdir(siblingDir, { recursive: true, mode: 0o700 });
    return path.join(siblingDir, filename);
  } catch {
    const dir = path.join(os.tmpdir(), 'beehive-metadata');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, filename);
  }
}
async function writeAndSyncReplacement(temp, target, data) {
  await fsp.writeFile(temp, data);
  await syncAndRenameExistingTemp(temp, target);
}
// Shared tail of writeAndSyncReplacement, for a writer (like metaflac) that
// already produced the final content directly at `temp` itself rather than
// handing us an in-memory buffer to write.
// Love gives the file a new modified time, like any write: that's how Hive Mobile's file mirror sees it
// and makes the phone's copy the same file again (by the tags alone; the song isn't copied).
async function syncAndRenameExistingTemp(temp, target) {
  const fd = await fsp.open(temp, 'r+');
  try { await fd.sync(); } finally { await fd.close(); }
  await replaceFile(temp, target);
}

const musicBeeWriteLocks = new Map();


// FLAC and any format without a handwritten binary-container writer below
// (mp3/wav/m4a have one each) go through the bundled Mutagen backend
// (resources/python/tag_helper.py), the same canonical writer main.js uses
// for every other metadata operation. This used to shell out to the external
// `metaflac`/`ffmpeg` binaries instead, which the canon doc
// (docs/ai/HIVE-METADATA-BACKEND-CANON.md) explicitly says not to do for
// ordinary tag/rating/Love changes, and which fails outright -- with no
// fallback -- on any system that doesn't have those separate packages
// installed (this was the cause of FLAC Love/Unlove erroring for the user).
let cachedTagHelperScript = null;
function resolveTagHelperScript() {
  if (cachedTagHelperScript && fs.existsSync(cachedTagHelperScript)) return cachedTagHelperScript;
  const rel = path.join('resources', 'python', 'tag_helper.py');
  // This worker is forked with its cwd set to the project root in dev, or the
  // unpacked app root in a packaged build (see workerForkOptions in main.js),
  // so the resource lives either directly under cwd or one level up.
  const candidates = [
    path.join(process.cwd(), rel),
    path.join(process.cwd(), '..', rel),
    path.join(__dirname, '..', '..', rel)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) { cachedTagHelperScript = candidate; return candidate; }
  }
  throw new Error('Native tag helper is missing from this Hive build.');
}

// One-shot invocation: this worker is a separate forked process from main.js's
// pooled tag-helper workers and cannot share that pool, but Love writes are
// infrequent enough (one file per dispatch) that paying Python startup cost
// per call is an acceptable tradeoff for removing the external-binary
// dependency.
function runTagHelperOnce(request) {
  return new Promise((resolve, reject) => {
    let script;
    try { script = resolveTagHelperScript(); } catch (err) { reject(err); return; }
    const python = process.env.BEEHIVE_PYTHON || 'python3';
    const child = spawn(python, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      fn(value);
    };
    child.stdout.on('data', chunk => {
      if (settled) return;
      buffer += String(chunk || '');
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      try {
        const msg = JSON.parse(line);
        if (msg.ok) finish(resolve, msg.result);
        else finish(reject, new Error(msg.error || 'Native tag helper error'));
      } catch (err) { finish(reject, err); }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => finish(reject, err));
    child.on('exit', code => { if (!settled) finish(reject, new Error(stderr.trim() || `Native tag helper exited ${code}`)); });
    try { child.stdin.write(JSON.stringify({ ...request, id: '1' }) + '\n'); }
    catch (err) { finish(reject, err); }
  });
}

function id3Synchsafe(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
}

function readId3Size(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  return ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
}

function musicBeePopmValue(stars) {
  // MusicBee's MP3 POPM values are discrete, including half-stars.
  // 0.5..5.0 => 13, 1, 54, 64, 118, 128, 186, 196, 242, 255.
  const values = [0, 13, 1, 54, 64, 118, 128, 186, 196, 242, 255];
  const halfSteps = Math.max(0, Math.min(10, Math.round((Number(stars) || 0) * 2)));
  return values[halfSteps];
}

function musicBeePopmByte(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? Math.round(n) : 0;
}

function musicBeePopmStars(raw) {
  const values = [0, 13, 1, 54, 64, 118, 128, 186, 196, 242, 255];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  let best = 0, bestDistance = Infinity;
  for (let i = 1; i < values.length; i++) {
    const distance = Math.abs(values[i] - n);
    if (distance < bestDistance) { bestDistance = distance; best = i; }
  }
  return best / 2;
}

function id3FrameSize(buf, version) {
  if (!buf || buf.length < 4) return -1;
  return version >= 4
    ? ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f)
    : buf.readUInt32BE(0);
}

function parseId3Frames(payload, version) {
  const frames = [];
  let pos = 0;
  while (pos + 10 <= payload.length) {
    const id = payload.toString('ascii', pos, pos + 4);

    // Valid ID3 padding is zero bytes at the end of the tag. Older Beehive
    // builds could accidentally append a frame after that padding, however.
    // Strawberry/TagLib reads the frame list rather than treating the first
    // zero byte as an absolute end marker, so recover those frames here too.
    if (/^\x00{4}$/.test(id)) {
      let next = pos;
      while (next < payload.length && payload[next] === 0) next++;
      if (next + 10 <= payload.length) {
        const nextId = payload.toString('ascii', next, next + 4);
        const nextSize = id3FrameSize(payload.subarray(next + 4, next + 8), version);
        if (/^[A-Z0-9]{4}$/.test(nextId) && nextSize > 0 && next + 10 + nextSize <= payload.length) {
          pos = next;
          continue;
        }
      }
      break;
    }

    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = id3FrameSize(payload.subarray(pos + 4, pos + 8), version);
    if (frameSize <= 0 || pos + 10 + frameSize > payload.length) break;
    frames.push({ id, data: payload.subarray(pos + 10, pos + 10 + frameSize), raw: payload.subarray(pos, pos + 10 + frameSize) });
    pos += 10 + frameSize;
  }
  return { frames, trailing: payload.subarray(pos) };
}

function txxxDescription(data) {
  if (!data || !data.length) return '';
  const encoding = data[0];
  const body = data.subarray(1);
  if (encoding === 0 || encoding === 3) {
    const nul = body.indexOf(0);
    return body.subarray(0, nul >= 0 ? nul : body.length).toString(encoding === 3 ? 'utf8' : 'latin1').trim();
  }
  if (encoding === 1 || encoding === 2) {
    // MusicBee commonly uses UTF-16LE for TXXX when Unicode text is required.
    let end = body.length;
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) { end = i; break; }
    }
    try { return body.subarray(0, end).toString('utf16le').replace(/^\uFEFF/, '').trim(); } catch { return ''; }
  }
  return '';
}

function makeId3Frame(id, data, version) {
  const size = version >= 4 ? id3Synchsafe(data.length) : (() => { const b = Buffer.alloc(4); b.writeUInt32BE(data.length); return b; })();
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.alloc(2), data]);
}

function makeMusicBeeLoveFrame(version, value = 'L') {
  // MusicBee's Love field: TXXX, encoding 0 (ISO-8859-1), description
  // "LOVE RATING". Beehive uses L for Loved and 0 for Unloved.
  const data = Buffer.concat([
    Buffer.from([0]),
    Buffer.from('LOVE RATING', 'latin1'),
    Buffer.from([0]),
    Buffer.from(String(value), 'latin1')
  ]);
  return makeId3Frame('TXXX', data, version);
}

function makeMusicBeePopmFrame(stars, version, counter = 0) {
  const value = musicBeePopmValue(stars);
  // Strawberry/TagLib keeps the POPM frame even when the rating is cleared;
  // it changes only the POPM rating byte to 0. Mirror that behavior.
  // MusicBee's POPM structure is:
  // "MusicBee" + NUL + rating byte + 32-bit play counter.
  // Preserve the existing counter when only the rating changes, matching
  // Strawberry's behavior of changing POPM.rating without resetting counter.
  const safeCounter = Number.isFinite(Number(counter)) && Number(counter) >= 0
    ? Math.min(0xFFFFFFFF, Math.floor(Number(counter)))
    : 0;
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(safeCounter >>> 0, 0);
  const data = Buffer.concat([
    Buffer.from('MusicBee', 'latin1'),
    Buffer.from([0, value]),
    counterBuf
  ]);
  return makeId3Frame('POPM', data, version);
}

function makeFMPSRatingFrame(stars, version) {
  const value = Math.max(0, Math.min(1, (Number(stars) || 0) / 5));
  const text = String(value);
  const data = Buffer.concat([
    Buffer.from([3]), // UTF-8, matching TagLib's text-frame semantics.
    Buffer.from('FMPS_Rating', 'utf8'),
    Buffer.from([0]),
    Buffer.from(text, 'utf8')
  ]);
  return makeId3Frame('TXXX', data, version);
}


async function withMusicBeeWriteLock(trackPath, fn) {
  const key = path.resolve(trackPath);
  const previous = musicBeeWriteLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  musicBeeWriteLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (musicBeeWriteLocks.get(key) === current) musicBeeWriteLocks.delete(key);
  }
}


async function readWavId3Tag(filePath) {
  const input = await fsp.readFile(filePath);
  if (input.length < 12 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  while (pos + 8 <= input.length) {
    const id = input.toString('ascii', pos, pos + 4);
    const size = input.readUInt32LE(pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > input.length) break;
    if (id === 'id3 ' || id === 'ID3 ') {
      const tag = input.subarray(dataStart, dataEnd);
      if (tag.length >= 10 && tag.toString('ascii', 0, 3) === 'ID3') {
        return { input, chunkPos: pos, chunkSize: size, dataStart, dataEnd, tag };
      }
    }
    pos = dataEnd + (size & 1);
  }
  return null;
}

async function readWavId3TagLight(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const header = Buffer.alloc(12);
      const hr = await fd.read(header, 0, 12, 0);
      if (hr.bytesRead < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;
      const stat = await fd.stat();
      let pos = 12;
      while (pos + 8 <= stat.size) {
        const ch = Buffer.alloc(8);
        const r = await fd.read(ch, 0, 8, pos);
        if (r.bytesRead < 8) break;
        const id = ch.toString('ascii', 0, 4);
        const size = ch.readUInt32LE(4);
        const dataStart = pos + 8;
        const dataEnd = dataStart + size;
        if (dataEnd > stat.size || dataEnd < dataStart) break;
        if ((id === 'id3 ' || id === 'ID3 ') && size >= 10 && size <= 32 * 1024 * 1024) {
          const tag = Buffer.alloc(size);
          await fd.read(tag, 0, size, dataStart);
          if (tag.toString('ascii', 0, 3) === 'ID3') return tag;
        }
        pos = dataEnd + (size & 1);
      }
    } finally { await fd.close(); }
  } catch {}
  return null;
}

async function readWavMusicBeeLove(filePath) {
  return readSharedWavMusicBeeLove(filePath);
}

async function readWavMusicBeePopmRaw(filePath) {
  return readSharedWavMusicBeePopmRaw(filePath);
}

async function updateWavMusicBeeTags(trackPath, { stars = null, loved = null } = {}) {
  return withMusicBeeWriteLock(trackPath, async () => {
    const found = await readWavId3Tag(trackPath);
    if (!found) throw new Error('WAV file does not contain an ID3 tag.');
    const input = found.input;
    const tag = found.tag;
    const version = tag[3] >= 4 ? 4 : 3;
    const tagSize = readId3Size(tag);
    const payload = tag.subarray(10, Math.min(tag.length, 10 + tagSize));
    const parsed = parseId3Frames(payload, version);
    const frames = parsed.frames;
    const trailing = parsed.trailing;
    const isPadding = trailing.length === 0 || trailing.every(byte => byte === 0);
    // A tag this reader can't walk to the end (an extended header, unsynchronisation, ID3v2.2, a frame
    // it can't parse) would lose every frame after that point if rebuilt: leave the file alone.
    if (!isPadding || (tag[5] & 0xC0) || tag[3] < 3) throw new Error('This WAV file\'s tag is in a form Hive can\'t rewrite safely; it was left as it is.');
    const outputFrames = [];
    let counter = 0;

    for (const frame of frames) {
      let remove = false;
      if (stars !== null && frame.id === 'POPM') {
        const nul = frame.data.indexOf(0);
        if (nul >= 0) {
          const email = frame.data.subarray(0, nul).toString('latin1').trim().toLowerCase();
          if (email === 'musicbee') {
            if (nul + 6 <= frame.data.length) counter = frame.data.readUInt32BE(nul + 2);
            remove = true;
          }
        }
      }
      if (stars !== null && frame.id === 'TXXX' && txxxDescription(frame.data).trim().toUpperCase() === 'FMPS_RATING') remove = true;
      if (loved !== null && frame.id === 'TXXX') {
        const desc = txxxDescription(frame.data).trim().toUpperCase();
        if (isBeehiveLoveFieldName(desc)) remove = true;
      }
      if (!remove) outputFrames.push(frame.raw);
    }

    if (loved !== null) if (loved) outputFrames.push(makeMusicBeeLoveFrame(version, 'L'));
    if (stars !== null) {
      // Keep the MusicBee POPM source of truth for WAVs with ID3, matching MP3.
      // FMPS_Rating is also synchronized for portability, but Beehive's reader
      // intentionally ignores it on WAV so other applications cannot override
      // the MusicBee value.
      outputFrames.push(makeFMPSRatingFrame(stars, version));
      outputFrames.push(makeMusicBeePopmFrame(stars, version, counter));
    }

    const keptTrailing = isPadding ? trailing : Buffer.alloc(0);
    const newPayload = Buffer.concat([...outputFrames, keptTrailing]);
    const newTag = Buffer.concat([
      Buffer.from('ID3','ascii'),
      Buffer.from([version,0,tag[5] & 0xF0]),
      id3Synchsafe(newPayload.length),
      newPayload
    ]);

    const oldChunkTotal = 8 + found.chunkSize + (found.chunkSize & 1);
    const newChunkSize = newTag.length;
    const newChunkTotal = 8 + newChunkSize + (newChunkSize & 1);
    let output;
    if (newChunkTotal <= oldChunkTotal) {
      const chunk = Buffer.alloc(oldChunkTotal);
      Buffer.from('id3 ','ascii').copy(chunk, 0);
      chunk.writeUInt32LE(oldChunkTotal - 8 - ((oldChunkTotal - 8) & 1), 4);
      // Keep the existing RIFF chunk size exactly stable; pad the ID3 payload.
      newTag.copy(chunk, 8);
      output = Buffer.concat([input.subarray(0, found.chunkPos), chunk, input.subarray(found.chunkPos + oldChunkTotal)]);
    } else {
      const chunk = Buffer.alloc(newChunkTotal);
      Buffer.from('id3 ','ascii').copy(chunk, 0);
      chunk.writeUInt32LE(newChunkSize, 4);
      newTag.copy(chunk, 8);
      output = Buffer.concat([input.subarray(0, found.chunkPos), chunk, input.subarray(found.chunkPos + oldChunkTotal)]);
      const riffSize = output.length - 8;
      output.writeUInt32LE(riffSize >>> 0, 4);
    }

    const temp = `${trackPath}.beehive-musicbee-${crypto.randomBytes(6).toString('hex')}.tmp`;
    await writeAndSyncReplacement(temp, trackPath, output);
  });
}

async function updateMp3MusicBeeTagsUnlocked(trackPath, { stars = null, loved = null } = {}) {
  const input = await fsp.readFile(trackPath);
  let version = 3;
  let flags = 0;
  let audioOffset = 0;
  let payload = Buffer.alloc(0);

  if (input.length >= 10 && input.toString('ascii', 0, 3) === 'ID3') {
    version = input[3] >= 4 ? 4 : 3;
    flags = input[5];
    const size = readId3Size(input);
    const end = Math.min(input.length, 10 + size);
    payload = input.subarray(10, end);
    audioOffset = end;
  }

  const parsed = parseId3Frames(payload, version);
  const frames = parsed.frames;
  const trailing = parsed.trailing;
  const isPadding = trailing.length === 0 || trailing.every(byte => byte === 0);
  // See the WAV writer: a tag this reader can't walk to the end is never rebuilt.
  if (payload.length && (!isPadding || (flags & 0xC0) || input[3] < 3)) throw new Error('This MP3\'s tag is in a form Hive can\'t rewrite safely; it was left as it is.');
  const outputFrames = [];
  let existingMusicBeeCounter = 0;

  for (const frame of frames) {
    let remove = false;
    if (frame.id === 'POPM' && stars !== null) {
      const nul = frame.data.indexOf(0);
      if (nul >= 0) {
        const email = frame.data.subarray(0, nul).toString('latin1').trim().toLowerCase();
        // Only replace MusicBee's own POPM. Preserve its play counter when
        // changing the rating, just as Strawberry changes only POPM.rating.
        if (email === 'musicbee') {
          if (nul + 6 <= frame.data.length) {
            existingMusicBeeCounter = frame.data.readUInt32BE(nul + 2);
          }
          remove = true;
        }
      }
    }
    if (frame.id === 'TXXX' && stars !== null) {
      // Strawberry stores its portable normalized rating as TXXX:FMPS_Rating.
      // Keep this synchronized with the MusicBee POPM value.
      const desc = txxxDescription(frame.data).trim().toUpperCase();
      if (desc === 'FMPS_RATING') remove = true;
    }
    if (frame.id === 'TXXX' && loved !== null) {
      const desc = txxxDescription(frame.data).toUpperCase();
      // Replace the exact MusicBee Love field. Also remove Beehive's old
      // incorrect TXXX:Love spelling if it exists from an earlier build.
      if (isBeehiveLoveFieldName(desc)) remove = true;
    }
    if (!remove) outputFrames.push(frame.raw);
  }

  // Write only MusicBee's definitive LOVE RATING field; do not create the
  // legacy TXXX:Love field.
  if (loved !== null) {
    // Keep one authoritative Love field. Unlove removes every Beehive Love field from the file.
    // The absence of the field is the authoritative Unloved state.
    if (loved) outputFrames.push(makeMusicBeeLoveFrame(version, 'L'));
  }
  if (stars !== null) {
    // This deliberately mirrors Strawberry's SetRating(): FMPS_Rating is
    // always replaced (including 0), and the MusicBee POPM frame remains in
    // the tag with its rating byte changed to 0 when the user clears it.
    // Keeping the frame is important: it gives us a deterministic, writable
    // source-of-truth instead of relying on deletion through a hand-written
    // ID3 parser.
    outputFrames.push(makeFMPSRatingFrame(stars, version));
    outputFrames.push(makeMusicBeePopmFrame(stars, version, existingMusicBeeCounter));
  }

  // Always keep ID3 padding at the very end. New/replaced frames must be
  // placed before it; putting them after padding makes otherwise valid tags
  // invisible to strict ID3 readers (and was the reason ratings appeared to
  // save in Beehive but disappeared after restart).
  const keptTrailing = isPadding ? trailing : Buffer.alloc(0);
  payload = Buffer.concat([...outputFrames, keptTrailing]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([version, 0, flags & 0xF0]),
    id3Synchsafe(payload.length)
  ]);
  const output = Buffer.concat([header, payload, input.subarray(audioOffset)]);
  const temp = `${trackPath}.beehive-musicbee-${crypto.randomBytes(6).toString('hex')}.tmp`;
  await writeAndSyncReplacement(temp, trackPath, output);
}

async function updateMp3MusicBeeTags(trackPath, options = {}) {
  return withMusicBeeWriteLock(trackPath, () => updateMp3MusicBeeTagsUnlocked(trackPath, options));
}

async function writeMp3MusicBeeRating(trackPath, stars) {
  await updateMp3MusicBeeTags(trackPath, { stars });
}

function isFavoriteLoveValue(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'L' || v === 'Y' || v === 'YES' || v === 'TRUE' ||
    v === '1' || v === 'LOVE' || v === 'LOVED' ||
    v === 'FAVORITE' || v === 'FAVOURITE';
}

// Every Love field Beehive has historically written/recognized. When Unlove is
// requested, ALL of these aliases are normalized to one LOVE RATING field. Unlove removes the Love fields; Love writes one canonical LOVE RATING=L field.
const BEEHIVE_LOVE_FIELD_NAMES = new Set([
  'LOVE RATING',
  'LOVE',
  'LOVERATING',
  'MUSICBEE/LOVE RATING',
  'MUSICBEE/LOVERATING',
  'MUSICBEE LOVE RATING'
]);
function isBeehiveLoveFieldName(value) {
  return BEEHIVE_LOVE_FIELD_NAMES.has(String(value ?? '').trim().toUpperCase());
}


async function writeMp3MusicBeeLove(trackPath, loved) {
  await updateMp3MusicBeeTags(trackPath, { loved: !!loved });
}

function mp4Atom(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  const size = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8);
  if (size === 0) return {offset,size:buffer.length-offset,type,header:8,end:buffer.length};
  if (size === 1) { if(offset+16>buffer.length)return null; const n=Number(buffer.readBigUInt64BE(offset+8)); if(!Number.isSafeInteger(n)||n<16||offset+n>buffer.length)return null; return {offset,size:n,type,header:16,end:offset+n}; }
  if (size < 8 || offset + size > buffer.length) return null;
  return {offset,size,type,header:8,end:offset+size};
}
function mp4Children(buffer, atom) {
  let p=atom.offset+atom.header+(atom.type==='meta'?4:0), out=[];
  while(p+8<=atom.end){const a=mp4Atom(buffer,p);if(!a||a.end>atom.end)break;out.push(a);p=a.end;} return out;
}
function mp4FindPath(buffer, atom, types, i=0) { if(i>=types.length)return atom; for(const c of mp4Children(buffer,atom)) if(c.type===types[i]) {const f=mp4FindPath(buffer,c,types,i+1);if(f)return f;} return null; }
function mp4AtomWithPayload(type,payload){const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length,0);b.write(type,4,4,'latin1');payload.copy(b,8);return b;}
function mp4FullBoxAtom(type,payload){return mp4AtomWithPayload(type,Buffer.concat([Buffer.alloc(4),payload]));}
function makeMp4FreeformLoveAtom(loved){const mean=mp4FullBoxAtom('mean',Buffer.from('com.apple.iTunes'));const name=mp4FullBoxAtom('name',Buffer.from('LOVE RATING'));const data=mp4AtomWithPayload('data',Buffer.concat([Buffer.from([0,0,0,1]),Buffer.alloc(4),Buffer.from(loved?'L':'0')]));return mp4AtomWithPayload('----',Buffer.concat([mean,name,data]));}
function parseMp4FreeformName(buffer,atom){if(atom.type!=='----')return null;let mean='',name='';for(const c of mp4Children(buffer,atom)){if(c.type==='mean'||c.type==='name'){const start=c.offset+c.header+4;const text=buffer.subarray(start,c.end).toString('utf8').replace(/\0+$/g,'');if(c.type==='mean')mean=text;else name=text;}}return {mean,name};}
function rebuildMp4Parent(buffer,parent,oldChild,newChild){const oldPayload=buffer.subarray(parent.offset+parent.header,parent.end);const rel=oldChild.offset-(parent.offset+parent.header);const before=oldPayload.subarray(0,rel),after=oldPayload.subarray(rel+oldChild.size);return mp4AtomWithPayload(parent.type,Buffer.concat([before,newChild,after]));}
// A rewritten moov that changed size must not move the audio without telling the file where it
// went: the chunk offsets (stco/co64) point into mdat by absolute position. Moving it by the
// size change without them made loved songs unplayable. A free atom right after moov takes up the
// change when it can, so the audio stays exactly where it was; otherwise the offsets of
// everything after moov are shifted by the change.
function mp4ShiftChunkOffsets(moovBuf,after,delta){
  const walk=(from,to)=>{let p=from;while(p+8<=to){const a=mp4Atom(moovBuf,p);if(!a||a.end>to)break;
    if(['trak','mdia','minf','stbl','moov'].includes(a.type))walk(a.offset+a.header,a.end);
    else if(a.type==='stco'){const n=moovBuf.readUInt32BE(a.offset+a.header+4);for(let i=0;i<n;i++){const o=a.offset+a.header+8+i*4;const v=moovBuf.readUInt32BE(o);if(v>=after){const nv=v+delta;if(nv<0||nv>0xFFFFFFFF)throw new Error('MP4/M4A chunk offset out of range after rewrite.');moovBuf.writeUInt32BE(nv,o);}}}
    else if(a.type==='co64'){const n=moovBuf.readUInt32BE(a.offset+a.header+4);for(let i=0;i<n;i++){const o=a.offset+a.header+8+i*8;const v=moovBuf.readBigUInt64BE(o);if(v>=BigInt(after))moovBuf.writeBigUInt64BE(v+BigInt(delta),o);}}
    p=a.end;}};
  walk(0,moovBuf.length);
}
function mp4ReplaceMoov(input,top,moov,newMoov){
  const delta=newMoov.length-moov.size;
  if(delta===0)return Buffer.concat([input.subarray(0,moov.offset),newMoov,input.subarray(moov.end)]);
  const next=top.find(a=>a.offset===moov.end);
  const room=next&&next.type==='free'&&next.header===8?next.size-delta:-1;
  if(room===0||room>=8){const free=room===0?Buffer.alloc(0):mp4AtomWithPayload('free',Buffer.alloc(room-8));return Buffer.concat([input.subarray(0,moov.offset),newMoov,free,input.subarray(next.end)]);}
  const fixed=Buffer.from(newMoov);mp4ShiftChunkOffsets(fixed,moov.end,delta);
  return Buffer.concat([input.subarray(0,moov.offset),fixed,input.subarray(moov.end)]);
}
async function writeMp4LoveTag(trackPath,loved){const input=await fsp.readFile(trackPath);let p=0,top=[];while(p+8<=input.length){const a=mp4Atom(input,p);if(!a)break;top.push(a);p=a.end;}const moov=top.find(a=>a.type==='moov');if(!moov)throw new Error('MP4/M4A file does not contain a moov atom.');const udta=mp4FindPath(input,moov,['udta']),meta=udta&&mp4FindPath(input,udta,['meta']),ilst=meta&&mp4FindPath(input,meta,['ilst']);if(!udta||!meta||!ilst)throw new Error('MP4/M4A file does not contain an iTunes metadata ilst atom.');const kept=[];for(const c of mp4Children(input,ilst)){const ff=parseMp4FreeformName(input,c);if(ff&&ff.mean.toLowerCase()==='com.apple.itunes'&&isBeehiveLoveFieldName(ff.name))continue;kept.push(input.subarray(c.offset,c.end));}if (loved) kept.push(makeMp4FreeformLoveAtom(true));let child=ilst,current=mp4AtomWithPayload('ilst',Buffer.concat(kept));for(const parent of [meta,udta,moov]){current=rebuildMp4Parent(input,parent,child,current);child=parent;}const out=mp4ReplaceMoov(input,top,moov,current);const temp=await metadataTempPath(trackPath,'love');await writeAndSyncReplacement(temp,trackPath,out);}
async function verifyMp4LoveTag(trackPath, expected) {
  const input = await fsp.readFile(trackPath);
  let p = 0;
  const top = [];
  while (p + 8 <= input.length) {
    const a = mp4Atom(input, p);
    if (!a) break;
    top.push(a);
    p = a.end;
  }
  const moov = top.find(a => a.type === 'moov');
  if (!moov) return !expected;
  const ilst = mp4FindPath(input, moov, ['udta', 'meta', 'ilst']);
  if (!ilst) return !expected;

  let loveCount = 0;
  let lovedValueCount = 0;
  let loveValueIsUnloved = false;
  for (const c of mp4Children(input, ilst)) {
    const ff = parseMp4FreeformName(input, c);
    if (!ff || ff.mean.toLowerCase() !== 'com.apple.itunes' ||
        !isBeehiveLoveFieldName(ff.name)) continue;
    loveCount++;
    const d = mp4Children(input, c).find(x => x.type === 'data');
    if (!d) continue;
    const value = input.subarray(d.offset + d.header + 8, d.end)
      .toString('utf8').trim().toUpperCase();
    if (value === 'L') lovedValueCount++;
    if (value === '0') loveValueIsUnloved = true;
  }
  return expected ? (loveCount === 1 && lovedValueCount === 1) : (loveCount === 0);
}
async function verifyLoveTag(trackPath, expected) {
  const ext = path.extname(trackPath).toLowerCase();

  // Each container has its own native MusicBee Love representation.
  // Verification deliberately checks the whole tag/container so an Unlove
  // operation cannot succeed while a duplicate/legacy Love field remains.
  if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') {
    const input = await fsp.readFile(trackPath);
    let p = 0;
    const top = [];
    while (p + 8 <= input.length) {
      const a = mp4Atom(input, p);
      if (!a) break;
      top.push(a);
      p = a.end;
    }
    const moov = top.find(a => a.type === 'moov');
    if (!moov) return !expected;
    const ilst = mp4FindPath(input, moov, ['udta', 'meta', 'ilst']);
    if (!ilst) return !expected;

    let loveCount = 0;
    let lovedValueCount = 0;
    let loveValueIsUnloved = false;
    for (const c of mp4Children(input, ilst)) {
      const ff = parseMp4FreeformName(input, c);
      if (!ff || ff.mean.toLowerCase() !== 'com.apple.itunes' ||
          !isBeehiveLoveFieldName(ff.name)) continue;
      loveCount++;
      const d = mp4Children(input, c).find(x => x.type === 'data');
      if (!d) continue;
      const value = input.subarray(d.offset + d.header + 8, d.end)
        .toString('utf8').trim().toUpperCase();
      if (value === 'L') lovedValueCount++;
      if (value === '0') loveValueIsUnloved = true;
    }
    return expected ? (loveCount === 1 && lovedValueCount === 1) : (loveCount === 0);
  }

  // FLAC verification goes through runTagHelperOnce's own read_love call in
  // embedLoveInFile below, not this function -- see the comment there.

  let data = await fsp.readFile(trackPath);
  if (ext === '.wav') {
    let p = 12;
    let found = null;
    while (p + 8 <= data.length) {
      const id = data.toString('ascii', p, p + 4);
      const size = data.readUInt32LE(p + 4);
      const dataStart = p + 8;
      if (dataStart + size > data.length) break;
      if (id === 'id3 ' || id === 'ID3 ') {
        found = data.subarray(dataStart, dataStart + size);
        break;
      }
      p = dataStart + size + (size & 1);
    }
    if (!found) return !expected;
    data = found;
  }

  if (ext === '.mp3' || ext === '.wav') {
    if (data.length < 10 || data.toString('ascii', 0, 3) !== 'ID3') return !expected;
    const version = data[3] >= 4 ? 4 : 3;
    const size = readId3Size(data);
    const payload = data.subarray(10, Math.min(data.length, 10 + size));
    let loveCount = 0;
    let lovedValueCount = 0;
    let loveValueIsUnloved = false;
    for (const frame of parseId3Frames(payload, version).frames) {
      if (frame.id !== 'TXXX') continue;
      const desc = txxxDescription(frame.data).trim().toUpperCase();
      if (!isBeehiveLoveFieldName(desc)) continue;
      loveCount++;
      const body = frame.data.subarray(1);
      const nul = body.indexOf(0);
      const value = body.subarray(nul >= 0 ? nul + 1 : 0)
        .toString(frame.data[0] === 3 ? 'utf8' : 'latin1')
        .trim().toUpperCase();
      if (value === 'L') lovedValueCount++;
      if (value === '0') loveValueIsUnloved = true;
    }
    return expected ? (loveCount === 1 && lovedValueCount === 1) : (loveCount === 0);
  }

  return false;
}

async function embedLoveInFile(trackPath, loved) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  const ext = path.extname(trackPath).toLowerCase();
  // MP3 and MP4/M4A go through Mutagen like FLAC (below): its writers keep the audio's offsets,
  // reuse the tag's padding and keep frames the handwritten writers couldn't read. The handwritten
  // MP4 writer moved loved songs' audio away from their chunk offsets (they wouldn't play).
  if (ext === '.wav') { await updateWavMusicBeeTags(trackPath, { loved: !!loved }); if (!await verifyLoveTag(trackPath, !!loved)) throw new Error('WAV Love tag verification failed after writing.'); return true; }
  if (ext === '.flac') {
    // Edit a temp copy on the same filesystem via the bundled Mutagen backend,
    // verify it, then fsync+rename it over the original so a crash or
    // force-quit mid-write can never leave the real file half-written.
    return withMusicBeeWriteLock(trackPath, async () => {
      const temp = await metadataTempPath(trackPath, 'love');
      try {
        await fsp.copyFile(trackPath, temp);
        await runTagHelperOnce({ op: 'write_love', path: temp, loved: !!loved });
        const readBack = await runTagHelperOnce({ op: 'read_love', path: temp });
        if (Boolean(readBack?.loved) !== Boolean(loved)) throw new Error('FLAC Love tag verification failed after writing.');
        await syncAndRenameExistingTemp(temp, trackPath);
        return true;
      } catch (err) {
        try { await fsp.unlink(temp); } catch {}
        throw new Error(`Could not embed FLAC Love tag: ${err.message}`);
      }
    });
  }

  // Any other format (ogg, opus, wma, ...) without a handwritten container
  // writer above: same temp-copy/verify/atomic-rename pattern via the
  // bundled Mutagen backend, which has a generic mutagen.File(...) fallback
  // for exactly this case.
  return withMusicBeeWriteLock(trackPath, async () => {
    const temp = await metadataTempPath(trackPath, 'love');
    try {
      await fsp.copyFile(trackPath, temp);
      await runTagHelperOnce({ op: 'write_love', path: temp, loved: !!loved });
      const readBack = await runTagHelperOnce({ op: 'read_love', path: temp });
      if (Boolean(readBack?.loved) !== Boolean(loved)) throw new Error('Love tag verification failed after writing.');
      await syncAndRenameExistingTemp(temp, trackPath);
      return true;
    } catch (err) {
      try { await fsp.unlink(temp); } catch {}
      throw new Error(`Could not embed Love tag: ${err.message}`);
    }
  });
}
process.on('message', async msg => {
  if (!msg || msg.cmd !== 'love') return;
  const trackPath = String(msg.path || '');
  const loved = !!msg.loved;
  try {
    await embedLoveInFile(trackPath, loved);
    if (process.send) process.send({ ok: true, path: trackPath });
  } catch (err) {
    if (process.send) process.send({ ok: false, path: trackPath, error: err?.message || String(err) });
  }
});
