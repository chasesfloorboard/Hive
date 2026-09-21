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

test('Spotify playlist import remains visible but is disabled and visibly deferred', () => {
  assert.match(html, /id="playlist-import-spotify"[^>]*disabled/);
  assert.match(html, /id="playlist-import-spotify"[^>]*aria-disabled="true"/);
  assert.match(html, /id="playlist-import-spotify"[^>]*title="Spotify import is deferred until after Hive 1\.0"/);
  assert.match(html, /id="playlist-import-spotify"[^>]*data-deferred="true"/);
  assert.match(css, /\.playlist-import-choice\.spotify-deferred/);
  assert.match(source, /playlistImportSpotify/);
});

test('Spotify development is paused for the post-Spotify 1.0 line', () => {
  const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(main, /SPOTIFY_DEVELOPMENT_PAUSED\s*=\s*true/);
  assert.match(main, /SPOTIFY_DEVELOPMENT_PAUSED[\s\S]{0,500}startSpotifyBridge/);
  assert.match(main, /spotify:launch[\s\S]{0,220}SPOTIFY_DEVELOPMENT_PAUSED/);
  assert.match(main, /spotify:command[\s\S]{0,220}SPOTIFY_DEVELOPMENT_PAUSED/);
  assert.match(installer, /POST-SPOTIFY 1\.0.*Spotify\/Spicetify installation is paused/i);
  assert.match(installer, /#\s*install_spotify_stack/);
  assert.match(installer, /#\s*install_spotify_background_dependency/);
});
