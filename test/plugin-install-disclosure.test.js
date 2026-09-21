'use strict';
// Plugins are trusted local code, not sandboxed (see docs/PLUGIN_API.md) --
// an installed plugin runs with the same permissions as Hive itself. That
// was only disclosed in documentation the user may never read; installing
// via Settings > Extensions copied the plugin folder immediately with no
// confirmation at all. This must be disclosed at the moment of installing,
// naming the actual plugin and its declared permissions, before anything is
// copied into the plugins folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

test('installing a plugin shows a native confirmation naming the plugin and its declared permissions before copying anything', () => {
  const start = main.indexOf("ipcMain.handle('plugins:installFolder'");
  const end = main.indexOf("\nipcMain.handle('scrobble:status'");
  assert.ok(start >= 0 && end > start, 'plugins:installFolder handler must exist');
  const block = main.slice(start, end);

  const manifestReadIndex = block.indexOf('JSON.parse(await fsp.readFile(manifestPath');
  const confirmIndex = block.indexOf('dialog.showMessageBox(mainWindow');
  const copyIndex = block.indexOf('fsp.cp(source,target');
  assert.ok(manifestReadIndex >= 0 && confirmIndex > manifestReadIndex, 'the confirmation must read the real manifest first, so it can name the actual plugin');
  assert.ok(copyIndex > confirmIndex, 'the confirmation must happen before the plugin folder is copied');

  assert.match(block, /trusted local code, not sandboxed/i);
  assert.match(block, /same permissions as Hive itself/i);
  assert.match(block, /Declared permissions: \$\{permissions\.length \? permissions\.join\(', '\) : 'none declared'\}/);
  assert.match(block, /message: `Install "\$\{String\(manifest\.name \|\| manifest\.id\)\}"\?`/);

  // Cancel must actually stop the install, not just close the dialog cosmetically.
  assert.match(block, /if \(confirmChoice\.response !== 1\) return \{ canceled: true \};/);
  assert.match(block, /buttons: \['Cancel', 'Install plugin'\]/);
  assert.match(block, /defaultId: 0/, 'Cancel must be the default so a stray Enter/Space keypress cannot install unreviewed code');
});
