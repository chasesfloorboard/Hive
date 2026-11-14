'use strict';

// Serialized library scan/cache operations + the cancellation registry. Extracted from main.js
// (QUALITY-ROADMAP, Library-scan region).
//
// Lock: tag edits can trigger both an explicit incremental refresh and a filesystem-watcher refresh;
// letting those read/write library.json concurrently can let an older snapshot win and make the UI appear
// momentarily empty. Every scan/cache operation runs one at a time through acquireLibraryScanLock().
//
// Cancellation: full scans in flight or queued register a token here. Cancelling only flips a flag; every
// phase of library:scan polls it at a safe boundary (between directories, stat()s, parsed files) and bails
// with LIBRARY_SCAN_CANCELLED before the cache/removed-track cleanup runs, so a stopped scan never commits
// a partial file list as if it were the whole library.

const LIBRARY_SCAN_CANCELLED = 'LIBRARY_SCAN_CANCELLED';

function createLibraryScanLock({ scanLog = () => {} } = {}) {
  // ---- one-at-a-time lock ----
  let libraryScanChain = Promise.resolve();
  async function acquireLibraryScanLock() {
    let releaseNext;
    const wait = libraryScanChain;
    libraryScanChain = new Promise(resolve => { releaseNext = resolve; });
    await wait;
    return releaseNext;
  }

  // ---- cancellation registry ----
  const activeLibraryScans = new Set();
  // Register a scan token (register BEFORE waiting on the lock, so Stop also works for a scan still queued
  // behind another library operation). Returns the unregister function to call when the scan finishes.
  function registerActiveScan(token) {
    activeLibraryScans.add(token);
    return function endActiveScan() { activeLibraryScans.delete(token); };
  }
  function cancelActiveLibraryScan() {
    let cancelled = false;
    for (const token of activeLibraryScans) {
      if (token.cancelled) continue;
      token.cancelled = true;
      cancelled = true;
      try { token.onCancel?.(); } catch {}
    }
    if (cancelled) scanLog('SCAN CANCEL REQUESTED');
    return cancelled;
  }

  return {
    acquireLibraryScanLock,
    registerActiveScan,
    cancelActiveLibraryScan,
    activeScanCount: () => activeLibraryScans.size,
    LIBRARY_SCAN_CANCELLED,
  };
}

module.exports = { createLibraryScanLock, LIBRARY_SCAN_CANCELLED };
