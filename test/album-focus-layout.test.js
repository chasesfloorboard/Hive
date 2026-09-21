'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

test('special album focus uses the full-width years layout when years are enabled', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.match(source, /function renderSpecialAlbums\(tracks\)[\s\S]{0,1800}albumsGrid\.classList\.toggle\('album-years-grouped', !!albumYearDividers\)/);
});

test('album year grouping remains block-flow full width', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
  assert.match(source, /#albums-grid\.album-browse-grid\.album-years-grouped\s*\{[\s\S]*?display:\s*block/);
  assert.match(source, /\.album-year-section\s*\{[\s\S]*?width:\s*100%/);
});
