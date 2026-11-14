'use strict';

// The library path-boundary guard. Extracted from main.js (QUALITY-ROADMAP, Metadata region). Zero state.
//
// Security-audit finding fixed before 1.0: the metadata/artwork write handlers (writeTags, writeArtwork,
// modifyArtwork, removeArtwork, removeFrontArtwork, and the metadata:saveBatch queue) only checked that a
// file existed -- so any track record pointing OUTSIDE the configured library folders (e.g. an imported
// playlist referencing an external file) could have its file silently rewritten by an ordinary
// Love/Rating/Tag edit. isTrackPathAllowedInLibrary is the shared guard at every write entry point.
//
// libraryFolders() is injected: it returns the resolved absolute library roots (understanding portable-form
// {type:'portable', path} entries), so the guard never talks to config/JSON directly.

const path = require('node:path');

const LIBRARY_BOUNDARY_ERROR = 'File is outside a configured Hive library folder.';

function createLibraryBoundary({ libraryFolders }) {
  // True when filePath is folderPath itself or lives somewhere beneath it. Resolves both and rejects any
  // path that escapes via "..", an absolute relative result, or empty input.
  function isPathInsideFolder(filePath, folderPath) {
    const file = path.resolve(String(filePath || ''));
    const folder = path.resolve(String(folderPath || ''));
    if (!file || !folder) return false;
    const rel = path.relative(folder, file);
    return rel === '' || (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  }

  // True only when trackPath resolves inside one of the configured library folders. The gate for every
  // file-mutating IPC handler.
  async function isTrackPathAllowedInLibrary(trackPath) {
    const resolved = path.resolve(String(trackPath || ''));
    if (!resolved) return false;
    const folders = await libraryFolders();
    return folders.some(folder => isPathInsideFolder(resolved, folder));
  }

  return { isPathInsideFolder, isTrackPathAllowedInLibrary, LIBRARY_BOUNDARY_ERROR };
}

module.exports = { createLibraryBoundary, LIBRARY_BOUNDARY_ERROR };
