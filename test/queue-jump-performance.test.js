'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

test('GStreamer queue jumps do not block LOAD on ReplayGain tag reads', () => {
  assert.match(source, /const gainPromise = resolveReplayGainForTrack\(t\);/);
  assert.match(source, /const gstLoaded = await gstLoadCurrent\(desired, requestGeneration\);[\s\S]*await gainPromise;/);
});

test('GStreamer queue jumps avoid the redundant STOP and renderer delay', () => {
  const block = source.slice(source.indexOf('if (gstAvailable && gstCompatibleTrack(t))'), source.indexOf('if (requestGeneration !== playbackLoadRequestGeneration) return false;', source.indexOf('if (gstAvailable && gstCompatibleTrack(t))')));
  assert.doesNotMatch(block, /if \(gstActive\) gstStop\(\)/);
  assert.doesNotMatch(source, /Give it one turn to enter[\s\S]*25 ms renderer delay/);
});


test('replaying within the same large collection does not synchronously rewrite the full queue before playback', () => {
  const blockStart = source.indexOf('function playQueue(tracks, startIndex=0, respectShuffle=true)');
  const blockEnd = source.indexOf('function queueRowHtml(', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  const block = source.slice(blockStart, blockEnd);
  assert.match(block, /const queuePersistenceNeeded = !sameQueueIdentity\(currentQueue, queue\);/);
  assert.match(block, /if \(queuePersistenceNeeded\) saveQueueSession\(\);/);
  assert.match(block, /else savePlaybackSession\(\);/);
});

test('sameQueueIdentity compares queue membership without serializing track payloads', () => {
  const blockStart = source.indexOf('function sameQueueIdentity(');
  const blockEnd = source.indexOf('function playQueue(', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  const block = source.slice(blockStart, blockEnd);
  assert.match(block, /a\.length !== b\.length/);
  assert.match(block, /String\(a\[i\]\?\.path \|\| ''\) !== String\(b\[i\]\?\.path \|\| ''\)/);
  assert.match(block, /return true;/);
});

test('queue virtualization delegates row interactions instead of rebinding listeners on every scroll window', () => {
  const blockStart = source.indexOf('function updateQueueVirtualRows(');
  const blockEnd = source.indexOf('// Warm artwork for coverless albums', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  const block = source.slice(blockStart, blockEnd);
  assert.doesNotMatch(block, /bindQueueRows\(\);/);
  assert.match(source, /el\.queueList\.addEventListener\('dblclick'/);
  assert.match(source, /el\.queueList\.addEventListener\('click'/);
});

test('queue scrolling uses a bounded pool of reusable virtual row DOM nodes', () => {
  assert.match(source, /queueVirtualState\s*=\s*\{[^}]*pool:\s*\[\]/s);
  assert.match(source, /queueVirtualState\.pool\.push\(row\)/);
  assert.match(source, /row\.__queueAssignedIndex/);
});

test('queue virtualization uses a bounded row pool instead of one DOM node per queue index', () => {
  assert.match(source, /queueVirtualState\s*=\s*\{[^}]*pool:\s*\[\]/s);
  assert.match(source, /queueVirtualState\.pool\.length/);
  assert.match(source, /dataset\.queueSlot/);
  assert.doesNotMatch(source, /queueVirtualState\.rows\s*=\s*new Map\(\)/);
});

test('queue virtualization only retargets current artwork when its row is visible', () => {
  const blockStart = source.indexOf('function updateQueueVirtualRows(');
  const blockEnd = source.indexOf('// Warm artwork for coverless albums', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  const block = source.slice(blockStart, blockEnd);
  assert.match(block, /start\s*<=\s*currentIndex\s*&&\s*currentIndex\s*<\s*end/);
  assert.match(block, /retargetCurrentCoverRotationTargets\(queueVirtualState\.pool/);
});

test('queue scrolling caches both virtual containers and preserves the known-good row window', () => {
  assert.match(source, /queueVirtualState\s*=\s*\{[^}]*spacer:\s*null/s);
  assert.match(source, /queueVirtualState\.spacer\s*=\s*el\.queueList\.querySelector/);
  assert.match(source, /el\.queueList\.appendChild\(row\)/);
  assert.doesNotMatch(source, /queue-virtual-window/);
});
