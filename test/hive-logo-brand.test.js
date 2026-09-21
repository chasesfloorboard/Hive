const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Hive glass logo is a high-resolution RGBA asset', () => {
  const file = path.join(root, 'resources', 'hive-logo-glass.png');
  assert.ok(fs.existsSync(file), 'hive-logo-glass.png must exist');
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  assert.equal(buf.readUInt32BE(16), 1254, 'logo width');
  assert.equal(buf.readUInt32BE(20), 1254, 'logo height');
  assert.equal(buf[25], 6, 'PNG must use RGBA color type for transparency');
});

test('Hive branding uses the shared glass logo instead of the legacy bee emoji', () => {
  const index = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');
  // hiveLogoPath() (the source of the brand icon) lives in tray.js, extracted
  // out of main.js's monolith.
  const tray = fs.readFileSync(path.join(root, 'app', 'main', 'tray.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.doesNotMatch(index, /🐝/);
  assert.match(index, /id="hive-brand-logo"/);
  assert.match(tray, /resources', 'hive-logo-glass\.png/);
  assert.match(renderer, /getYearlyWrapBrandIcon/);
});
