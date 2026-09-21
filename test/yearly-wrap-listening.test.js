'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

test('Yearly Wrap listening events do not reference an undefined completion flag', () => {
  const start = source.indexOf('async function wrapFinishListening()');
  const end = source.indexOf("audio.addEventListener('play'", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /completed:force/);
  assert.match(block, /completed:false/);
});
