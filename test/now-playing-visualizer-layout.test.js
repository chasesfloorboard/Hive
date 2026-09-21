'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');

test('Sandbox replaces the old Now Playing destination', () => {
  assert.match(renderer, /\{ id:'sandbox', label:'Sandbox'/);
  assert.match(renderer, /function showSandboxView\(tab = getActiveTab\(\)\)/);
  assert.match(renderer, /function showSandboxLauncher\(tab = getActiveTab\(\)\)/);
  assert.match(renderer, /data-sandbox-plugin/);
  assert.doesNotMatch(renderer, /function showNowPlayingView\(\)/);
});

test('Sandbox launcher exposes plugin tiles and independent plugin surfaces', () => {
  assert.match(renderer, /sandbox-app-grid/);
  assert.match(renderer, /sandbox-app-card/);
  assert.match(renderer, /showSandboxPlugin\(activeSandboxPluginId, tab\)/);
  assert.match(renderer, /hive-plugin-sandbox-panels/);
  assert.match(css, /\.sandbox-launcher/);
  assert.match(css, /\.sandbox-app-card/);
  assert.match(css, /\.sandbox-plugin-view/);
});

test('Music Viewer is shared by playable collections and exposes Years', () => {
  assert.match(renderer, /function renderMusicViewer\(title,tracks,kind\)/);
  assert.match(renderer, /renderMusicViewer\(playlistLabel\(pl\), tracksForPlaylist\(pl\), 'playlist'\)/);
  assert.match(renderer, /renderMusicViewer\('History'/);
  assert.match(renderer, /renderMusicViewer\('Recently Added'/);
  assert.match(renderer, /renderMusicViewer\('Top 25 Most Played'/);
  // Years stays visible during an artist search too (it's still the Albums
  // tab, just filtered) -- see test/album-playback-context.test.js for the
  // regression coverage of that specific behavior.
  assert.match(renderer, /const yearsVisible = viewMode === 'albums' && specialView !== 'yearly-wrap'/);
});
