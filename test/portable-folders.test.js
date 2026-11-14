'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPortableFolders } = require('../app/main/portable-folders');

// A fixed portable root and a fake fs whose existsSync answers from an allow-set, so
// the resolver's "does this path exist?" branches are deterministic.
const ROOT = '/opt/Hive';
function make(existing = []) {
  const set = new Set(existing.map((p) => path.resolve(p)));
  const fs = { existsSync: (p) => set.has(path.resolve(p)) };
  return createPortableFolders({ fs, path, portableRoot: () => ROOT });
}

test('createPortableFolders validates its dependencies', () => {
  assert.throws(() => createPortableFolders({}), /needs \{ fs, path, portableRoot/);
  assert.throws(() => createPortableFolders({ fs: {}, path, portableRoot: null }), /portableRoot/);
});

test('serializePortableFolder stores a folder inside the root as a relocatable record', () => {
  const { serializePortableFolder } = make();
  assert.deepEqual(serializePortableFolder('/opt/Hive/Music'), { type: 'portable', path: 'Music' });
  assert.deepEqual(serializePortableFolder('/opt/Hive/a/b'), { type: 'portable', path: path.join('a', 'b') });
  // The root itself serializes to '.'.
  assert.deepEqual(serializePortableFolder('/opt/Hive'), { type: 'portable', path: '.' });
});

test('serializePortableFolder keeps a folder outside the root as an absolute path', () => {
  const { serializePortableFolder } = make();
  assert.equal(serializePortableFolder('/home/user/Music'), '/home/user/Music');
  // A sibling of the root (outside it) is not portable.
  assert.equal(serializePortableFolder('/opt/Other'), '/opt/Other');
});

test('resolveConfiguredFolder rebases a portable record onto the current root', () => {
  const { resolveConfiguredFolder } = make();
  assert.equal(resolveConfiguredFolder({ type: 'portable', path: 'Music' }), path.resolve('/opt/Hive/Music'));
  assert.equal(resolveConfiguredFolder({ type: 'portable', path: '.' }), path.resolve('/opt/Hive'));
  assert.equal(resolveConfiguredFolder({ type: 'portable' }), path.resolve('/opt/Hive'));
});

test('resolveConfiguredFolder uses an absolute path that exists, as given', () => {
  const { resolveConfiguredFolder } = make(['/home/user/Music']);
  assert.equal(resolveConfiguredFolder('/home/user/Music'), path.resolve('/home/user/Music'));
});

test('resolveConfiguredFolder falls back to the same basename inside the root (moved install)', () => {
  // The saved absolute path no longer exists, but a folder of the same name sits in the
  // portable root — that is where a relocated install should look.
  const { resolveConfiguredFolder } = make(['/opt/Hive/Music']);
  assert.equal(resolveConfiguredFolder('/old/location/Music'), path.resolve('/opt/Hive/Music'));
});

test('resolveConfiguredFolder returns the absolute path when nothing exists, and empty for empty input', () => {
  const { resolveConfiguredFolder } = make();
  assert.equal(resolveConfiguredFolder('/nope/Music'), path.resolve('/nope/Music'));
  assert.equal(resolveConfiguredFolder(''), '');
  assert.equal(resolveConfiguredFolder(null), '');
});

test('resolveConfigFolders maps a config.folders list and drops empties', () => {
  const { resolveConfigFolders } = make(['/home/user/Music']);
  const out = resolveConfigFolders({ folders: [{ type: 'portable', path: 'Lib' }, '/home/user/Music', ''] });
  assert.deepEqual(out, [path.resolve('/opt/Hive/Lib'), path.resolve('/home/user/Music')]);
  assert.deepEqual(resolveConfigFolders({}), []);
  assert.deepEqual(resolveConfigFolders(null), []);
});

test('serialize then resolve round-trips a folder inside the root back to itself', () => {
  const { serializePortableFolder, resolveConfiguredFolder } = make();
  const stored = serializePortableFolder('/opt/Hive/Music/Rock');
  assert.equal(resolveConfiguredFolder(stored), path.resolve('/opt/Hive/Music/Rock'));
});
