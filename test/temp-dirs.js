'use strict';
// Temporary folders for a test file, removed when that file's tests finish (node --test runs each
// file in its own process). Only folders made here, under the system temp folder, are removed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const made = [];
process.on('exit', () => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  }
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

module.exports = { tempDir };
