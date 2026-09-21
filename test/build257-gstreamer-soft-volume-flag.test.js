'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');

test('Build 257 does not depend on the unavailable GST_PLAY_FLAG_SOFT_VOLUME header symbol', () => {
  assert.match(native, /HIVE_PLAY_FLAG_SOFT_VOLUME\s*=\s*\(1\s*<<\s*4\)/);
  assert.doesNotMatch(native, /\bGST_PLAY_FLAG_SOFT_VOLUME\b/);
});

test('Build 257 still clears playbin soft-volume before using native stream volume', () => {
  assert.match(native, /playbin_flags\s*&=\s*~HIVE_PLAY_FLAG_SOFT_VOLUME/);
  assert.match(native, /g_object_set\(player, "flags", playbin_flags, NULL\)/);
});
