'use strict';
// Real, direct exercises of app/main/update-checker.js against a fake
// autoUpdater (a tiny EventEmitter-like stub), the same dependency-injection
// approach used for app/main/metadata-writer.js -- so this logic is unit
// tested directly instead of only checked by grepping main.js's source text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateChecker } = require('../app/main/update-checker');

function makeFakeAutoUpdater() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: async () => {},
    downloadUpdate: async () => {},
    quitAndInstall: () => { emitter.installed = true; },
  });
}

test('createUpdateChecker disables auto-download and auto-install on construction (check-then-ask, never silent)', () => {
  const fake = makeFakeAutoUpdater();
  createUpdateChecker({ autoUpdater: fake });
  assert.equal(fake.autoDownload, false);
  assert.equal(fake.autoInstallOnAppQuit, false);
});

test('check() reflects checking -> available through status and listeners', async () => {
  const fake = makeFakeAutoUpdater();
  fake.checkForUpdates = async () => { fake.emit('checking-for-update'); fake.emit('update-available', { version: '1.2.3' }); };
  const checker = createUpdateChecker({ autoUpdater: fake });
  const seen = [];
  checker.onStatus(s => seen.push(s.state));
  const result = await checker.check();
  assert.equal(result.state, 'available');
  assert.equal(result.info.version, '1.2.3');
  assert.deepEqual(seen, ['checking', 'available']);
});

test('check() reflects an up-to-date result', async () => {
  const fake = makeFakeAutoUpdater();
  fake.checkForUpdates = async () => { fake.emit('update-not-available', { version: '1.0.0' }); };
  const checker = createUpdateChecker({ autoUpdater: fake });
  const result = await checker.check();
  assert.equal(result.state, 'up-to-date');
});

// A missing/placeholder publish repo (package.json's build.publish still
// says "REPLACE_WITH_GITHUB_OWNER") or no network must both surface as an
// ordinary status, never throw out of check() and never crash the app.
test('check() turns a thrown error into an error status instead of propagating', async () => {
  const fake = makeFakeAutoUpdater();
  fake.checkForUpdates = async () => { throw new Error('404: repository not found'); };
  const checker = createUpdateChecker({ autoUpdater: fake });
  const result = await checker.check();
  assert.equal(result.state, 'error');
  assert.match(result.error, /404/);
});

test('an error emitted mid-check (not just thrown) also becomes an error status', async () => {
  const fake = makeFakeAutoUpdater();
  fake.checkForUpdates = async () => { fake.emit('error', new Error('network unreachable')); };
  const checker = createUpdateChecker({ autoUpdater: fake });
  const result = await checker.check();
  assert.equal(result.state, 'error');
  assert.match(result.error, /network unreachable/);
});

test('download() reports progress and a downloaded result', async () => {
  const fake = makeFakeAutoUpdater();
  fake.downloadUpdate = async () => {
    fake.emit('download-progress', { percent: 42 });
    fake.emit('update-downloaded', { version: '1.2.3' });
  };
  const checker = createUpdateChecker({ autoUpdater: fake });
  const seen = [];
  checker.onStatus(s => seen.push(s.state));
  const result = await checker.download();
  assert.equal(result.state, 'downloaded');
  assert.deepEqual(seen, ['downloading', 'downloaded']);
});

test('quitAndInstall() calls through to the real autoUpdater.quitAndInstall', () => {
  const fake = makeFakeAutoUpdater();
  const checker = createUpdateChecker({ autoUpdater: fake });
  checker.quitAndInstall();
  assert.equal(fake.installed, true);
});

test('onStatus returns an unsubscribe function', async () => {
  const fake = makeFakeAutoUpdater();
  fake.checkForUpdates = async () => { fake.emit('update-not-available', {}); };
  const checker = createUpdateChecker({ autoUpdater: fake });
  const seen = [];
  const unsubscribe = checker.onStatus(s => seen.push(s.state));
  unsubscribe();
  await checker.check();
  assert.deepEqual(seen, []);
});

// --- Wiring: main.js IPC, preload exposure, and the Settings > About UI ---
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('package.json declares a GitHub publish target for electron-updater, with a clearly-marked placeholder owner', () => {
  assert.equal(packageJson.build?.publish?.provider, 'github');
  assert.equal(packageJson.build.publish.owner, 'REPLACE_WITH_GITHUB_OWNER', 'the placeholder must stay obviously named until the real repo exists');
  assert.equal(typeof packageJson.dependencies?.['electron-updater'], 'string');
});

test('main.js wires the update checker to IPC and never auto-checks in an unpacked dev build', () => {
  assert.match(main, /const \{ autoUpdater \} = require\('electron-updater'\);/);
  assert.match(main, /const updateChecker = createUpdateChecker\(\{ autoUpdater \}\);/);
  assert.match(main, /ipcMain\.handle\('updates:check', async \(\) => updateChecker\.check\(\)\);/);
  assert.match(main, /ipcMain\.handle\('updates:download', async \(\) => updateChecker\.download\(\)\);/);
  assert.match(main, /ipcMain\.handle\('updates:install', async \(\) => \{ updateChecker\.quitAndInstall\(\); return true; \}\);/);
  assert.match(main, /ipcMain\.handle\('updates:status', async \(\) => updateChecker\.getStatus\(\)\);/);
  // The passive startup check must be gated on app.isPackaged, immediately
  // adjacent to the actual check() call -- an unpacked dev checkout has no
  // app-update.yml and would otherwise log a meaningless error every launch.
  const checkCallIndex = main.indexOf('setTimeout(() => { void updateChecker.check(); }, 5000);');
  assert.ok(checkCallIndex >= 0, 'the deferred startup check must exist');
  const guardWindow = main.slice(Math.max(0, checkCallIndex - 200), checkCallIndex);
  assert.match(guardWindow, /if \(app\.isPackaged\) \{/);
});

test('preload exposes the update IPC channels to the renderer', () => {
  assert.match(preload, /checkForUpdates: \(\) => ipcRenderer\.invoke\('updates:check'\)/);
  assert.match(preload, /downloadUpdate: \(\) => ipcRenderer\.invoke\('updates:download'\)/);
  assert.match(preload, /installUpdate: \(\) => ipcRenderer\.invoke\('updates:install'\)/);
  assert.match(preload, /getUpdateStatus: \(\) => ipcRenderer\.invoke\('updates:status'\)/);
  assert.match(preload, /onUpdateStatusChanged: /);
});

test('the About dialog has a check-for-updates action that never downloads or installs on its own', () => {
  assert.match(html, /id="about-check-updates-btn"/);
  assert.match(html, /id="about-update-status"/);
  const start = renderer.indexOf('function renderUpdateStatus(status)');
  const end = renderer.indexOf("window.beehive.getUpdateStatus?.().then(renderUpdateStatus)");
  assert.ok(start >= 0 && end > start, 'renderUpdateStatus must exist');
  const block = renderer.slice(start, end);
  // The button's action is state-driven (check/download/install), not a
  // single hardcoded call -- confirms download/install only ever happen
  // from an explicit subsequent click, never automatically from a check.
  assert.match(block, /btn\.dataset\.updateAction = 'download';/);
  assert.match(block, /btn\.dataset\.updateAction = 'install';/);
  assert.match(renderer, /if \(action === 'install'\) await window\.beehive\.installUpdate\?\.\(\);/);
  assert.match(renderer, /else if \(action === 'download'\) renderUpdateStatus\(await window\.beehive\.downloadUpdate\?\.\(\)\);/);
});
