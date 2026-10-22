'use strict';
// Hive Mobile over USB. When a phone with USB debugging is plugged in, the
// phone's own 127.0.0.1:<port> is pointed at Hive Link here ("adb reverse"),
// so Hive Mobile reaches this PC through the cable: no Wi-Fi, no address to
// find. It needs adb (Android's platform tools); without it this does nothing.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findAdb() {
  // Windows: adb.exe, where Android Studio puts the SDK (%LOCALAPPDATA%\Android\Sdk) or a platform-tools folder on PATH.
  const windows = process.platform === 'win32';
  const adb = windows ? 'adb.exe' : 'adb';
  const onPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, adb));
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', adb),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', adb),
    windows && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', adb),
    path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', adb),
    ...(windows ? [] : ['/usr/bin/adb', '/usr/local/bin/adb', '/opt/android-sdk/platform-tools/adb']),
    ...onPath,
  ].filter(Boolean);
  return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

function run(adb, args, timeout = 8000) {
  return new Promise(resolve => execFile(adb, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || ''))));
}

/** Phones attached and authorized, by serial. */
function parseDevices(text) {
  return String(text || '').split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(([serial, state]) => serial && state === 'device').map(([serial]) => serial);
}

function createUsbBridge({ port, log = () => {}, intervalMs = 5000, adbPath = findAdb() } = {}) {
  let timer = null;
  const bridged = new Set();

  async function tick() {
    const listing = await run(adbPath, ['devices']);
    if (listing === null) return;
    const attached = new Set(parseDevices(listing));
    for (const serial of attached) {
      if (bridged.has(serial)) continue;
      // Emulators reach the PC at 10.0.2.2 already; only real phones need the cable.
      if (serial.startsWith('emulator-')) continue;
      const ok = await run(adbPath, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
      if (ok !== null) { bridged.add(serial); log(`Hive Link over USB for ${serial}`); }
    }
    for (const serial of [...bridged]) if (!attached.has(serial)) bridged.delete(serial);
  }

  return {
    available: !!adbPath,
    start() {
      if (!adbPath || timer) return;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    connected: () => [...bridged],
  };
}

module.exports = { createUsbBridge, parseDevices, findAdb };
