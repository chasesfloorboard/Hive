'use strict';

// Hive Link's file mirror: a phone keeps its music folder one to one with
// Hive's library folder, file for file (songs, covers, playlists, notes alike).
// Paths are relative to the library folder, with '/' between folders.
//
// Nothing is ever destroyed here: a file the phone replaces or deletes is moved
// into the keep folder (Hive's Deleted songs) under the same relative path.

const fs = require('fs');
const path = require('path');
const { replaceFile } = require('./replace-file');

// Hive's own half-written files (tag writes, song uploads, mirror copies): never mirrored.
const HIVE_TEMP = /(\.beehive-[a-z-]+-[0-9a-f]{6,}(\.[a-z0-9]+)?|\.hivelink-part|\.hive-mirror-part)$/i;

/** The absolute path of [rel] inside [root], or null for anything that would leave it. */
function safeRel(root, rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.includes('\0') || r.startsWith('/') || /^[a-z]:/i.test(r)) return null;
  if (r.split('/').some(s => s === '' || s === '.' || s === '..')) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, ...r.split('/'));
  return abs.startsWith(base + path.sep) ? abs : null;
}

/** Every file under [root]: { p: relative path, s: size, m: modified (ms) }. */
async function list(root) {
  const base = path.resolve(root);
  const out = [];
  async function walk(dir, prefix) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(abs, rel); continue; }
      if (!e.isFile() || HIVE_TEMP.test(e.name)) continue;
      try {
        const st = await fs.promises.stat(abs);
        out.push({ p: rel, s: st.size, m: Math.floor(st.mtimeMs) });
      } catch {}
    }
  }
  await walk(base, '');
  return out;
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
  const part = path.join(path.dirname(target), `.${path.basename(target)}.hive-mirror-part`);
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

module.exports = { list, safeRel, archive, write, freeName, HIVE_TEMP };
