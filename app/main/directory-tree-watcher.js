'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Node 20's fs.watch(folder, { recursive: true }) is emulated on Linux: it
// walks the whole tree SYNCHRONOUSLY and attaches a polling fs.watchFile()
// stat-watcher to every single file. On a ~30k-track library on a USB drive
// that walk froze the entire main process for ~36 s at every cold launch (the
// white-window startup hang -- not awaiting the promise can't help a
// synchronous walk), and the per-file pollers then kept re-stat-ing the whole
// library every few seconds for as long as Hive ran. Instead, walk the
// directories asynchronously and put one native, non-recursive inotify watch
// on each directory, reporting names relative to the library root exactly
// like the recursive watcher did.
function createDirectoryTreeWatcher(root, onEvent, isCurrent = () => true) {
  const dirWatchers = new Map();
  let closed = false;
  const live = () => !closed && isCurrent();
  // `announce` is set for folders that appear after startup: files copied into
  // them before their watch attached are reported so they still get indexed.
  const addDirectory = async (dir, announce = false) => {
    if (!live() || dirWatchers.has(dir)) return;
    if (/(^|[\\/])\.beehive-tmp$/i.test(dir)) return;
    let watcher;
    try {
      watcher = fs.watch(dir, (eventType, filename) => {
        if (!live()) return;
        const name = filename ? String(filename) : '';
        const full = name ? path.join(dir, name) : dir;
        const relative = name ? path.relative(root, full) : '';
        if (name && eventType === 'rename') {
          // A folder that appears later (e.g. a newly copied album) needs its
          // own watch; one that disappears drops its watch and all below it.
          fsp.stat(full)
            .then(st => { if (st.isDirectory()) addDirectory(full, true); })
            .catch(() => removeDirectory(full));
        }
        onEvent(eventType, relative);
      });
    } catch { return; }
    watcher.on('error', () => removeDirectory(dir));
    if (!live()) { try { watcher.close(); } catch {} return; }
    dirWatchers.set(dir, watcher);
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!live()) return;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await addDirectory(child, announce);
      else if (announce) onEvent('rename', path.relative(root, child));
    }
  };
  const removeDirectory = (dir) => {
    for (const [watched, watcher] of dirWatchers) {
      if (watched === dir || watched.startsWith(dir + path.sep)) {
        try { watcher.close(); } catch {}
        dirWatchers.delete(watched);
      }
    }
  };
  return {
    ready: addDirectory(root),
    close() {
      closed = true;
      for (const watcher of dirWatchers.values()) { try { watcher.close(); } catch {} }
      dirWatchers.clear();
    },
  };
}

module.exports = { createDirectoryTreeWatcher };
