const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'mpris.js'), 'utf8');

test('MPRIS local artwork remains file:// and does not substitute the localhost proxy', () => {
  assert.match(source, /mpris:artUrl.*new v\('s', localArt\)/s);
  assert.doesNotMatch(source, /proxiedArt.*mpris:artUrl/s);
  assert.match(source, /const artworkUrl = \(this\.coverPath && fs\.existsSync\(this\.coverPath\)\)/);
  assert.match(source, /pathToFileURL\(this\.coverPath\)\.href/);
});
