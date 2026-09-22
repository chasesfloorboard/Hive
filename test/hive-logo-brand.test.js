const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// The brand mark was switched from hive-logo-glass.png (a transparent glass
// hexagon) to hive-minimal-black.png (a flat black hexagon, no alpha
// channel) -- the old file is deliberately left on disk, unreferenced, per
// the user's request, rather than deleted.
test('Hive minimal-black logo is a high-resolution asset at the expected dimensions', () => {
  const file = path.join(root, 'resources', 'hive-minimal-black.png');
  assert.ok(fs.existsSync(file), 'hive-minimal-black.png must exist');
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  assert.equal(buf.readUInt32BE(16), 1254, 'logo width');
  assert.equal(buf.readUInt32BE(20), 1254, 'logo height');
});

test('Hive branding uses the minimal-black logo instead of the legacy bee emoji or the old glass logo', () => {
  const index = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');
  // hiveLogoPath() (the source of the brand icon, tray icon, and window icon)
  // lives in tray.js, extracted out of main.js's monolith.
  const tray = fs.readFileSync(path.join(root, 'app', 'main', 'tray.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.doesNotMatch(index, /🐝/);
  assert.match(index, /id="hive-brand-logo"/);
  assert.match(tray, /resources', 'hive-minimal-black\.png/);
  assert.doesNotMatch(tray, /hive-logo-glass\.png/);
  assert.match(renderer, /getYearlyWrapBrandIcon/);
  assert.match(packageJson, /"icon": "resources\/hive-minimal-black\.png"/);
  assert.match(installer, /resources\/hive-minimal-black\.png/);
});
