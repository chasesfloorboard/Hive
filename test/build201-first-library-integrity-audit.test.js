'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');

test('first library scan has a durable one-time integrity audit state separate from normal library cache', () => {
  assert.match(main, /AUDIO_INTEGRITY_FIRST_SCAN_STATE_PATH/);
  assert.match(main, /async function readFirstLibraryIntegrityAuditState/);
  assert.match(main, /async function writeFirstLibraryIntegrityAuditState/);
  assert.doesNotMatch(main, /AUDIO_INTEGRITY_FIRST_SCAN_STATE_PATH\(\).*LIBRARY_CACHE_PATH\(\)/);
});

test('the thorough integrity audit remains available as an explicit operation rather than a startup action', () => {
  assert.match(main, /async function scanAudioIntegrityLibrary/);
  assert.match(main, /scanAudioIntegrityLibrary\(paths/);
  assert.match(main, /generateAudioIntegrityReport\(result\)/);
  assert.match(main, /status:\s*['"]complete['"]/);
});

test('dormant first-audit state machinery does not participate in ordinary library scans', () => {
  const start = main.indexOf('async function maybeRunFirstLibraryIntegrityAudit');
  const end = main.indexOf("ipcMain.handle('yearly-wrap:chooseMusicBeeImport'", start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /if \(state\?\.status === ['"]complete['"]\)/);
  assert.match(block, /state\?\.status === ['"]running['"]/);
  assert.match(block, /!firstScan/);
  assert.doesNotMatch(main, /maybeRunFirstLibraryIntegrityAudit\(auditPaths, firstLibraryScan, evt\.sender\)/);
});

test('first audit report records metadata inspection failures separately from decoder corruption', () => {
  const start = main.indexOf('function formatAudioIntegrityReport');
  const end = main.indexOf('async function generateAudioIntegrityReport', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /metadataIssues/);
  assert.match(block, /METADATA INSPECTION ISSUES/);
  assert.match(block, /Corrupted:/);
});

test('if the dormant first-audit helper is ever used, it only completes state after its report is written', () => {
  const start = main.indexOf('async function maybeRunFirstLibraryIntegrityAudit');
  const end = main.indexOf("ipcMain.handle('yearly-wrap:chooseMusicBeeImport'", start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  const reportIndex = block.indexOf('generateAudioIntegrityReport(result)');
  const completeIndex = block.indexOf("status:'complete'");
  assert.ok(reportIndex >= 0 && completeIndex > reportIndex);
});

test('legacy first-audit completion handling remains harmless when no startup audit is scheduled', () => {
  const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'app', 'main', 'preload.js'), 'utf8');
  assert.match(preload, /onFirstScanIntegrityComplete/);
  assert.match(renderer, /onFirstScanIntegrityComplete/);
  assert.match(renderer, /First library integrity audit/);
  assert.match(renderer, /corrupt\.toLocaleString\(\)/);
  assert.match(renderer, /reportPath/);
});

test('normal scans do not invoke the first-library integrity audit hook', () => {
  const checkpointStart = main.indexOf('async function readAudioIntegrityScanCheckpoint');
  const checkpointEnd = main.indexOf('async function clearAudioIntegrityScanCheckpoint', checkpointStart);
  assert.ok(checkpointStart >= 0 && checkpointEnd > checkpointStart);
  const checkpointBlock = main.slice(checkpointStart, checkpointEnd);
  assert.doesNotMatch(checkpointBlock, /!completedPaths\.size/);

  const scanEnd = main.lastIndexOf('if (firstLibraryScan)');
  assert.equal(scanEnd, -1);
  assert.doesNotMatch(main, /maybeRunFirstLibraryIntegrityAudit\(auditPaths, firstLibraryScan, evt\.sender\)/);
});

// Moved here from build165-favorites-and-scan-recovery.test.js (consolidated
// into test/playlist-sidebar-navigation.test.js) -- this test is about
// audio-integrity checkpoint resumability, not Favorites.
test('audio integrity checkpoints serialize completed paths as an array so resume can recover completed work', () => {
  const start = main.indexOf('function writeAudioIntegrityScanCheckpoint');
  const end = main.indexOf('async function readAudioIntegrityScanCheckpoint', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /completedPaths:\s*\[\.\.\.state\.completedPaths\]/);
});
