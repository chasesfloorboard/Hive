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
