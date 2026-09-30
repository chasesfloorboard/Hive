'use strict';

// Self-updater for Hive's portable builds: the Windows zip and the Linux
// tarball. electron-updater only handles installer builds (it needs the
// app-update.yml an NSIS/AppImage build carries), so on these builds its
// "Check for updates" could only ever fail. This object mimics the slice of
// electron-updater's autoUpdater API that update-checker.js uses -- the same
// events and the same three methods -- so the Settings > About flow is
// unchanged: Check -> Download update -> Restart & install.
//
// Updating never touches user data. A release archive contains only app files,
// and the installer script swaps in exactly the top-level entries the new
// package has, skipping PROTECTED_NAMES even if a package ever shipped one. The
// data folders (Hive Data, User Data Backup, Hive Wrapped Data, logs) sit
// beside the app files and are left exactly where they are. Each replaced
// entry is moved to a backup first and restored if any step fails.
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PROTECTED_NAMES = ['Hive Data', 'User Data Backup', 'Hive Wrapped Data', 'logs', 'data', 'node_modules', '.git', '.hive-update', '.beehive-installed'];
const UPDATE_DIR_NAME = '.hive-update';

function parseVersion(value) {
  const m = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

// Semver precedence, enough for Hive's tags: numeric core first, then a
// release outranks any prerelease of the same core.
function compareVersions(a, b) {
  const va = parseVersion(a), vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) if (va.parts[i] !== vb.parts[i]) return va.parts[i] > vb.parts[i] ? 1 : -1;
  if (va.pre === vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  return va.pre > vb.pre ? 1 : -1;
}

function assetPatternFor(platform) {
  if (platform === 'win32') return /-Win-x64\.zip$/i;
  if (platform === 'linux') return /-Linux\.tar\.gz$/i;
  return null;
}

const WINDOWS_INSTALL_SCRIPT = String.raw`param([int]$HivePid, [string]$InstallRoot, [string]$PackageRoot, [string]$UpdateDir)
$ErrorActionPreference = 'Stop'
$LogPath = Join-Path $UpdateDir 'install.log'
function Log([string]$m) { Add-Content -LiteralPath $LogPath -Value ('[' + (Get-Date -Format o) + '] ' + $m) }
function Retry([scriptblock]$action) {
  for ($i = 1; $i -le 40; $i++) {
    try { & $action; return } catch { if ($i -eq 40) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
$protected = @(__PROTECTED__)
Log "waiting for Hive (pid $HivePid) to exit"
try { Wait-Process -Id $HivePid -Timeout 120 -ErrorAction SilentlyContinue } catch {}
# The playback helper and Python worker run from inside the install too.
for ($i = 0; $i -lt 60; $i++) {
  $busy = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path.StartsWith($InstallRoot, [StringComparison]::OrdinalIgnoreCase) } catch { $false } })
  if ($busy.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
$backup = Join-Path $UpdateDir 'backup'
if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$moved = @()
$ok = $false
try {
  foreach ($item in @(Get-ChildItem -LiteralPath $PackageRoot -Force)) {
    if ($protected -contains $item.Name) { Log "skipping protected $($item.Name)"; continue }
    $target = Join-Path $InstallRoot $item.Name
    if (Test-Path -LiteralPath $target) { Retry { Move-Item -LiteralPath $target -Destination (Join-Path $backup $item.Name) } }
    $moved += $item.Name
    Retry { Move-Item -LiteralPath $item.FullName -Destination $target }
  }
  $ok = $true
  Log 'update installed'
} catch {
  Log ('update failed, restoring previous version: ' + $_)
  foreach ($name in $moved) {
    $target = Join-Path $InstallRoot $name
    $saved = Join-Path $backup $name
    if (Test-Path -LiteralPath $saved) {
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
      Move-Item -LiteralPath $saved -Destination $target
    }
  }
}
if ($ok) {
  foreach ($leftover in @('backup', 'staging', 'download')) {
    Remove-Item -LiteralPath (Join-Path $UpdateDir $leftover) -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Start-Process -FilePath (Join-Path $InstallRoot 'Hive.exe') -WorkingDirectory $InstallRoot
`;

const LINUX_INSTALL_SCRIPT = String.raw`#!/usr/bin/env bash
hive_pid="$1"; install_root="$2"; package_root="$3"; update_dir="$4"
exec >>"$update_dir/install.log" 2>&1
log() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
protected=(__PROTECTED__)
is_protected() { local p; for p in "${'$'}{protected[@]}"; do [[ "$1" == "$p" ]] && return 0; done; return 1; }
log "waiting for Hive (pid $hive_pid) to exit"
for _ in $(seq 1 240); do kill -0 "$hive_pid" 2>/dev/null || break; sleep 0.5; done
sleep 1
# The dependency fingerprint ignores Hive's own version, which every release
# bumps in package-lock.json, so only real dependency changes reinstall.
lock_hash() {
  [[ -f "$1" ]] || return 0
  node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));delete l.version;if(l.packages&&l.packages[""])delete l.packages[""].version;process.stdout.write(require("crypto").createHash("sha256").update(JSON.stringify(l)).digest("hex"))' "$1" 2>/dev/null || sha256sum -- "$1" | cut -d' ' -f1
}
old_lock="$(lock_hash "$install_root/package-lock.json")"
backup="$update_dir/backup"
rm -rf -- "$backup"; mkdir -p -- "$backup"
moved=()
ok=1
shopt -s dotglob nullglob
for item in "$package_root"/*; do
  name="$(basename -- "$item")"
  if is_protected "$name"; then log "skipping protected $name"; continue; fi
  target="$install_root/$name"
  if [[ -e "$target" || -L "$target" ]]; then mv -- "$target" "$backup/$name" || { ok=0; break; }; fi
  moved+=("$name")
  mv -- "$item" "$target" || { ok=0; break; }
done
if (( ok )); then
  log "update installed"
  new_lock="$(lock_hash "$install_root/package-lock.json")"
  if [[ "$old_lock" != "$new_lock" || ! -x "$install_root/node_modules/electron/dist/electron" ]]; then
    log "dependencies changed; reinstalling them"
    rm -f -- "$install_root/.beehive-installed"
    (cd -- "$install_root" && HIVE_INSTALL_NO_LAUNCH=1 bash ./install.sh </dev/null) || log "dependency reinstall failed"
  fi
  rm -rf -- "$backup" "$update_dir/staging" "$update_dir/download"
else
  log "update failed, restoring previous version"
  for name in "${'$'}{moved[@]}"; do
    rm -rf -- "$install_root/$name"
    [[ -e "$backup/$name" || -L "$backup/$name" ]] && mv -- "$backup/$name" "$install_root/$name"
  done
fi
cd -- "$install_root" && setsid ./run.sh >/dev/null 2>&1 < /dev/null &
`;

// PowerShell arrays are comma-separated; bash arrays are space-separated (a
// comma there would become part of each name, so nothing would match).
const powershellList = names => names.map(n => `'${n.replace(/'/g, "''")}'`).join(', ');
const bashList = names => names.map(n => `'${n.replace(/'/g, `'\\''`)}'`).join(' ');

function createPortableUpdater(deps) {
  const {
    platform = process.platform,
    currentVersion,
    installRoot,
    owner,
    repo,
    feedUrl = '',
    fetchImpl = globalThis.fetch,
    spawn = require('child_process').spawn,
    quit = () => {},
    pid = process.pid,
  } = deps;

  const updater = new EventEmitter();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  let available = null;
  let downloaded = null;
  const root = () => path.resolve(typeof installRoot === 'function' ? installRoot() : installRoot);
  const updateDir = () => path.join(root(), UPDATE_DIR_NAME);

  function fail(message) {
    const err = new Error(message);
    updater.emit('error', err);
    throw err;
  }

  function unsupportedReason() {
    if (!assetPatternFor(platform)) return 'Updates are not available on this platform.';
    if (fs.existsSync(path.join(root(), '.git'))) return 'This copy of Hive is a git checkout. Update it with git instead.';
    return '';
  }

  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update');
    const reason = unsupportedReason();
    if (reason) fail(reason);
    const url = feedUrl || `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    let release;
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Hive-Updater' } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      release = await res.json();
    } catch (err) {
      fail(`Could not reach GitHub (${err?.message || err}).`);
    }
    const version = String(release?.tag_name || '').replace(/^v/i, '');
    const asset = (release?.assets || []).find(a => assetPatternFor(platform).test(String(a?.name || '')));
    if (!parseVersion(version) || compareVersions(version, currentVersion) <= 0 || !asset) {
      available = null;
      const info = { version: currentVersion };
      updater.emit('update-not-available', info);
      return { updateInfo: info };
    }
    available = {
      version,
      releaseName: release.name || `Hive ${version}`,
      releaseNotes: release.body || '',
      assetName: asset.name,
      assetUrl: asset.browser_download_url,
      size: Number(asset.size) || 0,
    };
    updater.emit('update-available', available);
    return { updateInfo: available };
  };

  async function extract(archive, dest) {
    await fsp.mkdir(dest, { recursive: true });
    const run = (cmd, args) => new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}`))));
    });
    if (platform === 'win32') {
      // tar.exe ships with Windows 10 1803+ and unpacks zips far faster than
      // PowerShell; Expand-Archive is the fallback for anything older.
      const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      try { await run(tarExe, ['-xf', archive, '-C', dest]); return; } catch {}
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]);
    } else {
      await run('tar', ['-xzf', archive, '-C', dest]);
    }
  }

  // The archive holds one top-level folder (Hive\ in the zip, hive-<version>/
  // in the tarball); that folder's contents are the new install.
  async function findPackageRoot(staging, expectedVersion) {
    const entries = (await fsp.readdir(staging, { withFileTypes: true })).filter(e => e.isDirectory());
    if (entries.length !== 1) throw new Error('The downloaded update has an unexpected layout.');
    const packageRoot = path.join(staging, entries[0].name);
    const pkgJson = platform === 'win32'
      ? path.join(packageRoot, 'resources', 'app', 'package.json')
      : path.join(packageRoot, 'package.json');
    const launcher = platform === 'win32' ? path.join(packageRoot, 'Hive.exe') : path.join(packageRoot, 'run.sh');
    let version = '';
    try { version = JSON.parse(await fsp.readFile(pkgJson, 'utf8')).version; } catch {}
    if (!fs.existsSync(launcher) || version !== expectedVersion) throw new Error('The downloaded update is incomplete or is not the expected version.');
    return packageRoot;
  }

  updater.downloadUpdate = async () => {
    if (!available) fail('No update is available to download.');
    const info = available;
    const dir = updateDir();
    const downloadDir = path.join(dir, 'download');
    const staging = path.join(dir, 'staging');
    try {
      await fsp.rm(downloadDir, { recursive: true, force: true });
      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(downloadDir, { recursive: true });
      const archive = path.join(downloadDir, info.assetName);
      const res = await fetchImpl(info.assetUrl, { headers: { 'User-Agent': 'Hive-Updater' } });
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
      const total = Number(res.headers?.get?.('content-length')) || info.size || 0;
      let transferred = 0;
      let lastEmit = 0;
      const body = typeof res.body.getReader === 'function' ? Readable.fromWeb(res.body) : res.body;
      body.on('data', chunk => {
        transferred += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 250) {
          lastEmit = now;
          updater.emit('download-progress', { transferred, total, percent: total ? (transferred / total) * 100 : 0 });
        }
      });
      await pipeline(body, fs.createWriteStream(archive));
      if (total && transferred !== total) throw new Error('download was incomplete');
      updater.emit('download-progress', { transferred, total, percent: 100 });
      await extract(archive, staging);
      const packageRoot = await findPackageRoot(staging, info.version);
      downloaded = { ...info, packageRoot };
      updater.emit('update-downloaded', info);
      return [archive];
    } catch (err) {
      fail(`Could not download the update: ${err?.message || err}`);
    }
  };

  updater.quitAndInstall = () => {
    if (!downloaded) { updater.emit('error', new Error('No downloaded update to install.')); return; }
    const dir = updateDir();
    let command, args;
    if (platform === 'win32') {
      const script = path.join(dir, 'install-update.ps1');
      fs.writeFileSync(script, WINDOWS_INSTALL_SCRIPT.replace('__PROTECTED__', powershellList(PROTECTED_NAMES)), 'utf8');
      command = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
        '-HivePid', String(pid), '-InstallRoot', root(), '-PackageRoot', downloaded.packageRoot, '-UpdateDir', dir];
    } else {
      const script = path.join(dir, 'install-update.sh');
      fs.writeFileSync(script, LINUX_INSTALL_SCRIPT.replace('__PROTECTED__', bashList(PROTECTED_NAMES)), { encoding: 'utf8', mode: 0o755 });
      command = 'bash';
      args = [script, String(pid), root(), downloaded.packageRoot, dir];
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    quit();
  };

  return updater;
}

module.exports = { createPortableUpdater, compareVersions, PROTECTED_NAMES, UPDATE_DIR_NAME, powershellList, bashList };
