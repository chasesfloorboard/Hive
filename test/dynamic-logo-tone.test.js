'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

test('palette extraction distinguishes dark, light, and colorful logo treatments', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'colorExtract.js'), 'utf8');
  assert.match(source, /logoTone: lightRatio >= 0\.62 \? 'light' : 'dark'/);
  assert.match(source, /logoTone: 'color'/);
});

test('renderer uses neutral grayscale logo treatment for monochrome artwork', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.match(source, /--hive-logo-grayscale/);
  assert.match(source, /--hive-logo-brightness/);
  assert.match(source, /--hive-logo-hue-rotate/);
  assert.match(source, /tone === 'dark'/);
  assert.match(source, /tone === 'light'/);
});


test('Hive logo stays monochrome even when artwork is colorful', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.match(source, /root\.setProperty\('--hive-logo-grayscale', '1'\)/);
  assert.match(source, /root\.setProperty\('--hive-logo-saturation', '0'\)/);
  assert.doesNotMatch(source, /applyHiveLogoAccent\(palette\.accent\)/);
  assert.doesNotMatch(source, /applyHiveLogoAccent\(cached\.accent\)/);
});
