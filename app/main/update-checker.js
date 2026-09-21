'use strict';

// Thin wrapper around electron-updater, kept as its own module (rather than
// inline in main.js) so the update-check/download/install lifecycle can be
// exercised directly in a test with a fake autoUpdater, matching the
// dependency-injection pattern already used by app/main/metadata-writer.js.
//
// Deliberately check-then-ask, never silent auto-install: autoDownload and
// autoInstallOnAppQuit are both off, so finding an update only ever notifies
// the user (see the Settings > About "Check for updates" action); nothing is
// downloaded or installed without an explicit action from them.
function createUpdateChecker({ autoUpdater }) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let status = { state: 'idle', info: null, error: null, progress: null, checkedAt: null };
  const listeners = new Set();

  function setStatus(patch) {
    status = { ...status, ...patch };
    for (const cb of listeners) { try { cb(status); } catch {} }
  }

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => setStatus({ state: 'available', info, checkedAt: Date.now() }));
  autoUpdater.on('update-not-available', (info) => setStatus({ state: 'up-to-date', info, checkedAt: Date.now() }));
  autoUpdater.on('error', (err) => setStatus({ state: 'error', error: err?.message || String(err), checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (progress) => setStatus({ state: 'downloading', progress }));
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'downloaded', info }));

  async function check() {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // A missing/placeholder publish repo (see package.json's build.publish
      // "REPLACE_WITH_GITHUB_OWNER") or no network both land here as an
      // ordinary error, not a crash -- an update check must never be able to
      // affect normal app startup or operation.
      setStatus({ state: 'error', error: err?.message || String(err), checkedAt: Date.now() });
    }
    return status;
  }

  async function download() {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      setStatus({ state: 'error', error: err?.message || String(err) });
    }
    return status;
  }

  function quitAndInstall() {
    autoUpdater.quitAndInstall();
  }

  function onStatus(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function getStatus() {
    return status;
  }

  return { check, download, quitAndInstall, onStatus, getStatus };
}

module.exports = { createUpdateChecker };
