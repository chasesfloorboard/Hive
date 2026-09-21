'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');

test('GPU acceleration is enabled by default and only an explicit disable turns it off', () => {
  const fn = main.slice(main.indexOf('function gpuAccelerationDisabledAtStartup()'), main.indexOf("if (gpuAccelerationDisabledAtStartup())"));
  assert.match(fn, /return config && config\.disableGpuAcceleration === true/);
  assert.match(fn, /gpuAccelerationAutoDisabled === true/);
  assert.match(html, /id="setting-gpu-acceleration" checked/);
});

test('automatic GPU crash fallback is diagnostic, not a persistent software-rendering default', () => {
  const start = main.indexOf("app.on('child-process-gone'");
  const end = main.indexOf("app.on('before-quit'", start);
  const block = main.slice(start, end);
  assert.match(block, /GPU PROCESS CRASHED/);
  assert.doesNotMatch(block, /disableGpuAcceleration:\s*true/);
  assert.doesNotMatch(block, /gpuAccelerationAutoDisabledAt/);
});

test('a legacy automatic GPU fallback marker is cleared on startup', () => {
  const start = main.indexOf('app.whenReady().then(async () => {');
  const end = main.indexOf('// POST-SPOTIFY 1.0:', start);
  const block = main.slice(start, end);
  assert.match(block, /gpuAccelerationAutoDisabled === true/);
  assert.match(block, /delete config\.disableGpuAcceleration/);
});
