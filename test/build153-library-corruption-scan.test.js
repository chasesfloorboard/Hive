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
  const start = main.indexOf('async function validateAudioForLibraryScan');
  const end = main.indexOf('async function scanAudioIntegrityLibrary', start);
  assert.ok(start >= 0 && end > start);
  const body = main.slice(start, end);
  assert.match(body, /'-i', absolutePath/);
  assert.match(body, /'-map', '0:a:0'/);
  assert.match(body, /'-f', 'null'/);
  assert.doesNotMatch(body, /'-t', String\(AUDIO_PREFLIGHT_SECONDS\)/);
});

test('Settings Library provides start/cancel controls and progress/results', () => {
  assert.match(html, /id="audio-integrity-scan-btn"/);
  assert.match(html, /id="audio-integrity-scan-cancel-btn"/);
  assert.match(html, /id="audio-integrity-scan-progress"/);
  assert.match(html, /id="audio-integrity-scan-results"/);
  assert.match(renderer, /scanAudioIntegrityLibrary/);
  assert.match(renderer, /onAudioIntegrityScanProgress/);
});
