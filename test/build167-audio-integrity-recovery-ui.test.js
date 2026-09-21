'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');

test('interrupted audio scan exposes one primary scan action and keeps start-over secondary', () => {
  assert.match(renderer, /audioIntegrityScanBtn\.textContent\s*=\s*`↻ Resume interrupted scan/);
  assert.match(renderer, /startOverBtn\.className='settings-inline-action hidden'/);
  assert.doesNotMatch(renderer, /startOverBtn\.className='sidebar-add hidden'/);
});

test('running audio scan shows Cancel scan as the only scan action', () => {
  assert.match(renderer, /function setAudioIntegrityScanRunning\(running\)[\s\S]*audioIntegrityScanBtn\.hidden = running/);
  assert.match(renderer, /function setAudioIntegrityScanRunning\(running\)[\s\S]*audioIntegrityScanCancelBtn\.hidden = !running/);
});

test('scan checkpoint retains completed work and prior findings across an app interruption', () => {
  const start = main.indexOf('function writeAudioIntegrityScanCheckpoint');
  const end = main.indexOf('async function readAudioIntegrityScanCheckpoint', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /completedPaths:\s*\[\.\.\.state\.completedPaths\]/);
  assert.match(block, /corrupt:\s*state\.corrupt/);
  assert.match(block, /unavailable:\s*state\.unavailable/);
  assert.match(block, /loveConflicts:\s*state\.loveConflicts/);
});

test('audio scan checkpoint writes are serialized so concurrent workers cannot overwrite newer progress with an older snapshot', () => {
  assert.match(main, /let audioIntegrityCheckpointWriteChain\s*=\s*Promise\.resolve\(\)/);
  assert.match(main, /audioIntegrityCheckpointWriteChain\s*=\s*audioIntegrityCheckpointWriteChain\s*\.catch\(\(\)\s*=>\s*\{\}\)\s*\.then\(\(\)\s*=>\s*\{/);
  assert.match(main, /return writeJsonSafe\(AUDIO_INTEGRITY_SCAN_CHECKPOINT_PATH\(\), payload\);/);
  assert.match(main, /return audioIntegrityCheckpointWriteChain/);
});

test('the normal Scan entire library button remains the single idle scan action', () => {
  assert.match(html, /id="audio-integrity-scan-btn"[^>]*>⌕ Scan entire library</);
  assert.match(html, /id="audio-integrity-scan-cancel-btn"[^>]*disabled>Cancel scan</);
});
