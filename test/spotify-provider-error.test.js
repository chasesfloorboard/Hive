const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

test('Spotify startup failure notice reports the provider phase and useful next action', () => {
  assert.match(renderer, /Spotify provider diagnostics:/, 'notice should identify provider diagnostics');
  assert.match(renderer, /backgroundPhase/, 'notice should distinguish the background provider phase');
  assert.match(renderer, /backgroundDetail/, 'notice should include the provider detail');
  assert.match(renderer, /Open the Spotify provider log/, 'notice should point to the provider log');
});

test('Spotify status exposes bridge age so stale provider connections are distinguishable', () => {
  assert.match(main, /bridgeAgeMs/, 'status should expose bridge age');
  assert.match(main, /Date\.now\(\) - Number\(spotifyBridgeState\.updatedAt/, 'bridge age should be derived from the last bridge update');
});


test('Spotify diagnostic notice provides a copyable diagnostics action', () => {
  const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
  assert.match(html, /id="notice-copy"/, 'notice modal should have a copy diagnostics control');
  assert.match(renderer, /navigator\.clipboard\.writeText/, 'diagnostics should use the clipboard API');
  assert.match(renderer, /noticeCopy/, 'renderer should manage the copy diagnostics control');
  assert.match(renderer, /copyable: true/, 'Spotify failures should enable the copy diagnostics control');
  assert.match(html, />Copy diagnostics</, 'copy control should be clearly labeled');
});
