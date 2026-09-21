'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');

test('queue virtual rows use an explicit top offset so a newly queued Favorites collection cannot render off-layer', () => {
  const start = source.indexOf('function updateQueueVirtualRows(');
  const end = source.indexOf('// Warm artwork for coverless albums', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /row\.style\.top\s*=\s*`\$\{index \* rowHeight\}px`/);
});

