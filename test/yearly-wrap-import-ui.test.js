'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');
const wrap = fs.readFileSync(path.join(root, 'app/renderer/yearly-wrap.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

test('Settings exposes the MusicBee Wrapped archive importer', () => {
  assert.match(index, /id="import-musicbee-wrapped-btn"/);
  assert.match(renderer, /chooseMusicBeeWrappedImport/);
  assert.match(renderer, /importMusicBeeWrapped/);
  assert.match(preload, /yearly-wrap:chooseMusicBeeImport/);
  assert.match(preload, /yearly-wrap:importMusicBee/);
});

test('Yearly Wrap can browse imported historical years and resolves local cover references', () => {
  assert.match(preload, /yearly-wrap:getYears/);
  assert.match(wrap, /id="year-select"/);
  assert.match(wrap, /getYearlyWrapYears/);
  assert.match(wrap, /function wrapCoverSrc\(src\)/);
  assert.match(wrap, /window\.beehive\.coverUrl\(s\)/);
  assert.match(wrap, /img\.src=wrapCoverSrc\(src\)\|\|src/);
});

test('MusicBee imports retain provenance and year metadata', () => {
  assert.match(main, /MUSICBEE_WRAPPED_IMPORTS_PATH/);
  assert.match(main, /source: 'musicbee-wrapped'/);
  assert.match(main, /legacyFileUrl/);
  assert.match(main, /importedMetadata/);
  assert.match(main, /musicBeeImportPlayId/);
});

// The History/Playcounts settings tab was cluttered with a flat list of
// import/export/replace/embed/clear buttons and paragraphs of hint text.
// Redesigned down to four elements: an Embed-play-counts toggle (on by
// default), a Wrapped-data card with just Import + Export, and Clear play
// counts. Replace/Force-overwrite still exist as real actions, but only as
// internal steps of the Import flow -- see playcount-embed-safety.test.js
// for that flow and for verifying the removed actions are gone, not hidden.
test('Settings exposes the redesigned four-action History panel: embed toggle, Import/Export Wrapped data, Clear', () => {
  assert.match(index, /History &amp; Play Counts/);
  assert.match(index, /id="setting-embed-play-counts"/);
  assert.match(index, /id="import-musicbee-wrapped-btn"/);
  assert.match(index, /id="export-hive-wrapped-btn"/);
  assert.match(index, /id="clear-play-counts-btn"/);
  assert.doesNotMatch(index, /id="export-musicbee-wrapped-btn"/, 'the old MusicBee-only export button should be replaced, not duplicated');

  assert.match(renderer, /exportHiveWrappedBtn/);
  assert.match(renderer, /chooseHiveWrappedExport/);
  assert.match(renderer, /exportHiveWrapped\(destination\)/);

  assert.match(preload, /chooseHiveWrappedExport:.*yearly-wrap:chooseWrappedExport/);
  assert.match(preload, /exportHiveWrapped:.*yearly-wrap:exportWrapped/);
  assert.match(preload, /forceEmbedPlayCounts:.*stats:forceEmbedPlayCounts/);
});
