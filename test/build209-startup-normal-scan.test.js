'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');

test('Build 209 startup library reconciliation never schedules the full first-library integrity audit', () => {
  assert.doesNotMatch(main, /maybeRunFirstLibraryIntegrityAudit\(auditPaths, firstLibraryScan, evt\.sender\)/);
  assert.match(main, /async function maybeRunFirstLibraryIntegrityAudit/);
});

test('Build 209 keeps the thorough integrity scanner available as an explicit operation', () => {
  assert.match(main, /ipcMain\.handle\('audio:integrity-scan'/);
  assert.match(main, /async function scanAudioIntegrityLibrary/);
  assert.match(main, /'-xerror'/);
});

// Real bug, confirmed live via the session log: fs.watch(folder,
// {recursive:true}) is emulated on Linux by walking and stat-ing the whole
// tree to register a per-directory inotify watch. On a ~30k-file library
// this measured 40+ seconds, and it ran inside the awaited app.whenReady()
// startup chain -- freezing the ENTIRE main process (all IPC, hence the
// renderer itself) for that whole window, exactly like awaiting a slow
// database/network call there would. startLibraryWatchers() must fire in
// the background the same way artworkProxy/mpris/discordPresence already do
// just above it, not block the window from becoming interactive.
test('library watchers start in the background and never block app startup', () => {
  const start = main.indexOf("startupDebug('LIBRARY WATCHERS START');");
  const end = main.indexOf("app.isPackaged", start);
  assert.ok(start >= 0 && end > start, 'expected to find the library watchers startup block');
  const block = main.slice(start, end);
  assert.doesNotMatch(block, /await startLibraryWatchers\(\)/);
  assert.match(block, /startLibraryWatchers\(\)\s*\n\s*\.then\(\(\) => startupDebug\('LIBRARY WATCHERS COMPLETE'/);
});
