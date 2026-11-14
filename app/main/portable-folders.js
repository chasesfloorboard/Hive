'use strict';
// Portable library-folder paths. Hive stores each library folder in config.json either
// as an absolute path or, when the folder lives inside the portable app root, as a
// relocatable { type:'portable', path:<relative> } record — so a moved or renamed
// portable install still finds its library. Extracted from main.js
// (docs/ai/ARCHITECTURE.md). A createX(deps) factory: fs, path and a portableRoot()
// getter are injected, so the path logic is unit-testable with fakes.
function createPortableFolders(deps = {}) {
  const { fs, path } = deps;
  const portableRoot = deps.portableRoot;
  if (!fs || !path || typeof portableRoot !== 'function') {
    throw new Error('createPortableFolders needs { fs, path, portableRoot() }');
  }

  // What config.json should store for a folder: a portable record when it sits inside
  // the current portable root, otherwise its absolute path.
  function serializePortableFolder(folder) {
    const absolute = path.resolve(String(folder || ''));
    if (!absolute) return '';
    const rel = path.relative(portableRoot(), absolute);
    if (rel && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return { type: 'portable', path: rel };
    if (rel === '') return { type: 'portable', path: '.' };
    return absolute;
  }

  // The inverse: resolve a stored folder back to an absolute path. A portable record is
  // rebased onto the current portable root; a bare path is used as-is when it exists,
  // else the same basename inside the portable root is tried (handles a moved install),
  // else the absolute path as given.
  function resolveConfiguredFolder(folder) {
    if (folder && typeof folder === 'object' && folder.type === 'portable') return path.resolve(portableRoot(), String(folder.path || '.'));
    const value = String(folder || '');
    if (!value) return '';
    const absolute = path.resolve(value);
    if (fs.existsSync(absolute)) return absolute;
    const sibling = path.join(portableRoot(), path.basename(value));
    if (fs.existsSync(sibling)) return sibling;
    return absolute;
  }

  // Resolve every folder in a config object, dropping empties.
  function resolveConfigFolders(config) {
    const source = Array.isArray(config?.folders) ? config.folders : [];
    return source.map(resolveConfiguredFolder).filter(Boolean);
  }

  return { serializePortableFolder, resolveConfiguredFolder, resolveConfigFolders };
}

module.exports = { createPortableFolders };
