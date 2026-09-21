const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'resources/spicetify/hive-spotify-bridge.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

test('Spotify bridge samples live transport getters for position, duration, and play state', () => {
  assert.match(bridge, /Spicetify\.Player\.getProgress\(\)/);
  assert.match(bridge, /Spicetify\.Player\.getDuration\(\)/);
  assert.match(bridge, /Spicetify\.Player\.isPlaying\(\)/);
  assert.match(bridge, /timestamp: Date\.now\(\)/);
});

test('Spotify provider progress events immediately refresh Hive transport state', () => {
  assert.match(bridge, /onprogress[^]*?sendState\(\)/);
  assert.match(bridge, /onplaypause[^]*?sendState\(\)/);
});

test('Spotify playlist hydration never discards existing artwork when fresh metadata omits it', () => {
  assert.match(renderer, /cover:\s*next\.cover\s*\|\|\s*old\.cover/);
  assert.match(renderer, /artworkUrl:\s*next\.artworkUrl\s*\|\|\s*old\.artworkUrl/);
  assert.match(renderer, /spotifyArtworkCacheFile:\s*next\.spotifyArtworkCacheFile\s*\|\|\s*old\.spotifyArtworkCacheFile/);
});
