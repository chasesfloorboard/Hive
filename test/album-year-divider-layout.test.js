'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const styles = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

test('Albums Years mode gives the section stack a definite full-width block layout', () => {
  assert.match(
    styles,
    /#albums-grid\.album-browse-grid\.album-years-grouped\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*100%;/
  );
  assert.match(
    styles,
    /\.album-year-section\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*100%;[\s\S]*?box-sizing:\s*border-box;/
  );
});

test('Year divider line uses a stable grid track instead of flex growth', () => {
  assert.match(
    styles,
    /\.album-year-heading\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\);/
  );
  assert.match(
    styles,
    /\.album-year-rule\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/
  );
});

test('Renderer explicitly enables the grouped year layout class', () => {
  assert.match(renderer, /el\.albumsGrid\.classList\.toggle\('album-years-grouped',\s*groupByYear\)/);
});
