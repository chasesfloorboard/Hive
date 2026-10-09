'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'native', 'gstreamer-player.c'), 'utf8');

test('GStreamer spectrum threshold is passed with the gint type required by the property', () => {
  const spectrumSet = source.match(/g_object_set\(spectrum,[\s\S]*?NULL\);/);
  assert.ok(spectrumSet, 'spectrum properties must be configured');
  // An integer property: passing a double through the varargs is undefined behavior.
  assert.match(spectrumSet[0], /"threshold",\s*\(gint\)\s*SPECTRUM_FLOOR_DB\s*,/);
  assert.match(source, /#define SPECTRUM_FLOOR_DB -80\.0/);
});
