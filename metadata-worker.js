const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { readWavMusicBeeLove: readSharedWavMusicBeeLove, readWavMusicBeePopmRaw: readSharedWavMusicBeePopmRaw } = require('./wav-id3');
const { spawn } = require('child_process');

// Metadata work should yield to playback and UI activity on Linux.
try { if (typeof process.setPriority === 'function') process.setPriority(process.pid, 10); } catch {}

// Per-file write serialization for metadata operations performed by this worker.
// This must live in the worker because bulk Love writes run here rather than in main.js.

async function metadataTempPath(target, label='media') {
  const dir = path.join(os.tmpdir(), 'beehive-metadata');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `media-${process.pid}-${Date.now()}-${label}-${crypto.randomBytes(8).toString('hex')}${path.extname(target).toLowerCase()}`);
}
async function writeAndSyncReplacement(temp, target, data) {
  await fsp.writeFile(temp, data);
  const fd = await fsp.open(temp, 'r+');
  try { await fd.sync(); } finally { await fd.close(); }
  try { await fsp.rename(temp, target); }
  catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    await fsp.copyFile(temp, target);
    await fsp.unlink(temp);
  }
}

const musicBeeWriteLocks = new Map();


async function runFfmpeg(args) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(err));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.split('\n').filter(Boolean).slice(-4).join(' ') || `ffmpeg exited ${code}`)));
  });
}


function runMetaflac(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('metaflac', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(err));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `metaflac exited ${code}`)));
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
const BEEHIVE_LOVE_FIELD_NAMES = new Set(['LOVE RATING', 'LOVE']);
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
async function writeMp4LoveTag(trackPath,loved){const input=await fsp.readFile(trackPath);let p=0,top=[];while(p+8<=input.length){const a=mp4Atom(input,p);if(!a)break;top.push(a);p=a.end;}const moov=top.find(a=>a.type==='moov');if(!moov)throw new Error('MP4/M4A file does not contain a moov atom.');const udta=mp4FindPath(input,moov,['udta']),meta=udta&&mp4FindPath(input,udta,['meta']),ilst=meta&&mp4FindPath(input,meta,['ilst']);if(!udta||!meta||!ilst)throw new Error('MP4/M4A file does not contain an iTunes metadata ilst atom.');const kept=[];for(const c of mp4Children(input,ilst)){const ff=parseMp4FreeformName(input,c);if(ff&&ff.mean.toLowerCase()==='com.apple.itunes'&&isBeehiveLoveFieldName(ff.name))continue;kept.push(input.subarray(c.offset,c.end));}if (loved) kept.push(makeMp4FreeformLoveAtom(true));let child=ilst,current=mp4AtomWithPayload('ilst',Buffer.concat(kept));for(const parent of [meta,udta,moov]){current=rebuildMp4Parent(input,parent,child,current);child=parent;}const out=Buffer.concat([input.subarray(0,moov.offset),current,input.subarray(moov.end)]);const temp=await metadataTempPath(trackPath,'love');await writeAndSyncReplacement(temp,trackPath,out);}
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

  if (ext === '.flac') {
    try {
      const c = spawn('metaflac', ['--export-tags-to=-', trackPath], { windowsHide: true });
      let output = '';
      c.stdout.on('data', d => { output += d.toString(); });
      const code = await new Promise((resolve, reject) => {
        c.on('error', reject);
        c.on('close', resolve);
      });
      if (code !== 0) return false;
      const lines = output.split(/\r?\n/).filter(Boolean);
      const loveLines = lines.filter(line => isBeehiveLoveFieldName(line.split('=')[0]));
      if (!expected) return loveLines.length === 0;
      return loveLines.length === 1 && /^LOVE RATING=L$/i.test(loveLines[0].trim());
    } catch {
      return false;
    }
  }

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
  if (ext === '.mp3') { await writeMp3MusicBeeLove(trackPath, !!loved); if (!await verifyLoveTag(trackPath, !!loved)) throw new Error('MP3 Love tag verification failed after writing.'); return true; }
  if (ext === '.wav') { await updateWavMusicBeeTags(trackPath, { loved: !!loved }); if (!await verifyLoveTag(trackPath, !!loved)) throw new Error('WAV Love tag verification failed after writing.'); return true; }
  if (ext === '.flac') { const args=['--remove-tag=LOVE RATING','--remove-tag=LOVE',...(loved ? ['--set-tag=LOVE RATING=L'] : []),trackPath]; await runMetaflac(args); if(!await verifyLoveTag(trackPath,!!loved)) throw new Error('FLAC Love tag verification failed after writing.'); return true; }
  if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') { await writeMp4LoveTag(trackPath,!!loved); if(!await verifyLoveTag(trackPath,!!loved)) throw new Error('MP4/M4A Love tag verification failed after writing.'); return true; }
  const temp=await metadataTempPath(trackPath,'love');
  try { await runFfmpeg(['-hide_banner','-loglevel','error','-y','-i',trackPath,'-map','0','-c','copy',...(loved ? ['-metadata','LOVE RATING=L'] : ['-metadata','LOVE RATING=']),temp]); await fsp.rename(temp,trackPath); if(!await verifyLoveTag(trackPath,!!loved)) throw new Error('Love tag verification failed after writing.'); return true; } catch(err){try{await fsp.unlink(temp);}catch{} throw new Error(`Could not embed Love tag: ${err.message}`);}
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
