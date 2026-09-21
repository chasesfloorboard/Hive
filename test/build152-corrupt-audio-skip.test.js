'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app', 'main', 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

test('Build 152 exposes an asynchronous audio integrity preflight', () => {
  assert.match(main, /validateAudioForPlayback/);
  assert.match(main, /ffmpeg/);
  assert.match(main, /audio:validate/);
  assert.match(preload, /validateAudioForPlayback/);
});

test('corrupt audio is rejected before GStreamer LOAD', () => {
  const start = renderer.indexOf('async function loadAndPlayCurrent');
  const gst = renderer.indexOf('const gstLoaded = await gstLoadCurrent', start);
  const preflight = renderer.indexOf('preflightLocalAudio(t)', start);
  assert.ok(start >= 0 && gst > start, 'loadAndPlayCurrent must contain native load');
  assert.ok(preflight > start && preflight < gst, 'integrity preflight must happen before GStreamer LOAD');
});

test('corrupt audio presents the file location and advances only after acknowledgement', () => {
  assert.match(renderer, /Corrupted audio file/);
  assert.match(renderer, /File location/);
  assert.match(renderer, /await themedAlert/);
  assert.match(renderer, /goNext\(\)/);
});

test('audio validation stays asynchronous and bounded', () => {
  assert.match(main, /setTimeout\([^\n]+[0-9]{3,5}/);
  assert.match(main, /spawnTracked\(['"]ffmpeg['"]/);
});
