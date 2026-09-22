'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
// Rating, artwork, and general-metadata writers were extracted out of
// main.js into their own dependency-injected, unit-testable module (see
// createMetadataWriter). Source-pattern checks for that logic read this file.
const metadataWriter = fs.readFileSync(path.join(root, 'app', 'main', 'metadata-writer.js'), 'utf8');


test('Love writes never replace the file currently being played', () => {
  const start = renderer.indexOf('function queueLoveFileWrite(');
  const end = renderer.indexOf('\n  async function setTrackLove', start);
  assert.ok(start >= 0 && end > start, 'Love write queue must be present');
  const block = renderer.slice(start, end);
  assert.match(renderer, /setPlaybackProtectedPath/);
  assert.match(main, /waitForPlaybackProtectionRelease/);
});

test('metadata replacement is not allowed to race an active audio inode', () => {
  assert.match(main, /metadata.*currently.*playing|currently.*playing.*metadata|playback.*protected/i,
    'main process must document/enforce playback protection for metadata replacement');
});

// Rating (5-star), artwork, and the general tag-editor Save path all use the
// same temp-copy-then-rename write pattern as Love, but did not wait for the
// active track's native player handle to be released before touching the
// file. Only Love and play-count embedding had the wait. This closes that gap
// for every writer that shares the pattern.
test('every temp-copy-then-rename metadata writer waits for playback protection release', () => {
  const functionStarts = [
    'async function embedRatingInFile(',
    'async function performWriteArtwork(',
    'async function performModifyArtwork(',
    'async function performRemoveFrontArtwork(',
    'async function performRemoveArtwork(',
    'async function performWriteMetadata(',
  ];
  for (const marker of functionStarts) {
    const start = metadataWriter.indexOf(marker);
    assert.ok(start >= 0, `${marker} must exist`);
    // Bound the search to a generous window after the function start rather
    // than trying to find the exact matching closing brace for a
    // multi-hundred-line function body.
    const block = metadataWriter.slice(start, start + 1500);
    assert.match(block, /waitForPlaybackProtectionRelease/, `${marker} must wait for playback protection release`);
  }
});

// Liking a track and rating it 5 stars moments apart both take an independent
// snapshot-modify-rename path. Without a shared per-file lock, whichever
// rename lands second silently discards the other edit in its entirety (e.g.
// the file ends up rated 5 stars but reverted to Unloved, with no error). All
// same-file metadata writers must serialize through the one existing
// per-path write lock.
test('rating, artwork, general metadata, and Love writes for the same file are serialized through one lock', () => {
  const lockedFunctions = [
    'async function embedRatingInFile(',
    'async function performWriteArtwork(',
    'async function performModifyArtwork(',
    'async function performRemoveFrontArtwork(',
    'async function performRemoveArtwork(',
    'async function performWriteMetadata(',
  ];
  for (const marker of lockedFunctions) {
    const start = metadataWriter.indexOf(marker);
    assert.ok(start >= 0, `${marker} must exist`);
    const block = metadataWriter.slice(start, start + 1500);
    assert.match(block, /withMusicBeeWriteLock\(trackPath/, `${marker} must acquire the shared per-path write lock`);
  }
  const loveStart = main.indexOf('async function setLoveForSingleTrack(');
  assert.ok(loveStart >= 0, 'setLoveForSingleTrack must exist');
  const loveBlock = main.slice(loveStart, loveStart + 1500);
  assert.match(loveBlock, /withMusicBeeWriteLock\(absolutePath/, 'Love writes must acquire the same shared per-path write lock');

  // Bulk Love (tracks:setLove) dispatches each file to a worker and only
  // learns the outcome later via an event-driven message/timeout/error
  // callback, not as a single continuous async call -- so it must hold the
  // lock across that whole in-flight window (via a stored release callback),
  // not just around the synchronous dispatch step.
  const bulkStart = main.indexOf("ipcMain.handle('tracks:setLove'");
  assert.ok(bulkStart >= 0, 'bulk Love handler must exist');
  const nextHandler = main.indexOf("\nipcMain.handle(", bulkStart + 1);
  const bulkBlock = main.slice(bulkStart, nextHandler >= 0 ? nextHandler : bulkStart + 12000);
  assert.match(bulkBlock, /withMusicBeeWriteLock\(job\.path, \(\) => new Promise\(resolve => \{/, 'each bulk Love job must acquire the shared per-path lock for its whole in-flight duration');
  assert.match(bulkBlock, /job\.releaseLock = resolve;/);
  assert.match(bulkBlock, /job\.releaseLock\?\.\(\);/, 'a completed job must release the lock it acquired');
  assert.match(bulkBlock, /timedOutJob\.releaseLock\?\.\(\);/, 'a timed-out job must also release the lock it acquired, not leave it held forever');
});

// A music library commonly lives on a different filesystem/device than the OS
// temp dir (a tmpfs /tmp vs. a library on a separate drive or NAS mount, which
// is this project's own dev machine's actual layout). commitMetadataTemp's
// rename across devices throws EXDEV and falls back to a non-atomic
// copy+unlink, which is the one path by which a crash mid-write could leave
// the real audio file truncated. The temp file must live next to the target
// on its own filesystem so the rename is a real atomic rename in the common
// case, using the ".beehive-tmp" convention the scanner/watcher already skip.
test('metadata temp files are created next to the target file, not only in the OS temp dir', () => {
  const start = metadataWriter.indexOf('async function createMetadataTempPath(');
  const end = metadataWriter.indexOf('\n  async function commitMetadataTemp');
  assert.ok(start >= 0 && end > start);
  const block = metadataWriter.slice(start, end);
  assert.match(block, /\.beehive-tmp/);
  assert.match(block, /path\.dirname\(trackPath\)/);
  assert.match(main, /if \(\/\^\\\.beehive-tmp\$\/i\.test\(entry\.name\)\) continue;/, 'the library scan walk must skip the .beehive-tmp convention');

  const workerPath = path.join(root, 'app', 'workers', 'metadata-worker.js');
  const worker = fs.readFileSync(workerPath, 'utf8');
  const workerStart = worker.indexOf('async function metadataTempPath(');
  const workerEnd = worker.indexOf('\nasync function writeAndSyncReplacement');
  assert.ok(workerStart >= 0 && workerEnd > workerStart);
  const workerBlock = worker.slice(workerStart, workerEnd);
  assert.match(workerBlock, /\.beehive-tmp/);
  assert.match(workerBlock, /path\.dirname\(target\)/);
});
