'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'app/renderer/styles.css'), 'utf8');

function selectorBlock(selector) {
  const start = css.indexOf(selector);
  const end = css.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `${selector} must exist`);
  return css.slice(start, end + 2);
}

test('albums viewer main frame has rounded bottom corners', () => {
  const block = selectorBlock('#main {');
  assert.match(block, /border-radius:\s*var\(--radius\)\s*;/);
});

test('albums viewer frame must not use square bottom corners', () => {
  const block = selectorBlock('#main {');
  assert.doesNotMatch(block, /border-radius:\s*var\(--radius\)\s*var\(--radius\)\s*0\s+0/);
});

test('playbar glass surface keeps its established upper-only radius', () => {
  const block = selectorBlock('#playbar.player-glass-surface');
  assert.match(block, /border-radius:\s*var\(--radius\)\s*var\(--radius\)\s*0\s+0/);
});
