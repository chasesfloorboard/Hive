const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

// 2026-09 settings overhaul: 11 tabs condensed to 7, one component system.
test('Settings has seven tabs, with lyrics display under Playback and file writes under Library', () => {
  const tabs = [...html.matchAll(/class="settings-tab-btn[^"]*"[^>]*data-settings-tab="([a-z]+)">([^<]+)</g)].map(m => `${m[1]}:${m[2]}`);
  assert.deepEqual(tabs, ['general:Playback', 'library:Library', 'appearance:Appearance', 'navigation:Sidebar', 'connections:Connections', 'plugins:Plugins', 'logs:Diagnostics']);
  const panel = key => html.match(new RegExp(`id="settings-panel-${key}"[\\s\\S]*?(?=<!-- =+ |\\n      </div>\\n      <div class="settings-footer")`))[0];
  assert.match(panel('general'), /id="setting-highlighted-lyrics"/);
  assert.match(panel('library'), /id="setting-embed-lyrics-automatically"/);
  assert.match(panel('library'), /id="setting-embed-play-counts"/);
  assert.match(html, /id="setting-theme-window-bar" checked/);
  assert.doesNotMatch(html, /id="settings-save-btn"/);
});

test('The library health check lives in Library, next to the folders it checks', () => {
  const library = html.match(/id="settings-panel-library"[\s\S]*?(?=<!-- =+ APPEARANCE)/)[0];
  assert.match(library, /id="audio-integrity-scan-btn"/);
  assert.match(library, /id="audio-integrity-scan-results"/);
});

test('Hive Theme selection and import/export sit at the top of Appearance, before Interface', () => {
  const appearance = html.match(/id="settings-panel-appearance"[\s\S]*?(?=<div id="settings-panel-navigation")/)[0];
  const themeIdx = appearance.indexOf('id="builtin-theme-select"');
  const importIdx = appearance.indexOf('id="theme-import-btn"');
  const interfaceIdx = appearance.indexOf('>Window &amp; glass<');
  assert.ok(themeIdx >= 0 && importIdx >= 0 && interfaceIdx >= 0);
  assert.ok(themeIdx < interfaceIdx, 'theme selector must come before the Interface section');
  assert.ok(importIdx < interfaceIdx, 'theme import/export must come before the Interface section');
});

test('Build 225 batches scan-track IPC and keeps album Add to Queue', () => {
  assert.match(main, /rendererTrackBatch = \[\]/);
  assert.match(main, /rendererTrackBatch\.length >= 100/);
  assert.match(main, /flushRendererTrackBatch\(\);\n  const finalizationStartedAt/);
  assert.match(renderer, /label: 'Queue',\n      icon: 'queue'/);
  assert.match(renderer, /window\.BeehiveIcons\?\./);
  assert.match(css, /\.context-item-icon \{/);
  assert.match(css, /align-items:center;/);
});
