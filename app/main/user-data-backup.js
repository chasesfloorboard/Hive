'use strict';

// The in-project "User Data Backup" mirror — a recovery copy of the user's profile (playlists, settings,
// themes, pairing…) kept beside Hive so a corrupt/wiped stable profile can be restored. Extracted from
// main.js (QUALITY-ROADMAP phase 3). Pure fs + path with the two data roots injected as lazy getters.

// Derived caches and volatile dirs are never mirrored.
const BACKUP_EXCLUDED_DIRS = new Set(['session', 'logs', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache']);

function createUserDataBackup({ stableDataRoot, userBackupRoot, fs, path }) {
  // Copy a directory's contents into another, skipping [skipDirs] and never overwriting an existing file.
  function copyDirectoryContentsSync(source, destination, { skipDirs = BACKUP_EXCLUDED_DIRS } = {}) {
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
      } else if (!fs.existsSync(to)) fs.copyFileSync(from, to);
    }
    return true;
  }

  // Restore into a fresh profile only the files it is MISSING. The stable profile is authoritative once it
  // exists; the backup is a recovery copy, not a competing source of truth (comparing mtimes once let a
  // stale backup look newer and resurrect old Favorites/UI state — so restore only what's absent).
  function restoreHiveUserBackupSync(dataRoot) {
    const backupRoot = userBackupRoot();
    if (!backupRoot || !fs.existsSync(backupRoot)) return false;
    let restored = false;
    try {
      fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
      const restoreNewer = (source, destination) => {
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
          if (BACKUP_EXCLUDED_DIRS.has(entry.name)) continue;
          const from = path.join(source, entry.name);
          const to = path.join(destination, entry.name);
          if (entry.isDirectory()) { fs.mkdirSync(to, { recursive: true, mode: 0o700 }); restoreNewer(from, to); continue; }
          const shouldCopy = !fs.existsSync(to);
          if (shouldCopy) { fs.copyFileSync(from, to); try { fs.chmodSync(to, 0o600); } catch {} restored = true; }
        }
      };
      restoreNewer(backupRoot, dataRoot);
    } catch (err) { console.warn('[Hive] User-data backup restore skipped:', err?.message || String(err)); }
    return restored;
  }

  // Snapshot the whole stable profile into the backup mirror (called on a clean shutdown).
  function backupHiveUserDataSync() {
    const source = stableDataRoot();
    const backupRoot = userBackupRoot();
    if (!backupRoot || !fs.existsSync(source)) return false;
    try {
      fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (BACKUP_EXCLUDED_DIRS.has(entry.name)) continue;
        const from = path.join(source, entry.name);
        const to = path.join(backupRoot, entry.name);
        fs.cpSync(from, to, { recursive: true, force: true });
      }
      fs.writeFileSync(path.join(backupRoot, '.hive-backup-meta.json'), JSON.stringify({ version: 1, backedUpAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
      return true;
    } catch (err) { console.warn('[Hive] User-data backup failed:', err?.message || String(err)); return false; }
  }

  // The backup twin of a stable-profile file (null if it isn't under the stable root). readJsonSafe /
  // writeJsonSafe use this to mirror and recover user-owned JSON.
  function userBackupPathFor(p) {
    try {
      const backupRoot = userBackupRoot();
      if (!backupRoot) return null;
      const relative = path.relative(stableDataRoot(), p);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
      return path.join(backupRoot, relative);
    } catch { return null; }
  }

  return { copyDirectoryContentsSync, restoreHiveUserBackupSync, backupHiveUserDataSync, userBackupPathFor };
}

module.exports = { createUserDataBackup, BACKUP_EXCLUDED_DIRS };
