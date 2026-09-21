const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');

test('Build 246 light theme makes the custom album back arrow black', () => {
  assert.match(index, /artist-back-icon/);
  assert.match(css, /html\[data-hive-theme="light"\] \.artist-back-icon \{ filter: invert\(1\); \}/);
});
