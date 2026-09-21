'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

test('renderer throttles ordinary MPRIS synchronization to five seconds', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.match(source, /mprisSyncTimer = setTimeout\(runMprisSync, 5000\)/);
  assert.match(source, /mprisHeartbeatTimer = setInterval\(\(\) => \{/);
  assert.match(source, /\}, 5000\);\n    mprisHeartbeatTimer\.unref/);
  assert.match(source, /scheduleMprisSync\(true\)/);
});

test('MPRIS artwork diagnostics are not emitted on every sync', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
  assert.match(source, /\[MPRIS\] artwork resolution/);
  assert.match(source, /lastMprisArtworkLogAt/);
  assert.match(source, /MPRIS_ARTWORK_LOG_INTERVAL_MS = 5000/);
  assert.match(source, /now - lastMprisArtworkLogAt >= MPRIS_ARTWORK_LOG_INTERVAL_MS/);
  assert.doesNotMatch(source, /lastMprisArtworkLogKey/);
});
