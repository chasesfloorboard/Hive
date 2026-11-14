'use strict';

// The library folder-time snapshot. Extracted from main.js (QUALITY-ROADMAP, Library-scan region).
//
// Each full scan records every library folder's modification time. Adding, removing or renaming a file
// changes its folder's mtime, so at startup Hive can tell whether anything changed while it was closed by
// stat-ing folders directly -- no folder listing, no scan, no progress bar when nothing changed. While Hive
// runs the folder watcher handles changes live, and Hive's own writes (embedding a play count, say) refresh
// just the touched folders so they don't look "changed while closed" next launch.
//
// Injected deps: fsp, path, readJsonSafe/writeJsonSafe (the safe JSON layer), isPathInsideFolder (the shared
// path guard), and userDataDir() for the snapshot file location.

function createLibraryFolderSnapshot({ fsp, path, readJsonSafe, writeJsonSafe, isPathInsideFolder, userDataDir }) {
  const snapshotPath = () => path.join(userDataDir(), 'library-folder-snapshot.json');

  let libraryFolderSnapshot = null;
  let libraryFolderSnapshotSaveTimer = null;

  async function loadLibraryFolderSnapshot() {
    if (!libraryFolderSnapshot) libraryFolderSnapshot = await readJsonSafe(snapshotPath(), null);
    return libraryFolderSnapshot;
  }

  function saveLibraryFolderSnapshotSoon() {
    if (libraryFolderSnapshotSaveTimer) clearTimeout(libraryFolderSnapshotSaveTimer);
    libraryFolderSnapshotSaveTimer = setTimeout(() => {
      libraryFolderSnapshotSaveTimer = null;
      if (libraryFolderSnapshot) writeJsonSafe(snapshotPath(), libraryFolderSnapshot).catch(() => {});
    }, 2000);
    libraryFolderSnapshotSaveTimer.unref?.();
  }

  async function statDirectoryMtimes(dirs) {
    const directories = {};
    const list = [...new Set(dirs.map(d => path.resolve(d)))];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(16, list.length) }, async () => {
      while (cursor < list.length) {
        const dir = list[cursor++];
        try { directories[dir] = Number((await fsp.stat(dir)).mtimeMs || 0); } catch {}
      }
    }));
    return directories;
  }

  function sortedLibraryRoots(roots) {
    return [...new Set((roots || []).map(r => path.resolve(String(r))))].sort();
  }

  async function saveLibraryFolderSnapshot(roots, directories) {
    libraryFolderSnapshot = { roots: sortedLibraryRoots(roots), directories, takenAt: Date.now() };
    if (libraryFolderSnapshotSaveTimer) { clearTimeout(libraryFolderSnapshotSaveTimer); libraryFolderSnapshotSaveTimer = null; }
    await writeJsonSafe(snapshotPath(), libraryFolderSnapshot);
  }

  // Re-reads the given folders (plus their parents up to the library root) after a change Hive already knows
  // about, so it doesn't count as "changed while closed" next launch.
  async function refreshLibraryFolderSnapshot(paths) {
    const snapshot = await loadLibraryFolderSnapshot();
    if (!snapshot?.directories || !Array.isArray(snapshot.roots)) return;
    const dirs = new Set();
    for (const p of paths) {
      let dir = path.resolve(String(p || ''));
      const root = snapshot.roots.find(r => isPathInsideFolder(dir, r));
      if (!root) continue;
      for (let i = 0; i < 64; i++) {
        dirs.add(dir);
        if (dir === root) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    for (const dir of dirs) {
      try {
        const st = await fsp.stat(dir);
        if (st.isDirectory()) snapshot.directories[dir] = Number(st.mtimeMs || 0);
      } catch { delete snapshot.directories[dir]; }
    }
    saveLibraryFolderSnapshotSoon();
  }

  const pendingOwnWriteSnapshotDirs = new Set();
  let ownWriteSnapshotTimer = null;
  function queueOwnWriteSnapshotRefresh(dir) {
    pendingOwnWriteSnapshotDirs.add(dir);
    if (ownWriteSnapshotTimer) clearTimeout(ownWriteSnapshotTimer);
    // After the write's temp-file rename has settled.
    ownWriteSnapshotTimer = setTimeout(() => {
      ownWriteSnapshotTimer = null;
      const dirs = [...pendingOwnWriteSnapshotDirs];
      pendingOwnWriteSnapshotDirs.clear();
      void refreshLibraryFolderSnapshot(dirs);
    }, 11000);
    ownWriteSnapshotTimer.unref?.();
  }

  return {
    snapshotPath,
    loadLibraryFolderSnapshot,
    saveLibraryFolderSnapshotSoon,
    statDirectoryMtimes,
    sortedLibraryRoots,
    saveLibraryFolderSnapshot,
    refreshLibraryFolderSnapshot,
    queueOwnWriteSnapshotRefresh,
  };
}

module.exports = { createLibraryFolderSnapshot };
