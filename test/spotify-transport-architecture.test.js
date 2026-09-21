const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'resources/spicetify/hive-spotify-bridge.js'), 'utf8');

test('Spotify transport has an explicit provider boundary', () => {
  assert.match(renderer, /let activePlaybackProvider = 'none'/);
  assert.match(renderer, /function activateSpotifyProvider\(\)/);
  assert.match(renderer, /function activateLocalProvider\(\)/);
  assert.match(renderer, /stopLocalPlaybackForExternalProvider\(\)/);
  assert.match(renderer, /stopSpotifyPlaybackForLocal\(\)/);
  assert.match(renderer, /async function podcastLoad\(/);
});

test('Spotify transport routes seek and volume without GStreamer', () => {
  assert.match(renderer, /activePlaybackProvider === 'spotify'/);
  assert.match(renderer, /spotifySend\(\{type:'seek', positionMs:/);
  assert.match(renderer, /spotifySend\(\{ type:'volume', value:engineVolume \}\)/);
  assert.match(bridge, /Spicetify\.Player\.seek\(/);
  assert.match(bridge, /Spicetify\.Player\.setVolume\(/);
});

test('Spotify provider state drives play/pause and normalized position', () => {
  assert.match(renderer, /dispatchAudio\(spotifyState\.isPlaying \? 'play' : 'pause'\)/);
  assert.match(renderer, /spotifyState = \{/);
  assert.match(renderer, /position, isPlaying/);
  assert.match(bridge, /onplaypause/);
  assert.match(bridge, /onprogress/);
});

test('Spotify mute is isolated to the provider bridge', () => {
  assert.match(renderer, /spotifySend\(\{ type:'mute', value:engineMuted \}\)/);
  assert.match(bridge, /Spicetify\.Player\.setMute\(/);
});


test('Spotify background launcher resolves the portable Hive root', () => {
  assert(!main.includes("path.join(APP_ROOT, 'scripts', 'spotify-background.sh')"));
  assert(main.includes("path.join(HIVE_PROJECT_ROOT, 'scripts', 'spotify-background.sh')"));
});

test('Spotify startup does not confuse the Hive HTTP server with the provider', () => {
  assert.match(renderer, /let spotifyBridgeStartupPromise = null/);
  assert.match(renderer, /if \(spotifyBridgeStartupPromise\) return spotifyBridgeStartupPromise/);
  assert.match(renderer, /const launched = await window\.beehive\.spotifyLaunch\?\./);
  assert.match(renderer, /status\?\.connected/);
});
