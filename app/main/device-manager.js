'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aiff', '.aif', '.alac', '.wv']);

function cleanName(value, fallback = 'Unknown') {
  const text = String(value || '').trim() || fallback;
  return text.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || fallback;
}

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function storageNameFromUri(uri, fallback = 'Storage') {
  try {
    const pathname = decodeURIComponent(new URL(uri).pathname || '').replace(/^\/+/, '').replace(/\/+$/, '');
    return pathname ? pathname.split('/').pop() : fallback;
  } catch { return fallback; }
}

function storagePathFromUri(uri) {
  try { return decodeURIComponent(new URL(uri).pathname || '').replace(/^\/+/, '').replace(/\/+$/, ''); }
  catch { return ''; }
}

function deviceHostFromUri(uri) {
  try { return new URL(uri).hostname || ''; } catch { return ''; }
}

function parseGioVolumes(output) {
  const lines = String(output || '').split(/\r?\n/);
  const raw = [];
  let volume = null;
  let mount = null;
  const finishMount = () => {
    if (!volume || !mount) return;
    const uri = String(mount.defaultLocation || '').trim();
    const type = `${volume.type || ''} ${mount.type || ''}`.toLowerCase();
    if (!uri || (!uri.startsWith('mtp://') && !type.includes('mtp'))) return;
    raw.push({
      id: uri,
      name: String(volume.name || mount.name || 'Android device').trim() || 'Android device',
      uri,
      mountPath: String(mount.mountPath || '').trim() || null,
      storageName: String(mount.name || storageNameFromUri(uri, 'Storage')).split(' -> ')[0].trim() || storageNameFromUri(uri, 'Storage'),
      storagePath: storagePathFromUri(uri)
    });
  };
  for (const line of lines) {
    const volumeMatch = line.match(/^Volume\(\d+\):\s*(.*)$/);
    if (volumeMatch) {
      finishMount();
      volume = { name: volumeMatch[1].trim() };
      mount = null;
      continue;
    }
    // `gio mount -li` also prints top-level Mount(N) entries that are NOT
    // indented under any Volume() block: internal GVfs shadow/daemon mounts
    // (is_shadowed=1 duplicates of a Volume's own Mount) and completely
    // unrelated mounts, e.g. a local folder literally named "Music". Without
    // this check they inherited whatever Volume happened to be seen last, so
    // an MTP phone's stale volume/type leaked onto the next unrelated mount:
    // the phone appeared to have a duplicate "mtp" storage, AND the local
    // Music folder mount was misread as a second MTP storage, which then
    // grouped into a second phantom "phone" (grouping falls back to
    // name-based keys for non-mtp:// URIs, and the stale volume.name was
    // still the real phone's name). Reset `volume` so only Mount(N) lines
    // genuinely indented under their own Volume() are attributed to it.
    const topLevelMountMatch = line.match(/^Mount\(\d+\):/);
    if (topLevelMountMatch) {
      finishMount();
      volume = null;
      mount = null;
      continue;
    }
    if (!volume) continue;
    const typeMatch = line.match(/^\s*Type:\s*(.*)$/);
    if (typeMatch && !mount) volume.type = typeMatch[1].trim();
    const mountMatch = line.match(/^\s+Mount\(\d+\):\s*(.*)$/);
    if (mountMatch) {
      finishMount();
      mount = { name: mountMatch[1].trim() };
      continue;
    }
    if (!mount) continue;
    const defaultLocation = line.match(/^\s*default_location=(.*)$/);
    if (defaultLocation) mount.defaultLocation = defaultLocation[1].trim();
    const mountPath = line.match(/^\s*mount_path=(.*)$/);
    if (mountPath) mount.mountPath = mountPath[1].trim();
    const mountType = line.match(/^\s*Type:\s*(.*)$/);
    if (mountType) mount.type = mountType[1].trim();
  }
  finishMount();

  // GIO exposes each MTP storage as a separate Mount entry. Present one
  // Android device to the UI and keep its internal storage / SD card entries
  // together so we never mistake multiple storages for multiple phones.
  const grouped = new Map();
  for (const item of raw) {
    const host = deviceHostFromUri(item.uri);
    const key = host ? `mtp:${host}` : `name:${item.name}`;
    let device = grouped.get(key);
    if (!device) {
      device = { id: host ? `mtp://${host}` : item.id, name: item.name, mountPath: item.mountPath || null, storages: [] };
      grouped.set(key, device);
    }
    if (!device.mountPath && item.mountPath) device.mountPath = item.mountPath;
    const storageKey = item.storagePath || item.storageName;
    if (!device.storages.some(storage => storage.key === storageKey)) {
      device.storages.push({
        key: storageKey,
        name: item.storageName,
        path: item.storagePath,
        uri: item.uri
      });
    }
  }
  return [...grouped.values()];
}

// Best-effort recovery for a device gio didn't report a usable mount_path
// for: look for a matching directory under the live GVfs mount root. This
// must stay async (fs.promises), never fs.readdirSync/fs.existsSync -- it
// lists the real, live MTP/FUSE mount, and a slow or wedged MTP session (a
// locked phone, one mid-transfer, or one that just dropped out) can leave a
// *synchronous* call to it blocking for many seconds. Since device discovery
// runs on Electron's single main process, a synchronous stall here used to
// freeze the entire app, not just the device list.
async function attachGvfsMountPaths(devices) {
  const gvfsRoot = path.join('/run/user', String(process.getuid?.() || ''), 'gvfs');
  let gvfsEntries = [];
  try { gvfsEntries = await fsp.readdir(gvfsRoot, { withFileTypes: true }); } catch {}
  const candidates = gvfsEntries.filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith('mtp:'));
  for (const device of devices) {
    if (device.mountPath && await fsp.access(device.mountPath).then(() => true, () => false)) continue;
    const host = device.id.startsWith('mtp://') ? device.id.slice('mtp://'.length) : '';
    // Only fall back to "the one mounted MTP directory" when there is
    // exactly one candidate: with two or more real phones connected, picking
    // an arbitrary candidate here would silently wire a device object to a
    // different phone's actual storage path.
    const match = candidates.find(entry => {
      const decoded = entry.name.replace(/%20/g, ' ');
      return host && decoded.includes(host);
    }) || candidates.find(entry => entry.name.includes(device.name.replace(/\s+/g, '_'))) || (candidates.length === 1 ? candidates[0] : null);
    if (match) device.mountPath = path.join(gvfsRoot, match.name);
  }
  return devices;
}

async function inspectStorageRoots(device) {
  if (!device?.mountPath || !fs.existsSync(device.mountPath)) return device;
  let existing = Array.isArray(device.storages) ? device.storages.slice() : [];
  try {
    const entries = await fsp.readdir(device.mountPath, { withFileTypes: true });
    let foundRealStorage = false;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name || entry.name === '.' || entry.name === '..') continue;
      foundRealStorage = true;
      if (!existing.some(storage => storage.path === entry.name)) {
        existing.push({ key: entry.name, name: entry.name, path: entry.name, uri: null });
      }
    }
    // GIO's own Mount() line (before any real storage folder is known) becomes
    // a placeholder storage entry with an empty path, meaning "write directly
    // at the device's MTP root". Android's MTP responder rejects mkdir/write
    // at that root (EACCES) -- every real transfer must target a folder
    // inside an actual storage volume (e.g. "Internal storage" or "SD_Card").
    // Once real storage folders are discovered, drop the placeholder so it
    // can never be selected and silently fail every transfer with
    // "permission denied" on the very first mkdir.
    if (foundRealStorage) existing = existing.filter(storage => storage.path);
  } catch {}
  device.storages = existing;
  return device;
}

async function gioList() {
  if (process.platform !== 'linux') return '';
  try {
    const result = await execFileAsync('gio', ['mount', '-li'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return result.stdout || '';
  } catch (error) {
    const output = `${error?.stdout || ''}\n${error?.stderr || ''}`;
    if (/not found|ENOENT/i.test(String(error?.message || '') + output)) {
      throw new Error('GVfs (gio) is not installed. Android/MTP device sync requires the standard GNOME GVfs tools.');
    }
    return output;
  }
}

async function refreshDevices({ autoMount = true } = {}) {
  if (process.platform !== 'linux') return { supported: false, devices: [], reason: 'Android/MTP device sync is currently supported on Linux.' };
  const output = await gioList();
  let devices = await attachGvfsMountPaths(parseGioVolumes(output));
  if (autoMount) {
    const mountTargets = devices.flatMap(device => (device.storages || []).map(storage => storage.uri).filter(Boolean));
    for (const uri of mountTargets) {
      try { await execFileAsync('gio', ['mount', uri], { timeout: 10000, maxBuffer: 256 * 1024 }); } catch {}
    }
    try { devices = await attachGvfsMountPaths(parseGioVolumes(await gioList())); } catch {}
  }
  for (const device of devices) await inspectStorageRoots(device);
  return {
    supported: true,
    devices: devices.map(device => ({ ...device, mounted: !!(device.mountPath && fs.existsSync(device.mountPath)) }))
  };
}

function normalizeDeviceRelativePath(value) {
  const raw = String(value || '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!raw) return '';
  const parts = raw.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Invalid Android destination path.');
  return parts.join('/');
}

function devicePath(device, relative) {
  const root = path.resolve(String(device?.mountPath || ''));
  const safeRelative = normalizeDeviceRelativePath(relative);
  const target = path.resolve(root, ...safeRelative.split('/'));
  if (!root || !target.startsWith(`${root}${path.sep}`) && target !== root) throw new Error('Invalid Android device path.');
  return target;
}

async function ensureDirectory(target) {
  await fsp.mkdir(target, { recursive: true });
}

async function copyWithProgress(source, destination, onProgress) {
  const stat = await fsp.stat(source);
  await ensureDirectory(path.dirname(destination));
  await new Promise((resolve, reject) => {
    let copied = 0;
    const input = fs.createReadStream(source);
    const output = fs.createWriteStream(destination, { flags: 'w' });
    const fail = error => { input.destroy(); output.destroy(); reject(error); };
    input.on('data', chunk => { copied += chunk.length; onProgress?.(copied, stat.size); });
    input.on('error', fail);
    output.on('error', fail);
    output.on('close', resolve);
    input.pipe(output);
  });
  try { await fsp.chmod(destination, stat.mode & 0o777); } catch {}
}

async function sendTracksToDevice(device, tracks, { onProgress } = {}) {
  if (!device?.mountPath || !fs.existsSync(device.mountPath)) throw new Error('The Android device is not mounted. Unlock the phone, choose File Transfer (MTP), and refresh Devices.');
  const items = Array.isArray(tracks) ? tracks.filter(track => track?.path && isAudioFile(track.path)) : [];
  if (!items.length) return { copied: [], skipped: [], failed: [], totalBytes: 0 };
  const copied = [], skipped = [], failed = [];
  let completedBytes = 0;
  const totalBytes = (await Promise.all(items.map(async track => { try { return (await fsp.stat(track.path)).size; } catch { return 0; } }))).reduce((sum, value) => sum + value, 0);
  for (const track of items) {
    const source = path.resolve(String(track.path));
    const stat = await fsp.stat(source).catch(() => null);
    if (!stat?.isFile()) { failed.push({ path: source, error: 'Source file is unavailable.' }); continue; }
    const artist = cleanName(track.artist, 'Unknown Artist');
    const album = cleanName(track.album, 'Unknown Album');
    const fileName = cleanName(path.basename(source, path.extname(source)), 'Track') + path.extname(source).toLowerCase();
    const base = normalizeDeviceRelativePath(device?.destinationPath || 'Music');
    const relative = path.posix.join(base || 'Music', artist, album, fileName);
    const destination = devicePath(device, relative);
    try {
      if (fs.existsSync(destination)) {
        const existing = await fsp.stat(destination).catch(() => null);
        if (existing?.size === stat.size) {
          skipped.push({ path: source, destination: relative, reason: 'Already on device' });
          completedBytes += stat.size;
          onProgress?.({ completedFiles: copied.length + skipped.length, totalFiles: items.length, completedBytes, totalBytes, track, skipped: true });
          continue;
        }
      }
      await copyWithProgress(source, destination, (copiedForFile) => {
        onProgress?.({ completedFiles: copied.length + skipped.length, totalFiles: items.length, completedBytes: completedBytes + copiedForFile, totalBytes, track, skipped: false });
      });
      copied.push({ path: source, destination: relative });
      completedBytes += stat.size;
      onProgress?.({ completedFiles: copied.length + skipped.length, totalFiles: items.length, completedBytes, totalBytes, track, skipped: false });
    } catch (error) {
      failed.push({ path: source, destination: relative, error: error?.message || String(error) });
    }
  }
  return { copied, skipped, failed, totalBytes };
}

module.exports = { refreshDevices, sendTracksToDevice, parseGioVolumes, isAudioFile, normalizeDeviceRelativePath, inspectStorageRoots, attachGvfsMountPaths };
