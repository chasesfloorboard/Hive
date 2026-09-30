'use strict';
// Stable home for the portable self-updater (app/main/portable-updater.js):
// the Settings > About update flow for the Windows zip and Linux tarball.
// Edit in place when the updater changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createPortableUpdater, compareVersions, PROTECTED_NAMES } = require('../app/main/portable-updater');

const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
};
const release = (tag, assets) => ({ tag_name: tag, name: `Hive ${tag}`, body: 'notes', assets });
const jsonResponse = body => ({ ok: true, status: 200, json: async () => body });

function makeUpdater(t, overrides = {}) {
  const updater = createPortableUpdater({
    platform: 'linux',
    currentVersion: '1.0.3',
    installRoot: overrides.installRoot || tmp(t, 'hive-install-'),
    owner: 'chasesfloorboard',
    repo: 'Hive',
    ...overrides,
  });
  const events = [];
  for (const name of ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'error']) {
    updater.on(name, payload => events.push({ name, payload }));
  }
  return { updater, events };
}

test('versions compare numerically and releases outrank prereleases', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('v1.0.4', '1.0.4'), 0);
  assert.equal(compareVersions('1.0.4', '1.0.4-rc.1'), 1);
  assert.equal(compareVersions('1.0.3', '1.1.0'), -1);
});

test('a newer release with an asset for this platform is offered', async (t) => {
  const assets = [
    { name: 'Hive-1.0.4-Win-x64.zip', browser_download_url: 'https://example/win.zip', size: 10 },
    { name: 'Hive-1.0.4-Linux.tar.gz', browser_download_url: 'https://example/linux.tar.gz', size: 5 },
  ];
  let requested = '';
  const { updater, events } = makeUpdater(t, { fetchImpl: async url => { requested = url; return jsonResponse(release('v1.0.4', assets)); } });
  await updater.checkForUpdates();
  assert.equal(requested, 'https://api.github.com/repos/chasesfloorboard/Hive/releases/latest');
  const offered = events.find(e => e.name === 'update-available').payload;
  assert.equal(offered.version, '1.0.4');
  assert.equal(offered.assetUrl, 'https://example/linux.tar.gz');

  const win = makeUpdater(t, { platform: 'win32', fetchImpl: async () => jsonResponse(release('v1.0.4', assets)) });
  await win.updater.checkForUpdates();
  assert.equal(win.events.find(e => e.name === 'update-available').payload.assetName, 'Hive-1.0.4-Win-x64.zip');
});

test('the same version, an older one, or a release without this platform asset is not offered', async (t) => {
  for (const body of [
    release('v1.0.3', [{ name: 'Hive-1.0.3-Linux.tar.gz' }]),
    release('v1.0.2', [{ name: 'Hive-1.0.2-Linux.tar.gz' }]),
    release('v1.0.9', [{ name: 'Hive-1.0.9-Win-x64.zip' }]),
  ]) {
    const { updater, events } = makeUpdater(t, { fetchImpl: async () => jsonResponse(body) });
    await updater.checkForUpdates();
    assert.deepEqual(events.map(e => e.name), ['checking-for-update', 'update-not-available']);
  }
});

test('a git checkout is never self-updated', async (t) => {
  const installRoot = tmp(t, 'hive-install-');
  fs.mkdirSync(path.join(installRoot, '.git'));
  const { updater } = makeUpdater(t, { installRoot, fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(updater.checkForUpdates(), /git checkout/);
});

// Builds a fake Linux install with user data next to the app files, and a
// release tarball for the next version, then runs the real install script.
function linuxFixture(t, { lockChanges = false } = {}) {
  const base = tmp(t, 'hive-update-e2e-');
  const root = path.join(base, 'Hive');
  write(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.3' }));
  write(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.3', packages: { '': { version: '1.0.3' }, 'node_modules/a': { version: '1.0.0' } } }));
  write(path.join(root, 'app', 'main.js'), 'old app');
  write(path.join(root, 'app', 'removed-in-new.js'), 'old only');
  write(path.join(root, 'run.sh'), `#!/usr/bin/env bash\necho old > "${base}/relaunched"\n`, 0o755);
  write(path.join(root, 'Hive Data', 'config.json'), '{"theme":"dark"}');
  write(path.join(root, 'Hive Data', 'beehive.db'), 'library');
  write(path.join(root, 'User Data Backup', 'b.json'), 'backup');
  write(path.join(root, 'Hive Wrapped Data', '2026', 'play_history.xml'), 'history');
  write(path.join(root, 'logs', 'session-1.txt'), 'log');
  write(path.join(root, '.beehive-installed'), '');
  write(path.join(root, 'node_modules', 'electron', 'dist', 'electron'), '', 0o755);
  write(path.join(root, 'install.sh'), `#!/usr/bin/env bash\necho reinstalled > "${base}/reinstalled"\n`, 0o755);

  const pkg = path.join(base, 'build', 'hive-1.0.4');
  write(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.0.4' }));
  // A release always bumps Hive's own version in the lock; only lockChanges
  // changes an actual dependency.
  write(path.join(pkg, 'package-lock.json'), JSON.stringify({ version: '1.0.4', packages: { '': { version: '1.0.4' }, 'node_modules/a': { version: lockChanges ? '2.0.0' : '1.0.0' } } }));
  write(path.join(pkg, 'app', 'main.js'), 'new app');
  write(path.join(pkg, 'run.sh'), `#!/usr/bin/env bash\necho new > "${base}/relaunched"\n`, 0o755);
  write(path.join(pkg, 'install.sh'), `#!/usr/bin/env bash\n[ "$HIVE_INSTALL_NO_LAUNCH" = 1 ] && echo reinstalled > "${base}/reinstalled"\n`, 0o755);
  write(path.join(pkg, 'logs', '.gitkeep'), '');
  write(path.join(pkg, 'Hive Data', 'config.json'), '{"theme":"SHIPPED-DEFAULT"}');
  const tarball = path.join(base, 'Hive-1.0.4-Linux.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', path.join(base, 'build'), 'hive-1.0.4']).status, 0);
  const fetchImpl = async url => {
    if (url.includes('api.github.com')) return jsonResponse(release('v1.0.4', [{ name: 'Hive-1.0.4-Linux.tar.gz', browser_download_url: 'file://tarball', size: fs.statSync(tarball).size }]));
    const data = fs.readFileSync(tarball);
    return { ok: true, status: 200, headers: { get: () => String(data.length) }, body: require('node:stream').Readable.from([data]) };
  };
  return { base, root, pkgName: 'hive-1.0.4', fetchImpl };
}

async function waitFor(file, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function runUpdate(t, fixture) {
  // The Hive process the script waits for: already gone by the time it looks.
  const exited = spawnSync('true');
  let quitCalled = false;
  const { updater, events } = makeUpdater(t, { installRoot: fixture.root, fetchImpl: fixture.fetchImpl, spawn, pid: exited.pid || 999999, quit: () => { quitCalled = true; } });
  await updater.checkForUpdates();
  await updater.downloadUpdate();
  assert.ok(events.some(e => e.name === 'update-downloaded'));
  updater.quitAndInstall();
  assert.equal(quitCalled, true);
  await waitFor(path.join(fixture.base, 'relaunched'));
  return fs.readFileSync(path.join(fixture.root, '.hive-update', 'install.log'), 'utf8');
}

test('Linux: installing an update replaces app files, keeps every user data folder, and relaunches the new version', { skip: process.platform === 'win32' }, async (t) => {
  const fx = linuxFixture(t);
  const log = await runUpdate(t, fx);
  assert.match(log, /update installed/);
  const read = rel => fs.readFileSync(path.join(fx.root, rel), 'utf8');
  assert.equal(JSON.parse(read('package.json')).version, '1.0.4');
  assert.equal(read('app/main.js'), 'new app');
  assert.equal(fs.existsSync(path.join(fx.root, 'app', 'removed-in-new.js')), false, 'app/ is replaced as a whole');
  assert.equal(read('Hive Data/config.json'), '{"theme":"dark"}', 'settings are never overwritten, even by a package that ships the folder');
  assert.equal(read('Hive Data/beehive.db'), 'library');
  assert.equal(read('User Data Backup/b.json'), 'backup');
  assert.equal(read('Hive Wrapped Data/2026/play_history.xml'), 'history');
  assert.equal(read('logs/session-1.txt'), 'log');
  assert.equal(fs.existsSync(path.join(fx.root, 'logs', '.gitkeep')), false);
  assert.ok(fs.existsSync(path.join(fx.root, 'node_modules', 'electron', 'dist', 'electron')));
  assert.equal(fs.readFileSync(path.join(fx.base, 'relaunched'), 'utf8').trim(), 'new', 'the new run.sh is what relaunches');
  assert.equal(fs.existsSync(path.join(fx.base, 'reinstalled')), false, 'unchanged dependencies are not reinstalled');
  assert.equal(fs.existsSync(path.join(fx.root, '.hive-update', 'backup')), false);
  assert.equal(fs.existsSync(path.join(fx.root, '.hive-update', 'staging')), false);
});

test('Linux: a release with changed dependencies reruns install.sh without letting it launch Hive', { skip: process.platform === 'win32' }, async (t) => {
  const fx = linuxFixture(t, { lockChanges: true });
  const log = await runUpdate(t, fx);
  assert.match(log, /dependencies changed/);
  assert.ok(fs.existsSync(path.join(fx.base, 'reinstalled')));
});

test('Linux: a failed install restores the previous version', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const fx = linuxFixture(t);
  const exited = spawnSync('true');
  const { updater } = makeUpdater(t, { installRoot: fx.root, fetchImpl: fx.fetchImpl, spawn, pid: exited.pid || 999999 });
  await updater.checkForUpdates();
  await updater.downloadUpdate();
  // Moving entries out of an unwritable package folder fails part-way through.
  const pkgRoot = path.join(fx.root, '.hive-update', 'staging', fx.pkgName);
  fs.chmodSync(pkgRoot, 0o555);
  updater.quitAndInstall();
  try { await waitFor(path.join(fx.base, 'relaunched')); } finally { fs.chmodSync(pkgRoot, 0o755); }
  const log = fs.readFileSync(path.join(fx.root, '.hive-update', 'install.log'), 'utf8');
  assert.match(log, /update failed, restoring previous version/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.root, 'package.json'), 'utf8')).version, '1.0.3');
  assert.equal(fs.readFileSync(path.join(fx.root, 'app', 'main.js'), 'utf8'), 'old app');
  assert.equal(fs.readFileSync(path.join(fx.root, 'Hive Data', 'config.json'), 'utf8'), '{"theme":"dark"}');
  assert.equal(fs.readFileSync(path.join(fx.base, 'relaunched'), 'utf8').trim(), 'old');
});

test('a download that is not the offered version is rejected before anything is installed', async (t) => {
  const fx = linuxFixture(t);
  const fetchImpl = async (url, opts) => {
    if (url.includes('api.github.com')) return jsonResponse(release('v1.0.5', [{ name: 'Hive-1.0.5-Linux.tar.gz', browser_download_url: 'file://x' }]));
    return fx.fetchImpl(url, opts);
  };
  const { updater } = makeUpdater(t, { installRoot: fx.root, fetchImpl, spawn });
  await updater.checkForUpdates();
  await assert.rejects(updater.downloadUpdate(), /not the expected version/);
  assert.equal(fs.readFileSync(path.join(fx.root, 'app', 'main.js'), 'utf8'), 'old app');
});

test('both install scripts protect the same user data folders', () => {
  for (const name of ['Hive Data', 'User Data Backup', 'Hive Wrapped Data', 'logs', 'data', 'node_modules', '.git']) {
    assert.ok(PROTECTED_NAMES.includes(name), name);
  }
});

// The Windows install script is PowerShell. It runs here when HIVE_TEST_PWSH
// points at a PowerShell binary (portable pwsh works on Linux); spawn maps
// powershell.exe to it, and the extraction falls back to Expand-Archive.
const pwsh = process.env.HIVE_TEST_PWSH || '';
test('Windows: installing an update replaces app files, keeps user data, and relaunches Hive.exe', { skip: !pwsh && 'set HIVE_TEST_PWSH to run the PowerShell installer' }, async (t) => {
  const base = tmp(t, 'hive-win-update-e2e-');
  const root = path.join(base, 'Hive');
  const exe = (dir, tag) => write(path.join(dir, 'Hive.exe'), `#!/usr/bin/env bash\necho ${tag} > "${base}/relaunched"\n`, 0o755);
  exe(root, 'old');
  write(path.join(root, 'resources', 'app', 'package.json'), JSON.stringify({ version: '1.0.3' }));
  write(path.join(root, 'resources', 'app', 'old-only.js'), 'old');
  write(path.join(root, 'ffmpeg.dll'), 'old dll');
  write(path.join(root, 'Hive Data', 'config.json'), '{"theme":"dark"}');
  write(path.join(root, 'Hive Data', 'gstreamer-registry-1.0.bin'), 'registry');
  write(path.join(root, 'logs', 'session-1.txt'), 'log');
  write(path.join(root, 'User Data Backup', 'b.json'), 'backup');
  const pkg = path.join(base, 'build', 'Hive');
  exe(pkg, 'new');
  write(path.join(pkg, 'resources', 'app', 'package.json'), JSON.stringify({ version: '1.0.4' }));
  write(path.join(pkg, 'ffmpeg.dll'), 'new dll');
  write(path.join(pkg, 'Hive Data', 'config.json'), '{"theme":"SHIPPED-DEFAULT"}');
  const zip = path.join(base, 'Hive-1.0.4-Win-x64.zip');
  assert.equal(spawnSync('bsdtar', ['-a', '-cf', zip, '-C', path.join(base, 'build'), 'Hive']).status, 0);
  const fetchImpl = async url => {
    if (url.includes('api.github.com')) return jsonResponse(release('v1.0.4', [{ name: 'Hive-1.0.4-Win-x64.zip', browser_download_url: 'file://zip', size: fs.statSync(zip).size }]));
    const data = fs.readFileSync(zip);
    return { ok: true, status: 200, headers: { get: () => String(data.length) }, body: require('node:stream').Readable.from([data]) };
  };
  // Linux pwsh rejects -WindowStyle ("not implemented on this platform").
  const winSpawn = (cmd, args, opts) => cmd === 'powershell.exe'
    ? spawn(pwsh, args.filter((a, i) => a !== '-WindowStyle' && args[i - 1] !== '-WindowStyle'), opts)
    : spawn(cmd, args, opts);
  const exited = spawnSync('true');
  const { updater } = makeUpdater(t, { platform: 'win32', installRoot: root, fetchImpl, spawn: winSpawn, pid: exited.pid || 999999 });
  await updater.checkForUpdates();
  await updater.downloadUpdate();
  updater.quitAndInstall();
  await waitFor(path.join(base, 'relaunched'), 60000);
  const log = fs.readFileSync(path.join(root, '.hive-update', 'install.log'), 'utf8');
  assert.match(log, /update installed/);
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
  assert.equal(JSON.parse(read('resources/app/package.json')).version, '1.0.4');
  assert.equal(fs.existsSync(path.join(root, 'resources', 'app', 'old-only.js')), false);
  assert.equal(read('ffmpeg.dll'), 'new dll');
  assert.equal(read('Hive Data/config.json'), '{"theme":"dark"}');
  assert.equal(read('Hive Data/gstreamer-registry-1.0.bin'), 'registry');
  assert.equal(read('logs/session-1.txt'), 'log');
  assert.equal(read('User Data Backup/b.json'), 'backup');
  assert.equal(fs.readFileSync(path.join(base, 'relaunched'), 'utf8').trim(), 'new');
  assert.equal(fs.existsSync(path.join(root, '.hive-update', 'backup')), false);
});
