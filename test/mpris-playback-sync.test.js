const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');

test('MPRIS follows the shared playback event boundary', () => {
  assert.match(source, /function dispatchAudio\(name\)[\s\S]*startMprisHeartbeat\(\)[\s\S]*scheduleMprisSync\(true\)/);
  assert.match(source, /name === 'pause' \|\| name === 'ended'[\s\S]*stopMprisHeartbeat\(\)[\s\S]*scheduleMprisSync\(true\)/);
  assert.match(source, /name === 'loadedmetadata' \|\| name === 'durationchange' \|\| name === 'timeupdate'[\s\S]*scheduleMprisSync\(false\)/);
});

test('MPRIS heartbeat reads the authoritative audioEngine clock while playing', () => {
  assert.match(source, /if \(!audioEngine\.paused && currentQueue\[currentIndex\]\) void syncMpris\(\)/);
  assert.match(source, /}, 5000\);/);
});
