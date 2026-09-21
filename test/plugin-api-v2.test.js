const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const docsPath = path.join(root, 'docs', 'PLUGIN_API.md');

// The first-party example plugin these tests used to check against
// (resources/hive-plugins/monstercat-visualizer) was removed -- it never
// worked under this app's CSP (plugins:run in main.js executes plugin code
// via `new Function(...)`, which requires 'unsafe-eval', and the CSP does not
// grant that) and is being rewritten. This file keeps the coverage that is
// independent of any specific bundled plugin: the public API v2 contract
// documented for third-party plugin authors.
test('Hive plugin documentation names the public API standard', () => {
  const docs = fs.readFileSync(docsPath, 'utf8');
  assert.match(docs, /Hive Plugin API v2/);
  assert.match(docs, /player\.read/);
  assert.match(docs, /spectrum\.read/);
  assert.match(docs, /registerSandboxPanel/);
  assert.match(docs, /ui\.sandbox/);
  assert.doesNotMatch(docs, /registerNowPlayingPanel/);
});
