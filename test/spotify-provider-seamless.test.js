const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'resources/spicetify/hive-spotify-bridge.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

test('Spotify bridge preserves playlist playback context', () => {
  assert.match(bridge, /contextUri: `spotify:playlist:\$\{id\}`/);
  assert.match(bridge, /Spicetify\.Player\.playUri\(uri, context\)/);
  assert.match(bridge, /contextURI: contextUri/);
  assert.match(bridge, /trackUri: uri/);
  assert.match(bridge, /contextual playUri failed; retrying bare track/);
  assert.match(bridge, /return Spicetify\.Player\.playUri\(uri\);/);
});

test('Spotify state reports provider context back to Hive', () => {
  assert.match(bridge, /contextUri: spotifyUriValue\(data\.context_uri\)/);
  assert.match(renderer, /const stateContextUri = String\(state\?\.contextUri \|\| ''\)\.trim\(\)/);
  assert.match(renderer, /t\.spotifyContextUri = stateContextUri/);
});

test('Spotify track starts use context and synchronize provider transport modes', () => {
  assert.match(renderer, /const contextUri = String\(t\.spotifyContextUri \|\| t\.contextUri \|\| ''\)\.trim\(\)/);
  assert.match(renderer, /type:'playUri', uri:t\.spotifyUri, \...\(contextUri \? \{ contextUri \} : \{\}\)/);
  assert.match(renderer, /type:'shuffle', enabled:!!shuffle/);
  assert.match(renderer, /type:'repeat', mode:Number\(repeat\)\|\|0/);
});

test('Spotify imported tracks retain their playlist context', () => {
  assert.match(renderer, /spotifyContextUri:entry\.contextUri \|\| data\.contextUri/);
  assert.match(renderer, /contextUri:entry\.contextUri \|\| data\.contextUri/);
});

test('Spotify provider state is wired from the main-process bridge into the renderer', () => {
  assert.match(renderer, /window\.beehive\.onSpotifyState\(state =>/);
  assert.match(renderer, /spotifyApplyState\(state\)/);
  assert.match(renderer, /status\.player\) spotifyApplyState\(status\.player\)/);
});

test('Spotify queue persistence retains provider playback context', () => {
  assert.ok(renderer.includes("spotifyContextUri:String(t.spotifyContextUri||t.contextUri||'')"));
});
