'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

test('responsive album-art scaling applies to Artists Years cards', () => {
  assert.match(css, /body:not\(.legacy-art-scaling\) #artists-grid\.artist-browse-grid\.artist-years-grouped \.artist-year-grid/);
  assert.match(css, /body:not\(.legacy-art-scaling\) #artists-grid\.artist-browse-grid\.artist-years-grouped \.artist-year-grid > \.artist-card \{[\s\S]*?flex: none;[\s\S]*?width: auto;/);
});

test('responsive album-art scaling applies to inline artist album cards', () => {
  assert.match(css, /body:not\(.legacy-art-scaling\) \.artist-inline-browser \.artist-inline-album-grid > \.album-card \{[^}]*flex: none; width: auto;/);
});

test('legacy scaling is unchecked by default while preserving fixed 178px legacy cards when enabled', () => {
  assert.match(renderer, /let legacyArtScaling = false;/);
  assert.match(css, /#albums-grid\.album-browse-grid > \.album-card \{ flex: 0 0 178px; width: 178px; \}/);
  assert.match(renderer, /const migratedValue = stored == null \? false : stored !== 'true';/);
  assert.match(renderer, /catch \{ return false; \}/);
  // Real bug, confirmed: the migration branch above defaulted a genuinely
  // fresh profile to false correctly, but the already-migrated return path
  // right after it still defaulted an absent stored value to `true` --
  // meaning a brand new install (already past the one-time migration, so it
  // never hits the branch above) started with legacy scaling ON, contrary
  // to the documented default.
  assert.match(renderer, /return stored == null \? false : stored === 'true';/);
});

// Real bug, confirmed: the Artists tab's virtualized "picker" grid (used
// whenever legacyArtScaling is off -- see isPicker) positioned cards using
// the hardcoded fixed 178px legacy card width for its column-width math,
// completely bypassing the responsive "grow to fill the row" sizing Albums
// gets for free from CSS grid (minmax(178px, 1fr)). Artists therefore looked
// identical to legacy scaling even with the setting turned off.
test('the Artists virtualized picker computes a responsive card width that fills the row, not the fixed legacy width', () => {
  const start = renderer.indexOf('const update = (force = false) => {');
  const end = renderer.indexOf('artistVirtualState.viewport = el.main;', start);
  assert.ok(start >= 0 && end > start, 'expected to find the artist picker update() function');
  const block = renderer.slice(start, end);
  assert.match(block, /const minCardWidth = artistVirtualState\.cardWidth;/);
  assert.match(block, /const cardWidth = Math\.floor\(\(width - \(columns - 1\) \* gap\) \/ columns\);/);
  assert.match(block, /const rowHeight = artistVirtualState\.rowHeight \+ \(cardWidth - minCardWidth\);/);
  assert.match(block, /card\.style\.width = `\$\{cardWidth\}px`;/);
  assert.match(block, /card\.style\.left = `\$\{\(i % columns\) \* \(cardWidth \+ gap\)\}px`;/);
});

test('Shuffle and Repeat restore independently of whether a queue exists', () => {
  const start = renderer.indexOf('function restoreSavedQueue()');
  const end = renderer.indexOf('async function', start + 1);
  const block = renderer.slice(start, end > start ? end : start + 12000);
  assert.match(block, /const modeCandidates = \[backendPlaybackState, localQueueState, localPlaybackState\]/);
  assert.match(block, /if \(!candidates.length\) return true;/);
  assert.match(block, /if \(modeState\)/);
});
