'use strict';

// Durable, atomic file replacement — the single home for "write a file without ever leaving it torn".
//
// Extracted from main.js (the monolith split, phase 2 of docs/ai/QUALITY-ROADMAP.md): these are pure Node
// fs operations with no app-specific dependencies, so pulling them into their own module makes them testable
// in isolation (test/atomic-file.test.js) and gives every writer one guaranteed-correct way to persist.
//
// The temp-file name matches main.js's removeStaleWriteTemps regex so a crash mid-write is cleaned up later.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

async function writeFileDurable(file, data) {
  const handle = await fsp.open(file, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// fsync the directory so a rename (the atomic step) is itself durable: a file whose bytes were fsynced can
// still vanish after a crash if the directory entry that names it was never flushed. Best-effort — some
// filesystems reject a directory fsync (EINVAL/EISDIR/EPERM), and win32 has no directory fsync.
async function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  let dh = null;
  try { dh = await fsp.open(dir, 'r'); await dh.sync(); }
  catch {}
  finally { if (dh) { try { await dh.close(); } catch {} } }
}

// Replace `dest` with `data` atomically AND durably: write a complete temp sibling, fsync it, rename it over
// the target, then fsync the parent directory. A crash/power-loss/drive-yank at any point leaves the PREVIOUS
// good file, never a torn or 0-byte one. The primary write, its backup mirror, the library-cache gzip sidecar,
// and the damaged-file restore all go through here, instead of some using a bare (non-atomic) copyFile.
async function atomicReplace(dest, data) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const temp = `${dest}.beehive-write-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFileDurable(temp, data);
    try {
      await fsp.rename(temp, dest);
    } catch (err) {
      // Windows can't rename over an existing file. Move the old one ASIDE first, put the new one in place,
      // then delete the old — so a failure (a lock, a crash) never leaves `dest` missing. Deleting dest up
      // front and then renaming would lose the file entirely if that second rename failed.
      if (process.platform === 'win32' && (err?.code === 'EEXIST' || err?.code === 'EPERM')) {
        const aside = `${dest}.beehive-old-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        await fsp.rename(dest, aside);
        try {
          await fsp.rename(temp, dest);
        } catch (err2) {
          try { await fsp.rename(aside, dest); } catch {} // restore the original; never lose it
          throw err2;
        }
        try { await fsp.unlink(aside); } catch {}
      } else throw err;
    }
    try { await fsp.chmod(dest, 0o600); } catch {}
    await fsyncDir(path.dirname(dest));
  } finally {
    try { await fsp.unlink(temp); } catch {}
  }
}

module.exports = { writeFileDurable, fsyncDir, atomicReplace };
