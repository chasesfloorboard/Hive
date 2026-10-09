'use strict';

// Startup change check: did anything in the library folders change while Hive
// was closed? Compares a snapshot of folder modification times (taken by the
// last full scan) and the cached size/dates of every known file against the
// disk, using the same "unchanged" rules as library:scan. Returns the first
// reason a scan is needed, or null when nothing changed.
//
// Dependency-injected (stat) so it can be tested against a temp folder.

// Runs `test` over items with limited concurrency; resolves to the first
// non-null result (stopping early), or null.
async function findFirstAsync(items, concurrency, test) {
  let cursor = 0;
  let found = null;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (found === null && cursor < items.length) {
      const result = await test(items[cursor++]);
      if (result !== null && found === null) found = result;
    }
  }));
  return found;
}

async function libraryChangeReason({ roots, snapshot, tracks, stat, metadataScanVersion, artworkScanVersion, concurrency = 16 }) {
  if (!roots.length) return null;
  if (!snapshot?.directories || !Array.isArray(snapshot.roots)) return 'no folder snapshot yet';
  if (JSON.stringify(snapshot.roots) !== JSON.stringify(roots)) return 'library folders changed';
  if (!tracks.length) return 'no cached library';
  for (const t of tracks) {
    if (Number(t.metadataScanVersion || 0) < metadataScanVersion) return 'scanner updated';
    const hasArtworkReference = !!t.cover || (Array.isArray(t.covers) && t.covers.some(item => item?.file));
    if (!hasArtworkReference && Number(t.artworkScanVersion || 0) < artworkScanVersion) return 'artwork scan updated';
  }
  const folderChange = await findFirstAsync(Object.entries(snapshot.directories), concurrency, async ([dir, mtimeMs]) => {
    try { return Number((await stat(dir)).mtimeMs || 0) === Number(mtimeMs) ? null : `folder changed: ${dir}`; }
    catch { return `folder missing: ${dir}`; }
  });
  if (folderChange) return folderChange;
  return findFirstAsync(tracks, concurrency, async t => {
    try {
      const st = await stat(t.path);
      const same = Number(t.fileMtimeMs || 0) === Number(st.mtimeMs || 0)
        && Number(t.fileCtimeMs || 0) === Number(st.ctimeMs || 0)
        && Number(t.fileSize || 0) === Number(st.size || 0);
      return same ? null : `file changed: ${t.path}`;
    } catch { return `file missing: ${t.path}`; }
  });
}

module.exports = { libraryChangeReason, findFirstAsync };
