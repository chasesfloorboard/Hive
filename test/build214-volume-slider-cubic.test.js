'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

function volumeBlock() {
  const start = renderer.indexOf("el.pbVolume.addEventListener('input'");
  const end = renderer.indexOf("// Allow the mouse wheel", start);
  assert.ok(start >= 0 && end > start, 'volume input handler must exist');
  return renderer.slice(start, end);
}

test('Build 215 supersedes the Build 214 cubic volume mapping with a linear boundary', () => {
  assert.doesNotMatch(renderer, /function volumeSliderToEngine/);
  assert.doesNotMatch(renderer, /function engineVolumeToSlider/);
  assert.doesNotMatch(renderer, /Math\.cbrt/);
  assert.match(renderer, /clampUnitVolume\(engineValue\)\s*\*\s*100/);
});

test('Build 215 sends the visible slider percentage directly to the canonical engine volume', () => {
  const block = volumeBlock();
  assert.match(block, /Number\(el\.pbVolume\.value\)\s*\|\|\s*0/);
  assert.match(block, /\/\s*100/);
  assert.match(block, /audioEngine\.volume\s*=\s*value/);
});

test('Build 215 keeps persisted/provider volume as canonical linear engine volume', () => {
  assert.match(renderer, /renderVolumeSliderFromEngine\(engineVolume\)/);
  assert.match(renderer, /renderVolumeSliderFromEngine\(normalizedVolume\)/);
  assert.match(renderer, /volume:Number\(audioEngine\.volume\)\|\|0/);
});
