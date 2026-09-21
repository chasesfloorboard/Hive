const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('Build 225 keeps settings compact and moves lyric mode into Library', () => {
  assert.match(html, />Playback<\/button>/);
  assert.match(html, />History<\/button>/);
  assert.match(html, />Scrobbling<\/button>/);
  assert.match(html, />Diagnostics<\/button>/);
  assert.match(html, /id="setting-theme-window-bar" checked/);
  assert.match(html, /settings-panel-library[\s\S]*id="setting-highlighted-lyrics"/);
  const appearance = html.match(/id="settings-panel-appearance"[\s\S]*?(?=<div id="settings-panel-navigation")/)[0];
  assert.doesNotMatch(appearance, /id="setting-highlighted-lyrics"/);
  assert.doesNotMatch(html, /id="settings-save-btn"/);
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
