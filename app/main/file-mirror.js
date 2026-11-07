'use strict';

// Hive Link's file mirror: a phone keeps its music folder one to one with
// Hive's library folder, file for file (songs, covers, playlists, notes alike).
// Paths are relative to the library folder, with '/' between folders.
//
// Nothing is ever destroyed here: a file the phone replaces or deletes is moved
// into the keep folder (Hive's Deleted songs) under the same relative path.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { replaceFile } = require('./replace-file');

// Hive's own half-written files (tag writes, song uploads, mirror copies): never mirrored.
// Hive's in-place repair copies (".Song.flac.hive-repair-<hex>.flac") and the phone's staged tag edits.
const HIVE_SCRATCH = /^\..*\.hive-repair-[0-9a-f]+(\.[a-z0-9]+)?$|\.hive-edit$/i;
const HIVE_TEMP = /(\.beehive-[a-z-]+-[0-9a-f]{6,}(\.[a-z0-9]+)?|\.hivelink-part|\.hive-mirror-part)$/i;

// Names Windows can't hold: it would save "Song ." as "Song", the two sides would never match,
// and the file would be sent again on every sync.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function windowsCantHold(segment) { return /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment); }

/** The absolute path of [rel] inside [root], or null for anything that would leave it (or that this system can't name). */
function safeRel(root, rel, platform = process.platform) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.includes('\0') || r.startsWith('/') || /^[a-z]:/i.test(r)) return null;
  if (r.split('/').some(s => s === '' || s === '.' || s === '..')) return null;
  if (platform === 'win32' && r.split('/').some(windowsCantHold)) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, ...r.split('/'));
  return abs.startsWith(base + path.sep) ? abs : null;
}

/**
 * Every file under [root]: { files: [{ p: relative path, s: size, m: modified (ms) }], unreadable: [relative paths] }.
 * A folder or file that couldn't be read is named in `unreadable`, never just left out: left out, the
 * phone would take its songs for deleted ones. A library folder that can't be read at all (a drive
 * not mounted) throws.
 */
async function list(root) {
  const base = path.resolve(root);
  const st = await fs.promises.stat(base).catch(() => null);
  if (!st?.isDirectory()) throw Object.assign(new Error("Hive can't reach its library folder right now (is the drive connected?)."), { code: 'LIBRARY_AWAY' });
  const files = [];
  const unreadable = [];
  async function walk(dir, prefix) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (err) {
      if (!prefix) throw Object.assign(new Error("Hive can't read its library folder right now."), { code: 'LIBRARY_AWAY' });
      // Gone between listing its parent and reading it: really gone, not unreadable.
      if (err?.code !== 'ENOENT') unreadable.push(prefix);
      return;
    }
    const pending = [];
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      // Hidden folders (Hive's own .beehive-tmp edits in progress, other apps' .stfolder and the like)
      // hold no songs: half-written files in them would be copied as music. Hidden FILES can be songs
      // (".Exe.mp3", "...And So It Was.mp3"), so only Hive's own scratch files are left out.
      if (e.isDirectory()) { if (!e.name.startsWith('.')) await walk(abs, rel); continue; }
      if (!e.isFile() || HIVE_TEMP.test(e.name) || HIVE_SCRATCH.test(e.name)) continue;
      pending.push({ rel, abs });
    }
    // A folder's files are looked at many at a time: one by one, a big library on a slow or network
    // drive took longer than the phone waits for the list.
    for (let i = 0; i < pending.length; i += 64) {
      await Promise.all(pending.slice(i, i + 64).map(async ({ rel, abs }) => {
        try {
          const fst = await fs.promises.stat(abs);
          files.push({ p: rel, s: fst.size, m: Math.floor(fst.mtimeMs) });
        } catch (err) { if (err?.code !== 'ENOENT') unreadable.push(rel); }
      }));
    }
  }
  await walk(base, '');
  return { files, unreadable };
}

/** A free name for [target]: itself, or "name (2).ext", "name (3).ext"... */
function freeName(target) {
  const ext = path.extname(target);
  let out = target;
  for (let n = 2; fs.existsSync(out); n += 1) out = `${target.slice(0, target.length - ext.length)} (${n})${ext}`;
  return out;
}

/** Moves root/rel into keepDir/rel (another drive: copied, checked, then removed). Returns where it went. */
async function archive(root, keepDir, rel) {
  const from = safeRel(root, rel);
  if (!from) throw new Error('Not a path inside the library.');
  const to = freeName(path.join(keepDir, ...String(rel).split('/')));
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(from, to);
  } catch {
    await fs.promises.copyFile(from, to);
    if ((await fs.promises.stat(to)).size !== (await fs.promises.stat(from)).size) throw new Error('The kept copy did not match.');
    await fs.promises.unlink(from);
  }
  return to;
}

/**
 * Saves [size] bytes from [stream] as root/rel with modified time [mtimeMs]. A file
 * already there is kept in keepDir first. Written beside the target and renamed into place,
 * so a cut-off transfer never leaves half a song in the library.
 */
async function write(root, keepDir, rel, stream, size, mtimeMs) {
  const target = safeRel(root, rel);
  if (!target) throw new Error('Not a path inside the library.');
  // Each transfer its own part file: a retry can arrive while the first try is still coming in.
  const part = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(4).toString('hex')}.hive-mirror-part`);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  let received = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      stream.on('data', chunk => {
        received += chunk.length;
        if (received > size) { stream.destroy(); out.destroy(); reject(new Error('More data than the file length.')); }
      });
      stream.on('error', reject);
      stream.on('aborted', () => reject(new Error('The transfer was cut off.')));
      out.on('error', reject);
      out.on('finish', resolve);
      stream.pipe(out);
    });
    if (received !== size) throw new Error('The transfer was cut off.');
    // An empty file is never a song: it never replaces one.
    if (size <= 0) throw new Error('An empty file was not saved over a song.');
    // The file there now is copied aside (not moved: Windows can't move a file that's open,
    // the song playing, say), then replaced, waiting while Windows has it locked.
    if (fs.existsSync(target)) {
      const kept = freeName(path.join(keepDir, ...String(rel).split('/')));
      await fs.promises.mkdir(path.dirname(kept), { recursive: true });
      await fs.promises.copyFile(target, kept);
    }
    await replaceFile(part, target);
    if (mtimeMs > 0) { const t = new Date(mtimeMs); await fs.promises.utimes(target, t, t); }
  } catch (err) {
    await fs.promises.unlink(part).catch(() => {});
    throw err;
  }
  const st = await fs.promises.stat(target);
  return { s: st.size, m: Math.floor(st.mtimeMs) };
}

// ---- the audio's own signature ----------------------------------------------
// Two copies of a song whose tags differ (a Love, a play count, a new cover) are the same
// song underneath: only their tag blocks differ. The signature covers the audio alone, so
// the mirror can tell a tag change (sent as tags) from new audio (sent as the file).
// Hive Mobile works it out the same way (AudioSignature.kt); both are checked against the
// same files in test/file-mirror.test.js and the phone's unit tests.

const SIGNATURE_SAMPLE = 1024 * 1024;

async function readAt(fd, position, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  const { bytesRead } = await fd.read(buf, 0, buf.length, position);
  return buf.subarray(0, bytesRead);
}

function syncsafe(b, at) { return ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f); }

/** Past any ID3v2 tags at [start]: where the audio (or FLAC's own header) begins. */
async function skipId3v2(fd, start, size) {
  for (let at = start; ;) {
    const h = await readAt(fd, at, 10);
    if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') return at;
    const next = at + 10 + syncsafe(h, 6) + ((h[5] & 0x10) ? 10 : 0);
    if (next > size) return at;
    at = next;
  }
}

/** Before an ID3v1 tag and an APEv2 tag at the end of the file. */
async function trimTail(fd, start, end) {
  if (end - start >= 128 && (await readAt(fd, end - 128, 3)).toString('latin1') === 'TAG') end -= 128;
  if (end - start >= 32) {
    const f = await readAt(fd, end - 32, 32);
    if (f.toString('latin1', 0, 8) === 'APETAGEX') {
      const tagSize = f.readUInt32LE(12) + ((f.readUInt32LE(20) & 0x80000000) ? 32 : 0);
      if (tagSize > 0 && tagSize <= end - start) end -= tagSize;
    }
  }
  return end;
}

/** The [start, end) of the audio in the file: null for a kind without a known layout. */
async function audioRegion(fd, ext, size) {
  if (ext === 'mp3' || ext === 'mp2' || ext === 'aac') {
    const start = await skipId3v2(fd, 0, size);
    return [start, await trimTail(fd, start, size)];
  }
  if (ext === 'flac') {
    let at = await skipId3v2(fd, 0, size);
    if ((await readAt(fd, at, 4)).toString('latin1') !== 'fLaC') return null;
    at += 4;
    for (;;) {
      const h = await readAt(fd, at, 4);
      if (h.length < 4) return null;
      at += 4 + ((h[1] << 16) | (h[2] << 8) | h[3]);
      if (at > size) return null;
      if (h[0] & 0x80) break;
    }
    return [at, await trimTail(fd, at, size)];
  }
  if (ext === 'm4a' || ext === 'm4b' || ext === 'mp4' || ext === 'alac') {
    // The biggest top-level 'mdat' box: the samples themselves (tag writers rewrite 'moov', not this).
    let best = null;
    for (let at = 0; at + 8 <= size;) {
      const h = await readAt(fd, at, 16);
      if (h.length < 8) break;
      let boxSize = h.readUInt32BE(0), header = 8;
      if (boxSize === 1) { if (h.length < 16) break; boxSize = Number(h.readBigUInt64BE(8)); header = 16; }
      else if (boxSize === 0) boxSize = size - at;
      if (boxSize < header || at + boxSize > size) break;
      if (h.toString('latin1', 4, 8) === 'mdat' && (!best || boxSize - header > best[1] - best[0])) best = [at + header, at + boxSize];
      at += boxSize;
    }
    return best;
  }
  if (ext === 'wav') {
    const h = await readAt(fd, 0, 12);
    if (h.length < 12 || h.toString('latin1', 0, 4) !== 'RIFF' || h.toString('latin1', 8, 12) !== 'WAVE') return null;
    for (let at = 12; at + 8 <= size;) {
      const c = await readAt(fd, at, 8);
      if (c.length < 8) break;
      const len = c.readUInt32LE(4);
      if (c.toString('latin1', 0, 4) === 'data') return [at + 8, Math.min(size, at + 8 + len)];
      at += 8 + len + (len & 1);
    }
    return null;
  }
  return null;
}

/**
 * The audio's signature: sha256 over its length and its first and last megabyte, as hex (32
 * characters). Null for a kind the mirror can't look inside (Ogg, Opus...): those are copied whole.
 */
async function audioSignature(abs) {
  const ext = path.extname(abs).slice(1).toLowerCase();
  const fd = await fs.promises.open(abs, 'r');
  try {
    const size = (await fd.stat()).size;
    const region = await audioRegion(fd, ext, size);
    if (!region || region[1] <= region[0]) return null;
    const [start, end] = region;
    const length = end - start;
    const hash = crypto.createHash('sha256').update(`${length}:`);
    hash.update(await readAt(fd, start, Math.min(SIGNATURE_SAMPLE, length)));
    hash.update(await readAt(fd, Math.max(start, end - SIGNATURE_SAMPLE), Math.min(SIGNATURE_SAMPLE, length)));
    return hash.digest('hex').slice(0, 32);
  } finally { await fd.close(); }
}

/** The audio's place in the file: { start, end, size }, or null for a kind without a known layout. */
async function audioPlace(abs) {
  const fd = await fs.promises.open(abs, 'r');
  try {
    const size = (await fd.stat()).size;
    const region = await audioRegion(fd, path.extname(abs).slice(1).toLowerCase(), size);
    return region && region[1] > region[0] ? { start: region[0], end: region[1], size } : null;
  } finally { await fd.close(); }
}

async function sha256Of(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(abs).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Everything in the file but its audio: the bytes before it and after it (all tags, every picture). */
async function tagBytes(abs) {
  const place = await audioPlace(abs);
  if (!place) return null;
  const fd = await fs.promises.open(abs, 'r');
  try {
    const head = await readAt(fd, 0, place.start);
    const tail = await readAt(fd, place.end, place.size - place.end);
    return { ...place, head, tail };
  } finally { await fd.close(); }
}

/**
 * Makes root/rel byte for byte the file another side has, from that file's tags ([head] before its
 * audio, [tail] after) and the audio already here: only the tags travel, never the song. [hash] is the
 * sha256 of the whole file wanted; a result that isn't exactly it (the audio here isn't the same after
 * all) changes nothing and throws AUDIO_DIFFERS. The file there now is kept in [keepDir] first, as
 * for any file the mirror replaces.
 */
async function writeFromTags(root, keepDir, rel, head, tail, hash, mtimeMs, { keepOnly = false } = {}) {
  const source = safeRel(root, rel);
  if (!source) throw new Error('Not a path inside the library.');
  // [keepOnly]: the phone's copy lost to the PC's (both changed): it's only kept aside, in Deleted songs.
  const target = keepOnly ? freeName(path.join(keepDir, 'Phone copies replaced', ...String(rel).split('/'))) : source;
  if (keepOnly) await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const place = await audioPlace(source);
  if (!place) throw Object.assign(new Error('Hive can\'t find the audio in its copy.'), { code: 'AUDIO_DIFFERS' });
  const part = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(4).toString('hex')}.hive-mirror-part`);
  try {
    const out = await fs.promises.open(part, 'w');
    try {
      await out.write(head);
      const src = await fs.promises.open(source, 'r');
      try {
        const buf = Buffer.alloc(1 << 20);
        for (let at = place.start; at < place.end;) {
          const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, place.end - at), at);
          if (!bytesRead) break;
          await out.write(buf.subarray(0, bytesRead));
          at += bytesRead;
        }
      } finally { await src.close(); }
      await out.write(tail);
      await out.sync();
    } finally { await out.close(); }
    if (await sha256Of(part) !== String(hash).toLowerCase()) throw Object.assign(new Error('The audio here isn\'t the same: the whole file is needed.'), { code: 'AUDIO_DIFFERS' });
    if (!keepOnly) {
      const kept = freeName(path.join(keepDir, ...String(rel).split('/')));
      await fs.promises.mkdir(path.dirname(kept), { recursive: true });
      await fs.promises.copyFile(target, kept);
    }
    await replaceFile(part, target);
    if (mtimeMs > 0) { const t = new Date(mtimeMs); await fs.promises.utimes(target, t, t); }
  } catch (err) {
    await fs.promises.unlink(part).catch(() => {});
    throw err;
  }
  const st = await fs.promises.stat(target);
  return { s: st.size, m: Math.floor(st.mtimeMs) };
}

module.exports = { list, safeRel, archive, write, freeName, audioSignature, audioPlace, sha256Of, tagBytes, writeFromTags, HIVE_TEMP };
