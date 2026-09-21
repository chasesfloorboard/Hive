'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

test('Build 239 makes playback time white in dark themes and dark in Light', () => {
  assert.match(css, /#playbar \.time \{ color:#fff; \}/);
  assert.match(css, /html\[data-hive-theme="light"\] #playbar \.time \{ color:#252a31; \}/);
});
