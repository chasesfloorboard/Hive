'use strict';
// Hive already has a substantial JS-level crash/diagnostic system
// (crashDebug()/session-log.js: uncaughtException, unhandledRejection,
// render-process-gone, gpu-process-crashed, child-process-gone, a manual
// diagnostic-session recorder). None of that can see a hard native crash --
// a segfault in the C GStreamer helper, a native Node addon, or
// Electron/Chromium itself kills the process before any JS handler ever
// runs. Electron's own crashReporter covers that one remaining gap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');

test('crashReporter is imported and started, with uploads disabled (Hive is offline-first and does not phone home)', () => {
  assert.match(main, /const \{ app, BrowserWindow,.*crashReporter \} = require\('electron'\);/);
  assert.match(main, /crashReporter\.start\(\{ productName: 'Hive', companyName: 'Hive', uploadToServer: false, compress: true \}\)/);
});

// A crash reporter that starts before the portable userData root is
// established would write dumps to the OS default location instead of
// Hive's own self-contained portable data area -- defeating the point of a
// portable build. It must start strictly after configureStableDataPaths().
test('the crash reporter starts after the portable userData root is established, not before', () => {
  const configureCallIndex = main.indexOf('configureStableDataPaths();');
  const crashReporterStartIndex = main.indexOf("crashReporter.start({");
  assert.ok(configureCallIndex >= 0, 'configureStableDataPaths() must be called');
  assert.ok(crashReporterStartIndex >= 0, 'crashReporter.start must be called');
  assert.ok(crashReporterStartIndex > configureCallIndex, 'crashReporter.start must run after the portable data root is established');
});

// Real bug, confirmed live: crashReporter.getCrashesDirectory() was removed
// from Electron's API (replaced by app.getPath('crashDumps')) well before
// Electron 33.2.0, the version this project is pinned to -- both handlers
// threw a TypeError on every call. Fixed to use app.getPath('crashDumps').
test('crash reports can be opened and counted via IPC, both reading the real crash directory', () => {
  assert.match(main, /ipcMain\.handle\('diagnostics:openCrashReports', async \(\) => \{/);
  assert.match(main, /ipcMain\.handle\('diagnostics:crashReportCount', async \(\) => \{/);
  const openBlock = main.slice(main.indexOf("ipcMain.handle('diagnostics:openCrashReports'"), main.indexOf("ipcMain.handle('diagnostics:crashReportCount'"));
  assert.match(openBlock, /app\.getPath\('crashDumps'\)/);
  assert.doesNotMatch(openBlock, /crashReporter\.getCrashesDirectory/);
  assert.match(openBlock, /shell\.openPath\(dir\)/);
  const countStart = main.indexOf("ipcMain.handle('diagnostics:crashReportCount'");
  const countBlock = main.slice(countStart, countStart + 400);
  assert.match(countBlock, /app\.getPath\('crashDumps'\)/);
  assert.doesNotMatch(countBlock, /crashReporter\.getCrashesDirectory/);
  assert.match(countBlock, /fsp\.readdir\(dir\)/);
});

test('preload exposes the crash report IPC channels to the renderer', () => {
  assert.match(preload, /openCrashReports: \(\) => ipcRenderer\.invoke\('diagnostics:openCrashReports'\)/);
  assert.match(preload, /crashReportCount: \(\) => ipcRenderer\.invoke\('diagnostics:crashReportCount'\)/);
});

test('Settings > Diagnostics has a native crash reports section that opens the folder and reports a live count', () => {
  assert.match(html, /id="settings-crash-reports-open"/);
  assert.match(html, /id="settings-crash-reports-status"/);
  assert.match(html, /never uploads them automatically/);
  assert.match(renderer, /crashReportsOpen: document\.getElementById\('settings-crash-reports-open'\)/);
  assert.match(renderer, /crashReportsStatus: document\.getElementById\('settings-crash-reports-status'\)/);
  assert.match(renderer, /window\.beehive\.crashReportCount\?\.\(\)/);
  assert.match(renderer, /window\.beehive\.openCrashReports\?\.\(\)/);
  assert.match(renderer, /void refreshCrashReportsStatus\(\);/);
});
