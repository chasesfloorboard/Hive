'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const native = fs.readFileSync(path.join(root, 'app', 'native', 'gstreamer-player.c'), 'utf8');

test('sidebar double-click invalidates the old transport before asynchronous collection lookup', () => {
  const start = renderer.indexOf('function beginFreshSidebarPlayback()');
  const end = renderer.indexOf('\n  async function playSidebarCollection(nav)', start);
  assert.ok(start >= 0 && end > start);
  const reset = renderer.slice(start, end);
  assert.match(reset, /\+\+playbackLoadRequestGeneration/);
  assert.match(reset, /\+\+gstLoadGeneration/);
  assert.match(reset, /gstActive = false/);
  assert.match(reset, /gstPosition = 0/);
  assert.match(reset, /el\.pbSeek\.value = '0'/);

  const sidebarStart = end;
  const lookup = renderer.indexOf('getSidebarCollectionTracks(nav)', sidebarStart);
  assert.ok(lookup > sidebarStart);
  assert.ok(renderer.indexOf('beginFreshSidebarPlayback();', sidebarStart) < lookup,
    'sidebar transport reset must happen before awaiting collection tracks');
});

test('fresh GStreamer LOAD explicitly seeks to zero instead of relying on URI replacement', () => {
  const start = native.indexOf('static void handle_load(');
  const end = native.indexOf('static void handle_seek(', start);
  assert.ok(start >= 0 && end > start);
  const block = native.slice(start, end);
  assert.match(block, /Always explicitly seek the fresh URI/);
  assert.match(block, /gst_element_seek\(player, 1\.0, GST_FORMAT_TIME/);
  assert.match(block, /gdouble absolute = trim_start \+ MAX\(0\.0, offset\)/);
  assert.doesNotMatch(block, /if \(offset > 0\.000001 \|\| trim_start > 0\.000001\)/);
});
