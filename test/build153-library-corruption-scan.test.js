'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app', 'main', 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');

test('Build 153 exposes a full-library asynchronous corruption scan', () => {
  assert.match(main, /scanAudioIntegrityLibrary/);
  assert.match(main, /audio:integrity-scan/);
  assert.match(main, /-xerror/);
  assert.match(main, /-f['\"]\s*,\s*['\"]null/);
  assert.match(preload, /scanAudioIntegrityLibrary/);
  assert.match(preload, /cancelAudioIntegrityScan/);
});

test('full corruption scan decodes the entire track rather than the two-second playback preflight', () => {
  // This once passed while the scan really used the 2-second preflight: a second function with the
  // preflight's name was declared later in main.js and won. So check the call, and that no name is
  // declared twice.
  const start = main.indexOf('async function validateAudioForLibraryScan');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  assert.match(body, /runAudioFullDecode\(absolutePath, 0, scanState\)/);
  assert.doesNotMatch(body, /runAudioPreflightDecode/);
  const full = main.slice(main.indexOf('function runAudioFullDecode('), main.indexOf('\n}\n', main.indexOf('function runAudioFullDecode(')));
  assert.match(full, /'-map', '0:a:0'/);
  assert.match(full, /'-f', 'null'/);
  assert.match(full, /scanState\?\.children\?\.add\(child\)/);
  assert.doesNotMatch(full, /'-t'/);
});

test('main.js declares no top-level function twice (a later one silently replaces the earlier)', () => {
  const counts = {};
  for (const m of main.matchAll(/^(?:async )?function\s+([A-Za-z0-9_$]+)\s*\(/gm)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  assert.deepEqual(Object.entries(counts).filter(([, n]) => n > 1), []);
});

test('Settings Library provides start/cancel controls and progress/results', () => {
  assert.match(html, /id="audio-integrity-scan-btn"/);
  assert.match(html, /id="audio-integrity-scan-cancel-btn"/);
  assert.match(html, /id="audio-integrity-scan-progress"/);
  assert.match(html, /id="audio-integrity-scan-results"/);
  assert.match(renderer, /scanAudioIntegrityLibrary/);
  assert.match(renderer, /onAudioIntegrityScanProgress/);
});
