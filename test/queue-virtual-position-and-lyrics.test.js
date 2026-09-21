const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rendererPath = path.join(__dirname, '..', 'app', 'renderer', 'renderer.js');
const source = fs.readFileSync(rendererPath, 'utf8');

test('queue virtualization positions pooled rows at their absolute queue indices', () => {
  assert.match(source, /row\.style\.top\s*=\s*`\$\{index \* rowHeight\}px`/);
  assert.doesNotMatch(source, /row\.style\.top\s*=\s*`\$\{slot \* rowHeight\}px`/);
});

test('lyrics normalization extracts text from common lyric object shapes instead of rendering [object Object]', () => {
  assert.match(source, /function normalizeLyricsText\(raw\)/);
  assert.match(source, /normalizeLyricsText\(raw\)/);
  assert.match(source, /normalizeLyricsText\(common\?\.lyrics\)/);
  const scanner = fs.readFileSync(path.join(__dirname, '..', 'app', 'workers', 'scanner-worker.js'), 'utf8');
  assert.match(scanner, /normalizeMetadataText\(common\.lyrics\)/);
});


test('queue render resets the reusable pool when replacing the virtual DOM', () => {
  assert.match(source, /queueVirtualState\.pool\s*=\s*\[\]/);
  assert.match(source, /queueVirtualState\.poolSize\s*=\s*0/);
  assert.match(source, /function renderQueue\(\)[\s\S]*?queueVirtualState\.pool\s*=\s*\[\]/);
});

test('applyLibrary without a payload preserves the current library instead of replacing it with an empty library', () => {
  assert.match(source, /library\s*=\s*lib\s*\|\|\s*library\s*\|\|\s*\{\s*tracks:\s*\[\]\s*\}/);
});

test('auto-tag refresh passes the updated library to applyLibrary', () => {
  assert.match(source, /applyLibrary\(library\)/);
  assert.doesNotMatch(source, /applyLibrary\(\);/);
});

test('cached and scanned lyric objects are normalized before entering the library model', () => {
  assert.match(source, /t\.lyrics\s*=\s*normalizeLyricsText\(t\.lyrics\)/);
  const scanner = fs.readFileSync(path.join(__dirname, '..', 'app', 'workers', 'scanner-worker.js'), 'utf8');
  assert.match(scanner, /lyrics\s*=\s*normalizeMetadataText\(common\.lyrics\)/);
});

test('periodic playback persistence does not serialize the entire queue', () => {
  const blockStart = source.indexOf('function savePlaybackSession(');
  const blockEnd = source.indexOf('function saveSession(', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  const block = source.slice(blockStart, blockEnd);
  assert.match(block, /buildTransportPlaybackState\(\)/);
  assert.doesNotMatch(block, /const state = buildPlaybackState\(\);/);
  assert.match(block, /if \(forceSync \|\| now - lastTransportBackendSaveAt >= 2000\)/);
});

test('queue virtual rows remain attached directly to the scroll list', () => {
  const renderStart = source.indexOf('function renderQueue()');
  const updateStart = source.indexOf('function updateQueueVirtualRows(');
  const renderEnd = source.indexOf('function readRememberedTrackPosition', renderStart);
  const updateEnd = source.indexOf('// Warm artwork for coverless albums', updateStart);
  assert.ok(renderStart >= 0 && updateStart >= 0 && renderEnd > renderStart && updateEnd > updateStart);
  const renderBlock = source.slice(renderStart, renderEnd);
  const updateBlock = source.slice(updateStart, updateEnd);
  assert.match(renderBlock, /queue-virtual-spacer/);
  assert.match(updateBlock, /el\.queueList\.appendChild\(row\)/);
  assert.doesNotMatch(renderBlock, /queue-virtual-window/);
  assert.doesNotMatch(updateBlock, /queue-virtual-window/);
});

