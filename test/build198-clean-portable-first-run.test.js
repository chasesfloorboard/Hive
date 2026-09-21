'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
const launcher = fs.readFileSync(path.join(root, 'scripts', 'hive-launcher.sh'), 'utf8');

test('stable profile migration is explicit and the in-project backup is the recovery source', () => {
  assert.match(main, /function configureStableDataPaths\(\)/);
  assert.match(main, /function restoreHiveUserBackupSync\(dataRoot\)/);
  assert.match(main, /User Data Backup/);
});

test('all Hive persistent user state is rooted in the stable profile', () => {
  assert.match(main, /const STABLE_DATA_ROOT = \(\) => stableHiveDataRoot\(\)/);
  assert.match(main, /app\.setPath\('userData', dataRoot\)/);
  assert.match(main, /app\.setPath\('sessionData', path\.join\(dataRoot, 'session'\)\)/);
});

test('portable data path is established before Electron creates the ready application state', () => {
  const setPath = main.indexOf("app.setPath('userData', dataRoot)");
  const whenReady = main.indexOf('app.whenReady()');
  assert.ok(setPath >= 0 && whenReady >= 0 && setPath < whenReady);
});

test('Linux launcher identifies the current extracted folder as Hive portable root', () => {
  assert.match(launcher, /export HIVE_PORTABLE_ROOT="\$PROJECT_DIR"/);
  assert.match(launcher, /exec "\$STABLE_ELECTRON"/);
});
