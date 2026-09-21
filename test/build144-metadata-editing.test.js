'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');

test('empty editable tag fields use Empty ghost text while trim fields show millisecond format', () => {
  assert.match(renderer, /function applyEmptyEditGhosts\(/);
  assert.match(renderer, /placeholder\s*=\s*['"]Empty['"]/);
  assert.match(html, /id="tag-start-time"[^>]*placeholder="00:00\.00"/);
  assert.match(html, /id="tag-end-time"[^>]*placeholder="00:00\.00"/);
});

// Tags (2) used to be a raw "add any native tag key/value" editor -- exactly
// the kind of freeform surface that can corrupt a file if a user types a bad
// frame ID or garbage value. It was replaced with a curated, read-friendly
// panel of a standard tag set (P_count, compilation, BPM, etc.) that maps
// directly to known, safe fields -- no arbitrary native key entry anywhere.
test('Tags (2) is a curated standard-tag panel, not a raw native key/value editor', () => {
  assert.doesNotMatch(renderer, /function renderNativeEditor\(/);
  assert.doesNotMatch(renderer, /function appendNativeEditorRow\(/);
  assert.doesNotMatch(renderer, /function readNativeEditorRows\(/);
  assert.doesNotMatch(html, /id="tag-native-add"/);
  assert.doesNotMatch(html, /id="tag-native-rows"/);
  assert.match(html, /data-tag-panel="tags2"/);
  assert.match(html, /id="tag-pcount"/);
  assert.match(html, /id="tag-compilation"[^>]*type="checkbox"/);
});

test('ReplayGain conversion exposes deterministic dB-to-linear diagnostic coverage', () => {
  assert.match(renderer, /function replayGainDbToLinear\(db\)/);
  assert.match(renderer, /Math\.pow\(10, n \/ 20\)/);
  assert.match(renderer, /engineTrackGain\s*=\s*Math\.max\(0, Math\.min\(8, effective\)\)/);
});
