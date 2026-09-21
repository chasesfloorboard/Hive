'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app', 'main', 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');

test('Hive stores persistent user data in the stable profile and derives a portable build root', () => {
  assert.match(main, /function getPortableApplicationRoot\(\)/);
  assert.match(main, /const PORTABLE_ROOT = \(\) => path\.resolve\(getPortableApplicationRoot\(\)\)/);
  assert.match(main, /function stableHiveDataRoot\(\)/);
  assert.match(main, /app\.setPath\('userData', dataRoot\)/);
  assert.match(main, /app\.setPath\('sessionData', path\.join\(dataRoot, 'session'\)/);
  assert.match(main, /User Data Backup/);
});

test('configured music folders are persisted portably and resolved back to absolute paths', () => {
  assert.match(main, /function serializePortableFolder\(folder\)/);
  assert.match(main, /function resolveConfiguredFolder\(folder\)/);
  assert.match(main, /function resolveConfigFolders\(config\)/);
  assert.match(main, /source\.map\(resolveConfiguredFolder\)/);
  assert.match(main, /serializePortableFolder\(folder\)/);
});

test('audio integrity exposes a safe repair action and report actions', () => {
  assert.match(main, /async function repairCorruptAudioFile\(item, sender\)/);
  assert.match(main, /audio:integrity-repair-corrupt/);
  assert.match(main, /audio:integrity-report/);
  assert.match(main, /AUDIO_INTEGRITY_REPORTS_DIR/);
  assert.match(preload, /repairCorruptAudioFile/);
  assert.match(preload, /generateAudioIntegrityReport/);
  assert.match(preload, /openAudioIntegrityReports/);
});

test('corrupt repair validates the recovered file before replacing the original and creates a backup', () => {
  const start = main.indexOf('async function repairCorruptAudioFile');
  const end = main.indexOf('const AUDIO_INTEGRITY_SCAN_CHECKPOINT_PATH', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /-err_detect.*ignore_err/);
  assert.match(block, /validateAudioForLibraryScan\(tempPath/);
  assert.match(block, /copyFile\(absolutePath, backupPath\)/);
  assert.match(block, /rename\(tempPath, absolutePath\)/);
});

test('Audio Integrity UI provides report generation and per-file repair controls', () => {
  assert.match(html, /id="audio-integrity-report-btn"/);
  assert.match(html, /id="audio-integrity-open-reports-btn"/);
  assert.match(renderer, /generateAudioIntegrityReport/);
  assert.match(renderer, /repairCorruptAudioFile/);
  assert.match(renderer, /Repair file/);
});
