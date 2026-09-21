'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'app/renderer/index.html'),'utf8');
const renderer = fs.readFileSync(path.join(root,'app/renderer/renderer.js'),'utf8');
const css = fs.readFileSync(path.join(root,'app/renderer/styles.css'),'utf8');

test('Build 187 keeps the colored Now Playing background setting while removing only the duplicate frosted toggle', () => {
  assert.match(html, /id="setting-playbar-now-playing-bg"/);
  assert.doesNotMatch(html, /id="setting-playbar-frosted"/);
  assert.match(renderer, /PLAYBAR_NOW_PLAYING_BG_KEY/);
  assert.match(renderer, /setPlaybarNowPlayingBg\(!!el\.playbarNowPlayingBgToggle/);
});

test('Build 187 restores the integrated rounded frosted playbar surface', () => {
  assert.match(css, /#playbar\.player-glass-surface[\s\S]*border-radius:\s*var\(--radius\)/);
  assert.match(css, /#playbar\.player-glass-surface[\s\S]*backdrop-filter:\s*blur\(var\(--blur\)\) saturate\(140%\)/);
  assert.doesNotMatch(css, /#playbar\.player-glass-surface[\s\S]*border-radius:\s*0\b/);
});

test('Build 187 uses one plugin settings action per installed plugin', () => {
  assert.match(html, /id="plugin-import-btn"/);
  assert.doesNotMatch(html, /id="plugin-example-btn"/);
  assert.doesNotMatch(html, /Built-in visualizer/);
  assert.match(renderer, /dataset\.pluginSettingsId/);
  assert.match(renderer, /Open plugin settings/);
  assert.doesNotMatch(renderer, /renderHivePluginSettings\(plugins\)/);
});

test('Build 200 makes Years part of the shared Music Viewer and keeps visibility reversible', () => {
  // Years stays visible during an artist search (still the Albums tab, just
  // filtered) -- see test/album-playback-context.test.js.
  assert.match(renderer, /yearsVisible\s*=\s*viewMode === 'albums' && specialView !== 'yearly-wrap'/);
  assert.match(renderer, /function renderMusicViewer\(title,tracks,kind\)/);
  assert.match(renderer, /el\.yearsToggle\.classList\.toggle\('hidden', !yearsVisible\)/);
  const start = renderer.indexOf('function setView(mode)');
  const end = renderer.indexOf('function', start + 20);
  const block = renderer.slice(start, end > start ? end : start + 1800);
  assert.match(block, /mode === 'albums'/);
  assert.match(block, /yearsVisible/);
});
