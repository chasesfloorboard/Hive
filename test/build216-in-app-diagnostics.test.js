'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { redactDiagnosticText, formatDiagnosticReport, createDiagnosticsController } = require('../app/main/diagnostics');

test('diagnostic redaction removes music-library paths', () => {
  const input = 'file=/home/tester/Music/Secret Album/track.flac home=/home/tester';
  const out = redactDiagnosticText(input, ['/home/tester/Music']);
  assert.equal(out.includes('Secret Album/track.flac'), false);
  assert.equal(out.includes('/home/tester/Music'), false);
  assert.match(out, /<music-library-path>/);
});

test('report formatter emits session and collection status without raw paths', () => {
  const text = formatDiagnosticReport({
    version: '1.0.0-rc.1', build: '216',
    session: { startedAt: '2026-09-16T00:00:00.000Z', endedAt: '2026-09-16T00:01:00.000Z', elapsedMs: 60000 },
    sections: [{ name: 'Runtime', status: 'PASS', body: 'rss=123' }],
    warnings: [],
    roots: ['/home/tester/Music/Secret Album']
  });
  assert.match(text, /Hive Diagnostic Report/);
  assert.match(text, /Runtime/);
  assert.doesNotMatch(text, /Secret Album/);
});

test('session lifecycle starts and finishes', async () => {
  const controller = createDiagnosticsController({
    collect: async () => ({ sections: [], warnings: [] }),
    userDataDir: '/tmp/hive-test-diagnostics',
    writeReport: async () => '/tmp/report.txt'
  });
  assert.equal(controller.getStatus().active, false);
  const started = controller.startSession();
  assert.equal(started.active, true);
  const finished = await controller.finishSession();
  assert.equal(finished.active, false);
  assert.match(finished.reportPath, /hive-diagnostic-\d{8}-\d{6}\.txt$/);
});

test('diagnostic sessions retain an action timeline', async () => {
  const controller = createDiagnosticsController({
    userDataDir: '/tmp/hive-test-diagnostics-timeline',
    writeReport: async (_path, text) => { assert.match(text, /Diagnostic action timeline/); assert.match(text, /VOLUME INPUT/); return _path; }
  });
  controller.startSession();
  controller.mark('VOLUME INPUT', 'value=42');
  const result = await controller.finishSession();
  assert.equal(result.active, false);
});

test('preload exposes the in-app diagnostic bridge', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'app/main/preload.js'), 'utf8');
  for (const name of ['startDiagnostics', 'finishDiagnostics', 'getDiagnosticsStatus', 'openDiagnosticsFolder', 'diagnosticMark']) assert.match(preload, new RegExp(name));
});

test('main registers the diagnostic IPC channels', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'app/main/main.js'), 'utf8');
  for (const name of ['diagnostics:start', 'diagnostics:finish', 'diagnostics:status', 'diagnostics:mark', 'diagnostics:open-folder']) assert.match(main, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Settings Logs surface contains the diagnostic controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app/renderer/index.html'), 'utf8');
  for (const id of ['settings-diagnostics-start', 'settings-diagnostics-finish', 'settings-diagnostics-open', 'settings-diagnostics-status', 'settings-diagnostics-crash-course']) assert.match(html, new RegExp(id));
});

test('renderer wires diagnostic actions', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'app/renderer/renderer.js'), 'utf8');
  assert.match(renderer, /startDiagnostics/);
  assert.match(renderer, /finishDiagnostics/);
  assert.match(renderer, /openDiagnosticsFolder/);
});

test('Build 216 diagnostic documentation exists', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'docs/development-BUILD216-IN-APP-DIAGNOSTICS.md')), true);
});

// Moved here from build151-volume-unmute-safety.test.js during the #12
// buildNNN consolidation pass -- this was a generic renderer diagnostics
// check, not a volume test.
test('renderer surfaces GStreamer diagnostic events for stalled-track investigation', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'app/renderer/renderer.js'), 'utf8');
  const native = fs.readFileSync(path.join(__dirname, '..', 'app/native/gstreamer-player.c'), 'utf8');
  assert.match(renderer, /GSTREAMER.*EVENT|GStreamer.*event|gstreamer:event/i);
  assert.match(renderer, /console\.error|console\.warn|console\.log/);
  assert.match(native, /HIVE_GST_TRACE/);
  assert.match(native, /TRACE|trace/i);
  assert.match(native, /COMMAND/);
  assert.match(native, /STATE_CHANGED/);
});
