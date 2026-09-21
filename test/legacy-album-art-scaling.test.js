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
});

test('Shuffle and Repeat restore independently of whether a queue exists', () => {
  const start = renderer.indexOf('function restoreSavedQueue()');
  const end = renderer.indexOf('async function', start + 1);
  const block = renderer.slice(start, end > start ? end : start + 12000);
  assert.match(block, /const modeCandidates = \[backendPlaybackState, localQueueState, localPlaybackState\]/);
  assert.match(block, /if \(!candidates.length\) return true;/);
  assert.match(block, /if \(modeState\)/);
});
