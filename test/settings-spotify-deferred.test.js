'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
const source = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');

test('Advanced CSS settings panel is removed while supported theme controls remain', () => {
  assert.doesNotMatch(html, />Advanced CSS</);
  assert.doesNotMatch(html, /id="custom-css-input"/);
  assert.doesNotMatch(html, /id="custom-css-apply-btn"/);
  assert.doesNotMatch(html, /id="custom-css-load-btn"/);
  assert.doesNotMatch(html, /id="custom-css-clear-btn"/);
  assert.match(html, /id="theme-import-btn"/);
  assert.match(html, /id="theme-export-btn"/);
});

test('Spotify playlist import is enabled again in Hive 2.0', () => {
  assert.doesNotMatch(html, /id="playlist-import-spotify"[^>]*disabled/);
  assert.doesNotMatch(html, /id="playlist-import-spotify"[^>]*data-deferred/);
  assert.match(source, /playlistImportSpotify/);
});

test('Spotify development resumes in Hive 2.0 behind the same flag', () => {
  const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
  assert.match(main, /SPOTIFY_DEVELOPMENT_PAUSED\s*=\s*false/);
  assert.match(main, /SPOTIFY_DEVELOPMENT_PAUSED[\s\S]{0,500}startSpotifyBridge/);
  assert.match(main, /spotify:launch[\s\S]{0,220}SPOTIFY_DEVELOPMENT_PAUSED/);
  assert.match(main, /spotify:command[\s\S]{0,220}SPOTIFY_DEVELOPMENT_PAUSED/);
});
