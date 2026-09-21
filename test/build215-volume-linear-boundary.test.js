'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');

function volumeInputBlock() {
  const start = source.indexOf("el.pbVolume.addEventListener('input'");
  const end = source.indexOf("// Allow the mouse wheel", start);
  assert.ok(start >= 0 && end > start, 'volume input handler must exist');
  return source.slice(start, end);
}

test('Build 215 uses a direct linear slider-to-engine boundary', () => {
  const block = volumeInputBlock();
  assert.match(block, /\/\s*100/);
  assert.match(block, /audioEngine\.volume\s*=\s*value/);
  assert.doesNotMatch(block, /volumeSliderToEngine/);
  assert.doesNotMatch(block, /Math\.cbrt|\*\s*position\s*\*\s*position/);
});

test('Build 215 projects canonical engine volume directly to the visible slider', () => {
  assert.match(source, /function renderVolumeSliderFromEngine\(engineValue\)/);
  const fnStart = source.indexOf('function renderVolumeSliderFromEngine');
  const fnEnd = source.indexOf('\n  }', fnStart) + 4;
  const fn = source.slice(fnStart, fnEnd);
  assert.match(fn, /Math\.round\(clampUnitVolume\(engineValue\)\s*\*\s*100\)/);
  assert.doesNotMatch(fn, /Math\.cbrt/);
});

test('Build 215 removes the cubic volume mapping helpers entirely', () => {
  assert.doesNotMatch(source, /function volumeSliderToEngine/);
  assert.doesNotMatch(source, /function engineVolumeToSlider/);
  assert.doesNotMatch(source, /0\.8 \* 0\.8 \* 0\.8/);
});
