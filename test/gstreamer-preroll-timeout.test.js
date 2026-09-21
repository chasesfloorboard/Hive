'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app', 'native', 'gstreamer-player.c'), 'utf8');

test('GStreamer track loads use a bounded preroll wait so a slow track cannot stall transport for seconds', () => {
  assert.match(source, /gst_element_get_state\(player, NULL, NULL, 250 \* GST_MSECOND\);/);
  assert.doesNotMatch(source, /gst_element_get_state\(player, NULL, NULL, 8 \* GST_SECOND\);/);
});
