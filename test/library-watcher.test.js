'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDirectoryTreeWatcher } = require('../app/main/directory-tree-watcher');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-watch-'));
  fs.mkdirSync(path.join(root, 'Artist', 'Album'), { recursive: true });
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(root, `track-${i}.flac`), '');
  fs.writeFileSync(path.join(root, 'Artist', 'Album', 'old.flac'), '');
  return root;
}

function collector() {
  const seen = [];
  const waiters = [];
  const onEvent = (_type, name) => {
    seen.push(name);
    for (const w of waiters.splice(0)) w();
  };
  const waitFor = async (name, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!seen.includes(name)) {
      if (Date.now() > deadline) throw new Error(`no event for ${name}; saw ${JSON.stringify(seen)}`);
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  };
  return { seen, onEvent, waitFor };
}

// Node 20's recursive fs.watch emulation on Linux walks the tree synchronously
// and puts a polling fs.watchFile on every file. That froze the main process
// for ~36 s at cold start on a 30k-track USB library (the white-window hang).
test('library watching never uses recursive fs.watch or per-file fs.watchFile', async (t) => {
  const root = makeTree();
  const realWatch = fs.watch;
  const realWatchFile = fs.watchFile;
  const watchCalls = [];
  let watchFileCalls = 0;
  fs.watch = (...args) => { watchCalls.push(args); return realWatch.apply(fs, args); };
  fs.watchFile = (...args) => { watchFileCalls++; return realWatchFile.apply(fs, args); };
  t.after(() => { fs.watch = realWatch; fs.watchFile = realWatchFile; fs.rmSync(root, { recursive: true, force: true }); });

  const watcher = createDirectoryTreeWatcher(root, () => {});
  // Only the root is watched synchronously; the rest of the walk is async.
  assert.equal(watchCalls.length, 1);
  await watcher.ready;
  watcher.close();

  assert.equal(watchFileCalls, 0);
  assert.deepEqual(watchCalls.map(args => args[0]).sort(), [root, path.join(root, 'Artist'), path.join(root, 'Artist', 'Album')].sort());
  for (const args of watchCalls) assert.ok(typeof args[1] === 'function', 'watch must be non-recursive (no options object)');
});

test('changes anywhere in the tree are reported relative to the library root', async (t) => {
  const root = makeTree();
  const events = collector();
  const watcher = createDirectoryTreeWatcher(root, events.onEvent);
  t.after(() => { watcher.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await watcher.ready;

  fs.writeFileSync(path.join(root, 'new-root.flac'), 'x');
  await events.waitFor('new-root.flac');

  fs.writeFileSync(path.join(root, 'Artist', 'Album', 'new-nested.flac'), 'x');
  await events.waitFor(path.join('Artist', 'Album', 'new-nested.flac'));
});

test('folders added after startup are watched and their existing files reported', async (t) => {
  const root = makeTree();
  const events = collector();
  const watcher = createDirectoryTreeWatcher(root, events.onEvent);
  t.after(() => { watcher.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await watcher.ready;

  // Simulates copying a whole album in: the file exists before any watch on
  // the new folder can be attached.
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-stage-'));
  fs.writeFileSync(path.join(staged, 'copied.flac'), 'x');
  fs.renameSync(staged, path.join(root, 'New Album'));
  await events.waitFor(path.join('New Album', 'copied.flac'));

  fs.writeFileSync(path.join(root, 'New Album', 'later.flac'), 'x');
  await events.waitFor(path.join('New Album', 'later.flac'));
});

test('a closed or superseded watcher reports nothing', async (t) => {
  const root = makeTree();
  const events = collector();
  let current = true;
  const watcher = createDirectoryTreeWatcher(root, events.onEvent, () => current);
  t.after(() => { watcher.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await watcher.ready;

  current = false;
  fs.writeFileSync(path.join(root, 'after-supersede.flac'), 'x');
  watcher.close();
  fs.writeFileSync(path.join(root, 'after-close.flac'), 'x');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(events.seen, []);
});
