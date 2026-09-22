'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('Hive desktop entry declares a GNOME media application', () => {
  const desktop = fs.readFileSync(path.join(root, 'resources', 'hive.desktop'), 'utf8');
  assert.match(desktop, /^Name=Hive$/m);
  assert.match(desktop, /^Icon=hive$/m);
  assert.match(desktop, /^Type=Application$/m);
  assert.match(desktop, /^Categories=.*Audio.*$/m);
  assert.match(desktop, /^Exec=__HIVE_EXEC__$/m);
});

test('MPRIS DesktopEntry matches the installed hive desktop id', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'main', 'mpris.js'), 'utf8');
  assert.match(source, /get DesktopEntry\(\) \{ return 'hive'; \}/);
});

// Real bug, confirmed live: the icon installer copied the app icon into
// icons/hicolor/743x743/apps -- 743x743 is not a real hicolor theme size (no
// index.theme anywhere declares it), so GNOME's icon lookup for the
// Icon=hive .desktop entry never found it and silently fell back to a
// generic placeholder icon in the dock/taskbar. 512x512 is one of the
// standard sizes the system hicolor theme actually declares; the source PNG
// being higher-resolution than that is fine, desktop environments downscale
// a too-large icon without complaint.
test('the app icon installs into a real hicolor theme size, not a made-up one', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const start = installer.indexOf('install_hive_desktop_integration() {');
  const end = installer.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'expected to find install_hive_desktop_integration');
  const block = installer.slice(start, end);
  assert.match(block, /icons\/hicolor\/512x512\/apps/);
  assert.doesNotMatch(block, /icons\/hicolor\/743x743\/apps/);
});
