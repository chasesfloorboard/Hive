'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The watcher-triggered incremental scan (ipcMain.handle('library:scanChanged')) runs a tiny worker
// pool inside main.js. A worker that dies mid-file used to be fatal in two ways: its id-less
// {type:'fatal'} message was consumed as the current file's answer, and the dead worker was never
// replaced (no-op exit handler), so every later file dispatched to that slot threw on a closed channel
// and was dropped -- a brand-new file dropped that way is silently never indexed. This guards the fix:
// the id-less message is ignored, and a crashed worker is recovered (replaced) like a hung one.
const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'main.js'), 'utf8');

function sliceBetween(from, to) {
  const start = main.indexOf(from);
  assert.ok(start >= 0, `expected to find ${from}`);
  const end = main.indexOf(to, start);
  assert.ok(end > start, `expected ${to} after ${from}`);
  return main.slice(start, end);
}

// The incremental-scan body: from its IPC handler to where it stops using the worker pool.
const block = sliceBetween("ipcMain.handle('library:scanChanged'", 'const persisted = []');

test("incremental scan ignores a worker's id-less fatal message (does not treat it as a file answer)", () => {
  assert.match(block, /if \(msg\?\.id !== i\) return;/, 'the message guard must ignore anything not addressed to this file, including an id-less fatal');
  assert.doesNotMatch(block, /msg\?\.id !== undefined && msg\.id !== i/, 'the old guard that let an id-less fatal through must be gone');
});

test('incremental scan replaces a crashed worker instead of leaving the slot dead', () => {
  assert.match(block, /const recoverSlot = \(slot, why\) =>/, 'a recoverSlot helper must exist');
  const recover = block.slice(block.indexOf('const recoverSlot'), block.indexOf('for(let i=0;i<workerCount'));
  assert.match(recover, /if \(!slot\.busy \|\| !slot\.job\) return;/, 'recovery only applies to a crash mid-file, not an idle/cleanup exit');
  assert.match(recover, /spawnScanner\(\)/, 'a crashed worker must be replaced with a fresh one');
  assert.match(recover, /slot\.child = fresh\.child/, 'the slot must point at the fresh worker');
  assert.match(recover, /dispatch\(slot\)/, 'the slot keeps processing remaining files after recovery');
  // The in-flight file is preserved (old record, or null for a new file) rather than lost outright.
  assert.match(recover, /changedResults\.push\(\{ info, track: oldByPath\.get\(path\.resolve\(info\.path\)\) \|\| null \}\)/);
});

test("incremental scan's worker exit/error handlers are not no-ops", () => {
  const loop = block.slice(block.indexOf('for(let i=0;i<workerCount'));
  assert.match(loop, /slot\.child\.on\('error', \(\) => recoverSlot\(slot, 'WORKER CRASH'\)\)/, 'error must trigger recovery');
  assert.match(loop, /slot\.child\.on\('exit', \(\) => recoverSlot\(slot, 'WORKER CRASH'\)\)/, 'exit must trigger recovery');
  assert.doesNotMatch(loop, /slot\.child\.on\('error',\(\)=>\{\}\)/, 'the old no-op handlers must be gone');
});
