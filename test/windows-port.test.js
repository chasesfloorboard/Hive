'use strict';
// Canonical, stable home for Windows-port behavior (the prebuilt native
// helper + bundled GStreamer runtime, the bundled Python, and text encoding
// across the Python pipes). Edit in place when the Windows port changes.
// The packaged build itself is produced by scripts/build-windows.sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function withPlatform(platform, resourcesPath, fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  const savedResources = process.resourcesPath;
  Object.defineProperty(process, 'platform', { value: platform });
  process.resourcesPath = resourcesPath;
  try { return fn(); } finally {
    Object.defineProperty(process, 'platform', saved);
    process.resourcesPath = savedResources;
  }
}

test('on Windows the bridge runs the bundled helper with the bundled GStreamer runtime and reads events from stdout', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-win-resources-'));
  try {
    fs.mkdirSync(path.join(resources, 'native'));
    fs.writeFileSync(path.join(resources, 'native', 'beehive-gstreamer-player.exe'), '');
    const spawned = [];
    const sent = [];
    const makeChild = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdio = [null, child.stdout, child.stderr];
      child.stdin = { writable: true, write() { return true; }, end() {} };
      return child;
    };
    withPlatform('win32', resources, () => {
      delete require.cache[require.resolve('../app/main/gstreamer-bridge')];
      const { createGstreamerBridge } = require('../app/main/gstreamer-bridge');
      const bridge = createGstreamerBridge({
        runtimeResourcePath: rel => path.join(root, rel),
        userDataDir: () => path.join(resources, 'data'),
        spawnTracked: (command, args, options) => { const child = makeChild(); spawned.push({ command, options, child }); return child; },
        crashDebug() {}, writeSession() {},
        getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push(payload) } }),
      });
      assert.equal(bridge.startGstreamerProcess(), true);
    });
    assert.equal(spawned.length, 1);
    const { command, options, child } = spawned[0];
    assert.equal(command, path.join(resources, 'native', 'beehive-gstreamer-player.exe'));
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'], 'no fd 3 on Windows');
    assert.equal(options.windowsHide, true);
    const gst = path.join(resources, 'GStreamer');
    const pathKey = Object.keys(options.env).find(k => k.toUpperCase() === 'PATH');
    assert.ok(options.env[pathKey].startsWith(path.join(gst, 'bin') + ';'), 'bundled GStreamer DLLs come first on PATH');
    assert.equal(options.env.GST_PLUGIN_SYSTEM_PATH_1_0, path.join(gst, 'lib', 'gstreamer-1.0'));
    assert.equal(options.env.GST_PLUGIN_PATH_1_0, '');
    assert.equal(options.env.GST_PLUGIN_SCANNER_1_0, path.join(gst, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe'));
    assert.equal(options.env.GST_REGISTRY_1_0, path.join(resources, 'data', 'gstreamer-registry-1.0.bin'));
    child.stdout.emit('data', Buffer.from('READY\r\nLOADED\tC:\\Music\\a.flac\r\n'));
    assert.deepEqual(sent, [{ name: 'READY', value: '' }, { name: 'LOADED', value: 'C:\\Music\\a.flac' }]);
  } finally {
    delete require.cache[require.resolve('../app/main/gstreamer-bridge')];
    fs.rmSync(resources, { recursive: true, force: true });
  }
});

function fakeWindowsBridge(resources, deps = {}) {
  fs.mkdirSync(path.join(resources, 'native'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'native', 'beehive-gstreamer-player.exe'), '');
  const spawned = [];
  const bridge = withPlatform('win32', resources, () => {
    delete require.cache[require.resolve('../app/main/gstreamer-bridge')];
    const { createGstreamerBridge } = require('../app/main/gstreamer-bridge');
    return createGstreamerBridge({
      runtimeResourcePath: rel => path.join(root, rel),
      userDataDir: () => path.join(resources, 'data'),
      spawnTracked: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdio = [null, child.stdout, child.stderr];
        child.stdin = { writable: true, write() { return true; }, end() {} };
        child.killed = false;
        child.kill = () => { child.killed = true; };
        spawned.push(child);
        return child;
      },
      crashDebug() {}, writeSession() {},
      getMainWindow: () => null,
      ...deps,
    });
  });
  // Spawning resolves the helper from process.resourcesPath, so calls run in scope.
  const status = () => withPlatform('win32', resources, () => bridge.gstreamerStatus());
  return { status, spawned };
}

// Real bug, reported from a real Windows machine: tracks queued but never
// played until Hive had been relaunched ~5 times. The helper's first gst_init()
// builds the plugin registry (every bundled plugin DLL, scanned by Defender),
// which blew through a 1.5 s READY timeout; the helper was killed mid-scan so
// the registry was never saved, and playback stayed off for that session.
test('a helper that is slow to report READY is waited for, not killed', async (t) => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-win-resources-'));
  t.after(() => { delete require.cache[require.resolve('../app/main/gstreamer-bridge')]; fs.rmSync(resources, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { status: gstreamerStatus, spawned } = fakeWindowsBridge(resources);
  let result;
  const status = gstreamerStatus().then(v => { result = v; });
  t.mock.timers.tick(20000);
  await Promise.resolve();
  assert.equal(result, undefined, 'still waiting for the registry build');
  assert.equal(spawned[0].killed, false);
  spawned[0].stdout.emit('data', Buffer.from('READY\r\n'));
  await status;
  assert.equal(result, true);
  assert.equal(spawned.length, 1);
});

test('a helper that really never becomes READY is replaced on the next status check', async (t) => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-win-resources-'));
  t.after(() => { delete require.cache[require.resolve('../app/main/gstreamer-bridge')]; fs.rmSync(resources, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { status: gstreamerStatus, spawned } = fakeWindowsBridge(resources, { readyTimeoutMs: 100 });
  const first = gstreamerStatus();
  t.mock.timers.tick(100);
  assert.equal(await first, false);
  assert.equal(spawned[0].killed, true);
  const second = gstreamerStatus();
  assert.equal(spawned.length, 2, 'a fresh helper is started instead of staying failed');
  spawned[1].stdout.emit('data', Buffer.from('READY\r\n'));
  assert.equal(await second, true);
});

test('a failed GStreamer availability check is not cached for the whole session', () => {
  const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  const line = renderer.split('\n').find(l => l.includes('gstAvailabilityPromise = window.beehive.gstreamerStatus()'));
  assert.ok(line, 'expected the renderer availability check');
  assert.match(line, /gstAvailabilityKnown = gstAvailable;/);
  assert.match(line, /if \(!gstAvailable\) gstAvailabilityPromise = null;/);
  assert.doesNotMatch(line, /\.catch\([^)]*\) => \{[^}]*gstAvailabilityKnown = true/);
});

test('on Windows main.js points every Python caller at the bundled embeddable Python', () => {
  const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
  assert.match(main, /process\.platform === 'win32' && !process\.env\.BEEHIVE_PYTHON[\s\S]{0,200}path\.join\(process\.resourcesPath \|\| '', 'python-runtime', 'python\.exe'\)/);
  // No Python launch may bypass BEEHIVE_PYTHON with a bare python3 (absent on Windows).
  for (const dir of ['app/main', 'app/workers']) {
    for (const file of fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(root, dir, file), 'utf8');
      for (const m of source.matchAll(/['"]python3['"]/g)) {
        const before = source.slice(Math.max(0, m.index - 40), m.index);
        assert.match(before, /BEEHIVE_PYTHON \|\| $/, `${dir}/${file} launches python3 without BEEHIVE_PYTHON`);
      }
    }
  }
});

// Windows Python opens its pipes in the ANSI code page (cp1252), which turned
// every non-ASCII tag into mojibake. Simulated here by forcing that encoding.
test('the tag helper and database worker speak UTF-8 even when Python defaults its pipes to cp1252', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-utf8-'));
  try {
    const env = { ...process.env, PYTHONIOENCODING: 'cp1252', PYTHONUTF8: '0' };
    const flac = path.join(dir, 'テスト.flac');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.1', flac]);
    assert.equal(made.status, 0, String(made.stderr));
    const title = 'Windows tést — 東京';
    const tag = spawnSync('python3', [path.join(root, 'resources', 'python', 'tag_helper.py')], {
      env, input: Buffer.from([
        JSON.stringify({ id: 1, op: 'write_tags', path: flac, tags: { title } }),
        JSON.stringify({ id: 2, op: 'read_metadata_fields', path: flac, fields: ['title'] }),
      ].join('\n') + '\n', 'utf8'),
    });
    const replies = String(tag.stdout).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies[0].ok, true, String(tag.stdout) + String(tag.stderr));
    assert.equal(replies[1].result.fields.title, title);

    const db = spawnSync('python3', [path.join(root, 'app', 'workers', 'database-worker.py'), path.join(dir, 'db.sqlite')], {
      env, input: Buffer.from([
        JSON.stringify({ id: 1, cmd: 'replace_library', tracks: [{ path: 'C:\\Music\\東京.flac', title }] }),
        JSON.stringify({ id: 2, cmd: 'search_tracks', text: '東京' }),
      ].join('\n') + '\n', 'utf8'),
    });
    const rows = String(db.stdout).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows[1].result[0]?.title, title, String(db.stdout) + String(db.stderr));
    assert.equal(rows[1].result[0]?.path, 'C:\\Music\\東京.flac');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the native helper builds for Windows: no POSIX-only calls outside a G_OS_WIN32 guard, events on stdout there', () => {
  const native = fs.readFileSync(path.join(root, 'app', 'native', 'gstreamer-player.c'), 'utf8');
  assert.doesNotMatch(native, /#include <(unistd|pthread)\.h>/);
  assert.doesNotMatch(native, /\bgetline\(|\bpthread_/);
  assert.match(native, /#ifdef G_OS_WIN32[\s\S]*?event_fp = stdout;[\s\S]*?#else\s*\n\s*event_fp = fdopen\(3, "w"\);/);
  assert.match(native, /g_thread_new\("hive-stdin", stdin_thread, NULL\)/);
});

// Windows refuses to replace a file another program has open (EPERM/EBUSY/
// EACCES): Hive's audio helper, the Search indexer, antivirus. Every metadata
// write ends in replaceFile, which retries there before failing clearly.
test('replaceFile retries a locked file on Windows, then gives a clear error; other platforms fail fast', async () => {
  const { replaceFile } = require('../app/main/replace-file');
  const lockedThenFree = () => { let n = 0; return async () => { if (n++ < 2) { const e = new Error('locked'); e.code = 'EPERM'; throw e; } }; };
  const sleeps = [];
  await replaceFile('t', 'f', { platform: 'win32', rename: lockedThenFree(), sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [100, 200], 'retried with backoff, then succeeded');

  const alwaysLocked = async () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  await assert.rejects(replaceFile('t', 'C:\\Music\\a.mp3', { platform: 'win32', rename: alwaysLocked, retryForMs: 0, sleep: async () => {} }),
    err => err.code === 'EBUSY' && /open in another program/.test(err.message));
  await assert.rejects(replaceFile('t', 'f', { platform: 'linux', rename: alwaysLocked, sleep: async () => { throw new Error('should not retry'); } }), { code: 'EBUSY' });

  let copied = false;
  const crossDevice = async () => { const e = new Error('xdev'); e.code = 'EXDEV'; throw e; };
  await replaceFile('t', 'f', { platform: 'win32', rename: crossDevice, copyOver: async () => { copied = true; } });
  assert.equal(copied, true, 'EXDEV falls back to copy');

  // Every media-file writer goes through it.
  for (const file of ['app/main/metadata-writer.js', 'app/workers/metadata-worker.js']) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /replaceFile\(/, file);
  }
});

// A song reached by a gapless transition was never marked as playing, so a
// Love/tag write went straight at the open file -- harmless on Linux, EPERM on
// Windows (the "liking a song failed" report).
test('a gapless transition protects the newly playing file like a fresh load does', () => {
  const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
  const start = renderer.indexOf("if (name === 'STREAM_START') {");
  const block = renderer.slice(start, renderer.indexOf('updateNowPlayingUI(next);', start));
  assert.match(block, /currentIndex = ni;[\s\S]*window\.beehive\.setPlaybackProtectedPath\?\.\(next\.path\);/);
});

// The Windows package ships the app as plain files: with app.asar, the
// unpacked workers could not load modules left in the archive, every scanner
// worker crashed, and every track showed 0:00.
test('the Windows package is plain files, bundles the Linux-equivalent tools and decoders, and resolves like a checkout', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'build-windows.sh'), 'utf8');
  assert.match(script, /asar: false/);
  for (const plugin of ['libav', 'asf', 'isomp4', 'fdkaac', 'flac', 'mpg123', 'opus', 'vorbis', 'wavpack', 'musepack', 'speex', 'wasapi2']) {
    assert.match(script, new RegExp(`PLUGINS=\\([^)]*\\b${plugin}\\b`), plugin);
  }
  assert.match(script, /TOOLS=\(ffmpeg\.exe metaflac\.exe\)/);
  const sessionLog = fs.readFileSync(path.join(root, 'app', 'main', 'session-log.js'), 'utf8');
  assert.match(sessionLog, /plainFilePackage = !fs\.existsSync\(path\.join\(process\.resourcesPath \|\| '', 'app\.asar'\)\)/);
  const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
  assert.match(main, /path\.join\(process\.resourcesPath \|\| '', 'GStreamer', 'bin'\)[\s\S]{0,300}process\.env\[pathKey\] = \[bundledBin/);
});

test('Windows gets a tray icon and keyboard media keys (Linux uses MPRIS for both)', () => {
  const tray = fs.readFileSync(path.join(root, 'app', 'main', 'tray.js'), 'utf8');
  assert.match(tray, /\['linux', 'win32'\]\.includes\(process\.platform\)/);
  const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
  for (const key of ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop']) assert.match(main, new RegExp(key));
  assert.match(main, /globalShortcut\.register\(accelerator, \(\) => mpris\.command\(command\)\)/);
});

// The scan's "finalization" flush ran before the worker pool started, so the
// last partial batch of scanned tracks never reached SQLite (a small library's
// first scan left the database empty; search found nothing).
test('a library scan flushes its last database batch after the workers finish', () => {
  const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
  assert.match(main, /await runPool\(\);\s*scanToken\.onCancel = null;\s*throwIfCancelled\(\);[\s\S]{0,400}await flushDatabaseBatch\(\);/);
});
