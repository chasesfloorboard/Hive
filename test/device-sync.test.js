'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseGioVolumes, isAudioFile, sendTracksToDevice, normalizeDeviceRelativePath, inspectStorageRoots } = require('../app/main/device-manager');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

test('Android device parser recognizes a mounted MTP volume', () => {
  // mount_path points at a directory that actually exists (here: this
  // process's real tmpdir) rather than a fake /run/user/... path. The parser
  // trusts a given mount_path verbatim only when it exists on disk; when it
  // doesn't, it falls back to matching a real gvfs mount on the machine
  // running the test, which makes an unconditionally fake path here flaky on
  // any machine/CI with a real MTP device already mounted.
  const realMountPath = require('node:os').tmpdir();
  const output = `Volume(0): Pixel 9\n  Type: GProxyVolume (GProxyVolumeMonitorMTP)\n  Mount(0): Internal storage -> mtp://Pixel_9/Internal%20storage\n    Type: GProxyMount (GProxyVolumeMonitorMTP)\n    default_location=mtp://Pixel_9/Internal%20storage\n    mount_path=${realMountPath}\n`;
  const devices = parseGioVolumes(output);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Pixel 9');
  assert.equal(devices[0].id, 'mtp://Pixel_9');
  assert.equal(devices[0].mountPath, realMountPath);
  assert.equal(devices[0].storages.length, 1);
  assert.equal(devices[0].storages[0].name, 'Internal storage');
  assert.equal(devices[0].storages[0].path, 'Internal storage');
});

test('Android parser groups multiple MTP storage mounts into one phone', () => {
  const output = `Volume(0): Samsung A55
  Type: GProxyVolume (GProxyVolumeMonitorMTP)
  Mount(0): Internal storage -> mtp://Samsung_A55/Internal%20storage
    Type: GProxyMount (GProxyVolumeMonitorMTP)
    default_location=mtp://Samsung_A55/Internal%20storage
    mount_path=/run/user/1000/gvfs/mtp:host=Samsung_A55
  Mount(1): SD card -> mtp://Samsung_A55/SD%20card
    Type: GProxyMount (GProxyVolumeMonitorMTP)
    default_location=mtp://Samsung_A55/SD%20card
    mount_path=/run/user/1000/gvfs/mtp:host=Samsung_A55
`;
  const devices = parseGioVolumes(output);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Samsung A55');
  assert.deepEqual(devices[0].storages.map(storage => storage.path), ['Internal storage', 'SD card']);
});

test('Android parser ignores unrelated top-level mounts and does not split one phone into two', () => {
  // Real `gio mount -li` output for one physical phone includes, after the
  // phone's own indented Mount(0), two top-level (non-indented) Mount(N)
  // entries that do NOT belong to that Volume: an internal GVfs daemon shadow
  // mount duplicating the same MTP host (is_shadowed=1), and an unrelated
  // local drive/folder mount (here literally named "Music"). The parser used
  // to never clear its `volume` variable on leaving a Volume() block, so both
  // top-level mounts inherited the phone's stale MTP volume/type: the shadow
  // mount became a bogus second "mtp" storage on the real phone, and the
  // local Music folder was misread as a second MTP device (name-keyed
  // grouping fell back to the phone's own stale name since a file:// URI has
  // no host) -- one physical Samsung phone showing up as two Android devices
  // in Settings > Devices, one of them offering a "Music" folder that was
  // actually the local library directory.
  const output = `Volume(0): SAMSUNG Android
  Type: GProxyVolume (GProxyVolumeMonitorMTP)
  ids:
   unix-device: '/dev/bus/usb/003/004'
  activation_root=mtp://SAMSUNG_SAMSUNG_Android_RZCY81KEGEY/
  can_mount=1
  can_eject=0
  should_automount=1
  Mount(0): SAMSUNG Android -> mtp://SAMSUNG_SAMSUNG_Android_RZCY81KEGEY/
    Type: GProxyShadowMount (GProxyVolumeMonitorMTP)
    default_location=mtp://SAMSUNG_SAMSUNG_Android_RZCY81KEGEY/
    can_unmount=1
    can_eject=0
    is_shadowed=0
Mount(1): mtp -> mtp://SAMSUNG_SAMSUNG_Android_RZCY81KEGEY/
  Type: GDaemonMount
  default_location=mtp://SAMSUNG_SAMSUNG_Android_RZCY81KEGEY/
  can_unmount=1
  can_eject=0
  is_shadowed=1
Mount(2): Music -> file:///home/madvillain/Music
  Type: GProxyMount (GProxyVolumeMonitorUDisks2)
  default_location=file:///home/madvillain/Music
  can_unmount=1
  can_eject=0
  is_shadowed=0
`;
  const devices = parseGioVolumes(output);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'SAMSUNG Android');
  assert.deepEqual(devices[0].storages.map(storage => storage.name), ['SAMSUNG Android']);
});

test('inspectStorageRoots drops the placeholder root storage once real storage folders are found', async (t) => {
  // Before a phone exposes per-storage folders (e.g. right after gio's own
  // Mount() line is parsed), the "storage" is a placeholder with an empty
  // path, meaning "write directly at the device's MTP root". Android's MTP
  // responder rejects mkdir/write at that root with EACCES -- a real
  // transfer must land inside an actual storage folder like "Internal
  // storage" or "SD_Card". Once inspectStorageRoots discovers those real
  // folders by listing the mount, the placeholder must be dropped so it can
  // never be selected and silently fail every transfer's first mkdir with
  // "permission denied".
  const fsp = require('node:fs/promises');
  const os = require('node:os');
  const mountPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'hive-device-'));
  await fsp.mkdir(path.join(mountPath, 'Internal storage'));
  await fsp.mkdir(path.join(mountPath, 'SD_Card'));
  t.after(() => fsp.rm(mountPath, { recursive: true, force: true }));

  const device = { mountPath, storages: [{ key: '', name: 'SAMSUNG Android', path: '', uri: null }] };
  const inspected = await inspectStorageRoots(device);
  assert.deepEqual(inspected.storages.map(storage => storage.name).sort(), ['Internal storage', 'SD_Card']);
  assert.ok(inspected.storages.every(storage => storage.path), 'no storage should have an empty (device-root) path');
});

test('inspectStorageRoots keeps the placeholder when no real storage folder can be listed yet', async () => {
  // A locked phone / one not yet in File Transfer mode reports an empty or
  // unreadable mount. In that case there is nothing better to offer than the
  // placeholder, so it must not be dropped (that would leave zero storages).
  const device = { mountPath: '/nonexistent/hive-device-test-path', storages: [{ key: '', name: 'SAMSUNG Android', path: '', uri: null }] };
  const inspected = await inspectStorageRoots(device);
  assert.deepEqual(inspected.storages.map(storage => storage.path), ['']);
});

test('device discovery never lists the live GVfs mount synchronously', () => {
  // parseGioVolumes() is a pure/fast string parser used synchronously
  // everywhere (including in tests). It used to also fs.readdirSync() the
  // real /run/user/<uid>/gvfs directory to recover a missing mount_path --
  // real filesystem I/O on Electron's single main process, synchronously.
  // A slow or wedged MTP/FUSE session (a locked phone, one mid-transfer, one
  // that just dropped) made that call block for many seconds, freezing the
  // entire app, not just the device list. That lookup now lives in the
  // async attachGvfsMountPaths(), called from refreshDevices() with
  // fs.promises so a slow response can never block the main process.
  const native = fs.readFileSync(path.join(root, 'app/main/device-manager.js'), 'utf8');
  const parserStart = native.indexOf('function parseGioVolumes');
  const parserEnd = native.indexOf('\n}', native.indexOf("return [...grouped.values()];", parserStart));
  const parserBody = native.slice(parserStart, parserEnd);
  assert.doesNotMatch(parserBody, /readdirSync/);
  assert.doesNotMatch(parserBody, /existsSync/);

  const attachStart = native.indexOf('async function attachGvfsMountPaths');
  assert.ok(attachStart >= 0, 'attachGvfsMountPaths should exist');
  const attachEnd = native.indexOf('\n}', attachStart);
  const attachBody = native.slice(attachStart, attachEnd);
  assert.match(attachBody, /await fsp\.readdir\(gvfsRoot/);
  assert.doesNotMatch(attachBody, /readdirSync|existsSync/);

  assert.match(native, /let devices = await attachGvfsMountPaths\(parseGioVolumes\(output\)\)/);
});

test('SD card default-destination detection matches real-world folder naming, not just "SD card" with a space', () => {
  // Real devices name this folder inconsistently: "SD card", "SD_Card",
  // "sdcard", "SD-Card". The detection regex in devices:list must match "sd"
  // and "card" with any (or no) separator, not just whitespace, or a real
  // phone's "SD_Card" folder (confirmed on this user's Samsung device) is
  // never recognized and the destination silently defaults to internal
  // storage instead of the SD card as documented in the Devices panel.
  const start = main.indexOf("ipcMain.handle('devices:list'");
  const end = main.indexOf('\n});', start);
  const block = main.slice(start, end);
  assert.match(block, /const sd = \(device\.storages/);
  assert.doesNotMatch(block, /\\bsd\\s\*card\\b/, 'must not require whitespace specifically between "sd" and "card"');
  assert.match(block, /sd\[\\s_-\]\*card/, 'expected the separator-tolerant sd[\\s_-]*card pattern');

  // Exercise the exact behavior with a standalone copy of the same pattern.
  const re = /\bsd[\s_-]*card\b/i;
  for (const name of ['SD card', 'SD_Card', 'sdcard', 'SD-Card']) {
    assert.ok(re.test(name), `expected SD-card regex to match "${name}"`);
  }
  assert.ok(!re.test('Internal storage'));
});

test('Android destination paths reject traversal', () => {
  assert.equal(normalizeDeviceRelativePath('SD card/Music'), 'SD card/Music');
  assert.throws(() => normalizeDeviceRelativePath('../Music'), /Invalid Android destination path/);
  assert.throws(() => normalizeDeviceRelativePath('SD card/../../Music'), /Invalid Android destination path/);
});

test('device sync accepts common local audio formats but not arbitrary files', () => {
  assert.equal(isAudioFile('/music/song.flac'), true);
  assert.equal(isAudioFile('/music/song.MP3'), true);
  assert.equal(isAudioFile('/music/cover.jpg'), false);
  assert.equal(isAudioFile('/music/readme.txt'), false);
});

test('Android sync has a native IPC path and settings UI', () => {
  assert.match(main, /ipcMain\.handle\('devices:list'/);
  assert.match(main, /ipcMain\.handle\('devices:sendTracks'/);
  assert.match(preload, /listDevices: \(\) => ipcRenderer\.invoke\('devices:list'\)/);
  assert.match(preload, /sendTracksToDevice: \(device, tracks\) => ipcRenderer\.invoke\('devices:sendTracks'/);
  assert.match(html, /data-settings-tab="connections">Connections/);
  assert.match(html, /id="settings-panel-connections"[\s\S]*Android devices/);
  assert.match(html, /id="device-refresh-btn"/);
  assert.match(renderer, /Send to/);
  assert.match(renderer, /setDeviceDestination/);
  assert.match(renderer, /sendTracksToAndroidDevice/);
});

test('Android transfers use an artist/album Music folder hierarchy', () => {
  const native = fs.readFileSync(path.join(root, 'app/main/device-manager.js'), 'utf8');
  assert.match(native, /path\.posix\.join\(base \|\| 'Music', artist, album, fileName\)/);
  assert.match(native, /Already on device/);
  assert.match(native, /onProgress\?/);
});


test('device transfer copies local music into the phone Music hierarchy', async () => {
  const os = require('node:os');
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hive-device-sync-'));
  try {
    const source = path.join(temp, 'track.flac');
    const mount = path.join(temp, 'phone');
    await fs.promises.mkdir(mount, { recursive: true });
    await fs.promises.writeFile(source, Buffer.from('fake audio bytes'));
    const result = await sendTracksToDevice({ name: 'Test Phone', mountPath: mount }, [{ path: source, artist: 'Example Artist', album: 'Example Album' }]);
    assert.equal(result.copied.length, 1);
    const destination = path.join(mount, 'Music', 'Example Artist', 'Example Album', 'track.flac');
    assert.equal(await fs.promises.readFile(destination, 'utf8'), 'fake audio bytes');
    const second = await sendTracksToDevice({ name: 'Test Phone', mountPath: mount }, [{ path: source, artist: 'Example Artist', album: 'Example Album' }]);
    assert.equal(second.skipped.length, 1);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
