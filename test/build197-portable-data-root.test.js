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

// Superseded: this used to assert the opposite -- that the portable root
// deliberately never imported machine-global (~/.config) state, back when
// user data intentionally lived OUTSIDE the Hive folder (see the newer test
// below for why and when that changed). Kept only to confirm the old,
// since-abandoned migration identifiers from that era don't reappear.
test('no leftover identifiers from the old one-way ~/.config-is-canonical migration', () => {
  assert.doesNotMatch(main, /LEGACY_USER_DATA_ROOT/);
  assert.doesNotMatch(main, /legacyPortableDataRoots/);
  assert.doesNotMatch(main, /migrateLegacyUserDataToPortableRoot/);
  assert.doesNotMatch(main, /legacy-user-data-migrated/);
});

// Real feature, explicitly requested: Hive should be truly portable -- the
// whole folder (app + data, including plugins/themes) movable to another
// drive or machine and keep working, not just the app code with a
// machine-global profile hanging off it. stableHiveDataRoot() now resolves
// inside the Hive folder itself (found via findHiveContainerRoot, same
// mechanism already used for "Hive Wrapped Data"/"User Data Backup"), and
// USER_DATA() (which PLUGINS_DIR/THEMES_DIR are both derived from) follows
// automatically since it's just app.getPath('userData') pointed at that root.
test('stable data root lives inside the Hive folder, not a per-machine home-directory location', () => {
  const start = main.indexOf('function stableHiveDataRoot() {');
  const end = main.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'expected to find stableHiveDataRoot()');
  const block = main.slice(start, end);
  assert.match(block, /const hiveRoot = findHiveContainerRoot\(PORTABLE_ROOT\(\)\);/);
  assert.match(block, /if \(hiveRoot\) return path\.join\(hiveRoot, 'Hive Data'\);/);
  // Falls back to the old per-OS location only if Hive isn't running from a
  // folder literally named "hive" -- not as the normal case.
  assert.match(block, /return legacyStableConfigRoot\(\);/);
});

// Anyone with an existing ~/.config/Hive-based install (every install before
// this change) must not lose their database/settings/playlists/plugins --
// migrate that data into the new in-folder root once, non-destructively
// (never overwrites an existing file at the destination, never deletes or
// modifies the source), the same safety shape as the existing
// findLegacyBuildDataRoot() migration right above it in configureStableDataPaths().
test('existing ~/.config-based user data is migrated into the portable root once, without deleting the original', () => {
  const start = main.indexOf('function configureStableDataPaths() {');
  const end = main.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'expected to find configureStableDataPaths()');
  const block = main.slice(start, end);
  assert.match(block, /const legacyConfig = legacyStableConfigRoot\(\);/);
  assert.match(block, /copyDirectoryContentsSync\(legacyConfig, dataRoot,/);
  assert.doesNotMatch(block, /fs\.rmSync\(legacyConfig/);
  assert.doesNotMatch(block, /rm(?:dir)?Sync\(legacyConfig/);
});

// Real problem found while building the migration above: on a real library,
// "Tag Backups" (pre-write safety copies of whole audio files -- see
// backupFileBeforeMetadataCommit in metadata-writer.js) had grown to 98GB
// with no pruning, dwarfing the actual settings/database and completely
// unrelated to what a "portable folder" migration should be moving. Copying
// it as part of this migration would make first launch hang for a very long
// time and might not fit on a smaller destination drive.
test('Tag Backups is excluded from the portable-mode migration -- it stays on the original machine', () => {
  const start = main.indexOf('const legacyConfig = legacyStableConfigRoot();');
  const end = main.indexOf('\n    }', start);
  assert.ok(start >= 0 && end > start, 'expected to find the portable-mode migration block');
  const block = main.slice(start, end);
  assert.match(block, /skipDirs: new Set\(\[\.\.\.BACKUP_EXCLUDED_DIRS, 'Tag Backups'\]\)/);
});
