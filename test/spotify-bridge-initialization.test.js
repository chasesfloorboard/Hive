const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const bridgePath = require('node:path').join(__dirname, '..', 'resources', 'spicetify', 'hive-spotify-bridge.js');
const source = fs.readFileSync(bridgePath, 'utf8');

test('Spotify bridge starts command polling before fragile event registration', () => {
  const polling = source.indexOf('startPolling();');
  const events = source.indexOf('registerPlayerEvents();');
  assert.ok(polling >= 0, 'bridge should have an explicit startPolling phase');
  assert.ok(events >= 0, 'bridge should isolate player event registration');
  assert.ok(polling < events, 'polling must start before event registration can abort initialization');
});

test('Spotify bridge initialization safely reads a possibly-not-yet-created Spicetify global', () => {
  assert.match(
    source,
    /const\s+api\s*=\s*globalThis\.Spicetify\s*;/,
    'initialization should not use optional chaining on an undeclared Spicetify identifier'
  );
});

test('Spotify bridge keeps polling and state timers idempotent across initialization retries', () => {
  assert.match(source, /if\s*\(\s*pollTimer\s*\)\s*return;/, 'polling startup should be idempotent');
  assert.match(source, /if\s*\(\s*stateTimer\s*\)\s*return;/, 'state timer startup should be idempotent');
});
