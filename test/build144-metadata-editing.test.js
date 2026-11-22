'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');

test('empty tag fields are left blank (no "Empty" ghost); bulk shows a multi-value hint; trim uses hidden inputs', () => {
  // Empty single fields read as blank — the label above each field already says what belongs there.
  // The literal word "Empty" (unprofessional) is gone, as is the ghost-filling helper.
  assert.doesNotMatch(renderer, /placeholder\s*=\s*['"]Empty['"]/);
  assert.doesNotMatch(renderer, /function applyEmptyEditGhosts\(/);
  // A multi-selection whose files disagree still shows which fields differ.
  assert.match(renderer, /node\.placeholder\s*=\s*multiLabel/);
  // Trim times are edited as hour / minute / second boxes backed by hidden
  // #tag-start-time / #tag-end-time inputs (see build195 test).
  assert.match(html, /<input type="hidden" id="tag-start-time">/);
  assert.match(html, /<input type="hidden" id="tag-end-time">/);
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
  // The pure dB-to-linear math lives in replaygain.js now (docs/ai/ARCHITECTURE.md); renderer wires it.
  const replaygain = fs.readFileSync(path.join(root, 'app', 'renderer', 'replaygain.js'), 'utf8');
  assert.match(replaygain, /function replayGainDbToLinear\(db\)/);
  assert.match(replaygain, /Math\.pow\(10, n \/ 20\)/);
  assert.match(renderer, /window\.HiveReplayGain/);
  assert.match(renderer, /engineTrackGain\s*=\s*Math\.max\(0, Math\.min\(8, effective\)\)/);
});
