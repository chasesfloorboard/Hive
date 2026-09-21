'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
const launcher = fs.readFileSync(path.join(root, 'scripts', 'hive-launcher.sh'), 'utf8');

test('user data uses the stable Hive profile while the launcher still identifies the current build root', () => {
  assert.match(main, /process\.env\.HIVE_PORTABLE_ROOT/);
  assert.match(main, /const PORTABLE_ROOT = \(\) => path\.resolve\(getPortableApplicationRoot\(\)\)/);
  assert.match(main, /function stableHiveDataRoot\(\)/);
  assert.match(main, /app\.setPath\('userData', dataRoot\)/);
  assert.match(main, /app\.setPath\('sessionData', path\.join\(dataRoot, 'session'\)\)/);
 });

test('Linux launcher explicitly supplies the portable build root while keeping stable Electron identity', () => {
  assert.match(launcher, /STABLE_ELECTRON/);
  assert.match(launcher, /export HIVE_PORTABLE_ROOT="\$PROJECT_DIR"/);
  assert.match(launcher, /exec "\$STABLE_ELECTRON"/);
});

test('portable data root is clean-install only and never imports machine-global Hive state', () => {
  assert.doesNotMatch(main, /LEGACY_USER_DATA_ROOT/);
  assert.doesNotMatch(main, /legacyPortableDataRoots/);
  assert.doesNotMatch(main, /migrateLegacyUserDataToPortableRoot/);
  assert.doesNotMatch(main, /legacy-user-data-migrated/);
});
