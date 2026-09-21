const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

test('Build 233 top-bar search remains in the navigation row under the current flow-based layout', () => {
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-right\s*\{[\s\S]*?position:\s*relative[\s\S]*?align-self:\s*center/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-titlebar-row > \.window-controls\s*\{[\s\S]*?z-index:\s*200[\s\S]*?pointer-events:\s*auto/);
  assert.match(css, /html\.theme-window-bar-enabled \.search-box\s*\{[\s\S]*?transform:\s*none/);
});

test('Build 233 keeps themed search and window controls interactive', () => {
  assert.match(css, /html\.theme-window-bar-enabled #topbar\s*\{[\s\S]*?-webkit-app-region:\s*drag/);
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-app-row,[\s\S]*?-webkit-app-region:\s*no-drag/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-titlebar-row\s*\{[\s\S]*?pointer-events:\s*none/);
  assert.match(css, /#topbar button,[\s\S]*?#topbar input/);
  assert.match(css, /\.window-control\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/);
});

test('Build 233 provides an in-project Hive user-data backup and recovery path', () => {
  assert.match(main, /function hiveUserBackupRoot\(\)/);
  assert.match(main, /User Data Backup/);
  assert.match(main, /function backupHiveUserDataSync\(\)/);
  assert.match(main, /function restoreHiveUserBackupSync\(dataRoot\)/);
  assert.match(main, /backupHiveUserDataSync\(\)/);
  assert.match(main, /restoreHiveUserBackupSync\(dataRoot\)/);
});

test('Build 233 mirrors persisted JSON outside cache/session/log data', () => {
  assert.match(main, /p !== LIBRARY_CACHE_PATH\(\)/);
  assert.match(main, /User-data JSON backup skipped/);
  assert.match(main, /copyFile\(p, backupPath\)/);
});
