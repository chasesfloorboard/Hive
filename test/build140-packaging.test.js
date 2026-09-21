'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const shellEntrypoints = [
  'install.sh',
  'run.sh',
  'setup-music-presence.sh',
  'enable-music-presence-autostart.sh',
  'scripts/hive-launcher.sh',
  'scripts/spotify-background.sh',
];

test('shipped shell entrypoints are executable', () => {
  for (const relative of shellEntrypoints) {
    const mode = fs.statSync(path.join(root, relative)).mode & 0o777;
    assert.equal(mode, 0o755, `${relative} must be mode 0755, got ${mode.toString(8)}`);
  }
});
