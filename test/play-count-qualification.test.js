'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');

test('play counts require five seconds of actual playback and survive pauses without counting skips', () => {
  assert.match(source, /const PLAY_COUNT_QUALIFY_MS = 5000/);
  assert.match(source, /function beginPlayCountSession\(t\)/);
  assert.match(source, /function pausePlayCountSession\(\)/);
  assert.match(source, /function endPlayCountSession\(\)/);
  assert.match(source, /session\.accumulatedMs \+= Math\.max\(0, performance\.now\(\) - session\.activeSince\)/);
  assert.match(source, /if \(countIfQualified && !session\.counted && session\.accumulatedMs >= PLAY_COUNT_QUALIFY_MS\)/);
  assert.match(source, /finishPlayCountSession\(\{ countIfQualified: true \}\);\n    queueUndoStack/);
  assert.match(source, /finishPlayCountSession\(\{ countIfQualified: true \}\);\n          updateNowPlayingUI\(next\);/);
  assert.match(source, /saveQueueSession\(\);\n          beginPlayCountSession\(next\);/);
});

test('Hive logo hue follows the current artwork accent instead of a fixed blue treatment', () => {
  assert.match(source, /setHiveLogoHueFromColor\(palette\.accent\)/);
  assert.match(source, /--hive-logo-hue/);
  assert.match(css, /grayscale\(var\(--hive-logo-grayscale\)\)/);
  assert.match(css, /hue-rotate\(var\(--hive-logo-hue-rotate\)\)/);
  assert.doesNotMatch(css, /rgba\(150,160,255/);
});
