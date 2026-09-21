'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'native', 'gstreamer-player.c'), 'utf8');

test('GStreamer helper declares event_line before its first use', () => {
  const declaration = source.indexOf('static void event_line(const char *name, const char *arg);');
  const definition = source.indexOf('static void event_line(const char *name, const char *arg) {');
  const firstUse = source.indexOf('event_line("SPECTRUM"');
  assert.ok(declaration >= 0, 'event_line forward declaration is required');
  assert.ok(definition >= 0, 'event_line definition is required');
  assert.ok(declaration < firstUse, 'forward declaration must precede first use');
  assert.ok(definition > firstUse, 'definition should remain below the spectrum helper');
});
