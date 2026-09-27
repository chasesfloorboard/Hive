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
