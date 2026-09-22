'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const shellEntrypoints = [
  'install.sh',
  'run.sh',
  'setup-music-presence.sh',
  'enable-music-presence-autostart.sh',
  'scripts/hive-launcher.sh',
  'scripts/spotify-background.sh',
];

test('shipped shell entrypoints are executable', () => {
  for (const relative of shellEntrypoints) {
    const mode = fs.statSync(path.join(root, relative)).mode & 0o777;
    assert.equal(mode, 0o755, `${relative} must be mode 0755, got ${mode.toString(8)}`);
  }
});

// Real bug, reproduced live on an actual exFAT external drive: Hive's whole
// folder (including node_modules) is designed to be portable to a removable
// drive (see stableHiveDataRoot() in main.js), but exFAT/FAT32 -- the most
// common filesystem choice for a cross-platform external drive -- have no
// symlink support at all. Without --no-bin-links, npm's default
// node_modules/.bin layout (built entirely out of symlinks) makes `npm
// install` hard-fail with EPERM on the very first dependency that has a
// "bin" entry. install.sh's own explicit Electron shim creation had the
// exact same failure mode one step later. Confirmed fixed by actually
// running `npm install` and the shim-creation logic against a real exFAT
// mount.
test('install.sh works on filesystems without symlink support (exFAT/FAT32 external drives)', () => {
  const install = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(install, /npm install --ignore-scripts --no-bin-links \|\| fail "npm install failed\."/);
  // The Electron .bin shim must fall back to a plain wrapper script instead
  // of hard-failing the whole install when ln -sfn can't create a symlink.
  const shimStart = install.indexOf('ELECTRON_SHIM="$PROJECT_DIR/node_modules/.bin/electron"');
  assert.ok(shimStart >= 0);
  const shimBlock = install.slice(shimStart, install.indexOf('\nfi', shimStart) + 3);
  assert.match(shimBlock, /if ! ln -sfn "\$ELECTRON_BIN" "\$ELECTRON_SHIM" 2>\/dev\/null; then/);
  assert.match(shimBlock, /printf '#!\/usr\/bin\/env bash\\nexec "%s" "\$@"\\n' "\$ELECTRON_BIN" > "\$ELECTRON_SHIM"/);
  assert.doesNotMatch(install, /fail "Could not create Electron command shim/, 'a missing shim must not be a fatal install error -- Hive\'s own launcher does not need it');
});

// Real bug, also reproduced live: the tarball git-archive builds for
// distribution used a versioned prefix folder (e.g. "Hive-1.0.0-rc.1/"),
// but findHiveContainerRoot() in main.js (the thing that makes portable
// mode work at all) only recognizes a folder literally named "hive"
// (case-insensitive, no suffix) by walking up parent directories. Extracted
// under its versioned name, Hive silently falls back to the fixed
// ~/.config/Hive location instead of storing data next to the app on the
// external drive -- directly defeating the point of portable mode. There is
// no source-level fix for this (the archive prefix is a packaging step, not
// application code) -- this test exists to document the requirement for
// whoever builds a release archive: it MUST extract to a bare "hive"/"Hive"
// folder, e.g. `git archive --prefix=Hive/ ...`, not a versioned one.
test('findHiveContainerRoot only recognizes a bare "hive" folder name, not a versioned one -- release archives must extract to "Hive/", not "Hive-<version>/"', () => {
  const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
  assert.match(main, /path\.basename\(current\)\.toLowerCase\(\) === 'hive'/);
});
