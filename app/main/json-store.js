'use strict';

// The one safe JSON layer for Hive's user-data files (config, playlists, play-stats, the library cache…).
// Extracted from main.js (QUALITY-ROADMAP, Persistence 3). Every read tolerates a damaged/0-byte file
// without destroying it; every write is durable and atomic and mirrors user-owned JSON into the in-project
// backup. Dependencies are injected so the layer is testable without Electron:
//   fsp                  node:fs/promises
//   path                 node:path
//   userBackupPathFor    (p) => backup twin path or null (from user-data-backup.js)
//   libraryCachePath     () => the library.json path (its writes are compacted + gzipped, never mirrored)
//   libraryCacheGzipPath () => the library.json.gz path (startup transport copy)
//   scanLog, crashDebug  logging sinks (optional)

const zlib = require('node:zlib');
const { atomicReplace } = require('./atomic-file');

function createJsonStore({
  fsp,
  path,
  userBackupPathFor,
  libraryCachePath,
  libraryCacheGzipPath,
  scanLog = () => {},
  crashDebug = () => {},
}) {
  // Files whose last read came back damaged. While a path is in here, writeJsonSafe will NOT overwrite its
  // backup copy with the fallback it is being handed — the backup is the only recovery source, so it must
  // survive until a good value is written back.
  const damagedJsonFiles = new Set();
  const jsonFileWriteQueues = new Map();

  // A cached reader keyed on (size:mtime): re-parses the file only when it changes on disk.
  function stampedJsonReader(pathFn, fallback) {
    let cache = { stamp: null, data: fallback };
    return async () => {
      const p = pathFn();
      let st;
      try { st = await fsp.stat(p); } catch { cache = { stamp: null, data: fallback }; return fallback; }
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (cache.stamp !== stamp) cache = { stamp, data: await readJsonSafe(p, fallback) };
      return cache.data;
    };
  }

  async function readJsonSafe(p, fallback) {
    let txt;
    try {
      txt = await fsp.readFile(p, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return fallback; // not created yet
      console.warn('[Hive] Could not read', p, err?.message || String(err));
      return fallback;
    }
    try {
      return JSON.parse(txt);
    } catch (err) {
      // Damaged (a crash mid-write, a 0-byte file on exFAT). Before, this silently returned the
      // fallback, the caller wrote it back, and the backup copy was overwritten too: playlists and
      // settings were lost for good. Keep the damaged file aside, and use the backup copy if it reads.
      console.warn('[Hive] Damaged JSON file', p, err?.message || String(err));
      if (!damagedJsonFiles.has(p)) {
        try { await fsp.copyFile(p, `${p}.damaged-${Date.now()}`); } catch {}
      }
      const backup = userBackupPathFor(p);
      if (backup) {
        try {
          const backupText = await fsp.readFile(backup, 'utf8');
          const restored = JSON.parse(backupText); // validate before we overwrite the primary with it
          console.warn('[Hive] Restored', p, 'from its backup copy');
          try { await atomicReplace(p, backupText); } catch {}
          damagedJsonFiles.delete(p);
          return restored;
        } catch {}
      }
      damagedJsonFiles.add(p);
      return fallback;
    }
  }

  // writeJsonSafe's temp files are named <file>.beehive-write-<pid>-<random>.tmp.
  // A crash or kill mid-write leaves them behind (a library cache temp is tens of
  // MB), so remove any left by a process that is no longer running.
  async function removeStaleWriteTemps(dir) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      const m = /\.beehive-write-(\d+)-[0-9a-f]+\.tmp$/.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      try { process.kill(pid, 0); continue; } catch (err) { if (err?.code === 'EPERM') continue; }
      try { await fsp.unlink(path.join(dir, name)); removed++; } catch {}
    }
    return removed;
  }

  async function writeJsonSafe(p, data) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const cachePath = libraryCachePath();
    const isLibraryCache = p === cachePath;
    const cacheWriteStartedAt = isLibraryCache ? Date.now() : 0;
    // The library cache is machine-only (immediately gzipped for transport,
    // never hand-edited) and can be tens of thousands of tracks -- pretty
    // printing it inflates the string V8 has to allocate and hash for no
    // benefit, on every single scan that finds even one changed file. Every
    // other JSON file stays indented for human readability/debugging.
    const payload = isLibraryCache ? JSON.stringify(data) : JSON.stringify(data, null, 2);
    if (isLibraryCache) scanLog('LIBRARY CACHE JSON SERIALIZED', { ms: Date.now() - cacheWriteStartedAt, bytes: Buffer.byteLength(payload, 'utf8') });
    // Never write JSON directly over a live cache file. A concurrent reader can
    // otherwise observe a partially-written JSON document, fall back to `{}`, and
    // a later incremental scan can accidentally replace a full library cache with
    // only the handful of tracks it was refreshing. Write a complete temporary
    // file first and replace the destination only after the new JSON is complete.
    // One durable, atomic replace: temp -> fsync file -> rename over target -> fsync dir. A truncated cache
    // once opened Hive on an empty library and a truncated playlists.json lost the playlists; both are now
    // impossible (a crash leaves the previous good file). Never write JSON directly over a live file.
    await atomicReplace(p, payload);

    // Mirror user-owned JSON state into the in-project Hive backup. Library cache
    // writes are intentionally excluded here because they are large; the complete
    // profile is snapshotted on application shutdown.
    // A file read back as its fallback because it was damaged keeps its backup copy as it was.
    if (p !== cachePath && !damagedJsonFiles.has(p) && !p.includes(`${path.sep}session${path.sep}`) && !p.includes(`${path.sep}logs${path.sep}`)) {
      try {
        const backupPath = userBackupPathFor(p);
        // The backup is the ONLY recovery source readJsonSafe has, so it must be written with the same atomic
        // durability as the primary — a bare copyFile could leave the backup itself torn/0-byte by a crash,
        // and then both copies fail together. Write the same `payload` bytes through atomicReplace.
        if (backupPath) await atomicReplace(backupPath, payload);
      } catch (err) { console.warn('[Hive] User-data JSON backup skipped:', err?.message || String(err)); }
    }

    // Keep a compact startup transport copy of the library cache. Electron's IPC
    // structured-clone cost grows substantially with a 30k-track object graph;
    // shipping the compressed bytes avoids cloning hundreds of megabytes of
    // duplicated JS objects before the renderer can use them. The plain JSON file
    // remains the canonical human-readable cache and fallback.
    if (isLibraryCache) {
      try {
        // Compression is deliberately asynchronous. A synchronous gzip here can
        // stall the main process for hundreds of milliseconds on a large library,
        // including while playback/MPRIS IPC is being serviced.
        const compressed = await new Promise((resolve, reject) => {
          zlib.gzip(Buffer.from(payload, 'utf8'), { level: 1 }, (err, out) => err ? reject(err) : resolve(out));
        });
        await atomicReplace(libraryCacheGzipPath(), compressed);
        scanLog('LIBRARY CACHE GZIP WRITTEN', { ms: Date.now() - cacheWriteStartedAt, compressedBytes: compressed.length });
      } catch (err) {
        crashDebug('COMPRESSED LIBRARY CACHE WRITE FAILED', { message: err?.message || String(err) });
      }
    }
  }

  // Serialize read-modify-write cycles against a shared JSON file. readJsonSafe/
  // writeJsonSafe individually are safe (atomic temp-file + rename), but neither
  // is aware of a concurrent caller doing its own read-modify-write against the
  // same path -- two near-simultaneous mutations (even unrelated ones, e.g.
  // renaming playlist A while a Favorites-timestamp autosave for playlist B
  // lands) can each read the same "before" snapshot and whichever writes last
  // silently discards the other's change. withJsonFileLock forces every
  // registered mutation against one path through a single queue.
  function withJsonFileLock(filePath, fn) {
    const previous = jsonFileWriteQueues.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    jsonFileWriteQueues.set(filePath, next.catch(() => {}));
    return next;
  }

  return { stampedJsonReader, readJsonSafe, removeStaleWriteTemps, writeJsonSafe, withJsonFileLock, damagedJsonFiles };
}

module.exports = { createJsonStore };
