'use strict';
// Canonical, stable home for the "N songs selected" hover tooltip (total
// duration + combined file size of the current selection). Edit this file
// in place when this feature's architecture legitimately changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = renderer.indexOf(marker);
  assert.ok(start >= 0, `expected to find function ${name}`);
  let depth = 0;
  let i = renderer.indexOf('{', start);
  const bodyStart = i;
  depth = 1; i++;
  for (; i < renderer.length; i++) {
    if (renderer[i] === '{') depth++;
    else if (renderer[i] === '}') { depth--; if (depth === 0) break; }
  }
  const src = renderer.slice(start, i + 1);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${src}\nthis.__fn = ${name};`, context);
  return context.__fn;
}

const formatDurationLong = extractFunction('formatDurationLong');
const formatFileSizeShort = extractFunction('formatFileSizeShort');

test('formatDurationLong only shows units that actually apply, never a leading zero unit', () => {
  assert.equal(formatDurationLong(0), '0s');
  assert.equal(formatDurationLong(45), '45s');
  assert.equal(formatDurationLong(185), '3m 5s');
  assert.equal(formatDurationLong(3661), '1h 1m 1s');
  // Once a larger unit is shown, smaller ones show too even at zero, so the
  // duration still reads correctly (not collapsed/ambiguous).
  assert.equal(formatDurationLong(7200), '2h 0m 0s');
  assert.equal(formatDurationLong(90000), '1d 1h 0m 0s');
  assert.equal(formatDurationLong(172800), '2d 0h 0m 0s');
  // Never negative, never NaN passthrough.
  assert.equal(formatDurationLong(-50), '0s');
  assert.equal(formatDurationLong(NaN), '0s');
});

test('formatFileSizeShort renders a compact lowercase unit, decimal only when not a whole number', () => {
  assert.equal(formatFileSizeShort(0), '0b');
  assert.equal(formatFileSizeShort(500), '500b');
  assert.equal(formatFileSizeShort(340 * 1024 * 1024), '340mb');
  assert.equal(formatFileSizeShort(1.2 * 1024 * 1024 * 1024), '1.2gb');
  assert.equal(formatFileSizeShort(-100), '0b');
});

test('updateSelectionStatus sets a combined duration + size tooltip on the selection-status element', () => {
  const start = renderer.indexOf('function updateSelectionStatus()');
  const end = renderer.indexOf('\n  function clearAlbumSelection', start);
  assert.ok(start >= 0 && end > start, 'updateSelectionStatus must exist');
  const block = renderer.slice(start, end);
  assert.match(block, /const tracks = selectedTracksForStatus\(\);/);
  assert.match(block, /totalSeconds \+= |reduce\(\(sum, t\) => sum \+ \(Number\(t\?\.duration\)/);
  assert.match(block, /reduce\(\(sum, t\) => sum \+ \(Number\(t\?\.fileSize\)/);
  assert.match(block, /node\.dataset\.tooltip = `\$\{formatDurationLong\(totalSeconds\)\} · \$\{formatFileSizeShort\(totalBytes\)\}`;/);
  assert.match(block, /delete node\.dataset\.tooltip;/);
});
