const { app, BrowserWindow, protocol, net, ipcMain, dialog, clipboard, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { fork, spawn, execFileSync, execFile } = require('child_process');
const { readWavMusicBeeLove: readSharedWavMusicBeeLove, readWavMusicBeePopmRaw: readSharedWavMusicBeePopmRaw } = require('./wav-id3');
const { createClient: createMusicBrainzClient } = require('./musicbrainz');
const { canonicalize } = require('./canonical-metadata');
const { normalizeText: normalizeArtworkText, scoreResult: scoreArtworkResult, createArtworkCache, providers: artworkProviders } = require('./artwork-providers');
const { TaskManager } = require('./task-manager');
const { DiscordRichPresence } = require('./discord-presence');
const { BeehiveMPRIS } = require('./mpris');
const { runSecurityAudit, runLibraryHealth, runEnvironmentAudit } = require('./beta-diagnostics');

// Optional startup profiler. It is completely inert unless Beehive is launched
// with --startup-debug (or BEEHIVE_STARTUP_DEBUG=1). The profiler records the
// main-process timeline, renderer milestones, event-loop stalls, Electron
// process metrics, and every child process Beehive launches during startup.
// This is intentionally separate from normal crash logging so production
// launches do not pay the diagnostic I/O cost.
const STARTUP_DEBUG_ENABLED = process.argv.includes('--startup-debug') || process.env.BEEHIVE_STARTUP_DEBUG === '1';
const STARTUP_DEBUG_STARTED_AT = process.hrtime.bigint();
let startupDebugTimer = null;
let startupDebugStopped = false;
const startupTrackedChildren = new Map();
function beehiveLogDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, 'Logs', 'BeehiveMusicBrainz');
}
function ensureBeehiveLogDir() { try { fs.mkdirSync(beehiveLogDir(), { recursive:true, mode:0o700 }); } catch {} }
function startupDebugPath() { return path.join(beehiveLogDir(), 'startup-debug.jsonl'); }
function startupDebug(label, details = null) {
  if (!STARTUP_DEBUG_ENABLED) return;
  const now = process.hrtime.bigint();
  const event = {
    ts: new Date().toISOString(),
    tMs: Number(now - STARTUP_DEBUG_STARTED_AT) / 1e6,
    pid: process.pid,
    label,
    details,
    memory: (() => { try { const m = process.memoryUsage(); return { rss:m.rss, heapUsed:m.heapUsed, heapTotal:m.heapTotal, external:m.external }; } catch { return null; } })()
  };
  const line = JSON.stringify(event) + '\n';
  try { fs.appendFileSync(startupDebugPath(), line); } catch {}
  try { process.stderr.write(`[Beehive Startup ${event.tMs.toFixed(1)}ms] ${label}${details == null ? '' : ` ${JSON.stringify(details)}`}\n`); } catch {}
}
function startupTrackedSnapshot() {
  return [...startupTrackedChildren.values()].map(x => ({ ...x }));
}
function startupDebugAppMetrics() {
  if (!STARTUP_DEBUG_ENABLED) return;
  let metrics = [];
  try { metrics = app.getAppMetrics().map(m => ({ type:m.type, pid:m.pid, name:m.name, cpu:m.cpu?.percent, rss:m.memory?.workingSetSize, creationTime:m.creationTime })); } catch {}
  startupDebug('PROCESS SNAPSHOT', { trackedChildren: startupTrackedSnapshot(), appMetrics: metrics });
}
function startStartupProfiler() {
  if (!STARTUP_DEBUG_ENABLED || startupDebugTimer) return;
  try { fs.mkdirSync(path.dirname(startupDebugPath()), { recursive:true }); } catch {}
  try { fs.writeFileSync(startupDebugPath(), ''); } catch {}
  startupDebug('STARTUP DEBUG ENABLED', { argv:process.argv, node:process.version, electron:process.versions.electron, platform:process.platform, arch:process.arch });
  let last = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const drift = now - last - 250;
    last = now;
    if (drift > 75) startupDebug('MAIN EVENT LOOP STALL', { delayMs:Number(drift.toFixed(1)) });
    startupDebugAppMetrics();
  }, 250);
  lagTimer.unref?.();
  startupDebugTimer = setTimeout(() => {
    clearInterval(lagTimer);
    startupDebug('STARTUP PROFILER WINDOW COMPLETE', { durationMs:Number((performance.now()).toFixed(1)), trackedChildren:startupTrackedSnapshot() });
    startupDebugStopped = true;
  }, 20000);
  startupDebugTimer.unref?.();
}
function stopStartupProfiler(reason='manual') {
  if (!STARTUP_DEBUG_ENABLED || startupDebugStopped) return;
  startupDebug('STARTUP DEBUG STOPPED', { reason, trackedChildren:startupTrackedSnapshot() });
  startupDebugStopped = true;
  if (startupDebugTimer) { clearTimeout(startupDebugTimer); startupDebugTimer = null; }
}
function spawnTracked(command, args = [], options = {}) {
  const child = spawn(command, args, options);
  if (STARTUP_DEBUG_ENABLED) {
    const key = `${child.pid}:${command}`;
    startupTrackedChildren.set(key, { pid:child.pid, kind:'spawn', command:String(command), args:(args||[]).map(String), startedMs:Number((Number(process.hrtime.bigint()-STARTUP_DEBUG_STARTED_AT)/1e6).toFixed(1)), state:'running' });
    startupDebug('CHILD SPAWN', startupTrackedChildren.get(key));
    child.on('exit', (code, signal) => { const item=startupTrackedChildren.get(key); if(item){ item.state='exited'; item.code=code; item.signal=signal; item.endedMs=Number((Number(process.hrtime.bigint()-STARTUP_DEBUG_STARTED_AT)/1e6).toFixed(1)); } startupDebug('CHILD EXIT', item || {pid:child.pid,command}); });
  }
  return child;
}
function forkTracked(modulePath, args = [], options = {}) {
  const child = fork(modulePath, args, options);
  if (STARTUP_DEBUG_ENABLED) {
    const key = `${child.pid}:fork:${modulePath}`;
    startupTrackedChildren.set(key, { pid:child.pid, kind:'fork', module:String(modulePath), args:(args||[]).map(String), startedMs:Number((Number(process.hrtime.bigint()-STARTUP_DEBUG_STARTED_AT)/1e6).toFixed(1)), state:'running' });
    startupDebug('CHILD FORK', startupTrackedChildren.get(key));
    child.on('exit', (code, signal) => { const item=startupTrackedChildren.get(key); if(item){ item.state='exited'; item.code=code; item.signal=signal; item.endedMs=Number((Number(process.hrtime.bigint()-STARTUP_DEBUG_STARTED_AT)/1e6).toFixed(1)); } startupDebug('CHILD EXIT', item || {pid:child.pid,module:modulePath}); });
  }
  return child;
}
startStartupProfiler();

// Crash diagnostics: keep failures visible in the terminal and in a small local
// log without changing normal playback behavior. Electron exposes renderer and
// child-process termination through render-process-gone/child-process-gone.
const CRASH_DEBUG_PATH = () => path.join(beehiveLogDir(), 'beehive-crash-debug.log');
function crashDebug(label, details) {
  const line = `[Beehive Debug ${new Date().toISOString()}] ${label}${details == null ? '' : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`}\n`;
  try { process.stderr.write(line); } catch {}
  try { ensureBeehiveLogDir(); fs.appendFileSync(CRASH_DEBUG_PATH(), line); } catch {}
}
process.on('uncaughtException', err => crashDebug('MAIN uncaughtException', { message: err?.message, stack: err?.stack }));
process.on('unhandledRejection', reason => crashDebug('MAIN unhandledRejection', { reason: reason?.stack || reason?.message || String(reason) }));

// Optional native GStreamer playback backend. GStreamer owns the actual audio
// sink, clock, buffering, seeking and gapless transition; Electron only sends
// transport commands and receives lightweight events.
let gstreamerProcess = null;
let gstreamerReady = false;
let gstreamerCompileAttempted = false;
let gstreamerRuntimeReady = false;
let gstreamerShuttingDown = false;
let gstreamerEventBuffer = '';
let gstreamerReadyWaiters = [];
function gstreamerHelperSource() { return path.join(__dirname, 'gstreamer-player.c'); }
function gstreamerHelperBinary() { return path.join(USER_DATA(), 'beehive-gstreamer-player'); }
function ensureGstreamerHelper() {
  if (process.platform !== 'linux') return false;
  if (gstreamerCompileAttempted) return !!gstreamerReady;
  gstreamerCompileAttempted = true;
  try {
    const source = gstreamerHelperSource();
    if (!fs.existsSync(source)) return false;
    const out = gstreamerHelperBinary();
    let rebuild = !fs.existsSync(out);
    if (!rebuild) rebuild = fs.statSync(out).mtimeMs < fs.statSync(source).mtimeMs;
    if (rebuild) {
      const cflags = execFileSync('pkg-config', ['--cflags', 'gstreamer-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
      const libs = execFileSync('pkg-config', ['--libs', 'gstreamer-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
      execFileSync('cc', [source, '-O2', '-o', out, ...cflags, ...libs, '-pthread'], { stdio: 'ignore' });
      fs.chmodSync(out, 0o755);
    }
    gstreamerReady = true;
    return true;
  } catch (err) {
    gstreamerReady = false;
    try { console.warn('[Beehive] GStreamer backend unavailable:', err.message); } catch {}
    return false;
  }
}
function startGstreamerProcess() {
  if (!ensureGstreamerHelper()) return false;
  if (gstreamerProcess && !gstreamerProcess.killed) return true;
  try {
    gstreamerEventBuffer = '';
    gstreamerRuntimeReady = false;
    gstreamerProcess = spawnTracked(gstreamerHelperBinary(), [], { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
    // Audio playback should not compete with interactive applications such as
    // Discord when they are doing CPU-side video work (e.g. hardware acceleration
    // disabled). Keep the GStreamer helper below normal scheduling priority while
    // leaving Beehive's UI/main process responsive. This also lowers the priority
    // inherited by GStreamer's decoder/audio helper threads on Linux.
    try { if (typeof process.setPriority === 'function' && gstreamerProcess.pid) process.setPriority(gstreamerProcess.pid, 10); } catch {}
    gstreamerProcess.stdio[2].on('data', chunk => {
      const text = chunk.toString('utf8').trim();
      if (text) crashDebug('GSTREAMER stderr', text);
    });
    gstreamerProcess.stdio[3].on('data', chunk => {
      gstreamerEventBuffer += chunk.toString('utf8');
      let idx;
      while ((idx = gstreamerEventBuffer.indexOf('\n')) >= 0) {
        const line = gstreamerEventBuffer.slice(0, idx).replace(/\r$/, '');
        gstreamerEventBuffer = gstreamerEventBuffer.slice(idx + 1);
        const tab = line.indexOf('\t');
        const name = tab >= 0 ? line.slice(0, tab) : line;
        const value = tab >= 0 ? line.slice(tab + 1) : '';
        if (name === 'READY') {
          gstreamerRuntimeReady = true;
          const waiters = gstreamerReadyWaiters.splice(0);
          waiters.forEach(resolve => resolve(true));
        }
        if (name === 'ERROR' && !gstreamerRuntimeReady) {
          const waiters = gstreamerReadyWaiters.splice(0);
          waiters.forEach(resolve => resolve(false));
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          try { mainWindow.webContents.send('gstreamer:event', { name, value }); } catch {}
        }
      }
    });
    gstreamerProcess.on('exit', (code, signal) => {
      crashDebug('GSTREAMER exit', { code, signal });
      gstreamerProcess = null;
      gstreamerRuntimeReady = false;
    });
    return true;
  } catch (err) {
    try { console.warn('[Beehive] Failed to start GStreamer helper:', err.message); } catch {}
    gstreamerProcess = null;
    return false;
  }
}
async function gstreamerStatus() {
  if (!startGstreamerProcess()) return false;
  if (gstreamerRuntimeReady) return true;
  return await new Promise(resolve => {
    gstreamerReadyWaiters.push(resolve);
    setTimeout(() => {
      const i = gstreamerReadyWaiters.indexOf(resolve);
      if (i >= 0) gstreamerReadyWaiters.splice(i, 1);
      resolve(!!gstreamerRuntimeReady);
    }, 1500);
  });
}
function sendGstreamerCommand(command) {
  if (!startGstreamerProcess() || !gstreamerProcess?.stdin?.writable) return false;
  try { gstreamerProcess.stdin.write(String(command).replace(/\n/g, '') + '\n'); return true; } catch { return false; }
}

// Give large 20k+ library scans more V8 heap headroom and expose GC for
// periodic cleanup of temporary metadata/artwork parser objects.
// Chromium VSync/presentation timing is currently producing repeated
// GLSurfacePresentationHelper GetVSyncParametersIfAvailable() failures on the
// target Linux desktop. Disable GPU VSync so Chromium does not wait for the
// problematic display-vblank synchronization path. This is independent of
// GStreamer and does not change native audio transport.
// Linux Chromium presentation compatibility: the target desktop is showing repeated
// GetVSyncParametersIfAvailable() failures and startup hitches. Force the Electron
// renderer onto X11's presentation path and disable GPU-vblank synchronization.
// This is a graphics/compositor workaround only; GStreamer/native audio is untouched.
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-features', 'UseOzonePlatform');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192 --expose-gc');

const USER_DATA = () => app.getPath('userData');
const MUSICBRAINZ_CACHE_PATH = () => path.join(USER_DATA(), 'musicbrainz-cache.json');
let musicBrainzClient;
const CONFIG_PATH = () => path.join(USER_DATA(), 'config.json');
const discordPresence = new DiscordRichPresence({
  getConfigPath: CONFIG_PATH,
  appName: 'Hive'
});


const mpris = new BeehiveMPRIS({
  userData: USER_DATA,
  sendCommand: command => {
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mpris:command', String(command || '')); } catch {}
  }
});
let mprisTrackPath = '';

// GPU acceleration is a process-start setting in Electron. Read the persisted
// preference before app.whenReady() so it can be applied early enough for the
// next launch. This does not touch the native GStreamer playback process.
function gpuAccelerationDisabledAtStartup() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8');
    const config = JSON.parse(raw);
    return config && config.disableGpuAcceleration === true;
  } catch {
    return false;
  }
}
if (gpuAccelerationDisabledAtStartup()) {
  try { app.disableHardwareAcceleration(); } catch (err) { console.warn('[Beehive] Could not disable hardware acceleration:', err.message); }
}

const COVERS_DIR = () => path.join(USER_DATA(), 'covers');
const LIBRARY_CACHE_PATH = () => path.join(USER_DATA(), 'library.json');
const LIBRARY_CACHE_GZIP_PATH = () => path.join(USER_DATA(), 'library.json.gz');
const HISTORY_PATH = () => path.join(USER_DATA(), 'history.json');
const STATS_PATH = () => path.join(USER_DATA(), 'play-stats.json');
const PLAYLISTS_PATH = () => path.join(USER_DATA(), 'playlists.json');
const SCAN_LOG_PATH = () => path.join(beehiveLogDir(), 'scan-live.log');
// Small renderer-owned session snapshot. This is intentionally separate from
// library metadata/play statistics so playback recovery can be updated often.
const PLAYBACK_STATE_PATH = () => path.join(USER_DATA(), 'playback-state.json');
// One-time migration: discard only Hive's derived library cache/database records
// so beta.6 can perform a genuinely cold first library scan. User configuration,
// playlists, playback state, and the music files themselves are never removed.
const LIBRARY_COLD_START_RESET_VERSION = 1;
const DATABASE_PATH = () => path.join(USER_DATA(), 'beehive.db');
let databaseProcess = null;
let databaseReady = false;
let databaseSeq = 0;
const databasePending = new Map();
let recoveredMetadataJobs = [];
const taskManager = new TaskManager();
let artworkCacheManager = null;

function startDatabaseWorker() {
  if (databaseProcess && !databaseProcess.killed) return;
  const worker = path.join(__dirname, 'database-worker.py');
  databaseProcess = spawnTracked(process.env.BEEHIVE_PYTHON || 'python3', [worker, DATABASE_PATH()], { stdio: ['pipe','pipe','pipe'] });
  try { if (databaseProcess.pid) process.setPriority(databaseProcess.pid, 15); } catch {}
  let buffer = '';
  databaseProcess.stdout.on('data', chunk => {
    buffer += String(chunk || '');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const pending = databasePending.get(String(msg.id));
        if (!pending) continue;
        databasePending.delete(String(msg.id));
        if (msg.ok) pending.resolve(msg.result); else pending.reject(new Error(msg.error || 'Database worker error'));
      } catch (err) { crashDebug('DATABASE invalid response', { message: err.message }); }
    }
  });
  databaseProcess.stderr.on('data', chunk => { const text=String(chunk||'').trim(); if(text) crashDebug('DATABASE worker stderr', text); });
  databaseProcess.on('exit', () => {
    for (const pending of databasePending.values()) pending.reject(new Error('Database worker exited.'));
    databasePending.clear(); databaseProcess = null; databaseReady = false;
  });
  databaseReady = true;
}
function databaseRequest(cmd, payload = {}) {
  startDatabaseWorker();
  const id = String(++databaseSeq);
  return new Promise((resolve,reject) => {
    databasePending.set(id,{resolve,reject});
    try { databaseProcess.stdin.write(JSON.stringify({ id, cmd, ...payload })+'\n'); }
    catch (err) { databasePending.delete(id); reject(err); }
  });
}
async function clearLibraryCacheData({ clearCovers = true } = {}) {
  const removed = [];
  for (const target of [LIBRARY_CACHE_PATH(), LIBRARY_CACHE_GZIP_PATH()]) {
    try { await fsp.rm(target, { force: true }); removed.push(target); } catch (err) {
      throw new Error(`Could not clear library cache ${target}: ${err.message}`);
    }
  }
  if (!databaseReady) throw new Error('Library database is not ready; cache reset was not completed.');
  {
    try { await databaseRequest('clear_library'); }
    catch (err) { throw new Error(`Could not clear cached library database: ${err.message}`); }
  }
  if (clearCovers) {
    try {
      const entries = await fsp.readdir(COVERS_DIR(), { withFileTypes: true });
      await Promise.all(entries.map(entry => fsp.rm(path.join(COVERS_DIR(), entry.name), { recursive: true, force: true })));
      removed.push(COVERS_DIR());
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new Error(`Could not clear cached artwork: ${err.message}`);
    }
  }
  scanLog('LIBRARY CACHE CLEARED', { clearCovers, removed: removed.length });
  return { ok: true, removed };
}

async function shouldPerformColdStartReset() {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  return Number(config.libraryColdStartResetVersion || 0) < LIBRARY_COLD_START_RESET_VERSION || config.clearLibraryCacheOnNextLaunch === true;
}

async function markColdStartResetComplete() {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  config.libraryColdStartResetVersion = LIBRARY_COLD_START_RESET_VERSION;
  config.clearLibraryCacheOnNextLaunch = false;
  await writeJsonSafe(CONFIG_PATH(), config);
}

async function initializeDatabase() {
  startDatabaseWorker();
  artworkCacheManager = createArtworkCache(COVERS_DIR());
  try {
    recoveredMetadataJobs = await databaseRequest('recover_jobs');
    databaseReady = true;
  } catch (err) { databaseReady = false; crashDebug('DATABASE initialization failed', { message: err.message }); }
}
async function persistLibraryDatabase(tracks) {
  try { await databaseRequest('replace_library', { tracks: Array.isArray(tracks) ? tracks.map(canonicalize) : [] }); }
  catch (err) { crashDebug('DATABASE library persist failed', { message: err.message }); }
}
async function persistMetadataJob(job, status='queued', attempts=0, lastError='') {
  const payload = { id:String(job.id), status, job, attempts, createdAt:Number(job.createdAt || Date.now()), lastError };
  // A metadata write must never begin unless its recovery journal entry has
  // actually reached SQLite. Swallowing this error would turn the journal into
  // best-effort logging and could leave a partially completed physical write
  // with no durable recovery record after a crash.
  try {
    await databaseRequest('upsert_job', { job:payload });
  } catch (err) {
    crashDebug('DATABASE metadata job persist failed', { message:err.message });
    throw new Error(`Could not make the metadata operation durable: ${err.message}`);
  }
}
async function updateMetadataJob(id,status,attempts,error='') { try { await databaseRequest('update_job',{job_id:String(id),status,attempts,error}); } catch (err) { crashDebug('DATABASE metadata job update failed',{message:err.message}); } }
async function deleteMetadataJob(id) { try { await databaseRequest('delete_job',{job_id:String(id)}); } catch (err) { crashDebug('DATABASE metadata job delete failed',{message:err.message}); } }

function scanLog(message, data = null) {
  const stamp = new Date().toISOString();
  const suffix = data === null || data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  const line = `[${stamp}] ${message}${suffix}`;
  try { console.log(`[Beehive Scan] ${line}`); } catch {}
  try { ensureBeehiveLogDir(); fs.appendFileSync(SCAN_LOG_PATH(), line + '\n', 'utf8'); } catch {}
}


const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.mp4', '.aac', '.wav', '.aiff', '.aif',
  '.ogg', '.oga', '.opus', '.wma', '.asf', '.ape', '.wv', '.mp2', '.mpc',
  '.dsf', '.dff', '.mka', '.mkv', '.webm', '.spx'
]);

let mainWindow;
let mm; // music-metadata, loaded lazily (ESM)

// ---------- protocol registration (must happen before app.ready) ----------
protocol.registerSchemesAsPrivileged([
  { scheme: 'mbfile', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'mbcover', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true } }
]);

function decodePath(url, prefix) {
  return decodeURIComponent(url.slice(prefix.length).replace(/^\/+/, ''));
}

async function readJsonSafe(p, fallback) {
  try {
    const txt = await fsp.readFile(p, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const payload = JSON.stringify(data, null, 2);
  // Never write JSON directly over a live cache file. A concurrent reader can
  // otherwise observe a partially-written JSON document, fall back to `{}`, and
  // a later incremental scan can accidentally replace a full library cache with
  // only the handful of tracks it was refreshing. Write a complete temporary
  // file first and replace the destination only after the new JSON is complete.
  const temp = `${p}.beehive-write-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(temp, payload, 'utf8');
  try {
    await fsp.rename(temp, p);
  } catch (err) {
    // Windows does not allow rename-over-existing-file. Remove the old file only
    // as the platform-specific fallback; the new file itself is already complete.
    if (process.platform === 'win32' && (err?.code === 'EEXIST' || err?.code === 'EPERM')) {
      await fsp.rm(p, { force: true });
      await fsp.rename(temp, p);
    } else {
      throw err;
    }
  } finally {
    try { await fsp.unlink(temp); } catch {}
  }

  // Keep a compact startup transport copy of the library cache. Electron's IPC
  // structured-clone cost grows substantially with a 30k-track object graph;
  // shipping the compressed bytes avoids cloning hundreds of megabytes of
  // duplicated JS objects before the renderer can use them. The plain JSON file
  // remains the canonical human-readable cache and fallback.
  if (p === LIBRARY_CACHE_PATH()) {
    try {
      const compressed = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 1 });
      const gzipPath = LIBRARY_CACHE_GZIP_PATH();
      const gzipTemp = `${gzipPath}.beehive-write-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fsp.writeFile(gzipTemp, compressed);
      try { await fsp.rename(gzipTemp, gzipPath); }
      catch (err) {
        if (process.platform === 'win32' && (err?.code === 'EEXIST' || err?.code === 'EPERM')) {
          await fsp.rm(gzipPath, { force: true });
          await fsp.rename(gzipTemp, gzipPath);
        } else throw err;
      }
      try { await fsp.unlink(gzipTemp); } catch {}
    } catch (err) {
      crashDebug('COMPRESSED LIBRARY CACHE WRITE FAILED', { message: err?.message || String(err) });
    }
  }
}

// Serialize mutations to Beehive's play-stats.json so a clear operation cannot
// race a play/rating write and accidentally restore an old play count.
let statsMutationChain = Promise.resolve();
function withStatsMutation(task) {
  const run = statsMutationChain.then(task, task);
  statsMutationChain = run.catch(() => {});
  return run;
}

async function getMusicBrainzClient() {
  if (!musicBrainzClient) {
    musicBrainzClient = createMusicBrainzClient({ cacheFile: MUSICBRAINZ_CACHE_PATH() });
  }
  return musicBrainzClient;
}

ipcMain.handle('musicbrainz:searchReleaseGroups', async (_evt, query = {}) => {
  const client = await getMusicBrainzClient();
  return client.searchReleaseGroups(query);
});

ipcMain.handle('musicbrainz:identify', async (_evt, query = {}) => {
  const client = await getMusicBrainzClient();
  return client.identify(query);
});

function createWindow() {
  startupDebug('WINDOW CREATE START');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0c0f',
    autoHideMenuBar: true,
    frame: true,
    title: 'Hive',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') { shell.openExternal(url).catch(() => {}); }
    } catch {}
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const current = new URL(mainWindow.webContents.getURL() || 'file:///');
      const next = new URL(url);
      if (next.protocol !== current.protocol || next.href !== current.href) event.preventDefault();
    } catch { event.preventDefault(); }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    let metrics = null;
    try { metrics = app.getAppMetrics().map(m => ({ type: m.type, pid: m.pid, memory: m.memory?.workingSetSize, cpu: m.cpu?.percent })); } catch {}
    crashDebug('RENDERER render-process-gone', { details, processMemory: process.memoryUsage(), appMetrics: metrics });
  });
  mainWindow.webContents.on('unresponsive', () => { crashDebug('RENDERER unresponsive'); startupDebug('RENDERER UNRESPONSIVE'); });
  mainWindow.webContents.on('responsive', () => { crashDebug('RENDERER responsive'); startupDebug('RENDERER RESPONSIVE'); });

  // When Beehive is open but not the foreground app, don't let an otherwise
  // idle Electron renderer consume the same compositor/GPU budget that apps
  // such as Steam need for smooth scrolling. Audio playback is independent of
  // the renderer frame rate, so this does not affect music playback. Restore
  // the normal frame rate as soon as Beehive regains focus.
  try {
    mainWindow.webContents.setFrameRate(30);
    mainWindow.on('focus', () => {
      try { mainWindow.webContents.setFrameRate(60); } catch {}
    });
    mainWindow.on('blur', () => {
      try { mainWindow.webContents.setFrameRate(30); } catch {}
    });
  } catch {}

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (STARTUP_DEBUG_ENABLED) startupDebug('RENDERER CONSOLE', { level, message, line, sourceId });
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    startupDebug('RENDERER PRELOAD ERROR', { preloadPath, error: String(error?.stack || error?.message || error) });
  });
  mainWindow.webContents.on('did-start-loading', () => startupDebug('RENDERER did-start-loading'));
  mainWindow.webContents.on('dom-ready', () => startupDebug('RENDERER dom-ready'));
  mainWindow.webContents.on('did-finish-load', () => startupDebug('RENDERER did-finish-load'));
  mainWindow.webContents.on('did-stop-loading', () => startupDebug('RENDERER did-stop-loading'));
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  startupDebug('WINDOW CREATE COMPLETE', { webContentsId:mainWindow.webContents.id });
}

app.on('child-process-gone', (_event, details) => {
  crashDebug('CHILD PROCESS gone', details);
});

app.on('before-quit', () => {
  startupDebug('APP BEFORE QUIT');
  stopStartupProfiler('before-quit');
  try { mpris.stop(); } catch {}
  gstreamerShuttingDown = true;
  try {
    if (gstreamerProcess && !gstreamerProcess.killed && gstreamerProcess.stdin?.writable) {
      // The GStreamer helper owns a persistent audio pipeline. Explicitly tell
      // it to quit before Electron exits; otherwise an orphaned helper can keep
      // the previous song playing and the next Beehive launch can start a second
      // helper, producing two songs at once.
      gstreamerProcess.stdin.write('QUIT\n');
      gstreamerProcess.stdin.end();
      setTimeout(() => { try { if (gstreamerProcess && !gstreamerProcess.killed) gstreamerProcess.kill('SIGTERM'); } catch {} }, 1000).unref?.();
    }
  } catch {}
  try { for (const p of tagReaderPending.values()) p.reject(new Error('Beehive is shutting down.')); } catch {}
  try { tagReaderProcess?.kill(); } catch {}
  try { databaseProcess?.kill(); } catch {}
});

app.whenReady().then(async () => {
  startupDebug('APP READY');
  // Absolute local file streaming (audio). Handle HTTP byte ranges explicitly so
  // Chromium's media element can seek reliably instead of falling back to 0.
  protocol.handle('mbfile', async (request) => {
    try {
      const filePath = path.resolve(decodePath(request.url, 'mbfile://'));
      const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
      const folders = Array.isArray(config?.folders) ? config.folders.map(f => path.resolve(String(f || ''))).filter(Boolean) : [];
      if (!folders.some(folder => isPathInsideFolder(filePath, folder))) {
        return new Response('Forbidden', { status: 403 });
      }
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });

      const size = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const mime = ({
        '.mp3':'audio/mpeg', '.flac':'audio/flac', '.m4a':'audio/mp4',
        '.mp4':'audio/mp4', '.ogg':'audio/ogg', '.opus':'audio/ogg',
        '.wav':'audio/wav', '.aac':'audio/aac', '.wma':'audio/x-ms-wma'
      })[ext] || 'application/octet-stream';
      const baseHeaders = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      };

      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } });
      }

      const range = request.headers.get('range');
      if (!range) {
        return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
          status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) }
        });
      }

      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) return new Response('Invalid Range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });

      let start;
      let end;
      if (match[1] === '') {
        const suffix = Number(match[2]);
        if (!Number.isFinite(suffix) || suffix <= 0) return new Response('Invalid Range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Number(match[2]);
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
        return new Response('Invalid Range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      const length = end - start + 1;
      return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(length),
          'Content-Range': `bytes ${start}-${end}/${size}`
        }
      });
    } catch (err) {
      return new Response(`Not found: ${err.message}`, { status: 404 });
    }
  });

  // Cached cover art, stored under userData/covers/<hash>.<ext>
  ipcMain.handle('gstreamer:status', () => gstreamerStatus());
  ipcMain.on('gstreamer:command', (_evt, command) => { sendGstreamerCommand(command); });

  protocol.handle('mbcover', async (request) => {
    try {
      const name = decodePath(request.url, 'mbcover://');
      const filePath = path.join(COVERS_DIR(), name);
      const fileUrl = pathToFileURL(filePath).toString();
      return net.fetch(fileUrl);
    } catch (err) {
      return new Response(`Not found: ${err.message}`, { status: 404 });
    }
  });

  scanLog('Beehive started', { version: app.getVersion(), userData: USER_DATA() });
  // beta.6 performs one deliberate true-cold-start migration. Do this before the
  // renderer exists so it cannot load the old library snapshot in a race. The
  // reset only removes Hive-derived library/artwork cache; music and user config
  // remain untouched. A later Settings action can request the same one-shot reset.
  const coldStartReset = await shouldPerformColdStartReset();
  if (coldStartReset) {
    startupDebug('COLD START CACHE RESET REQUIRED');
    await initializeDatabase();
    await clearLibraryCacheData({ clearCovers: true });
    await markColdStartResetComplete();
    startupDebug('COLD START CACHE RESET COMPLETE');
  }

  // Show the application shell before waiting on the database worker during
  // ordinary launches. The database is important for durability/recovery, but
  // it should never sit in front of the first paint on normal cached startups.
  createWindow();
  startupDebug('WINDOW REQUESTED');
  mpris.start().then(() => startupDebug('MPRIS START COMPLETE')).catch(err => startupDebug('MPRIS START FAILED', {message:err?.message}));
  if (!databaseReady) {
    startupDebug('DATABASE INITIALIZATION START');
    await initializeDatabase();
    startupDebug('DATABASE INITIALIZATION COMPLETE', { ready:databaseReady });
  }
  startupDebug('LIBRARY WATCHERS START');
  await startLibraryWatchers();
  startupDebug('LIBRARY WATCHERS COMPLETE', { count:libraryWatchers.size });
  if (Array.isArray(recoveredMetadataJobs) && recoveredMetadataJobs.length) {
    setTimeout(() => {
      startupDebug('RECOVERED METADATA JOBS DISPATCH', { count:recoveredMetadataJobs.length });
      const jobs = recoveredMetadataJobs.map(item => ({ ...(item.job || {}), id:item.id, attempts:Number(item.attempts||0), createdAt:Number(item.createdAt||Date.now()) }));
      recoveredMetadataJobs = [];
      if (jobs.length) {
        scanLog('Recovering interrupted metadata jobs', { count: jobs.length });
        enqueueMetadataSave({ sender: mainWindow?.webContents }, jobs, { recovered:true });
      }
    }, 1200);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopLibraryWatchers();
  if (process.platform !== 'darwin') app.quit();
});

// ---------- library auto-scan / filesystem watching ----------
let libraryWatchers = new Map();
let libraryWatchDebounce = null;
let libraryWatchChangedPaths = new Set();
let libraryBulkWriteIgnoreUntil = 0;
// Paths written by Beehive itself are ignored by the filesystem watcher.
// A tag edit should update the UI directly, not trigger a full library scan.
// Bulk Love writes can legitimately take longer than the normal per-file
// suppression window, so the whole bulk operation has its own watcher guard.
let libraryBulkWriteActive = false;
let libraryBulkWriteDepth = 0;
function beginLibraryBulkWrite(label = 'metadata') {
  libraryBulkWriteDepth++; libraryBulkWriteActive = true;
  libraryBulkWriteIgnoreUntil = Math.max(libraryBulkWriteIgnoreUntil, Date.now() + 10 * 60 * 1000);
  if (libraryWatchDebounce) { clearTimeout(libraryWatchDebounce); libraryWatchDebounce = null; }
  scanLog('BULK WRITE BEGIN', { label, depth: libraryBulkWriteDepth });
}
function endLibraryBulkWrite(label = 'metadata') {
  libraryBulkWriteDepth = Math.max(0, libraryBulkWriteDepth - 1);
  if (libraryBulkWriteDepth === 0) { libraryBulkWriteActive = false; libraryBulkWriteIgnoreUntil = Date.now() + 5000; }
  scanLog('BULK WRITE END', { label, depth: libraryBulkWriteDepth });
}

// Desired Love state for files currently being processed by the background metadata worker.
const libraryPendingLoveWrites = new Map();
const libraryInternalWrites = new Map();
const libraryInternalWriteDirs = new Map();
function markLibraryInternalWrite(trackPath) {
  const p = path.resolve(String(trackPath || ''));
  if (!p) return;
  const until = Date.now() + 10000;
  libraryInternalWrites.set(p, until);
  // MP3/WAV/FFmpeg writers use a temporary file and then rename it over the
  // original. The watcher can therefore report the temporary filename or a
  // directory-level rename rather than the final track path. Suppress the
  // containing directory for this short self-write window so Beehive never
  // rescans its own tag edits.
  libraryInternalWriteDirs.set(path.dirname(p), until);
}
function isLibraryInternalWrite(trackPath) {
  const p = path.resolve(String(trackPath || ''));
  const now = Date.now();
  const until = libraryInternalWrites.get(p) || 0;
  if (until && until >= now) return true;
  if (until) libraryInternalWrites.delete(p);
  const dir = path.dirname(p);
  const dirUntil = libraryInternalWriteDirs.get(dir) || 0;
  if (dirUntil && dirUntil >= now) return true;
  if (dirUntil) libraryInternalWriteDirs.delete(dir);
  return false;
}


function notifyLibraryFilesystemChange(reason = 'filesystem', changedPath = '') {
  if (changedPath) libraryWatchChangedPaths.add(path.resolve(String(changedPath)));
  if (libraryWatchDebounce) clearTimeout(libraryWatchDebounce);
  libraryWatchDebounce = setTimeout(() => {
    libraryWatchDebounce = null;
    if (!mainWindow || mainWindow.isDestroyed()) { libraryWatchChangedPaths.clear(); return; }
    const paths = [...libraryWatchChangedPaths];
    libraryWatchChangedPaths.clear();
    try { mainWindow.webContents.send('library:filesChanged', { reason, paths }); } catch {}
  }, 900);
}
function stopLibraryWatchers() {
  for (const watcher of libraryWatchers.values()) { try { watcher.close(); } catch {} }
  libraryWatchers.clear();
}
async function startLibraryWatchers() {
  stopLibraryWatchers();
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  for (const folder of (config.folders || [])) {
    if (!folder) continue;
    try { await fsp.access(folder, fs.constants.R_OK); } catch { continue; }
    try {
      const watcher = fs.watch(folder, { recursive: true }, (_eventType, filename) => {
        // A bulk Love operation may touch thousands of files and can outlive
        // the normal 10-second per-file self-write suppression. Never turn
        // those intentional writes into automatic rescans.
        if (libraryBulkWriteActive || Date.now() < libraryBulkWriteIgnoreUntil) return;
        const name = filename ? String(filename) : '';
        // Never index Beehive's private transactional media copies. Older
        // versions created these next to the music file; even if a filesystem
        // watcher reports one, it is not a library track.
        if (/\.beehive-(?:native-|love-|rating-|tags-|musicbee-)/i.test(name) || /(^|[\\/])\.beehive-tmp(?:[\\/]|$)/i.test(name)) return;
        // Node's recursive watcher reports relative paths for file changes.
        // Keep changedPath in the watcher callback's scope because it is also
        // needed after the directory-event check below.
        const changedPath = name ? path.resolve(folder, name) : '';
        // Ignore changes caused by Beehive's own tag writes; the renderer has
        // already updated that track's Love/rating state directly.
        if (changedPath && isLibraryInternalWrite(changedPath)) return;
        // Tag writers can also produce a directory-level event. During the
        // short self-write window, suppress that event as well so it cannot
        // cause a redundant full scan.
        if (!name) {
          const now = Date.now();
          const root = path.resolve(folder);
          for (const [dir, until] of libraryInternalWriteDirs) {
            if (until >= now && (dir === root || dir.startsWith(root + path.sep))) return;
            if (until < now) libraryInternalWriteDirs.delete(dir);
          }
          // Directory-only notifications are not useful for library indexing.
          // We only need to react when an actual audio file is created, removed,
          // or changed while Beehive is open.
          return;
        }
        if (!AUDIO_EXTS.has(path.extname(name).toLowerCase())) return;
        notifyLibraryFilesystemChange('audio-file', changedPath);
      });
      watcher.on('error', () => {});
      libraryWatchers.set(folder, watcher);
    } catch {}
  }
}

// ---------- IPC ----------

// Playback recovery is written synchronously on renderer shutdown so the last
// position/queue snapshot is on disk before the BrowserWindow disappears.
// The renderer also updates this file periodically while playing.
ipcMain.on('playback-state:saveSync', (_evt, state = {}) => {
  try {
    const payload = {
      version: 3,
      paths: Array.isArray(state.paths) ? state.paths.map(p => String(p || '')).filter(Boolean) : [],
      currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : -1,
      currentPath: String(state.currentPath || ''),
      position: Number.isFinite(Number(state.position)) ? Math.max(0, Number(state.position)) : 0,
      shuffle: !!state.shuffle,
      repeat: Number.isInteger(Number(state.repeat)) && Number(state.repeat) >= 0 && Number(state.repeat) <= 2 ? Number(state.repeat) : 0,
      volume: Number.isFinite(Number(state.volume)) ? Math.max(0, Math.min(1, Number(state.volume))) : 1,
      selectedQueueIndex: Number.isInteger(state.selectedQueueIndex) ? state.selectedQueueIndex : -1,
      selectedIndices: Array.isArray(state.selectedIndices) ? state.selectedIndices.filter(Number.isInteger) : [],
      wasPlaying: !!state.wasPlaying,
      savedAt: Date.now()
    };
    const target = PLAYBACK_STATE_PATH();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    _evt.returnValue = true;
  } catch (err) {
    try { _evt.returnValue = false; } catch {}
    console.warn('Beehive playback-state save failed:', err);
  }
});
ipcMain.handle('playback-state:get', async () => readJsonSafe(PLAYBACK_STATE_PATH(), null));
ipcMain.on('playback-state:updateTransportSync', (_evt, state = {}) => {
  try {
    const target = PLAYBACK_STATE_PATH();
    const existing = readJsonSafe(target, {}) || {};
    const payload = {
      ...existing,
      position: Number.isFinite(Number(state.position)) ? Math.max(0, Number(state.position)) : Number(existing.position || 0),
      currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : (Number.isInteger(existing.currentIndex) ? existing.currentIndex : -1),
      currentPath: state.currentPath != null ? String(state.currentPath || '') : String(existing.currentPath || ''),
      shuffle: state.shuffle == null ? !!existing.shuffle : !!state.shuffle,
      repeat: Number.isInteger(Number(state.repeat)) && Number(state.repeat) >= 0 && Number(state.repeat) <= 2 ? Number(state.repeat) : (Number.isInteger(existing.repeat) ? existing.repeat : 0),
      volume: Number.isFinite(Number(state.volume)) ? Math.max(0, Math.min(1, Number(state.volume))) : (Number.isFinite(Number(existing.volume)) ? Number(existing.volume) : 1),
      wasPlaying: state.wasPlaying == null ? !!existing.wasPlaying : !!state.wasPlaying,
      savedAt: Date.now()
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    _evt.returnValue = true;
  } catch (err) {
    try { _evt.returnValue = false; } catch {}
    console.warn('Beehive playback transport save failed:', err);
  }
});

ipcMain.on('startup:preloadEntry', () => startupDebug('PRELOAD SCRIPT ENTRY'));
ipcMain.handle('startup:debugLog', async (_evt, payload = {}) => { startupDebug('RENDERER ' + String(payload.label || 'EVENT'), payload.details ?? null); return STARTUP_DEBUG_ENABLED; });
ipcMain.handle('startup:debugState', async () => ({ enabled:STARTUP_DEBUG_ENABLED, path:STARTUP_DEBUG_ENABLED ? startupDebugPath() : null }));
ipcMain.handle('app:getVersion', async () => {
  return { version: app.getVersion(), name: 'Beehive' };
});

ipcMain.handle('config:get', async () => {
  return readJsonSafe(CONFIG_PATH(), { folders: [] });
});

ipcMain.handle('library:getCacheResetSetting', async () => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  return config.clearLibraryCacheOnNextLaunch === true;
});

ipcMain.handle('library:setCacheResetSetting', async (_evt, enabled) => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  config.clearLibraryCacheOnNextLaunch = !!enabled;
  await writeJsonSafe(CONFIG_PATH(), config);
  return config.clearLibraryCacheOnNextLaunch === true;
});

ipcMain.handle('library:clearCacheNow', async () => clearLibraryCacheData({ clearCovers: true }));

ipcMain.handle('discord:getSettings', async () => discordPresence.getSettings());
ipcMain.handle('discord:getStatus', async () => discordPresence.status());
ipcMain.handle('discord:saveSettings', async (_evt, patch) => discordPresence.saveSettings(patch || {}));
ipcMain.handle('discord:updateActivity', async (_evt, payload) => {
  const p = payload || {};
  return discordPresence.update(p.track || null, Number(p.position) || 0, !!p.paused);
});
ipcMain.handle('discord:clearActivity', async () => discordPresence.clear());
ipcMain.handle('mpris:update', async (_evt, payload = {}) => {
  const p = payload || {};
  const track = p.track || null;
  const coverCandidates = [
    track?.cover,
    track?.coverFile,
    ...(Array.isArray(track?.covers) ? track.covers.map(c => c?.file) : [])
  ].map(v => String(v || '').trim()).filter(Boolean);
  let artworkPath = '';
  if (track?.path) {
    mprisTrackPath = String(track.path);
    for (const coverFile of coverCandidates) {
      // Only Beehive's own cached cover filename is accepted here. Remote/data/blob
      // URLs are handled separately through artworkUrl when there is no local art.
      if (/^(?:https?:|data:|blob:|mbcover:)/i.test(coverFile)) continue;
      const candidate = path.join(COVERS_DIR(), path.basename(coverFile));
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          artworkPath = candidate;
          break;
        }
      } catch {}
    }
    console.info('[MPRIS] artwork resolution', {
      track: String(track.path),
      candidates: coverCandidates,
      coversDir: COVERS_DIR(),
      artworkPath
    });
  } else {
    mprisTrackPath = '';
  }
  const updatePayload = {
    track,
    position:Number(p.position)||0,
    duration:Number(p.duration)||Number(track?.duration)||0,
    paused:!!p.paused,
    volume:Number(p.volume),
    shuffle:!!p.shuffle,
    repeat:Number(p.repeat)||0,
    artworkUrl:String(p.artworkUrl||''),
    artworkPath
  };
  return mpris.update(updatePayload);
});

ipcMain.handle('stats:getEmbedPlayCounts', async () => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  return !!config.embedPlayCounts;
});

ipcMain.handle('stats:setEmbedPlayCounts', async (_evt, enabled) => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  config.embedPlayCounts = !!enabled;
  await writeJsonSafe(CONFIG_PATH(), config);
  return config.embedPlayCounts;
});

ipcMain.handle('graphics:getGpuAcceleration', async () => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  return config.disableGpuAcceleration !== true;
});

ipcMain.handle('graphics:setGpuAcceleration', async (_evt, enabled) => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  config.disableGpuAcceleration = !enabled;
  await writeJsonSafe(CONFIG_PATH(), config);
  return config.disableGpuAcceleration !== true;
});

ipcMain.handle('config:addFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  const folder = res.filePaths[0];
  if (!config.folders.includes(folder)) config.folders.push(folder);
  await writeJsonSafe(CONFIG_PATH(), config);
  await startLibraryWatchers();
  return config;
});

ipcMain.handle('config:removeFolder', async (_evt, folder) => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  config.folders = config.folders.filter((f) => f !== folder);
  await writeJsonSafe(CONFIG_PATH(), config);
  await startLibraryWatchers();
  return config;
});

function isPathInsideFolder(filePath, folderPath) {
  const file = path.resolve(String(filePath || ''));
  const folder = path.resolve(String(folderPath || ''));
  if (!file || !folder) return false;
  const rel = path.relative(folder, file);
  return rel === '' || (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

ipcMain.on('files:startDrag', (evt, filePaths = []) => {
  const paths = Array.from(new Set((Array.isArray(filePaths) ? filePaths : [filePaths]).map(p => String(p || '')).filter(Boolean)))
    .filter(p => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } });
  if (!paths.length) return;
  try {
    // Electron's native file drag exposes the real filesystem paths to the OS,
    // which lets targets such as Discord, a DAW, Nautilus, etc. receive the
    // actual music files instead of a web URL.
    evt.sender.startDrag({
      files: paths,
      icon: nativeImage.createEmpty()
    });
  } catch (err) {
    crashDebug('Native file drag failed', { message: err?.message || String(err) });
  }
});

ipcMain.handle('file:showInBrowser', async (_evt, filePath) => {
  const target = path.resolve(String(filePath || ''));
  if (!target) return { ok: false, error: 'No file was specified.' };
  try {
    const st = await fsp.stat(target);
    if (!st.isFile()) return { ok: false, error: 'The selected path is not a file.' };
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('tracks:deleteFromDisk', async (_evt, filePaths = []) => {
  const requested = [...new Set((Array.isArray(filePaths) ? filePaths : [])
    .filter(Boolean).map(p => path.resolve(String(p))))];
  if (!requested.length) return { ok: false, deleted: [], errors: [] };

  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  const folders = Array.isArray(config.folders) ? config.folders.map(f => path.resolve(String(f || ''))).filter(Boolean) : [];
  const invalid = requested.filter(p => !folders.some(folder => isPathInsideFolder(p, folder)));
  if (invalid.length) {
    return { ok: false, deleted: [], errors: invalid.map(p => ({ path: p, error: 'File is outside a configured Beehive library folder.' })) };
  }

  const existing = [];
  const missing = [];
  for (const p of requested) {
    try {
      const st = await fsp.stat(p);
      if (!st.isFile() || !AUDIO_EXTS.has(path.extname(p).toLowerCase())) {
        missing.push({ path: p, error: 'The selected path is not a supported audio file.' });
      } else {
        existing.push(p);
      }
    } catch (err) {
      missing.push({ path: p, error: err?.message || 'File could not be accessed.' });
    }
  }
  if (!existing.length) return { ok: false, deleted: [], errors: missing };


  const deleted = [];
  const errors = missing.slice();
  for (const p of existing) {
    try {
      await fsp.unlink(p);
      deleted.push(p);
    } catch (err) {
      errors.push({ path: p, error: err?.message || String(err) });
    }
  }
  return { ok: errors.length === 0, deleted, errors };
});

ipcMain.handle('library:getCached', async () => {
  // Fast-start transport: prefer the compressed sidecar so Electron clones a
  // small Uint8Array instead of a huge nested track object graph. The renderer
  // decompresses/parses this off the synchronous startup path.
  const fastStartAt = process.hrtime.bigint();
  try {
    const compressed = await fsp.readFile(LIBRARY_CACHE_GZIP_PATH());
    if (compressed.length) {
      startupDebug('FAST LIBRARY CACHE GZIP READY', {
        bytes: compressed.length,
        elapsedMs: Number(process.hrtime.bigint() - fastStartAt) / 1e6
      });
      return { compressed: 'gzip', data: new Uint8Array(compressed) };
    }
  } catch {}

  const cached = await readJsonSafe(LIBRARY_CACHE_PATH(), null);
  if (cached && Array.isArray(cached.tracks) && cached.tracks.length) {
    startupDebug('FAST LIBRARY CACHE READY', {
      tracks: cached.tracks.length,
      elapsedMs: Number(process.hrtime.bigint() - fastStartAt) / 1e6
    });
    return cached;
  }

  try {
    const db = await databaseRequest('get_library');
    if (db && Array.isArray(db.tracks) && db.tracks.length) return db;
  } catch (err) { crashDebug('DATABASE cache read failed', { message: err.message }); }
  return cached;
});

async function walk(dir, out, onDirectory = null, state = { directories: 0 }) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    scanLog('WALK ERROR', { dir, error: err?.message || String(err) });
    return;
  }
  state.directories++;
  try { onDirectory?.(state.directories, dir); } catch {}
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^\.beehive-tmp$/i.test(entry.name)) continue;
      await walk(full, out, onDirectory, state);
    } else {
      if (/\.beehive-(?:native-|love-|rating-|tags-|musicbee-)/i.test(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTS.has(ext)) out.push(full);
    }
  }
}

async function ensureMM() {
  if (!mm) mm = await import('music-metadata');
  return mm;
}

async function extractAndCacheCovers(pictures) {
  if (!pictures || !pictures.length) return [];
  const seen = new Set();
  const out = [];
  for (const picture of pictures) {
    if (!picture || !picture.data) continue;
    const ext = (picture.format || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const hash = crypto.createHash('sha1').update(picture.data).digest('hex');
    if (seen.has(hash)) continue; // some files repeat the same image under multiple tag frames
    seen.add(hash);
    const fileName = `${hash}.${ext}`;
    const filePath = path.join(COVERS_DIR(), fileName);
    try {
      await fsp.access(filePath);
    } catch {
      await fsp.mkdir(COVERS_DIR(), { recursive: true });
      await fsp.writeFile(filePath, picture.data);
    }
    // music-metadata gives a human-readable type like "Cover (front)" / "Cover (back)"
    out.push({ file: fileName, type: picture.type || null, hash });
  }
  // front cover first, back cover next, everything else after, in original order otherwise
  const rank = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('front')) return 0;
    if (t.includes('back')) return 1;
    return 2;
  };
  out.sort((a, b) => rank(a.type) - rank(b.type));
  return out;
}



function tagHelperPath() { return path.join(__dirname, 'resources', 'tag_helper.py'); }

// Metadata writes are deliberately lower-priority than playback. Artwork edits
// can rewrite a large FLAC/MP3, so a normal-priority helper plus normal-priority
// file copy can compete with GStreamer's audio buffers and cause audible/stuttery
// playback. Background metadata jobs opt into Linux's idle I/O class and a modest
// CPU nice value. Interactive/direct tag operations retain their normal priority.
function backgroundProcessCommand(executable, args) {
  if (process.platform === 'linux') {
    return { command: 'ionice', args: ['-c', '3', 'nice', '-n', '12', executable, ...args] };
  }
  if (process.platform === 'darwin') {
    return { command: 'nice', args: ['-n', '12', executable, ...args] };
  }
  return { command: executable, args };
}

async function copyMetadataFile(source, destination, background = false) {
  if (!background || (process.platform !== 'linux' && process.platform !== 'darwin')) {
    await fsp.copyFile(source, destination);
    return;
  }
  const { command, args } = backgroundProcessCommand('cp', ['--reflink=auto', source, destination]);
  await new Promise((resolve, reject) => {
    const child = spawnTracked(command, args, { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `Background file copy exited with code ${code}`)));
  }).catch(async err => {
    // Some non-GNU cp implementations do not support --reflink. Preserve the
    // low-priority behavior where possible, but fall back safely to Node copy.
    await fsp.copyFile(source, destination);
  });
}

let tagReaderProcess = null;
let tagReaderSeq = 0;
const tagReaderPending = new Map();
function startTagReaderProcess() {
  if (tagReaderProcess && !tagReaderProcess.killed) return tagReaderProcess;
  const script = tagHelperPath();
  if (!fs.existsSync(script)) throw new Error('Native tag helper is missing from this Beehive build.');
  const python = process.env.BEEHIVE_PYTHON || 'python3';
  const launch = backgroundProcessCommand(python, [script]);
  tagReaderProcess = spawnTracked(launch.command, launch.args, { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  try { if (tagReaderProcess.pid) process.setPriority(tagReaderProcess.pid, 15); } catch {}
  let buffer = '';
  tagReaderProcess.stdout.on('data', chunk => {
    buffer += String(chunk || '');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const pending = tagReaderPending.get(String(msg.id));
        if (!pending) continue;
        tagReaderPending.delete(String(msg.id));
        if (msg.ok) pending.resolve(msg.result); else pending.reject(new Error(msg.error || 'Native tag helper error'));
      } catch (err) { crashDebug('TAGREADER invalid response', { message: err.message }); }
    }
  });
  tagReaderProcess.stderr.on('data', chunk => { const text = String(chunk || '').trim(); if (text) crashDebug('TAGREADER stderr', text); });
  tagReaderProcess.on('error', err => crashDebug('TAGREADER process error', { message: err.message }));
  tagReaderProcess.on('exit', () => {
    for (const pending of tagReaderPending.values()) pending.reject(new Error('Native tag reader exited.'));
    tagReaderPending.clear();
    tagReaderProcess = null;
  });
  return tagReaderProcess;
}
function runTagHelper(request) {
  const proc = startTagReaderProcess();
  const id = String(++tagReaderSeq);
  const payload = { ...request, id };
  return new Promise((resolve, reject) => {
    tagReaderPending.set(id, { resolve, reject });
    try { proc.stdin.write(JSON.stringify(payload) + '\n'); }
    catch (err) { tagReaderPending.delete(id); reject(err); }
  });
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawnTracked('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(err));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.split('\n').filter(Boolean).slice(-4).join(' ') || `ffmpeg exited ${code}`)));
  });
}


function runMetaflac(args) {
  return new Promise((resolve, reject) => {
    const child = spawnTracked('metaflac', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(err));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `metaflac exited ${code}`)));
  });
}

function id3Synchsafe(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
}

function readId3Size(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  return ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
}

function musicBeePopmValue(stars) {
  // MusicBee's MP3 POPM values are discrete, including half-stars.
  // 0.5..5.0 => 13, 1, 54, 64, 118, 128, 186, 196, 242, 255.
  const values = [0, 13, 1, 54, 64, 118, 128, 186, 196, 242, 255];
  const halfSteps = Math.max(0, Math.min(10, Math.round((Number(stars) || 0) * 2)));
  return values[halfSteps];
}

function musicBeePopmByte(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? Math.round(n) : 0;
}

function musicBeePopmStars(raw) {
  const values = [0, 13, 1, 54, 64, 118, 128, 186, 196, 242, 255];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  let best = 0, bestDistance = Infinity;
  for (let i = 1; i < values.length; i++) {
    const distance = Math.abs(values[i] - n);
    if (distance < bestDistance) { bestDistance = distance; best = i; }
  }
  return best / 2;
}

function id3FrameSize(buf, version) {
  if (!buf || buf.length < 4) return -1;
  return version >= 4
    ? ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f)
    : buf.readUInt32BE(0);
}

function parseId3Frames(payload, version) {
  const frames = [];
  let pos = 0;
  while (pos + 10 <= payload.length) {
    const id = payload.toString('ascii', pos, pos + 4);

    // Valid ID3 padding is zero bytes at the end of the tag. Older Beehive
    // builds could accidentally append a frame after that padding, however.
    // Strawberry/TagLib reads the frame list rather than treating the first
    // zero byte as an absolute end marker, so recover those frames here too.
    if (/^\x00{4}$/.test(id)) {
      let next = pos;
      while (next < payload.length && payload[next] === 0) next++;
      if (next + 10 <= payload.length) {
        const nextId = payload.toString('ascii', next, next + 4);
        const nextSize = id3FrameSize(payload.subarray(next + 4, next + 8), version);
        if (/^[A-Z0-9]{4}$/.test(nextId) && nextSize > 0 && next + 10 + nextSize <= payload.length) {
          pos = next;
          continue;
        }
      }
      break;
    }

    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = id3FrameSize(payload.subarray(pos + 4, pos + 8), version);
    if (frameSize <= 0 || pos + 10 + frameSize > payload.length) break;
    frames.push({ id, data: payload.subarray(pos + 10, pos + 10 + frameSize), raw: payload.subarray(pos, pos + 10 + frameSize) });
    pos += 10 + frameSize;
  }
  return { frames, trailing: payload.subarray(pos) };
}

function txxxDescription(data) {
  if (!data || !data.length) return '';
  const encoding = data[0];
  const body = data.subarray(1);
  if (encoding === 0 || encoding === 3) {
    const nul = body.indexOf(0);
    return body.subarray(0, nul >= 0 ? nul : body.length).toString(encoding === 3 ? 'utf8' : 'latin1').trim();
  }
  if (encoding === 1 || encoding === 2) {
    // MusicBee commonly uses UTF-16LE for TXXX when Unicode text is required.
    let end = body.length;
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) { end = i; break; }
    }
    try { return body.subarray(0, end).toString('utf16le').replace(/^\uFEFF/, '').trim(); } catch { return ''; }
  }
  return '';
}

function makeId3Frame(id, data, version) {
  const size = version >= 4 ? id3Synchsafe(data.length) : (() => { const b = Buffer.alloc(4); b.writeUInt32BE(data.length); return b; })();
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.alloc(2), data]);
}

function makeMusicBeeLoveFrame(version, value = 'L') {
  // MusicBee's Love field: TXXX, encoding 0 (ISO-8859-1), description
  // "LOVE RATING". Beehive uses L for Loved and 0 for Unloved.
  const data = Buffer.concat([
    Buffer.from([0]),
    Buffer.from('LOVE RATING', 'latin1'),
    Buffer.from([0]),
    Buffer.from(String(value), 'latin1')
  ]);
  return makeId3Frame('TXXX', data, version);
}

function makeMusicBeePopmFrame(stars, version, counter = 0) {
  const value = musicBeePopmValue(stars);
  // Strawberry/TagLib keeps the POPM frame even when the rating is cleared;
  // it changes only the POPM rating byte to 0. Mirror that behavior.
  // MusicBee's POPM structure is:
  // "MusicBee" + NUL + rating byte + 32-bit play counter.
  // Preserve the existing counter when only the rating changes, matching
  // Strawberry's behavior of changing POPM.rating without resetting counter.
  const safeCounter = Number.isFinite(Number(counter)) && Number(counter) >= 0
    ? Math.min(0xFFFFFFFF, Math.floor(Number(counter)))
    : 0;
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(safeCounter >>> 0, 0);
  const data = Buffer.concat([
    Buffer.from('MusicBee', 'latin1'),
    Buffer.from([0, value]),
    counterBuf
  ]);
  return makeId3Frame('POPM', data, version);
}

function makeFMPSRatingFrame(stars, version) {
  const value = Math.max(0, Math.min(1, (Number(stars) || 0) / 5));
  const text = String(value);
  const data = Buffer.concat([
    Buffer.from([3]), // UTF-8, matching TagLib's text-frame semantics.
    Buffer.from('FMPS_Rating', 'utf8'),
    Buffer.from([0]),
    Buffer.from(text, 'utf8')
  ]);
  return makeId3Frame('TXXX', data, version);
}


async function writeAndSyncReplacement(temp, target, data) {
  await fsp.writeFile(temp, data);
  const fd = await fsp.open(temp, 'r+');
  try { await fd.sync(); } finally { await fd.close(); }
  await fsp.rename(temp, target);
}

const musicBeeWriteLocks = new Map();

async function withMusicBeeWriteLock(trackPath, fn) {
  const key = path.resolve(trackPath);
  const previous = musicBeeWriteLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  musicBeeWriteLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (musicBeeWriteLocks.get(key) === current) musicBeeWriteLocks.delete(key);
  }
}


async function readWavId3Tag(filePath) {
  const input = await fsp.readFile(filePath);
  if (input.length < 12 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  while (pos + 8 <= input.length) {
    const id = input.toString('ascii', pos, pos + 4);
    const size = input.readUInt32LE(pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > input.length) break;
    if (id === 'id3 ' || id === 'ID3 ') {
      const tag = input.subarray(dataStart, dataEnd);
      if (tag.length >= 10 && tag.toString('ascii', 0, 3) === 'ID3') {
        return { input, chunkPos: pos, chunkSize: size, dataStart, dataEnd, tag };
      }
    }
    pos = dataEnd + (size & 1);
  }
  return null;
}

async function readWavId3TagLight(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const header = Buffer.alloc(12);
      const hr = await fd.read(header, 0, 12, 0);
      if (hr.bytesRead < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;
      const stat = await fd.stat();
      let pos = 12;
      while (pos + 8 <= stat.size) {
        const ch = Buffer.alloc(8);
        const r = await fd.read(ch, 0, 8, pos);
        if (r.bytesRead < 8) break;
        const id = ch.toString('ascii', 0, 4);
        const size = ch.readUInt32LE(4);
        const dataStart = pos + 8;
        const dataEnd = dataStart + size;
        if (dataEnd > stat.size || dataEnd < dataStart) break;
        if ((id === 'id3 ' || id === 'ID3 ') && size >= 10 && size <= 32 * 1024 * 1024) {
          const tag = Buffer.alloc(size);
          await fd.read(tag, 0, size, dataStart);
          if (tag.toString('ascii', 0, 3) === 'ID3') return tag;
        }
        pos = dataEnd + (size & 1);
      }
    } finally { await fd.close(); }
  } catch {}
  return null;
}

async function readWavMusicBeeLove(filePath) {
  return readSharedWavMusicBeeLove(filePath);
}

async function readWavMusicBeePopmRaw(filePath) {
  return readSharedWavMusicBeePopmRaw(filePath);
}

async function updateWavMusicBeeTags(trackPath, { stars = null, loved = null } = {}) {
  return withMusicBeeWriteLock(trackPath, async () => {
    const found = await readWavId3Tag(trackPath);
    if (!found) throw new Error('WAV file does not contain an ID3 tag.');
    const input = found.input;
    const tag = found.tag;
    const version = tag[3] >= 4 ? 4 : 3;
    const tagSize = readId3Size(tag);
    const payload = tag.subarray(10, Math.min(tag.length, 10 + tagSize));
    const parsed = parseId3Frames(payload, version);
    const frames = parsed.frames;
    const trailing = parsed.trailing;
    const isPadding = trailing.length === 0 || trailing.every(byte => byte === 0);
    const outputFrames = [];
    let counter = 0;

    for (const frame of frames) {
      let remove = false;
      if (stars !== null && frame.id === 'POPM') {
        const nul = frame.data.indexOf(0);
        if (nul >= 0) {
          const email = frame.data.subarray(0, nul).toString('latin1').trim().toLowerCase();
          if (email === 'musicbee') {
            if (nul + 6 <= frame.data.length) counter = frame.data.readUInt32BE(nul + 2);
            remove = true;
          }
        }
      }
      if (stars !== null && frame.id === 'TXXX' && txxxDescription(frame.data).trim().toUpperCase() === 'FMPS_RATING') remove = true;
      if (loved !== null && frame.id === 'TXXX') {
        const desc = txxxDescription(frame.data).trim().toUpperCase();
        if (isBeehiveLoveFieldName(desc)) remove = true;
      }
      if (!remove) outputFrames.push(frame.raw);
    }

    if (loved !== null) if (loved) outputFrames.push(makeMusicBeeLoveFrame(version, 'L'));
    if (stars !== null) {
      // Keep the MusicBee POPM source of truth for WAVs with ID3, matching MP3.
      // FMPS_Rating is also synchronized for portability, but Beehive's reader
      // intentionally ignores it on WAV so other applications cannot override
      // the MusicBee value.
      outputFrames.push(makeFMPSRatingFrame(stars, version));
      outputFrames.push(makeMusicBeePopmFrame(stars, version, counter));
    }

    const keptTrailing = isPadding ? trailing : Buffer.alloc(0);
    const newPayload = Buffer.concat([...outputFrames, keptTrailing]);
    const newTag = Buffer.concat([
      Buffer.from('ID3','ascii'),
      Buffer.from([version,0,tag[5] & 0xF0]),
      id3Synchsafe(newPayload.length),
      newPayload
    ]);

    const oldChunkTotal = 8 + found.chunkSize + (found.chunkSize & 1);
    const newChunkSize = newTag.length;
    const newChunkTotal = 8 + newChunkSize + (newChunkSize & 1);
    let output;
    if (newChunkTotal <= oldChunkTotal) {
      const chunk = Buffer.alloc(oldChunkTotal);
      Buffer.from('id3 ','ascii').copy(chunk, 0);
      chunk.writeUInt32LE(oldChunkTotal - 8 - ((oldChunkTotal - 8) & 1), 4);
      // Keep the existing RIFF chunk size exactly stable; pad the ID3 payload.
      newTag.copy(chunk, 8);
      output = Buffer.concat([input.subarray(0, found.chunkPos), chunk, input.subarray(found.chunkPos + oldChunkTotal)]);
    } else {
      const chunk = Buffer.alloc(newChunkTotal);
      Buffer.from('id3 ','ascii').copy(chunk, 0);
      chunk.writeUInt32LE(newChunkSize, 4);
      newTag.copy(chunk, 8);
      output = Buffer.concat([input.subarray(0, found.chunkPos), chunk, input.subarray(found.chunkPos + oldChunkTotal)]);
      const riffSize = output.length - 8;
      output.writeUInt32LE(riffSize >>> 0, 4);
    }

    const temp = `${trackPath}.beehive-musicbee-${crypto.randomBytes(6).toString('hex')}.tmp`;
    await writeAndSyncReplacement(temp, trackPath, output);
  });
}

async function updateMp3MusicBeeTagsUnlocked(trackPath, { stars = null, loved = null } = {}) {
  const input = await fsp.readFile(trackPath);
  let version = 3;
  let flags = 0;
  let audioOffset = 0;
  let payload = Buffer.alloc(0);

  if (input.length >= 10 && input.toString('ascii', 0, 3) === 'ID3') {
    version = input[3] >= 4 ? 4 : 3;
    flags = input[5];
    const size = readId3Size(input);
    const end = Math.min(input.length, 10 + size);
    payload = input.subarray(10, end);
    audioOffset = end;
  }

  const parsed = parseId3Frames(payload, version);
  const frames = parsed.frames;
  const trailing = parsed.trailing;
  const isPadding = trailing.length === 0 || trailing.every(byte => byte === 0);
  const outputFrames = [];
  let existingMusicBeeCounter = 0;

  for (const frame of frames) {
    let remove = false;
    if (frame.id === 'POPM' && stars !== null) {
      const nul = frame.data.indexOf(0);
      if (nul >= 0) {
        const email = frame.data.subarray(0, nul).toString('latin1').trim().toLowerCase();
        // Only replace MusicBee's own POPM. Preserve its play counter when
        // changing the rating, just as Strawberry changes only POPM.rating.
        if (email === 'musicbee') {
          if (nul + 6 <= frame.data.length) {
            existingMusicBeeCounter = frame.data.readUInt32BE(nul + 2);
          }
          remove = true;
        }
      }
    }
    if (frame.id === 'TXXX' && stars !== null) {
      // Strawberry stores its portable normalized rating as TXXX:FMPS_Rating.
      // Keep this synchronized with the MusicBee POPM value.
      const desc = txxxDescription(frame.data).trim().toUpperCase();
      if (desc === 'FMPS_RATING') remove = true;
    }
    if (frame.id === 'TXXX' && loved !== null) {
      const desc = txxxDescription(frame.data).toUpperCase();
      // Replace the exact MusicBee Love field. Also remove Beehive's old
      // incorrect TXXX:Love spelling if it exists from an earlier build.
      if (isBeehiveLoveFieldName(desc)) remove = true;
    }
    if (!remove) outputFrames.push(frame.raw);
  }

  // Write only MusicBee's definitive LOVE RATING field; do not create the
  // legacy TXXX:Love field.
  if (loved !== null) {
    // Keep one authoritative Love field. Unlove removes every Beehive Love field from the file.
    // The absence of the field is the authoritative Unloved state.
    if (loved) outputFrames.push(makeMusicBeeLoveFrame(version, 'L'));
  }
  if (stars !== null) {
    // This deliberately mirrors Strawberry's SetRating(): FMPS_Rating is
    // always replaced (including 0), and the MusicBee POPM frame remains in
    // the tag with its rating byte changed to 0 when the user clears it.
    // Keeping the frame is important: it gives us a deterministic, writable
    // source-of-truth instead of relying on deletion through a hand-written
    // ID3 parser.
    outputFrames.push(makeFMPSRatingFrame(stars, version));
    outputFrames.push(makeMusicBeePopmFrame(stars, version, existingMusicBeeCounter));
  }

  // Always keep ID3 padding at the very end. New/replaced frames must be
  // placed before it; putting them after padding makes otherwise valid tags
  // invisible to strict ID3 readers (and was the reason ratings appeared to
  // save in Beehive but disappeared after restart).
  const keptTrailing = isPadding ? trailing : Buffer.alloc(0);
  payload = Buffer.concat([...outputFrames, keptTrailing]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([version, 0, flags & 0xF0]),
    id3Synchsafe(payload.length)
  ]);
  const output = Buffer.concat([header, payload, input.subarray(audioOffset)]);
  const temp = `${trackPath}.beehive-musicbee-${crypto.randomBytes(6).toString('hex')}.tmp`;
  await writeAndSyncReplacement(temp, trackPath, output);
}

async function updateMp3MusicBeeTags(trackPath, options = {}) {
  return withMusicBeeWriteLock(trackPath, () => updateMp3MusicBeeTagsUnlocked(trackPath, options));
}

async function writeMp3MusicBeeRating(trackPath, stars) {
  await updateMp3MusicBeeTags(trackPath, { stars });
}

const LOVE_SCAN_VERSION = 3;
// Bumped when the library record gains a broader native-tag inventory. A stale
// record is reparsed once during the next normal scan so the migration is real,
// not merely a cache-field default.
const METADATA_SCAN_VERSION = 1;

function isFavoriteLoveValue(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'L' || v === 'Y' || v === 'YES' || v === 'TRUE' ||
    v === '1' || v === 'LOVE' || v === 'LOVED' ||
    v === 'FAVORITE' || v === 'FAVOURITE';
}

// Every Love field Beehive has historically written/recognized. When Unlove is
// requested, ALL of these aliases are normalized to one LOVE RATING field. Unlove removes the Love fields; Love writes one canonical LOVE RATING=L field.
const BEEHIVE_LOVE_FIELD_NAMES = new Set([
  'LOVE RATING',
  'LOVE',
  'LOVERATING',
  'MUSICBEE/LOVE RATING',
  'MUSICBEE/LOVERATING'
]);
function isBeehiveLoveFieldName(value) {
  return BEEHIVE_LOVE_FIELD_NAMES.has(String(value ?? '').trim().toUpperCase());
}

async function readMp3MusicBeeLove(filePath) {
  try {
    const input = await fsp.readFile(filePath);
    if (input.length < 10 || input.toString('ascii', 0, 3) !== 'ID3') return false;
    const version = input[3] >= 4 ? 4 : 3;
    const size = readId3Size(input);
    const payload = input.subarray(10, Math.min(input.length, 10 + size));
    const { frames } = parseId3Frames(payload, version);
    for (const frame of frames) {
      if (frame.id !== 'TXXX') continue;
      const desc = txxxDescription(frame.data).trim().toUpperCase();
      if (!isBeehiveLoveFieldName(desc)) continue;
      const data = frame.data.subarray(1);
      const encoding = frame.data[0];
      let value = '';
      if (encoding === 0 || encoding === 3) {
        const nul = data.indexOf(0);
        value = data.subarray(nul >= 0 ? nul + 1 : 0).toString(encoding === 3 ? 'utf8' : 'latin1');
      } else {
        let start = 0;
        for (let i = 0; i + 1 < data.length; i += 2) {
          if (data[i] === 0 && data[i + 1] === 0) { start = i + 2; break; }
        }
        value = data.subarray(start).toString('utf16le');
      }
      // A file can contain multiple Love fields. Do not stop at the first
      // one: Beehive considers the file Loved when ANY recognized Love field
      // contains a Loved value. Unlove removes all of them.
      if (isFavoriteLoveValue(value)) return true;
    }
  } catch {}
  return false;
}

async function readMp3PopmRaw(filePath) {
  // ID3 can legally contain more than one POPM frame (one per application/email).
  // MusicBee uses the "MusicBee" email. Never return the first POPM blindly:
  // another player's POPM with rating 0 can otherwise hide MusicBee's 255.
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const head = Buffer.alloc(10);
      const { bytesRead } = await fd.read(head, 0, 10, 0);
      if (bytesRead < 10 || head.toString('ascii', 0, 3) !== 'ID3') return 0;
      const major = head[3];
      const flags = head[5];
      const tagSize = readId3Size(head);
      const payload = Buffer.alloc(tagSize);
      await fd.read(payload, 0, tagSize, 10);

      let pos = 0;
      // ID3v2.3/v2.4 extended headers precede the frames when the flag is set.
      if (major >= 3 && (flags & 0x40)) {
        if (payload.length >= 4) {
          const extSize = major >= 4
            ? ((payload[0] & 0x7f) << 21) | ((payload[1] & 0x7f) << 14) | ((payload[2] & 0x7f) << 7) | (payload[3] & 0x7f)
            : payload.readUInt32BE(0);
          // v2.3's size excludes its four-byte size field; v2.4 includes the size field.
          pos = major >= 4 ? extSize : 4 + extSize;
          if (pos > payload.length) pos = 0;
        }
      }

      let musicBeeRating = 0;
      let anyPopmRating = 0;
      let fmpsRating = 0;
      while (pos < payload.length) {
        if (major === 2) {
          if (pos + 6 > payload.length) break;
          const id = payload.toString('ascii', pos, pos + 3);
          const size = (payload[pos + 3] << 16) | (payload[pos + 4] << 8) | payload[pos + 5];
          if (!/^[A-Z0-9]{3}$/.test(id) || size <= 0 || pos + 6 + size > payload.length) break;
          if (id === 'POP') {
            const frame = payload.subarray(pos + 6, pos + 6 + size);
            const nul = frame.indexOf(0);
            if (nul >= 0 && nul + 1 < frame.length) {
              const email = frame.subarray(0, nul).toString('latin1').trim().toLowerCase();
              const raw = musicBeePopmByte(frame[nul + 1]);
              anyPopmRating = Math.max(anyPopmRating, raw);
              if (email === 'musicbee') musicBeeRating = Math.max(musicBeeRating, raw);
            }
          }
          pos += 6 + size;
        } else {
          if (pos + 10 > payload.length) break;
          const id = payload.toString('ascii', pos, pos + 4);
          const b = payload.subarray(pos + 4, pos + 8);
          const size = major >= 4
            ? ((b[0] & 0x7f) << 21) | ((b[1] & 0x7f) << 14) | ((b[2] & 0x7f) << 7) | (b[3] & 0x7f)
            : b.readUInt32BE(0);
          if (/^\x00{4}$/.test(id)) {
            let next = pos;
            while (next < payload.length && payload[next] === 0) next++;
            if (next + 10 <= payload.length) {
              const nextId = payload.toString('ascii', next, next + 4);
              const nextSize = major >= 4
                ? ((payload[next + 4] & 0x7f) << 21) | ((payload[next + 5] & 0x7f) << 14) | ((payload[next + 6] & 0x7f) << 7) | (payload[next + 7] & 0x7f)
                : payload.readUInt32BE(next + 4);
              if (/^[A-Z0-9]{4}$/.test(nextId) && nextSize > 0 && next + 10 + nextSize <= payload.length) {
                pos = next;
                continue;
              }
            }
            break;
          }
          if (!/^[A-Z0-9]{4}$/.test(id) || size <= 0) break;
          if (pos + 10 + size > payload.length) break;
          const frame = payload.subarray(pos + 10, pos + 10 + size);
          if (id === 'POPM') {
            const nul = frame.indexOf(0);
            if (nul >= 0 && nul + 1 < frame.length) {
              const email = frame.subarray(0, nul).toString('latin1').trim().toLowerCase();
              const raw = musicBeePopmByte(frame[nul + 1]);
              anyPopmRating = Math.max(anyPopmRating, raw);
              if (email === 'musicbee') musicBeeRating = Math.max(musicBeeRating, raw);
            }
          } else if (id === 'TXXX') {
            // Strawberry's portable fallback is TXXX:FMPS_Rating with a
            // normalized 0.0-1.0 value. Read it if no POPM is available.
            const desc = txxxDescription(frame).trim().toUpperCase();
            if (desc === 'FMPS_RATING') {
              const encoding = frame[0];
              const body = frame.subarray(1);
              let sep = -1;
              if (encoding === 0 || encoding === 3) {
                sep = body.indexOf(0);
                if (sep >= 0) {
                  const valueText = body.subarray(sep + 1).toString(encoding === 3 ? 'utf8' : 'latin1').trim();
                  const normalized = Number.parseFloat(valueText);
                  if (Number.isFinite(normalized) && normalized > fmpsRating) fmpsRating = Math.max(0, Math.min(1, normalized));
                }
              } else {
                for (let i = 0; i + 1 < body.length; i += 2) {
                  if (body[i] === 0 && body[i + 1] === 0) { sep = i; break; }
                }
                if (sep >= 0) {
                  const valueText = body.subarray(sep + 2).toString('utf16le').trim();
                  const normalized = Number.parseFloat(valueText);
                  if (Number.isFinite(normalized) && normalized > fmpsRating) fmpsRating = Math.max(0, Math.min(1, normalized));
                }
              }
            }
          }
          pos += 10 + size;
        }
      }
      // Beehive's MP3 rating authority is ONLY the MusicBee POPM frame.
      // Other POPM applications and FMPS are deliberately ignored for display.
      return musicBeeRating || 0;
    } finally {
      await fd.close();
    }
  } catch {
    return 0;
  }
}

async function readMp3PopmRating(filePath) {
  const raw = await readMp3PopmRaw(filePath);
  return musicBeePopmStars(raw);
}

async function readNativeEmbeddedRating(filePath, metadataLib) {
  const meta = await metadataLib.parseFile(filePath, { duration: false, skipCovers: true });
  const normalize = (raw, scale255 = false, scaleNormalized = false) => {
    if (raw === null || raw === undefined || raw === '') return 0;
    if (typeof raw === 'object') return normalize(raw.rating ?? raw.text ?? raw.value, scale255, scaleNormalized);
    const n = Number(String(raw).replace(/[^0-9.+-]/g, ''));
    if (!Number.isFinite(n)) return 0;
    if (scale255) return musicBeePopmStars(n);
    if (scaleNormalized) return Math.max(0, Math.min(5, Math.round(n * 10) / 2));
    if (n <= 5) return Math.round(n * 2) / 2;
    if (n <= 100) return Math.max(0, Math.min(5, Math.round(n / 10) / 2));
    return musicBeePopmStars(n);
  };

  let rating = 0;
  for (const tagList of Object.values(meta.native || {})) {
    for (const tag of (Array.isArray(tagList) ? tagList : [])) {
      const id = String(tag?.id || '').toUpperCase();
      const desc = String(tag?.value?.description || '').toUpperCase();
      // Only read the exact portable field Beehive writes for non-MP3 files.
      // Generic/provider rating tags are intentionally ignored.
      if (id === 'FMPS_RATING' || desc === 'FMPS_RATING' || id === 'FMPS/RATING' || desc === 'FMPS/RATING') {
        rating = Math.max(rating, normalize(
          tag?.value?.rating ?? tag?.value?.text ?? tag?.value?.value ?? tag?.value,
          false,
          true
        ));
      }
    }
  }
  return Math.max(0, Math.min(5, rating));
}

async function readEmbeddedRating(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return readMp3PopmRating(filePath);
  if (ext === '.wav') return musicBeePopmStars(await readWavMusicBeePopmRaw(filePath));
  const metadataLib = await ensureMM();
  return readNativeEmbeddedRating(filePath, metadataLib);
}

async function embedRatingInFile(trackPath, stars) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  const ext = path.extname(trackPath).toLowerCase();
  const value = Math.max(0, Math.min(5, Number(stars) || 0));
  if (ext === '.mp3') {
    await writeMp3MusicBeeRating(trackPath, value);
    const readBack = await readEmbeddedRating(trackPath);
    if (Math.abs(readBack - value) > 0.01) {
      throw new Error(`MusicBee rating write verification failed: expected ${value}, read back ${readBack}`);
    }
    return true;
  }
  if (ext === '.wav') {
    await updateWavMusicBeeTags(trackPath, { stars: value });
    const readBack = await readEmbeddedRating(trackPath);
    if (Math.abs(readBack - value) > 0.01) {
      throw new Error(`MusicBee WAV rating write verification failed: expected ${value}, read back ${readBack}`);
    }
    return true;
  }

  // Strawberry's TagLib implementation uses the portable FMPS_Rating field:
  //   ID3v2  -> TXXX:FMPS_Rating
  //   Vorbis -> FMPS_RATING
  //   MP4    -> ----:com.apple.iTunes:FMPS_Rating
  //   ASF    -> FMPS/Rating
  // Keep those exact keys rather than ffmpeg's generic "rate"/"RATING" names.
  const normalized = String(value / 5);
  let metadataKey = 'FMPS_RATING';
  let metadataValue = normalized;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', trackPath, '-map', '0', '-c', 'copy'];

  if (ext === '.m4a' || ext === '.mp4') {
    metadataKey = '----:com.apple.iTunes:FMPS_Rating';
    // FFmpeg only preserves/writes arbitrary MP4 freeform metadata when this
    // flag is enabled. This is the equivalent of Strawberry's MP4 freeform item.
    args.push('-movflags', 'use_metadata_tags');
    metadataValue = normalized;
  } else if (ext === '.wma') {
    metadataKey = 'FMPS/Rating';
  } else if (ext === '.wav' || ext === '.aiff') {
    // WAV/AIFF use ID3 tags in TagLib, so use an ID3-style TXXX field where
    // ffmpeg supports it.
    metadataKey = 'FMPS_Rating';
  }

  const temp = `${trackPath}.beehive-rating-${crypto.randomBytes(6).toString('hex')}${ext}`;
  try {
    args.push('-metadata', `${metadataKey}=${metadataValue}`, temp);
    await runFfmpeg(args);
    const st = await fsp.stat(temp);
    if (!st.size) throw new Error('ffmpeg produced an empty output file');
    await fsp.rename(temp, trackPath);
    // Strawberry's tests write a tag and immediately read it back. Do the same
    // here so Beehive never reports a rating as saved when the metadata backend
    // silently discarded the field.
    const readBack = await readEmbeddedRating(trackPath);
    if (Math.abs(readBack - value) > 0.01) {
      throw new Error(`Rating write verification failed: expected ${value}, read back ${readBack}`);
    }
    return true;
  } catch (err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not embed rating: ${err.message}`);
  }
}

function ffmpegMetadataArgs(tags) {
  const map = {
    title: 'title', artist: 'artist', album: 'album', albumArtist: 'album_artist',
    genre: 'genre', year: 'date', track: 'track', disk: 'disc', comment: 'comment',
    composer: 'composer', grouping: 'grouping', copyright: 'copyright', lyrics: 'lyrics',
    compilation: 'COMPILATION', bpm: 'bpm', publisher: 'publisher', conductor: 'conductor'
  };
  const args = [];
  const standard = new Set(Object.keys(map));
  for (const [key, value] of Object.entries(tags || {})) {
    if (value === undefined || value === null) continue;
    const target = map[key] || key;
    args.push('-metadata', `${target}=${String(value)}`);
  }
  return args;
}

// Library cache/scan operations are serialized. Tag edits can trigger both an
// explicit incremental refresh and a filesystem-watcher refresh; allowing those
// two scans to read/write library.json concurrently can let an older snapshot win
// and make the UI temporarily appear empty.
let libraryScanChain = Promise.resolve();
async function acquireLibraryScanLock() {
  let releaseNext;
  const wait = libraryScanChain;
  libraryScanChain = new Promise(resolve => { releaseNext = resolve; });
  await wait;
  return releaseNext;
}

// Favorites/Love state is read as part of the scanner's existing metadata pass.
// Do not perform a second full-library Love scan after the library scan completes.
ipcMain.handle('library:scanChanged', async (evt, changedPaths = []) => {
  const releaseLibraryScan = await acquireLibraryScanLock();
  try {
  const requested = [...new Set((Array.isArray(changedPaths) ? changedPaths : [])
    .filter(Boolean).map(p => path.resolve(String(p))))];
  if (!requested.length) return await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });

  const previous = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const oldTracks = Array.isArray(previous.tracks) ? previous.tracks : [];
  const oldByPath = new Map(oldTracks.map(t => [path.resolve(String(t?.path || '')), t]));
  const stats = await readJsonSafe(STATS_PATH(), {});
  const existing = [];
  const removed = [];

  for (const filePath of requested) {
    try {
      const st = await fsp.stat(filePath);
      if (st.isFile() && AUDIO_EXTS.has(path.extname(filePath).toLowerCase())) {
        existing.push({ path: filePath, mtimeMs: Number(st.mtimeMs || 0), ctimeMs: Number(st.ctimeMs || 0), size: Number(st.size || 0) });
      } else {
        removed.push(filePath);
      }
    } catch {
      removed.push(filePath);
    }
  }

  if (!existing.length && !removed.length) return previous;

  const tracksByPath = new Map(oldTracks.map(t => [path.resolve(String(t?.path || '')), t]));
  for (const filePath of removed) tracksByPath.delete(filePath);

  let cursor = 0;
  const workerCount = Math.min(2, Math.max(1, existing.length));
  const workerPath = path.join(__dirname, 'scanner-worker.js');
  const pool = [];
  const changedResults = [];

  const spawnScanner = () => {
    const child = forkTracked(workerPath, [], { cwd: __dirname, execArgv: ['--max-old-space-size=512'], stdio: ['ignore','pipe','pipe','ipc'] });
    const slot = { child, busy:false, job:null, timer:null };
    child.stdout?.on('data', chunk => { const text=String(chunk||'').trim(); if(text) scanLog(`incremental worker stdout: ${text}`); });
    child.stderr?.on('data', chunk => { const text=String(chunk||'').trim(); if(text) scanLog(`incremental worker stderr: ${text}`); });
    pool.push(slot); return slot;
  };
  const cleanup = slot => { if(slot.timer) clearTimeout(slot.timer); try{slot.child.removeAllListeners();}catch{} try{slot.child.disconnect();}catch{} try{slot.child.kill();}catch{} };

  await new Promise((resolve) => {
    if (!existing.length) return resolve();
    let finished = 0;
    const dispatch = slot => {
      const i = cursor++;
      if (i >= existing.length) { if (pool.every(s => !s.busy)) resolve(); return; }
      const info = existing[i]; slot.busy=true; slot.job=info;
      slot.timer=setTimeout(() => {
        if (!slot.busy) return;
        scanLog('INCREMENTAL SCAN TIMEOUT - preserving cached track', { file: info.path });
        changedResults.push({ info, track: oldByPath.get(path.resolve(info.path)) || null });
        slot.busy=false; slot.job=null; finished++;
        dispatch(slot); if (finished >= existing.length) resolve();
      }, 12000);
      slot.child.once('message', msg => {
        if (slot.timer) { clearTimeout(slot.timer); slot.timer=null; }
        const old = oldByPath.get(path.resolve(info.path));
        if (msg?.type === 'result' && msg.track) {
          changedResults.push({ info, track: msg.track });
        } else {
          // A failed incremental parse must never erase a previously known track
          // or its cached Love state. Preserve the old record until a successful
          // authoritative scan can replace it.
          changedResults.push({ info, track: old || null });
          scanLog('INCREMENTAL SCAN ERROR - preserving cached track', { file: info.path, error: msg?.error || 'unknown' });
        }
        slot.busy=false; slot.job=null; finished++;
        dispatch(slot); if (finished >= existing.length) resolve();
      });
      try { slot.child.send({ type:'scan', id:i, filePath:info.path, coversDir:COVERS_DIR() }); }
      catch { const old=oldByPath.get(path.resolve(info.path)); changedResults.push({info,track:old||null}); slot.busy=false; slot.job=null; finished++; dispatch(slot); if(finished>=existing.length) resolve(); }
    };
    for(let i=0;i<workerCount;i++) {
      const slot=spawnScanner();
      slot.child.on('error',()=>{}); slot.child.on('exit',()=>{});
    }
    for(const slot of pool) dispatch(slot);
  });
  for (const slot of pool) cleanup(slot);

  for (const { info, track } of changedResults) {
    const key = path.resolve(info.path);
    if (!track) continue;
    const old = oldByPath.get(key);
    const merged = {
      ...track,
      path: info.path,
      fileMtimeMs: info.mtimeMs,
      fileCtimeMs: Number(info?.ctimeMs || 0),
      fileSize: info.size,
      addedAt: old?.addedAt || track.addedAt || Date.now(),
      playCount: Number(stats[info.path]?.playCount || old?.playCount || track.playCount || 0),
      skipCount: Number(stats[info.path]?.skipCount || old?.skipCount || track.skipCount || 0),
      lastPlayedAt: Number(stats[info.path]?.lastPlayedAt || old?.lastPlayedAt || track.lastPlayedAt || 0),
      loved: !!track.loved,
      loveHydrated: true,
      loveCheckedMtimeMs: Number(info?.mtimeMs || 0),
      loveCheckedSize: Number(info?.size || 0),
      loveScanVersion: LOVE_SCAN_VERSION,
      metadataScanVersion: Number(t.metadataScanVersion || METADATA_SCAN_VERSION)
    };
    tracksByPath.set(key, merged);
    try { evt.sender.send('library:scanTrack', merged); } catch {}
  }

  const ordered = [];
  const changedSet = new Set(requested);
  for (const t of oldTracks) {
    const key = path.resolve(String(t?.path || ''));
    if (!key || !tracksByPath.has(key)) continue;
    if (!changedSet.has(key)) ordered.push(t);
    else ordered.push(tracksByPath.get(key));
  }
  for (const [key, t] of tracksByPath) {
    if (!oldByPath.has(key)) ordered.push(t);
  }

  const result = { tracks: ordered, scannedAt: Date.now() };
  await writeJsonSafe(LIBRARY_CACHE_PATH(), result);
  // Keep SQLite authoritative for the next startup too. Incremental watcher
  // scans used to update only library.json, which meant the new SQLite backend
  // could immediately resurrect stale metadata after a restart.
  await persistLibraryDatabase(ordered);
  scanLog('Incremental library scan finished', { requested: requested.length, existing: existing.length, removed: removed.length, tracks: ordered.length });
  return result;
  } finally {
    releaseLibraryScan();
  }
});

ipcMain.handle('library:scan', async (evt, options = {}) => {
  const releaseLibraryScan = await acquireLibraryScanLock();
  try {
  const forceFull = options?.forceFull === true;
  scanLog('SCAN IPC ENTER', { forceFull });
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  scanLog('SCAN CONFIG LOADED', { folders: Array.isArray(config.folders) ? config.folders.length : 0 });
  const files = [];
  const folders = Array.isArray(config.folders) ? config.folders : [];
  for (const folder of folders) {
    const before = files.length;
    scanLog('WALK START', { folder });
    await walk(folder, files, (count, currentDir) => {
      if (count % 100 === 0 || files.length % 250 === 0) {
        scanLog('WALK PROGRESS', { folder, filesFound: files.length, directories: count, currentDir });
        try {
          evt.sender.send('library:scanProgress', {
            done: 0, total: files.length, tracksFound: 0, skipped: 0, current: path.basename(currentDir || folder),
            phase: `Finding music files · ${files.length.toLocaleString()} found`, changed: 0, unchanged: 0, enumerating: true
          });
        } catch {}
      }
    });
    scanLog('WALK DONE', { folder, addedFiles: files.length - before, totalFiles: files.length });
  }
  scanLog('FILE ENUMERATION DONE', { total: files.length });
  try {
    evt.sender.send('library:scanProgress', {
      done: 0, total: files.length, tracksFound: 0, skipped: 0, current: '',
      phase: `Preparing ${files.length.toLocaleString()} music files`, changed: 0, unchanged: 0, enumerating: false
    });
  } catch {}

  const previous = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const oldTracks = Array.isArray(previous.tracks) ? previous.tracks : [];
  const oldByPath = new Map(oldTracks.map(t => [path.resolve(String(t?.path || '')), t]));
  const stats = await readJsonSafe(STATS_PATH(), {});

  // A rescan is incremental: recursively enumerate the configured folders, but
  // only send NEW or MODIFIED files through the expensive metadata/artwork parser.
  // Removed files disappear naturally because the final library is rebuilt from
  // the current filesystem set plus the cached records for unchanged files.
  const fileInfo = [];
  scanLog('STAT PHASE START', { totalFiles: files.length });
  let statCursor = 0;
  let statDone = 0;
  let statLastLog = Date.now();
  // Keep metadata probes deliberately modest. A large burst of concurrent stat()
  // calls can saturate a network-backed or spinning filesystem and make the scan
  // appear frozen. Eight workers give us steady progress without hammering storage.
  const statWorkerCount = Math.min(8, Math.max(1, files.length));
  const statWorkers = Array.from({ length: statWorkerCount }, async (_, workerIndex) => {
    scanLog('STAT WORKER START', { worker: workerIndex, total: statWorkerCount });
    while (true) {
      const i = statCursor++;
      if (i >= files.length) return;
      const filePath = files[i];
      const startedAt = Date.now();
      try {
        const st = await fsp.stat(filePath);
        fileInfo[i] = { path: filePath, mtimeMs: Number(st.mtimeMs || 0), ctimeMs: Number(st.ctimeMs || 0), size: Number(st.size || 0) };
      } catch {
        fileInfo[i] = null;
      } finally {
        statDone++;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= 1000) scanLog('Slow stat', { ms: elapsed, file: filePath, index: i });
        if (statDone === files.length || statDone % 250 === 0 || Date.now() - statLastLog >= 2000) {
          statLastLog = Date.now();
          scanLog('STAT PROGRESS', { done: statDone, total: files.length, file: filePath, index: i });
          try {
            evt.sender.send('library:scanProgress', {
              done: statDone, total: files.length, tracksFound: 0, skipped: files.length - statDone,
              current: path.basename(filePath || ''), phase: 'Checking files for changes', changed: 0, unchanged: 0, statPhase: true
            });
          } catch {}
        }
      }
    }
  });
  await Promise.all(statWorkers);
  scanLog('STAT PHASE DONE', { totalFiles: files.length, completed: statDone });

  const changed = [];
  const unchanged = [];
  for (const info of fileInfo) {
    if (!info) continue;
    const old = oldByPath.get(info.path);
    const same = !forceFull && old && Number(old.fileMtimeMs || 0) === info.mtimeMs && Number(old.fileCtimeMs || 0) === info.ctimeMs && Number(old.fileSize || 0) === info.size && Number(old.metadataScanVersion || 0) >= METADATA_SCAN_VERSION;
    if (same) unchanged.push({ ...old, fileMtimeMs: info.mtimeMs, fileCtimeMs: info.ctimeMs, fileSize: info.size });
    else changed.push(info);
  }

  const tracks = unchanged.slice();
  const inaccessible = files.length - fileInfo.filter(Boolean).length;
  let done = 0;
  let skipped = inaccessible;
  let cursor = 0;
  let lastProgressAt = 0;
  const total = files.length;
  scanLog('LIBRARY SCAN STARTED', { forceFull, total, previousTracks: oldTracks.length, changed: changed.length, unchanged: unchanged.length });
  const workerCount = Math.min(forceFull ? 4 : 2, Math.max(1, changed.length));
  const WORKER_RECYCLE_AFTER = 250;
  const JOB_TIMEOUT_MS = 12000;
  const workerPath = path.join(__dirname, 'scanner-worker.js');
  const pool = [];

  const enrichTrack = (t, info) => {
    const old = oldByPath.get(t.path);
    return {
      ...t,
      fileMtimeMs: Number(info?.mtimeMs || 0),
      fileCtimeMs: Number(info?.ctimeMs || 0),
      fileSize: Number(info?.size || 0),
      addedAt: old?.addedAt || Date.now(),
      playCount: Number(stats[t.path]?.playCount || old?.playCount || 0),
      skipCount: Number(stats[t.path]?.skipCount || old?.skipCount || 0),
      lastPlayedAt: Number(stats[t.path]?.lastPlayedAt || old?.lastPlayedAt || 0),
      loved: !!t.loved,
      loveHydrated: true,
      loveCheckedMtimeMs: Number(info?.mtimeMs || 0),
      loveCheckedSize: Number(info?.size || 0),
      loveScanVersion: LOVE_SCAN_VERSION,
      metadataScanVersion: Number(t.metadataScanVersion || METADATA_SCAN_VERSION)
    };
  };

  // Progressive renderer updates are deliberately compact. A full scanner result can
  // contain a large nativeTags inventory and lyrics; serializing those objects over
  // Electron IPC once per file can block the main process long enough to make a large
  // first scan appear hung. The final scan result still carries the complete record.
  const progressiveTrackPayload = (track) => {
    if (!track || typeof track !== 'object') return track;
    const out = {};
    const fields = [
      'id','path','title','artist','album','albumArtist','year','genre','composer','publisher',
      'conductor','comment','grouping','copyright','originalArtist','originalAlbum','originalYear',
      'language','mood','occasion','keywords','quality','tempo','isrc','barcode','track','trackCount',
      'disk','discCount','duration','sampleRate','bitrate','bitDepth','channels','codec','cover','covers',
      'loved','rating','ratingRaw','ratingHydrated','startTime','endTime','fileMtimeMs','fileCtimeMs',
      'fileSize','addedAt','playCount','skipCount','lastPlayedAt','loveHydrated','loveCheckedMtimeMs',
      'loveCheckedSize','loveScanVersion','metadataScanVersion'
    ];
    for (const key of fields) if (Object.prototype.hasOwnProperty.call(track, key)) out[key] = track[key];
    return out;
  };

  const sendProgress = (current = '', phase = 'Scanning changes') => {
    const now = Date.now();
    if (done === total || done % 5 === 0 || now - lastProgressAt >= 150) {
      lastProgressAt = now;
      evt.sender.send('library:scanProgress', {
        done, total, tracksFound: tracks.length, skipped, current, phase,
        changed: changed.length, unchanged: unchanged.length
      });
    }
  };

  // First phase is intentionally cheap: filesystem stat checks only. This is
  // what makes rescans practical for a 20k-30k library.
  evt.sender.send('library:scanProgress', {
    done: 0, total, tracksFound: tracks.length, skipped: 0, current: '',
    phase: forceFull ? `Reading tags from ${total.toLocaleString()} files` : `Checking ${total.toLocaleString()} files for changes`,
    changed: changed.length, unchanged: unchanged.length
  });

  const spawnScanner = () => {
    const child = forkTracked(workerPath, [], {
      cwd: __dirname,
      execArgv: ['--max-old-space-size=512'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    const slot = { child, busy:false, job:null, timer:null, heartbeat:null, startedAt:0, completed:0, stopping:false };
    child.stdout?.on('data', chunk => {
      const text = String(chunk || '').trim();
      if (text) scanLog(`worker stdout: ${text}`);
    });
    child.stderr?.on('data', chunk => {
      const text = String(chunk || '').trim();
      if (text) scanLog(`worker stderr: ${text}`);
    });
    pool.push(slot);
    scanLog('Scanner worker started', { pid: child.pid });
    return slot;
  };
  const cleanupSlot = (slot) => {
    if (slot.timer) { clearTimeout(slot.timer); slot.timer=null; }
    if (slot.heartbeat) { clearInterval(slot.heartbeat); slot.heartbeat=null; }
    try { slot.child.removeAllListeners(); } catch {}
    try { slot.child.disconnect(); } catch {}
    try { slot.child.kill(); } catch {}
    slot.busy=false; slot.job=null;
  };

  const runPool = () => new Promise((resolve, reject) => {
    if (!changed.length) return resolve();
    let finished=false;
    const failAll = err => { if(finished)return; finished=true; for(const slot of pool)cleanupSlot(slot); reject(err); };
    const completeIfDone = () => {
      if (done >= total && !finished) { finished=true; for(const slot of pool)cleanupSlot(slot); resolve(); }
      else if (cursor >= changed.length && pool.every(s => !s.busy) && done >= total && !finished) { finished=true; for(const slot of pool)cleanupSlot(slot); resolve(); }
    };
    const replaceWorker = slot => {
      if(finished || slot.stopping)return;
      const idx=pool.indexOf(slot); cleanupSlot(slot); if(idx<0||finished)return;
      const replacement=spawnScanner(); pool.splice(pool.indexOf(replacement),1); pool[idx]=replacement; attach(replacement); dispatch(replacement);
    };
    const fallbackTrackFor = (info) => {
      if (!info?.path) return null;
      const old = oldByPath.get(path.resolve(String(info.path || '')));
      if (old) {
        // Preserve the last known metadata when parsing fails. Do NOT mark the
        // file as freshly hydrated: its Love/metadata check markers remain stale
        // so a later scan will retry the authoritative read.
        return {
          ...old,
          fileMtimeMs: Number(info?.mtimeMs || old.fileMtimeMs || 0),
          fileCtimeMs: Number(info?.ctimeMs || old.fileCtimeMs || 0),
          fileSize: Number(info?.size || old.fileSize || 0)
        };
      }
      const ext = path.extname(info.path);
      return {
        id: crypto.createHash('md5').update(info.path).digest('hex'),
        path: info.path, title: path.basename(info.path, ext),
        artist: 'Unknown Artist', album: 'Unknown Album', albumArtist: 'Unknown Artist',
        year: null, genre: null, composer: null, publisher: null, conductor: null, comment: null,
        grouping: null, copyright: null, originalArtist: null, originalAlbum: null, originalYear: null,
        language: null, mood: null, occasion: null, keywords: null, quality: null, tempo: null, isrc: null, barcode: null,
        track: null, trackCount: null, disk: null, discCount: null, duration: 0, sampleRate: null, bitrate: null,
        channels: null, codec: ext.replace('.','').toUpperCase(), cover: null, covers: [], loved: false, lyrics: null,
        rating: 0, ratingRaw: 0, ratingHydrated: true, startTime: '', endTime: '', customTags: {}, nativeTags: {}, metadataScanVersion: 0,
        fileMtimeMs: info.mtimeMs, fileCtimeMs: Number(info?.ctimeMs || 0), fileSize: info.size, addedAt: Date.now(), playCount: 0, skipCount: 0, lastPlayedAt: 0, loveHydrated: false, loveCheckedMtimeMs: 0, loveCheckedCtimeMs: 0, loveCheckedSize: 0, loveScanVersion: 0
      };
    };
    const markSkippedAndContinue = (slot, info, dispatchNext=true) => {
      if(slot.timer){clearTimeout(slot.timer);slot.timer=null;}
      if(slot.heartbeat){clearInterval(slot.heartbeat);slot.heartbeat=null;}
      slot.busy=false;slot.job=null;
      const fallback = fallbackTrackFor(info);
      if (fallback && !tracks.some(t => t.path === fallback.path)) tracks.push(fallback);
      skipped++; done++;
      sendProgress(info?.path ? path.basename(info.path) : '', 'Scanning changed files');
      if(dispatchNext) dispatch(slot); completeIfDone();
    };
    const dispatch = slot => {
      if(finished || slot.busy || slot.stopping)return completeIfDone();
      const i=cursor++; if(i>=changed.length)return completeIfDone();
      const info=changed[i]; slot.busy=true; slot.job={index:i,info}; slot.startedAt=Date.now();
      scanLog('SCAN START', { index:i, done, total, file:info.path, worker:slot.child.pid });
      sendProgress(path.basename(info.path), 'Scanning changed files');
      slot.heartbeat=setInterval(()=>{
        if(!slot.busy||!slot.job)return;
        const elapsed=Date.now()-slot.startedAt;
        sendProgress(path.basename(slot.job.info.path), `Scanning changed files · ${Math.floor(elapsed/1000)}s on current file`);
        if(elapsed >= 2000) scanLog('SCAN WAIT', { ms:elapsed, file:slot.job.info.path, worker:slot.child.pid });
      }, 1000);
      slot.timer=setTimeout(()=>{
        if(!slot.busy||!slot.job)return;
        const stuck=slot.job.info; const elapsed=Date.now()-slot.startedAt;
        scanLog('SCAN TIMEOUT - killing worker and continuing', { ms:elapsed, file:stuck.path, worker:slot.child.pid });
        try{slot.child.kill('SIGKILL');}catch{}
        markSkippedAndContinue(slot,stuck,false); replaceWorker(slot);
      },JOB_TIMEOUT_MS);
      try { slot.child.send({type:'scan',id:i,filePath:info.path,coversDir:COVERS_DIR()}); }
      catch { scanLog('SCAN SEND ERROR', { file:info.path, worker:slot.child.pid }); markSkippedAndContinue(slot,info); }
    };
    const attach = slot => {
      slot.child.on('message', msg => {
        if(finished||!slot.busy||!slot.job)return;
        if(!msg||msg.id!==slot.job.index)return;
        const info=slot.job.info;
        if(slot.timer){clearTimeout(slot.timer);slot.timer=null;}
        if(slot.heartbeat){clearInterval(slot.heartbeat);slot.heartbeat=null;}
        const elapsed = Date.now() - slot.startedAt;
        slot.busy=false;slot.job=null;
        scanLog(msg.type==='result' && msg.track ? 'SCAN DONE' : 'SCAN ERROR', { ms:elapsed, file:info.path, worker:slot.child.pid, error:msg.error || undefined });
        if(msg.type==='result'&&msg.track) {
          try {
            const enriched = enrichTrack(msg.track,info);
            tracks.push(enriched);
            try { evt.sender.send('library:scanTrack', progressiveTrackPayload(enriched)); } catch {}
          } catch (err) {
            scanLog('SCAN RESULT HANDLER ERROR', { file:info.path, worker:slot.child.pid, error:String(err?.stack || err) });
            const fallback = fallbackTrackFor(info);
            if (fallback && !tracks.some(t => t.path === fallback.path)) tracks.push(fallback);
            skipped++;
          }
        } else {
          const fallback = fallbackTrackFor(info);
          if (fallback && !tracks.some(t => t.path === fallback.path)) tracks.push(fallback);
          skipped++;
        }
        done++;
        sendProgress(path.basename(info.path), 'Scanning changed files');
        slot.completed++;
        if(slot.completed>=WORKER_RECYCLE_AFTER && cursor<changed.length){
          slot.stopping=true; try{slot.child.disconnect();}catch{} try{slot.child.kill();}catch{};
          const idx=pool.indexOf(slot), replacement=spawnScanner(); pool.splice(pool.indexOf(replacement),1); pool[idx]=replacement;
          attach(replacement); dispatch(replacement); completeIfDone(); return;
        }
        dispatch(slot); completeIfDone();
      });
      const childFailure = () => {
        if(finished||slot.stopping)return;
        if(slot.busy&&slot.job){const info=slot.job.info;if(slot.timer){clearTimeout(slot.timer);slot.timer=null;}markSkippedAndContinue(slot,info,false);}
        replaceWorker(slot);
      };
      slot.child.on('error', childFailure);
      slot.child.on('exit', childFailure);
    };
    for(let i=0;i<workerCount;i++){const slot=spawnScanner();attach(slot);}
    for(const slot of pool)dispatch(slot);
  });

  // In normal mode, unchanged files count as already processed. In a full
  // authoritative rescan every file is reparsed so embedded tags override any
  // stale Beehive cache and newly added files are guaranteed to enter the library.
  done = unchanged.length;
  sendProgress('', changed.length ? 'Scanning changed files' : 'No changes detected');
  await runPool();

  // Love is part of normal library reconciliation, not a separate Favorites
  // scanner. A one-time compatibility version lets us repair caches created by
  // older readers without forcing every future startup to reopen every file.
  // Changed/new files were already read by scanner-worker above; this pass is
  // only for unchanged records whose cached Love state predates the current
  // authoritative reader. Failed reads deliberately retain their old state and
  // remain candidates for a later scan.
  const staleLoveTracks = forceFull ? [] : tracks.filter(t => t && (
    t.loveHydrated !== true ||
    !Number.isFinite(Number(t.loveCheckedMtimeMs)) ||
    !Number.isFinite(Number(t.loveCheckedSize)) ||
    Number(t.loveScanVersion || 0) < LOVE_SCAN_VERSION
  ));
  if (staleLoveTracks.length) {
    scanLog('LOVE RECONCILIATION START', { total: staleLoveTracks.length, version: LOVE_SCAN_VERSION });
    let loveCursor = 0;
    let loveDone = 0;
    let loveUpdated = 0;
    let loveFailed = 0;
    const loveWorkers = Array.from({ length: Math.min(12, staleLoveTracks.length) }, async () => {
      while (true) {
        const i = loveCursor++;
        if (i >= staleLoveTracks.length) return;
        const track = staleLoveTracks[i];
        const filePath = String(track.path || '');
        try {
          const stat = await fsp.stat(filePath);
          const value = !!(await readLoveStateFromDisk(filePath));
          track.loved = value;
          track.loveHydrated = true;
          track.loveCheckedMtimeMs = Number(stat.mtimeMs || 0);
          track.loveCheckedCtimeMs = Number(stat.ctimeMs || 0);
          track.loveCheckedSize = Number(stat.size || 0);
          track.fileMtimeMs = Number(stat.mtimeMs || track.fileMtimeMs || 0);
          track.fileCtimeMs = Number(stat.ctimeMs || track.fileCtimeMs || 0);
          track.fileSize = Number(stat.size || track.fileSize || 0);
          track.loveScanVersion = LOVE_SCAN_VERSION;
          loveUpdated++;
          try { evt.sender.send('library:scanTrack', track); } catch {}
        } catch (err) {
          loveFailed++;
          scanLog('LOVE RECONCILIATION READ FAILED', { file: filePath, error: err?.message || String(err) });
        }
        loveDone++;
        if (loveDone === staleLoveTracks.length || loveDone % 250 === 0) {
          sendProgress(path.basename(filePath), 'Reconciling embedded Love tags');
        }
      }
    });
    await Promise.all(loveWorkers);
    scanLog('LOVE RECONCILIATION FINISHED', { total: staleLoveTracks.length, updated: loveUpdated, failed: loveFailed, version: LOVE_SCAN_VERSION });
  }

  if (total > 0 && tracks.length === 0 && oldTracks.length) {
    throw new Error('Library scan found no readable audio tracks; keeping the previous library.');
  }

  // Keep the cache ordered like the filesystem scan, while retaining the cached
  // metadata for unchanged files. This also drops files that were deleted.
  const byPath = new Map(tracks.map(t => [t.path, t]));
  const ordered = [];
  for (const info of fileInfo) if (info && byPath.has(info.path)) ordered.push(byPath.get(info.path));
  // Love/favorite state is part of the same reconciliation result. Changed
  // files are refreshed by scanner-worker, while unchanged records that need a
  // compatibility migration are refreshed by the bounded Love pass above.
  // There is no separate Favorites scan in the normal library path.
  scanLog('Library scan finished', { total, tracks: ordered.length, skipped });
  const result = { tracks: ordered, scannedAt: Date.now() };
  await writeJsonSafe(LIBRARY_CACHE_PATH(), result);
  await persistLibraryDatabase(ordered);
  return result;
  } finally {
    releaseLibraryScan();
  }
});

ipcMain.handle('history:get', async () => {
  const history = await readJsonSafe(HISTORY_PATH(), []);
  return Array.isArray(history) ? history.sort((a,b) => Number(b.playedAt || 0) - Number(a.playedAt || 0)) : [];
});


async function readEmbeddedPlayCount(trackPath) {
  const metadataLib = await ensureMM();
  const meta = await metadataLib.parseFile(trackPath, { duration: false, skipCovers: true });
  const common = meta?.common || {};
  const first = value => Array.isArray(value) ? (value.length ? value[0] : '') : value;
  const raw = first(common.p_count ?? common.pcount ?? '');
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function writeEmbeddedPlayCount(trackPath, value) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  const nextValue = Math.max(0, Math.min(0xFFFFFFFF, Math.floor(Number(value) || 0)));
  const ext = path.extname(trackPath).toLowerCase();
  const temp = `${trackPath}.beehive-pcount-${crypto.randomBytes(6).toString('hex')}${ext}`;
  try {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', trackPath,
      '-map', '0',
      '-map_metadata', '0',
      '-c', 'copy'
    ];
    if (ext === '.mp3') args.push('-id3v2_version', '3', '-write_id3v1', '0');
    if (ext === '.m4a' || ext === '.mp4' || ext === '.m4b') args.push('-movflags', 'use_metadata_tags');
    args.push('-metadata', `p_count=${nextValue}`);
    await runFfmpeg([...args, temp]);
    const st = await fsp.stat(temp);
    if (!st.size) throw new Error('metadata writer produced an empty file');

    const written = await readEmbeddedPlayCount(temp);
    if (written !== nextValue) {
      throw new Error(`P_count verification failed: expected ${nextValue}, read back ${written}`);
    }
    await fsp.rename(temp, trackPath);
    return nextValue;
  } catch (err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not embed P_count: ${err.message}`);
  }
}

async function embedPlayCountDelta(trackPath, delta) {
  const amount = Math.max(0, Math.floor(Number(delta) || 0));
  if (!amount) return { embedded: false, pCount: await readEmbeddedPlayCount(trackPath) };
  return withMusicBeeWriteLock(trackPath, async () => {
    const current = await readEmbeddedPlayCount(trackPath);
    const next = Math.min(0xFFFFFFFF, current + amount);
    await writeEmbeddedPlayCount(trackPath, next);
    return { embedded: true, pCount: next };
  });
}

ipcMain.handle('track:recordPlay', async (_evt, trackPath, meta = {}) => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  const entry = stats[trackPath] || { playCount: 0, lastPlayedAt: 0 };
  entry.playCount = Number(entry.playCount || 0) + 1;
  entry.lastPlayedAt = Date.now();
  stats[trackPath] = entry;

  // If enabled, embed only the new local plays since the last successful
  // embedding. This preserves the file's existing P_count and prevents a
  // second enable/restart from adding the same local plays twice.
  let pCountEmbedding = null;
  try {
    const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
    if (config.embedPlayCounts) {
      const previousEmbeddedLocal = Number(entry.pCountEmbeddedLocal);
      const baseline = Number.isFinite(previousEmbeddedLocal) && previousEmbeddedLocal >= 0 ? previousEmbeddedLocal : 0;
      const delta = Math.max(0, entry.playCount - baseline);
      if (delta > 0) {
        pCountEmbedding = await embedPlayCountDelta(trackPath, delta);
        entry.pCountEmbeddedLocal = entry.playCount;
        stats[trackPath] = entry;
      } else if (entry.playCount >= baseline) {
        entry.pCountEmbeddedLocal = entry.playCount;
        stats[trackPath] = entry;
      }
    }
  } catch (err) {
    // Local play statistics must never be lost because embedding failed.
    // The baseline is intentionally left unchanged so the next play can retry
    // the outstanding local delta instead of silently losing it.
    console.warn('Could not embed local play count into file:', trackPath, err?.message || err);
    pCountEmbedding = { embedded: false, error: err?.message || String(err) };
  }
  await writeJsonSafe(STATS_PATH(), stats);

  // Keep the library cache synchronized with the durable play statistic.
  // Otherwise a fresh launch can load an older cached playCount until the next
  // full/incremental scan, making the counter appear to have disappeared.
  try {
    const libraryCache = await readJsonSafe(LIBRARY_CACHE_PATH(), null);
    if (libraryCache && Array.isArray(libraryCache.tracks)) {
      let changed = false;
      libraryCache.tracks = libraryCache.tracks.map(track => {
        if (String(track?.path || '') !== String(trackPath)) return track;
        changed = true;
        return { ...track, playCount: entry.playCount, lastPlayedAt: entry.lastPlayedAt };
      });
      if (changed) await writeJsonSafe(LIBRARY_CACHE_PATH(), libraryCache);
    }
  } catch {}

  const history = await readJsonSafe(HISTORY_PATH(), []);
  const snapshot = { title: meta.title || '', artist: meta.artist || '', album: meta.album || '', cover: meta.cover || null };
  const next = [{ path: trackPath, playedAt: entry.lastPlayedAt, ...snapshot }, ...history.filter(h => h.path !== trackPath)];
  await writeJsonSafe(HISTORY_PATH(), next.slice(0, 500));
  return { ...entry, pCountEmbedding };
}));


ipcMain.handle('stats:embedCurrentPlayCounts', async () => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  const results = { total: 0, embedded: 0, skipped: 0, failed: 0, errors: [] };
  const entries = Object.entries(stats);
  for (const [trackPath, rawEntry] of entries) {
    if (!trackPath) continue;
    const entry = rawEntry && typeof rawEntry === 'object' ? { ...rawEntry } : {};
    const localCount = Math.max(0, Math.floor(Number(entry.playCount) || 0));
    const baselineRaw = Number(entry.pCountEmbeddedLocal);
    const baseline = Number.isFinite(baselineRaw) && baselineRaw >= 0 ? baselineRaw : 0;
    const delta = Math.max(0, localCount - baseline);
    results.total += 1;
    if (!delta) {
      entry.pCountEmbeddedLocal = localCount;
      stats[trackPath] = entry;
      results.skipped += 1;
      continue;
    }
    try {
      const result = await embedPlayCountDelta(trackPath, delta);
      entry.pCountEmbeddedLocal = localCount;
      stats[trackPath] = entry;
      results.embedded += 1;
    } catch (err) {
      results.failed += 1;
      results.errors.push({ path: trackPath, error: err?.message || String(err) });
    }
  }
  await writeJsonSafe(STATS_PATH(), stats);
  return results;
}));

ipcMain.handle('stats:importEmbeddedPlayCounts', async () => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  const libraryCache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const tracks = Array.isArray(libraryCache.tracks) ? libraryCache.tracks : [];
  const candidates = tracks.map(t => String(t?.path || '')).filter(Boolean);
  const results = { total: candidates.length, checked: 0, imported: 0, unchanged: 0, failed: 0, errors: [] };
  let cursor = 0;
  const workerCount = Math.min(8, Math.max(1, candidates.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const trackPath = candidates[i];
      try {
        const embedded = await readEmbeddedPlayCount(trackPath);
        const entry = stats[trackPath] && typeof stats[trackPath] === 'object' ? { ...stats[trackPath] } : { playCount: 0, lastPlayedAt: 0 };
        const local = Math.max(0, Math.floor(Number(entry.playCount) || 0));
        // Embedded P_count is durable history. Never lower a larger local count,
        // but remember the file count as the embedding baseline so future local
        // plays are added exactly once.
        if (embedded > local) {
          entry.playCount = embedded;
          results.imported++;
        } else {
          results.unchanged++;
        }
        const baseline = Number(entry.pCountEmbeddedLocal);
        entry.pCountEmbeddedLocal = Number.isFinite(baseline) && baseline > embedded ? baseline : embedded;
        stats[trackPath] = entry;
        results.checked++;
      } catch (err) {
        results.failed++;
        if (results.errors.length < 100) results.errors.push({ path: trackPath, error: err?.message || String(err) });
      }
    }
  });
  await Promise.all(workers);
  await writeJsonSafe(STATS_PATH(), stats);
  if (Array.isArray(libraryCache.tracks)) {
    libraryCache.tracks = libraryCache.tracks.map(track => {
      const entry = stats[track.path];
      return entry ? { ...track, playCount: Number(entry.playCount || 0) } : track;
    });
    await writeJsonSafe(LIBRARY_CACHE_PATH(), libraryCache);
  }
  return results;
}));

ipcMain.handle('stats:clearPlayCounts', async () => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  let cleared = 0;
  const nextStats = { ...stats };
  for (const [trackPath, rawEntry] of Object.entries(nextStats)) {
    const entry = rawEntry && typeof rawEntry === 'object' ? { ...rawEntry } : {};
    const previous = Number(entry.playCount || 0);
    if (previous > 0) cleared += previous;
    entry.playCount = 0;
    // Clearing Beehive's local counter must not erase the file's P_count.
    // Reset only the local embedding baseline so future plays are added again
    // starting from zero local plays.
    entry.pCountEmbeddedLocal = 0;
    nextStats[trackPath] = entry;
  }
  await writeJsonSafe(STATS_PATH(), nextStats);

  // Keep the cached library in sync so the UI and the next startup both show
  // zero Beehive play counts without rescanning or touching any music files.
  const libraryCache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  if (Array.isArray(libraryCache.tracks)) {
    libraryCache.tracks = libraryCache.tracks.map(track => ({ ...track, playCount: 0 }));
    await writeJsonSafe(LIBRARY_CACHE_PATH(), libraryCache);
  }

  return { cleared };
}));

ipcMain.handle('tracks:setRatings', async (evt, trackPaths = [], rating) => withStatsMutation(async () => {
  const paths = [...new Set((Array.isArray(trackPaths) ? trackPaths : [])
    .filter(Boolean)
    .map(p => String(p)))];
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  const stats = await readJsonSafe(STATS_PATH(), {});
  const results = { updated: 0, failed: 0, errors: [] };
  const total = paths.length;
  sendTagProgress(evt, { active: true, operation: 'rating', operationLabel: `Rating ${total.toLocaleString()} files`, phase: 'Writing ratings', done: 0, total, updated: 0, failed: 0, current: '' });
  let lastProgressAt = 0;
  try {
    // Serialize bulk writes. The underlying writers replace complete media
    // files (MP3/WAV ID3 rewrites and FFmpeg container rewrites), so parallel
    // metadata jobs can race with filesystem watchers/decoders and make a
    // bulk Clear appear to succeed while one or more files retain the old
    // rating. Individual rating writes were already serialized by their own
    // file locks; bulk now follows the same safe rule.
    for (let i = 0; i < paths.length; i++) {
      const trackPath = paths[i];
      const recoveryJob = { id:crypto.randomUUID(), kind:'rating', path:path.resolve(String(trackPath)), rating:value, createdAt:Date.now() };
      await persistMetadataJob(recoveryJob, 'running', 1, '');
      try {
        markLibraryInternalWrite(trackPath);
        await embedRatingInFile(trackPath, value);
        const entry = stats[trackPath] || { playCount: 0, lastPlayedAt: 0 };
        entry.rating = value;
        entry.ratingSource = 'beehive';
        stats[trackPath] = entry;
        results.updated += 1;
        await deleteMetadataJob(recoveryJob.id);
      } catch (err) {
        results.failed += 1;
        await updateMetadataJob(recoveryJob.id, 'retry', 1, err?.message || String(err));
        results.errors.push({ path: trackPath, error: err?.message || String(err) });
      }

      const done = i + 1;
      const now = Date.now();
      if (done === total || now - lastProgressAt >= 100) {
        lastProgressAt = now;
        sendTagProgress(evt, { active: true, operation: 'rating', operationLabel: `Rating ${total.toLocaleString()} files`, phase: 'Writing ratings', done, total, updated: results.updated, failed: results.failed, current: path.basename(trackPath) });
      }
    }
    await writeJsonSafe(STATS_PATH(), stats);
    return { ...results, rating: value };
  } finally {
    sendTagProgress(evt, { active: false, operation: 'rating', operationLabel: 'Rating complete', phase: results.failed ? 'Finished with errors' : 'Finished', done: total, total, updated: results.updated, failed: results.failed, current: '' });
  }
}));

ipcMain.handle('track:setRating', async (_evt, trackPath, rating) => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  const entry = stats[trackPath] || { playCount: 0, lastPlayedAt: 0 };
  const recoveryJob = { id:crypto.randomUUID(), kind:'rating', path:path.resolve(String(trackPath)), rating:value, createdAt:Date.now() };
  await persistMetadataJob(recoveryJob, 'running', 1, '');
  try {
    await embedRatingInFile(trackPath, value);
    await deleteMetadataJob(recoveryJob.id);
  } catch (err) {
    await updateMetadataJob(recoveryJob.id, 'retry', 1, err?.message || String(err));
    throw err;
  }
  entry.rating = value;
  entry.ratingSource = 'beehive';
  stats[trackPath] = entry;
  await writeJsonSafe(STATS_PATH(), stats);
  return value;
}));

ipcMain.handle('track:readLove', async (_evt, trackPath) => {
  try { return await readLoveStateFromDisk(trackPath); }
  catch { return false; }
});

ipcMain.handle('tracks:readLove', async (_evt, paths = []) => {
  const out = {};
  const list = Array.isArray(paths) ? [...new Set(paths.filter(Boolean).map(String))] : [];
  let cursor = 0;
  const concurrency = 12;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      const filePath = list[i];
      try { out[filePath] = await readLoveStateFromDisk(filePath); }
      catch { out[filePath] = false; }
    }
  });
  await Promise.all(workers);
  return out;
});

ipcMain.handle('library:needsLovedRefresh', async () => {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const tracks = Array.isArray(cache.tracks) ? cache.tracks : [];
  // Only request the one-time migration refresh when we have tracks that have
  // never had their embedded Love state successfully checked. Normal scans
  // mark new/changed files with their exact mtime/size, so they do not need a
  // second full-library Love pass on the next startup.
  return tracks.some(t => t && (t.loveHydrated !== true || !Number.isFinite(Number(t.loveCheckedMtimeMs)) || !Number.isFinite(Number(t.loveCheckedSize)) || Number(t.loveScanVersion || 0) < LOVE_SCAN_VERSION));
});

ipcMain.handle('library:refreshLoved', async (evt) => {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const tracks = Array.isArray(cache.tracks) ? cache.tracks : [];
  const total = tracks.length;
  let done = 0, loved = 0, failed = 0;
  let cursor = 0, lastProgressAt = 0;
  sendTagProgress(evt, { active: true, operation: 'love-refresh', operationLabel: 'Refreshing Favorites', phase: 'Reading embedded Love state', done: 0, total, updated: 0, failed: 0, skipped: 0, current: '' });
  try {
    if (!total) return { tracks: [], total: 0, loved: 0, failed: 0 };
    const concurrency = Math.min(24, total);
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= total) return;
        const track = tracks[i];
        const filePath = String(track?.path || '');
        try {
          const exists = !!filePath && fs.existsSync(filePath);
          if (!exists) throw new Error('File not found');
          const stat = await fs.promises.stat(filePath);
          const value = !!(await readLoveStateFromDisk(filePath));
          track.loved = value;
          track.loveHydrated = true;
          track.loveCheckedMtimeMs = Number(stat.mtimeMs || 0);
          track.loveCheckedCtimeMs = Number(stat.ctimeMs || 0);
          track.loveCheckedSize = Number(stat.size || 0);
          track.loveScanVersion = LOVE_SCAN_VERSION;
          if (value) loved++;
        } catch (err) {
          failed++;
          // A failed read is not a successful check. Keep the previous cached
          // Love value and leave the check markers untouched so a later manual
          // refresh can retry it.
        }
        done++;
        const now = Date.now();
        if (done === total || now - lastProgressAt >= 150) {
          lastProgressAt = now;
          sendTagProgress(evt, { active: true, operation: 'love-refresh', operationLabel: 'Refreshing Favorites', phase: 'Reading embedded Love state', done, total, updated: loved, failed, skipped: 0, current: path.basename(filePath) });
        }
      }
    });
    await Promise.all(workers);
    cache.tracks = tracks;
    await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
    await persistLibraryDatabase(tracks);
    scanLog('Favorites Love reconciliation finished', { total, loved, failed });
    return { tracks, total, loved, failed };
  } finally {
    sendTagProgress(evt, { active: false, operation: 'love-refresh', operationLabel: failed ? 'Favorites refresh finished with errors' : 'Favorites refresh complete', phase: failed ? 'Some files could not be checked' : 'Finished', done, total, updated: loved, failed, skipped: 0, current: '' });
  }
});

ipcMain.handle('tracks:readRatings', async (_evt, paths = []) => {
  const out = {};
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  const readOne = async (filePath) => {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.mp3') {
        const raw = await readMp3PopmRaw(filePath);
        // MusicBee's 5-star POPM value is exactly 255. Treat that byte as
        // authoritative rather than relying on any normalized parser output.
        out[filePath] = { stars: raw === 255 ? 5 : musicBeePopmStars(raw), raw };
        return;
      }
      const stars = await readEmbeddedRating(filePath);
      out[filePath] = { stars, raw: 0 };
    } catch {
      // Leave an unreadable/unsupported file alone rather than falsely setting it to zero.
    }
  };
  const concurrency = 12;
  let cursor = 0;
  const workers = Array.from({length: Math.min(concurrency, list.length)}, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      await readOne(list[i]);
    }
  });
  await Promise.all(workers);
  return out;
});

ipcMain.handle('tracks:updateCachedLoves', async (_evt, loves = {}) => {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const values = loves && typeof loves === 'object' ? loves : {};
  let changed = false;
  for (const t of (cache.tracks || [])) {
    if (!t?.path || !Object.prototype.hasOwnProperty.call(values, t.path)) continue;
    const value = !!values[t.path];
    if (!!t.loved !== value || t.loveHydrated !== true) changed = true;
    t.loved = value;
    t.loveHydrated = true;
    t.loveScanVersion = LOVE_SCAN_VERSION;
  }
  if (changed) await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
  return true;
});

ipcMain.handle('tracks:updateCachedRatings', async (_evt, ratings = {}) => {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const values = ratings && typeof ratings === 'object' ? ratings : {};
  for (const t of (cache.tracks || [])) {
    if (!t?.path || !Object.prototype.hasOwnProperty.call(values, t.path)) continue;
    t.rating = Math.max(0, Math.min(5, Number(values[t.path]) || 0));
    t.ratingRaw = t.rating >= 5 ? 255 : 0;
    t.ratingHydrated = true;
  }
  await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
  return true;
});

ipcMain.handle('tracks:embedRatings', async (_evt, tracks = []) => {
  const results = { embedded: 0, failed: 0, errors: [] };
  for (const item of Array.isArray(tracks) ? tracks : []) {
    try {
      if (!item?.path) continue;
      await embedRatingInFile(item.path, Number(item.rating) || 0);
      results.embedded += 1;
    } catch (err) {
      results.failed += 1;
      results.errors.push({ path: item?.path, error: err.message });
    }
  }
  return results;
});

function decodeGeniusHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '\"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } });
}

function stripGeniusLyricsHtml(html) {
  return decodeGeniusHtmlEntities(String(html || '')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(?:div|p|li|h[1-6])>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
  ).replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeLyricMatch(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function searchGeniusLyrics(artist, title) {
  const query = `${artist} ${title}`.trim();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
  };
  const wantedArtist = normalizeLyricMatch(artist);
  const wantedTitle = normalizeLyricMatch(title);
  const candidates = [];

  // Genius' public search page is intentionally used first. This does not require
  // a Genius API token and keeps lyric discovery inside Genius itself.
  try {
    const searchResponse = await fetch(`https://genius.com/search?q=${encodeURIComponent(query)}`, { headers });
    if (searchResponse.ok) {
      const html = await searchResponse.text();
      const hrefRe = /(?:href|data-href)=[\"'](?:https?:\/\/genius\.com)?(\/[^\"']+?-lyrics)(?:[\"'])/gi;
      let match;
      while ((match = hrefRe.exec(html))) {
        const href = `https://genius.com${match[1]}`;
        if (!candidates.some(c => c.url === href)) candidates.push({ url: href });
      }
    }
  } catch (_) {}

  // Some Genius responses expose their search results as JSON. Try that as a
  // second Genius-only discovery path before falling back to another lyrics source.
  if (!candidates.length) {
    try {
      const apiResponse = await fetch(`https://genius.com/api/search/multi?per_page=10&q=${encodeURIComponent(query)}`, { headers });
      if (apiResponse.ok) {
        const data = await apiResponse.json();
        for (const section of (data?.response?.sections || [])) {
          for (const hit of (section?.hits || [])) {
            const result = hit?.result;
            const url = String(result?.url || '');
            if (/^https?:\/\/genius\.com\/[^\s]+-lyrics$/i.test(url) && !candidates.some(c => c.url === url)) {
              candidates.push({ url, title: result?.title, artist: result?.primary_artist?.name });
            }
          }
        }
      }
    } catch (_) {}
  }

  // Score candidate slugs/metadata so a broad Genius search does not accidentally
  // display a similarly named song by another artist.
  const scoreGeniusCandidate = item => {
    const hay = normalizeLyricMatch(`${item.title || ''} ${item.artist || ''} ${item.url || ''}`);
    let n = 0;
    if (wantedTitle && hay.includes(wantedTitle)) n += 4;
    if (wantedArtist && hay.includes(wantedArtist)) n += 4;
    return n;
  };
  candidates.sort((a, b) => scoreGeniusCandidate(b) - scoreGeniusCandidate(a));

  // Require both artist and title to be represented in the Genius result before
  // displaying it. A broad search must never silently replace the requested song
  // with a similarly titled track.
  for (const candidate of candidates.filter(item => scoreGeniusCandidate(item) >= 8).slice(0, 8)) {
    try {
      const response = await fetch(candidate.url, { headers });
      if (!response.ok) continue;
      const html = await response.text();
      const blocks = [];
      const blockRe = /<div[^>]*data-lyrics-container=[\"']true[\"'][^>]*>([\s\S]*?)<\/div>/gi;
      let block;
      while ((block = blockRe.exec(html))) {
        const text = stripGeniusLyricsHtml(block[1]);
        if (text) blocks.push(text);
      }
      const lyrics = blocks.join('\n\n').trim();
      if (lyrics) return lyrics;
    } catch (_) {}
  }
  return null;
}

async function searchLrcLibLyrics(artist, title, album, duration) {
  const params = new URLSearchParams({ track_name: title, artist_name: artist });
  if (album) params.set('album_name', album);
  if (Number.isFinite(duration) && duration > 0) params.set('duration', String(Math.round(duration)));
  try {
    const response = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
      headers: { 'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz)' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const lyrics = String(data?.plainLyrics || '').trim();
    return lyrics || null;
  } catch (_) {
    return null;
  }
}

ipcMain.handle('lyrics:search', async (_evt, query = {}) => {
  const artist = String(query.artist || '').trim();
  const title = String(query.title || '').trim();
  const album = String(query.album || '').trim();
  const duration = Number(query.duration || 0);
  if (!artist || !title) return null;

  // Online fallback order is deliberate: Genius first, then the existing LRCLIB
  // lookup. Embedded/local lyrics are still handled by the renderer first and are
  // never overwritten by either online source.
  const geniusLyrics = await searchGeniusLyrics(artist, title);
  if (geniusLyrics) return geniusLyrics;
  return searchLrcLibLyrics(artist, title, album, duration);
});

ipcMain.handle('track:hasEmbeddedArtwork', async (_evt, trackPath) => {
  if (!trackPath || !fs.existsSync(trackPath)) return false;
  try {
    const native = await runTagHelper({ op: 'read_artwork', path: trackPath });
    return Array.isArray(native?.pictures) && native.pictures.length > 0;
  } catch {
    // Fall back to music-metadata only if the native helper cannot inspect the file.
    try {
      const metadataLib = await ensureMM();
      const meta = await metadataLib.parseFile(trackPath, { duration: false, skipCovers: false });
      return Array.isArray(meta?.common?.picture) && meta.common.picture.length > 0;
    } catch { return false; }
  }
});

ipcMain.handle('track:readTags', async (_evt, trackPath) => {
  const metadataLib = await ensureMM();
  const meta = await metadataLib.parseFile(trackPath, { duration: true, skipCovers: false });
  let stat = null;
  try { const st = await fsp.stat(trackPath); stat = { size: st.size, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs }; } catch {}
  // Keep a compact, content-based artwork signature for the multi-file tag editor.
  // Comparing image bytes rather than cached cover paths lets the editor reliably
  // detect when even one selected album track has different embedded artwork.
  const pictures = (Array.isArray(meta.common?.picture) ? meta.common.picture : []).map((picture, index) => {
    let data = picture?.data;
    try {
      if (Buffer.isBuffer(data)) data = data;
      else if (data instanceof Uint8Array) data = Buffer.from(data);
      else if (data?.type === 'Buffer' && Array.isArray(data.data)) data = Buffer.from(data.data);
      else if (Array.isArray(data)) data = Buffer.from(data);
      else if (typeof data === 'string') data = Buffer.from(data, 'base64');
      else data = Buffer.alloc(0);
    } catch { data = Buffer.alloc(0); }
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const mime = String(picture?.format || 'image/jpeg');
    return {
      // music-metadata can expose picture types as enum strings such as
      // `PictureType.COVER_BACK`. Normalize those before the native helper
      // fallback reaches the artwork editor so the dropdown can select the
      // actual Cover (Back) option rather than displaying the raw enum name.
      type: normalizePictureType(picture?.type || 'Other'),
      mime,
      description: String(picture?.description || ''),
      hash,
      index,
      dataUrl: data.length ? `data:${mime};base64,${data.toString('base64')}` : ''
    };
  });
  let nativePictures = pictures;
  let nativeCompilation = null;
  try {
    const native = await runTagHelper({ op: 'read_artwork', path: trackPath });
    nativePictures = (native.pictures || []).map(p => ({
      type: String(p.type || 'Other'), mime: String(p.mime || 'image/jpeg'), description: String(p.description || ''),
      hash: crypto.createHash('sha256').update(Buffer.from(p.dataBase64 || '', 'base64')).digest('hex'), index: Number(p.index || 0),
      dataUrl: p.dataBase64 ? `data:${String(p.mime || 'image/jpeg')};base64,${p.dataBase64}` : ''
    }));

    // readTags() is also used to refresh the currently playing queue entry.
    // The native artwork helper returns the actual embedded bytes, but historically
    // this response only exposed a data URL and dropped Beehive's persistent cover
    // cache filename. That meant the queue/now-playing UI could still display an
    // image while MPRIS (and Music Presence) had no local file to expose, resulting
    // in playing tracks with no artwork. Cache every embedded picture here and return
    // its stable cache filename so every consumer uses the same artwork source.
    try {
      const cachePictures = (native.pictures || []).map(p => ({
        data: Buffer.from(String(p.dataBase64 || ''), 'base64'),
        format: String(p.mime || 'image/jpeg'),
        type: String(p.type || 'Other')
      })).filter(p => p.data.length);
      const cached = await extractAndCacheCovers(cachePictures);
      const byHash = new Map(cached.map(item => [item.hash, item]));
      nativePictures = nativePictures.map(item => {
        const cachedItem = byHash.get(crypto.createHash('sha1').update(Buffer.from(String((native.pictures || [])[item.index]?.dataBase64 || ''), 'base64')).digest('hex'));
        return cachedItem ? { ...item, file: cachedItem.file } : item;
      });
    } catch (cacheErr) {
      console.warn('[Beehive] Embedded artwork cache refresh failed:', cacheErr?.message || cacheErr);
    }
    const compilation = await runTagHelper({ op: 'read_compilation', path: trackPath });
    nativeCompilation = String(compilation?.compilation || '0') === '1';
  } catch (err) { console.warn('[Beehive] Native metadata read fallback:', err.message); }
  const pictureSignatures = nativePictures.map(({ type, mime, hash, index }) => ({ type, mime, hash, index }));
  // Use the native helper as the source of truth for Compilation. This avoids
  // format-specific differences in music-metadata's normalized common tag.
  const normalizedCommon = { ...(meta.common || {}) };
  if (nativeCompilation !== null) normalizedCommon.compilation = nativeCompilation;
  return { common: normalizedCommon, native: meta.native || {}, format: meta.format || {}, stat, pictureSignatures, pictures: nativePictures };
});

ipcMain.handle('cover:choose', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg','jpeg','png','webp','gif','bmp'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const chosenPath = res.filePaths[0];
  const data = await fsp.readFile(chosenPath);
  const mime = ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp'})[path.extname(chosenPath).toLowerCase()] || 'application/octet-stream';
  return { path: chosenPath, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
});

function normalizePictureType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === '3' || raw.includes('front') || raw === 'album cover' || raw === 'cover') return 'Cover (Front)';
  if (raw === '4' || raw.includes('back') || raw === 'album cover (back)') return 'Cover (Back)';
  if (raw.includes('artist')) return 'Artist';
  return 'Other';
}

async function createMetadataTempPath(trackPath, label) {
  const ext = path.extname(trackPath).toLowerCase();
  const dir = path.join(app.getPath('temp'), 'beehive-metadata');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `media-${process.pid}-${Date.now()}-${label}-${crypto.randomBytes(8).toString('hex')}${ext}`);
}
async function commitMetadataTemp(temp, trackPath, background = false) {
  try {
    await fsp.rename(temp, trackPath);
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
    await copyMetadataFile(temp, trackPath, background);
    await fsp.unlink(temp);
  }
}

async function performWriteArtwork(trackPath, imagePath, artworkMeta = {}, options = {}) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  markLibraryInternalWrite(trackPath);
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error('Artwork file not found.');
  const protectedBefore = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: trackPath })).fingerprint;
  const ext = path.extname(trackPath).toLowerCase();
  const temp = await createMetadataTempPath(trackPath, 'art');
  try {
    await copyMetadataFile(trackPath, temp, !!options.background);
    const pictureType = normalizePictureType(artworkMeta?.pictureType || 'Cover (Front)');
    if (pictureType === 'Cover (Front)') {
      await runTagHelper({ __background: !!options.background, op: 'replace_front', path: temp, imagePath, pictureType: 'Cover (Front)', comment: String(artworkMeta?.comment || '') });
    } else {
      await runTagHelper({ __background: !!options.background, op: 'modify_artwork', path: temp, operation: { action:'add', imagePath, pictureType, comment: String(artworkMeta?.comment || '') } });
    }
    const verify = await runTagHelper({ __background: !!options.background, op: 'read_artwork', path: temp });
    const wanted = crypto.createHash('sha256').update(await fsp.readFile(imagePath)).digest('hex');
    const ok = (verify.pictures || []).some(pic => crypto.createHash('sha256').update(Buffer.from(pic.dataBase64 || '', 'base64')).digest('hex') === wanted);
    if (!ok) throw new Error('The new artwork could not be verified in the file after the save completed.');
    const protectedAfter = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: temp })).fingerprint;
    if (protectedBefore !== protectedAfter) throw new Error('Artwork save changed unrelated tags; the original file was left untouched.');
    await commitMetadataTemp(temp, trackPath, !!options.background);
    return true;
  } catch (err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not write artwork: ${err.message}`);
  }
}

async function performModifyArtwork(trackPath, operation = {}, options = {}) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  markLibraryInternalWrite(trackPath);
  const ext = path.extname(trackPath).toLowerCase();
  const protectedBefore = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: trackPath })).fingerprint;
  const temp = await createMetadataTempPath(trackPath, 'artmod');
  try {
    await copyMetadataFile(trackPath, temp, !!options.background);
    await runTagHelper({ __background: !!options.background, op: 'modify_artwork', path: temp, operation });
    const verify = await runTagHelper({ __background: !!options.background, op: 'read_artwork', path: temp });
    const protectedAfter = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: temp })).fingerprint;
    if (protectedBefore !== protectedAfter) throw new Error('Artwork edit changed unrelated tags; the original file was left untouched.');
    await commitMetadataTemp(temp, trackPath, !!options.background);
    return (verify.pictures || []).map(pic => ({ index:pic.index, type:pic.type, description:pic.description, mime:pic.mime }));
  } catch (err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not modify artwork: ${err.message}`);
  }
}

async function performRemoveFrontArtwork(trackPath, options = {}) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  markLibraryInternalWrite(trackPath);
  const ext = path.extname(trackPath).toLowerCase();
  // The artwork-excluded fingerprint includes all other metadata, including
  // Love and Rating. One before/after comparison is sufficient and avoids the
  // extra full-file reads that previously made bulk removal unnecessarily heavy.
  const protectedBefore = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: trackPath })).fingerprint;
  const temp = await createMetadataTempPath(trackPath, 'no-front');
  try {
    await copyMetadataFile(trackPath, temp, !!options.background);
    const result = await runTagHelper({ __background: !!options.background, op: 'remove_front', path: temp });
    const remaining = Array.isArray(result?.pictures) ? result.pictures : [];
    if (remaining.some(p => normalizePictureType(p?.type || 'Other') === 'Cover (Front)')) {
      throw new Error('Front artwork could not be fully removed from the file.');
    }
    const protectedAfter = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: temp })).fingerprint;
    if (protectedBefore !== protectedAfter) throw new Error('Artwork removal changed unrelated tags; the original file was left untouched.');
    await commitMetadataTemp(temp, trackPath, !!options.background);
    return true;
  } catch (err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not remove front artwork: ${err.message}`);
  }
}

async function performRemoveArtwork(trackPath, options = {}) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  markLibraryInternalWrite(trackPath);
  const ext = path.extname(trackPath).toLowerCase();
  const protectedBefore = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: trackPath })).fingerprint;
  const temp = await createMetadataTempPath(trackPath, 'no-art');
  try {
    await copyMetadataFile(trackPath, temp, !!options.background);
    // clear_artwork already rereads the pictures and returns the result. Avoid
    // launching a second artwork reader for the same file.
    const result = await runTagHelper({ __background: !!options.background, op: 'clear_artwork', path: temp });
    if ((result?.pictures || []).length) throw new Error('Embedded artwork could not be fully removed from the file.');
    const protectedAfter = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: temp })).fingerprint;
    if (protectedBefore !== protectedAfter) throw new Error('Artwork removal changed unrelated tags; the original file was left untouched.');
    await commitMetadataTemp(temp, trackPath, !!options.background);
    return true;
  } catch (err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not remove artwork: ${err.message}`);
  }
}

async function performWriteTags(trackPath, tags, options = {}) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  markLibraryInternalWrite(trackPath);
  const ext = path.extname(trackPath).toLowerCase();
  const temp = await createMetadataTempPath(trackPath, 'tags');
  try {
    await copyMetadataFile(trackPath, temp, !!options.background);
    await runTagHelper({ __background: !!options.background, op: 'write_tags', path: temp, tags: tags || {} });
    const st = await fsp.stat(temp);
    if (!st.size) throw new Error('native tag writer produced an empty file');
    const metadataLib = await ensureMM();
    const verify = await metadataLib.parseFile(temp, { duration: false, skipCovers: false });
    const got = verify?.common || {};
    const first = value => Array.isArray(value) ? (value[0] ?? '') : value;
    const norm = value => String(first(value) ?? '').trim();
    const mappings = [
      ['title','title'],['artist','artist'],['album','album'],['albumArtist','albumartist'],
      ['genre','genre'],['comment','comment'],['composer','composer'],['grouping','grouping'],
      ['copyright','copyright'],['publisher','publisher'],['conductor','conductor']
    ];
    for (const [key, commonKey] of mappings) {
      if (!Object.prototype.hasOwnProperty.call(tags || {}, key)) continue;
      if (norm(tags[key]) !== norm(got[commonKey])) throw new Error(`Tag write verification failed for ${key}: expected ${JSON.stringify(tags[key])}, read back ${JSON.stringify(got[commonKey])}`);
    }
    if (Object.prototype.hasOwnProperty.call(tags || {}, 'compilation')) {
      const nativeVerify = await runTagHelper({ __background: !!options.background, op: 'read_compilation', path: temp });
      const expected = String(tags.compilation) === '1' ? '1' : '0';
      const actual = String(nativeVerify?.compilation || '0') === '1' ? '1' : '0';
      if (expected !== actual) throw new Error(`Tag write verification failed for compilation: expected ${expected}, read back ${actual}`);
    }
    await commitMetadataTemp(temp, trackPath, !!options.background);
    return true;
  } catch (err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not write tags: ${err.message}`);
  }
}

// Direct single-file APIs remain available to the artwork editor, but all
// multi-file Save operations use the background batch queue below. This keeps
// file I/O out of the renderer/UI thread and gives every selected file its own
// completion result.
ipcMain.handle('metadata:bulkWriteStart', async (_evt, label = 'metadata') => { beginLibraryBulkWrite(String(label || 'metadata')); return true; });
ipcMain.handle('metadata:bulkWriteEnd', async (_evt, label = 'metadata') => { endLibraryBulkWrite(String(label || 'metadata')); return true; });
ipcMain.handle('track:writeArtwork', async (_evt, trackPath, imagePath, artworkMeta = {}) => performWriteArtwork(trackPath, imagePath, artworkMeta));
ipcMain.handle('track:modifyArtwork', async (_evt, trackPath, operation = {}, options = {}) => performModifyArtwork(trackPath, operation, { background: !!options?.background }));
ipcMain.handle('track:removeFrontArtwork', async (_evt, trackPath) => performRemoveFrontArtwork(trackPath));
ipcMain.handle('track:removeArtwork', async (_evt, trackPath) => performRemoveArtwork(trackPath));
ipcMain.handle('track:writeTags', async (_evt, trackPath, tags) => performWriteTags(trackPath, tags));

let metadataSaveQueue = Promise.resolve();

async function metadataJobAlreadySatisfied(job) {
  try {
    if (!job?.path || !fs.existsSync(job.path)) return false;
    if (job.kind === 'love') return (await readLoveStateFromDisk(job.path)) === !!job.loved;
    if (job.kind === 'rating') return Math.abs((Number(await readEmbeddedRating(job.path)) || 0) - (Number(job.rating) || 0)) < 0.01;
    if (job.kind === 'artwork:removeAll') { const r=await runTagHelper({op:'read_artwork',path:job.path}); return !(r?.pictures||[]).length; }
    if (job.kind === 'artwork:removeFront') { const r=await runTagHelper({op:'read_artwork',path:job.path}); return !(r?.pictures||[]).some(p=>normalizePictureType(p?.type||'Other')==='Cover (Front)'); }
    if (job.kind === 'artwork:add' || job.kind === 'artwork:replaceSlot') {
      if (!job.imagePath || !fs.existsSync(job.imagePath)) return false;
      const wanted=crypto.createHash('sha256').update(await fsp.readFile(job.imagePath)).digest('hex');
      const r=await runTagHelper({op:'read_artwork',path:job.path});
      return (r?.pictures||[]).some(p=>crypto.createHash('sha256').update(Buffer.from(p.dataBase64||'','base64')).digest('hex')===wanted);
    }
  } catch {}
  return false;
}

function enqueueMetadataSave(evt, jobs, options = {}) {
  const sender = evt?.sender || mainWindow?.webContents;
  const normalizedJobs = (Array.isArray(jobs) ? jobs : []).map(job => ({ ...job, id:String(job?.id || crypto.randomUUID()), createdAt:Number(job?.createdAt || Date.now()), path:String(job?.path || '') })).filter(job => job.path);
  metadataSaveQueue = metadataSaveQueue.then(() => new Promise((resolve) => {
    taskManager.enqueue('metadata', async () => {
      try { await runMetadataBatch(normalizedJobs, sender, options); } finally { resolve(); }
    }, { priority: 30 });
  }));
  return metadataSaveQueue;
}

async function runMetadataBatch(normalizedJobs, sender, options = {}) {
  try {
    // Durability comes before the physical write. Previously these journal writes
    // were fire-and-forget, so a fast shutdown could leave a file half-processed
    // with no recovery record at all.
    await Promise.all(normalizedJobs.map(job => persistMetadataJob(job, 'queued', Number(job.attempts||0), job.lastError || '')));
    const total=normalizedJobs.length; let done=0,updated=0,failed=0; const errors=[],updatedPaths=[];
    const sendProgress=(active,phase,current='')=>{ try{ sender?.send('library:tagProgress',{active,operationLabel:'Saving changes',phase,done,total,updated,failed,current,errors,paths:updatedPaths,recovered:!!options.recovered}); }catch{} };
    if(!total){sendProgress(false,'Finished');return;} sendProgress(true,'Writing');
    for(const job of normalizedJobs){
      let attempts=Number(job.attempts||0); let success=false; let lastError='';
      while(attempts<3 && !success){
        attempts++; await updateMetadataJob(job.id,'running',attempts,lastError);
        try {
          if(await metadataJobAlreadySatisfied(job)){ success=true; }
          else {
            if(job.kind==='love') await embedLoveInFile(job.path,!!job.loved);
            else if(job.kind==='rating') await embedRatingInFile(job.path, Number(job.rating)||0);
            else if(job.kind==='tags') await performWriteTags(job.path,job.perTrack||{},{background:true});
            else if(job.kind==='artwork:removeFront') await performRemoveFrontArtwork(job.path,{background:true});
            else if(job.kind==='artwork:removeAll') await performRemoveArtwork(job.path,{background:true});
            else if(job.kind==='artwork:replaceSlot'){ const data=await runTagHelper({op:'read_artwork',path:job.path}); const pictures=Array.isArray(data?.pictures)?data.pictures:[]; const targetType=normalizePictureType(job.slot?.type||'Other'); const occurrence=Math.max(1,Number(job.slot?.occurrence)||1); let seen=0,targetIndex=-1; for(let i=0;i<pictures.length;i++){if(normalizePictureType(pictures[i]?.type||'Other')!==targetType)continue; if(++seen===occurrence){targetIndex=i;break;}} if(targetIndex<0)throw new Error(`The ${job.slotLabel||'artwork'} is not present in this file.`); await performModifyArtwork(job.path,{action:'replace',index:targetIndex,imagePath:job.imagePath,pictureType:job.pictureType,comment:job.comment},{background:true}); }
            else if(job.kind==='artwork:add') await performWriteArtwork(job.path,job.imagePath,{pictureType:job.pictureType,comment:job.comment},{background:true});
            else throw new Error(`Unknown metadata job: ${job.kind}`);
            success=true;
          }
        } catch(err) {
          lastError=err?.message||String(err);
          await updateMetadataJob(job.id, attempts<3 ? 'retry' : 'failed', attempts, lastError);
          if(attempts<3) await new Promise(r=>setTimeout(r,500*attempts));
        }
      }
      done++;
      if(success){ updated++; updatedPaths.push(job.path); await deleteMetadataJob(job.id); }
      else { failed++; errors.push({path:job.path,error:lastError||'Metadata operation failed after 3 attempts.'}); }
      sendProgress(true,'Writing',path.basename(job.path));
      await new Promise(r=>setTimeout(r,75));
    }
    sendProgress(false,failed?'Finished with errors':'Finished');
  } catch (err) {
    try { sender?.send('library:tagProgress',{active:false,operationLabel:'Metadata save failed',phase:'Finished',done:0,total:normalizedJobs.length,updated:0,failed:normalizedJobs.length,errors:[{path:'',error:err?.message||String(err)}],paths:[],recovered:!!options.recovered}); } catch {}
  }
}

ipcMain.on('metadata:saveBatch', (evt, jobs) => enqueueMetadataSave(evt, jobs));

ipcMain.handle('library:searchDatabase', async (_evt, query = {}) => {
  const text = String(query.text || '').trim();
  if (!text) return [];
  return databaseRequest('search_tracks', { text, limit: Math.min(5000, Math.max(1, Number(query.limit) || 1000)) });
});
ipcMain.handle('library:taskStatus', async () => taskManager.status());
ipcMain.handle('beta:securityAudit', async () => runSecurityAudit(__dirname));
ipcMain.handle('beta:libraryHealth', async () => {
  const cached = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  return runLibraryHealth(Array.isArray(cached?.tracks) ? cached.tracks : []);
});
ipcMain.handle('beta:environmentAudit', async () => {
  const cfg = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  return runEnvironmentAudit(__dirname, {
    logDir: beehiveLogDir(),
    tempDir: path.join(app.getPath('temp'), 'BeehiveMusicBrainz'),
    libraryRoots: Array.isArray(cfg?.folders) ? cfg.folders : []
  });
});
ipcMain.handle('beta:databaseHealth', async () => databaseRequest('health_check'));
ipcMain.handle('artwork:providers', async () => artworkProviders);

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz) (cover search)', 'Accept': 'application/json', ...headers } });
  if (!response.ok) throw new Error(`Cover search failed (${response.status}).`);
  return response.json();
}

function normalizeCoverSearchText(value) {
  return normalizeArtworkText(value);
}
function scoreCoverResult(item, album, artist) { return scoreArtworkResult(item, album, artist); }

async function fetchTemporaryArtwork(url) {
  const imageHeaders = {
    'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz) (temporary artwork)',
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  };
  const jsonHeaders = {
    'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz) (temporary artwork)',
    'Accept': 'application/json'
  };

  // Cover Art Archive's /front-1200 convenience endpoint is not a reliable
  // existence test: it can 404 when the release has artwork but no image is
  // currently designated as the release's canonical "front" (and a 1200px
  // thumbnail can also be missing even when the original/500px image exists).
  // Resolve CAA metadata first and try the actual image/thumbnail URLs in
  // descending quality order. All returned bytes remain memory-only.
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isCaa = /(?:^|\.)coverartarchive\.org$/.test(host);
    const releaseMatch = isCaa && parsed.pathname.match(/^\/release\/([^/]+)\/(?:front(?:-(?:250|500|1200))?|back(?:-(?:250|500|1200))?)$/i);
    const releaseGroupMatch = isCaa && parsed.pathname.match(/^\/release-group\/([^/]+)\/front(?:-(?:250|500|1200))?$/i);

    if (releaseMatch || releaseGroupMatch) {
      const kind = releaseGroupMatch ? 'release-group' : 'release';
      const id = decodeURIComponent((releaseMatch || releaseGroupMatch)[1]);
      const apiUrl = `https://coverartarchive.org/${kind}/${encodeURIComponent(id)}`;
      const apiResponse = await fetch(apiUrl, { headers: jsonHeaders, cache: 'no-store' });
      if (apiResponse.ok) {
        const data = await apiResponse.json();
        const images = Array.isArray(data?.images) ? data.images : [];
        const preferred = [
          ...images.filter(item => item?.front && item?.approved !== false),
          ...images.filter(item => item?.front),
          ...images.filter(item => item?.approved !== false),
          ...images
        ];
        const seen = new Set();
        for (const image of preferred) {
          if (!image || seen.has(image.id)) continue;
          if (image.id != null) seen.add(image.id);
          const thumbs = image.thumbnails || {};
          const candidates = [
            thumbs['1200'], thumbs['500'], thumbs['250'],
            thumbs.large, thumbs.small, image.image
          ].filter(Boolean).map(String);
          for (const candidate of [...new Set(candidates)]) {
            try {
              const imageResponse = await fetch(candidate, {
                headers: imageHeaders,
                cache: 'no-store'
              });
              if (imageResponse.ok) return imageResponse;
            } catch {}
          }
        }
      }
    }
  } catch {}

  // If metadata resolution did not produce a usable image, retain the normal
  // direct fetch path. This keeps non-CAA sources (including iTunes) unchanged.
  try {
    const response = await fetch(url, {
      headers: imageHeaders,
      cache: 'no-store'
    });
    if (response.ok) return response;
    throw new Error(`Temporary artwork failed (${response.status}).`);
  } catch (err) {
    throw err instanceof Error ? err : new Error('Temporary artwork fetch failed.');
  }
}

ipcMain.handle('cover:loadTemporary', async (_evt, rawUrl = '') => {
  const url = String(rawUrl || '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('Temporary artwork URL must use HTTPS.');
  const response = await fetchTemporaryArtwork(url);
  const contentType = String(response.headers.get('content-type') || 'image/jpeg').split(';', 1)[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('Temporary artwork response was not an image.');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > 12 * 1024 * 1024) throw new Error('Temporary artwork image is empty or too large.');
  return { mimeType: contentType, base64: data.toString('base64') };
});

ipcMain.handle('cover:searchInternet', async (_evt, query = {}) => {
  const album = String(query.album || '').trim();
  const artist = String(query.artist || '').trim();
  const manualQuery = String(query.manualQuery || '').trim();
  if (!album && !manualQuery) return [];

  const targetAlbum = album || manualQuery;
  const targetArtist = artist;
  const results = [];
  const seen = new Set();
  const addResult = (item, scoreBoost = 0) => {
    const albumName = String(item.collectionName || item.releaseGroupTitle || item.title || '').trim();
    const artistName = String(item.artistName || item.artist || '').trim();
    if (!albumName || !item.artworkUrl) return;
    const key = String(item.artworkUrl || item.releaseId || item.collectionId || `${normalizeCoverSearchText(albumName)}|${normalizeCoverSearchText(artistName)}|${item.source}`);
    if (seen.has(key)) return;
    seen.add(key);
    item.score = scoreCoverResult(item, targetAlbum, targetArtist) + scoreBoost;
    results.push(item);
  };
  // Search actual releases first. Cover Art Archive artwork is attached to
  // releases (not merely release-groups), so this gives us a reliable artwork
  // URL and also lets us match the credited artist correctly.
  try {
    const mbClient = await getMusicBrainzClient();
    let mbResults = await mbClient.searchReleases({ album: targetAlbum, artist: targetArtist, limit: 20 });
    if (!mbResults.length) mbResults = await mbClient.searchReleases({ album: targetAlbum, artist: '', limit: 20 });
    for (const item of mbResults) addResult(item, 40);
  } catch (err) {
    console.warn('[BeehiveMusicBrainz] MusicBrainz release artwork search failed:', err.message);
  }

  const automatic = !manualQuery;
  const appleSearch = async (term, exactArtistOnly = false) => {
    const params = new URLSearchParams({ term, entity: 'album', media: 'music', country: 'US', limit: '25' });
    const data = await fetchJson(`https://itunes.apple.com/search?${params.toString()}`);
    const items = Array.isArray(data?.results) ? data.results : [];
    for (const item of items) {
      const itemAlbum = normalizeCoverSearchText(item.collectionName || '');
      const itemArtist = normalizeCoverSearchText(item.artistName || '');
      const wantedAlbum = normalizeCoverSearchText(targetAlbum);
      const wantedArtist = normalizeCoverSearchText(targetArtist);
      const albumExact = itemAlbum === wantedAlbum;
      const artistExact = !wantedArtist || itemArtist === wantedArtist;
      if (!albumExact) continue;
      if (exactArtistOnly && !artistExact) continue;
      if (!item.artworkUrl100) continue;
      const url = String(item.artworkUrl100)
        .replace(/100x100bb\.(jpg|jpeg|png)/i, '1000x1000bb.$1')
        .replace(/100x100[-.]?/i, '1000x1000');
      addResult({
        source: 'iTunes',
        collectionName: item.collectionName || '',
        artistName: item.artistName || '',
        releaseYear: item.releaseDate ? String(item.releaseDate).slice(0,4) : '',
        artworkUrl: url,
        width: 1000,
        height: 1000,
        collectionId: item.collectionId || null,
        collectionViewUrl: item.collectionViewUrl || ''
      }, exactArtistOnly ? 12 : 0);
    }
  };

  try {
    // Always consult Apple as a second artwork catalog. A successful MusicBrainz
    // search must not suppress alternate Apple covers, editions, or artwork.
    const beforeApple = results.length;
    if (targetArtist) await appleSearch(`${targetAlbum} ${targetArtist}`, true);
    const appleAdded = results.length - beforeApple;
    if (!appleAdded) await appleSearch(targetAlbum, false);
    if (!automatic && manualQuery && results.length === beforeApple) await appleSearch(manualQuery, false);
  } catch (err) {
    console.warn('[Beehive] iTunes cover search failed:', err.message);
  }

  // Keep exact album matches, but retain multiple releases/editions and both
  // artwork catalogs. The UI lets the user inspect the full-size image before applying it.
  return results
    .filter(item => normalizeCoverSearchText(item.collectionName) === normalizeCoverSearchText(targetAlbum))
    .sort((a,b) => Number(b.score||0) - Number(a.score||0))
    .slice(0, 12);
});

function assertSafeArtworkUrl(value) {
  const parsed = new URL(String(value || ''));
  if (parsed.protocol !== 'https:') throw new Error('Artwork URL must use HTTPS.');
  const host = parsed.hostname.toLowerCase();
  const approved = host === 'mzstatic.com' || host.endsWith('.mzstatic.com') || host === 'coverartarchive.org' || host.endsWith('.coverartarchive.org') || host === 'archive.org' || host.endsWith('.archive.org');
  if (!approved) throw new Error('Artwork source is not an approved music artwork host.');
  return parsed;
}

ipcMain.handle('cover:downloadSearchResult', async (_evt, artworkUrl) => {
  const parsed = assertSafeArtworkUrl(artworkUrl);
  const response = await fetch(parsed.toString(), { headers: { 'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz) (cover download)' } });
  if (!response.ok) throw new Error(`Could not download artwork (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('Downloaded artwork was empty.');
  const tempDir = path.join(app.getPath('temp'), 'beehive-artwork');
  await fsp.mkdir(tempDir, { recursive: true });
  const inputExt = path.extname(new URL(response.url || parsed.toString()).pathname).toLowerCase() === '.png' ? '.png' : '.jpg';
  const rawPath = path.join(tempDir, `cover-source-${crypto.randomBytes(10).toString('hex')}${inputExt}`);
  const normalizedPath = path.join(tempDir, `cover-1000-${crypto.randomBytes(10).toString('hex')}.jpg`);
  await fsp.writeFile(rawPath, buffer);
  try {
    // Normalize every selected online cover to exactly 1000x1000. The search
    // prefers true 1000px iTunes artwork and 1200px CAA artwork, but this keeps
    // the file embedded by Beehive consistent regardless of source.
    await runFfmpeg(['-hide_banner','-loglevel','error','-y','-i',rawPath,'-vf','scale=1000:1000:force_original_aspect_ratio=decrease,pad=1000:1000:(ow-iw)/2:(oh-ih)/2:color=black','-q:v','2',normalizedPath]);
    const normalized = await fsp.readFile(normalizedPath);
    try { await artworkCacheManager?.put(parsed.toString(), normalizedPath, { provider: parsed.hostname.includes('coverartarchive') ? 'musicbrainz-caa' : 'itunes', width: 1000, height: 1000 }); } catch {}
    return { path: normalizedPath, dataUrl: `data:image/jpeg;base64,${normalized.toString('base64')}`, width: 1000, height: 1000, sourceUrl: parsed.toString() };
  } finally {
    try { await fsp.unlink(rawPath); } catch {}
  }
});

ipcMain.handle('cover:downloadItunes', async (_evt, artworkUrl) => {
  return ipcMain.emit ? (await (async()=>{
    const parsed = assertSafeArtworkUrl(artworkUrl);
    if (!(parsed.hostname === 'mzstatic.com' || parsed.hostname.endsWith('.mzstatic.com'))) throw new Error('Not an iTunes artwork URL.');
    const response = await fetch(parsed.toString(), { headers: { 'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz)' } });
    if (!response.ok) throw new Error(`Could not download artwork (${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Downloaded artwork was empty.');
    const tempDir = path.join(app.getPath('temp'), 'beehive-artwork');
    await fsp.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `itunes-${crypto.randomBytes(10).toString('hex')}.jpg`);
    await fsp.writeFile(tempPath, buffer);
    return { path: tempPath, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };
  })()) : null;
});

ipcMain.handle('cover:paste', async () => {
  const image = clipboard.readImage();
  if (!image || image.isEmpty()) return null;
  const tempDir = path.join(app.getPath('temp'), 'beehive-artwork');
  await fsp.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `clipboard-${crypto.randomBytes(10).toString('hex')}.png`);
  await fsp.writeFile(tempPath, image.toPNG());
  return { path: tempPath, dataUrl: image.toDataURL() };
});

ipcMain.handle('cover:saveDataUrlImage', async (_evt, dataUrl, filename='artwork.jpg') => {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error('Invalid artwork image data.');
  const ext = path.extname(String(filename || '.jpg')) || '.jpg';
  const out = path.join(app.getPath('temp'), `beehive-export-${crypto.randomBytes(8).toString('hex')}${ext}`);
  await fsp.writeFile(out, Buffer.from(match[2], 'base64'));
  return out;
});

ipcMain.handle('cover:saveImage', async (_evt, imagePath) => {
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error('Artwork file not found.');
  const ext = path.extname(imagePath) || '.jpg';
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: `cover${ext}`, filters: [{ name: 'Image', extensions: ['png','jpg','jpeg','webp'] }] });
  if (res.canceled || !res.filePath) return false;
  await fsp.copyFile(imagePath, res.filePath);
  return true;
});

ipcMain.handle('cover:copy', async (_evt, coverFile) => {
  if (!coverFile) return false;
  const filePath = path.join(COVERS_DIR(), path.basename(coverFile));
  if (!fs.existsSync(filePath)) return false;
  clipboard.writeImage(nativeImage.createFromPath(filePath));
  return true;
});

ipcMain.handle('cover:save', async (_evt, coverFile) => {
  if (!coverFile) return false;
  const src = path.join(COVERS_DIR(), path.basename(coverFile));
  if (!fs.existsSync(src)) return false;
  const ext = path.extname(src) || '.jpg';
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: `cover${ext}`, filters: [{ name: 'Image', extensions: ['png','jpg','jpeg','webp'] }] });
  if (res.canceled || !res.filePath) return false;
  await fsp.copyFile(src, res.filePath);
  return true;
});

ipcMain.handle('playlists:get', async () => readJsonSafe(PLAYLISTS_PATH(), []));
ipcMain.handle('playlists:save', async (_evt, playlist) => {
  const lists = await readJsonSafe(PLAYLISTS_PATH(), []);
  const existing = lists.find(p => p.id === playlist.id);
  const now = Date.now();
  const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  const previousAdded = (existing && existing.trackAddedAt && typeof existing.trackAddedAt === 'object') ? existing.trackAddedAt : {};
  const trackAddedAt = {};
  for (const trackPath of tracks) {
    const key = String(trackPath || '');
    if (!key) continue;
    trackAddedAt[key] = Number(previousAdded[key]) || now;
  }
  const item = {
    ...playlist,
    id: playlist.id || crypto.randomUUID(),
    name: String(playlist.name || 'Untitled Playlist'),
    tracks,
    trackAddedAt,
    smart: !!playlist.smart,
    match: playlist.match === 'any' ? 'any' : 'all',
    rules: Array.isArray(playlist.rules) ? playlist.rules : [],
    limit: Math.max(1, Math.min(5000, Number(playlist.limit) || 500)),
    updatedAt: now,
    createdAt: playlist.createdAt || now
  };

  const idx = lists.findIndex(p => p.id === item.id);
  if (idx >= 0) lists[idx] = item; else lists.push(item);
  await writeJsonSafe(PLAYLISTS_PATH(), lists);
  return item;
});

function parseM3UEntries(text, playlistFile) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries = [];
  let pendingInfo = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toUpperCase().startsWith('#EXTINF:')) {
      const comma = line.indexOf(',');
      const info = comma >= 0 ? line.slice(comma + 1).trim() : '';
      const meta = line.slice(8, comma >= 0 ? comma : undefined);
      const dash = meta.indexOf(',');
      const duration = dash >= 0 ? meta.slice(0, dash) : meta;
      const parts = info.split(' - ');
      pendingInfo = { duration: Number(duration) || -1, artist: parts.length > 1 ? parts.shift().trim() : '', title: parts.join(' - ').trim() || info };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/^https?:\/\//i.test(line)) { pendingInfo = null; continue; }
    let filePath = line;
    if (/^file:\/\//i.test(filePath)) { try { filePath = decodeURIComponent(new URL(filePath).pathname); } catch { try { filePath = decodeURI(new URL(filePath).pathname); } catch {} } }
    else { try { filePath = decodeURIComponent(filePath); } catch {} }
    if (!path.isAbsolute(filePath)) filePath = path.resolve(path.dirname(playlistFile), filePath);
    entries.push({ path: path.normalize(filePath), info: pendingInfo || {} });
    pendingInfo = null;
  }
  return entries;
}

ipcMain.handle('playlists:chooseImportFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'M3U playlists', extensions: ['m3u', 'm3u8'] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  const text = await fsp.readFile(filePath, 'utf8');
  return { path: filePath, name: path.basename(filePath, path.extname(filePath)), entries: parseM3UEntries(text, filePath) };
});

ipcMain.handle('playlists:exportM3U', async (_evt, payload) => {
  const name = String(payload?.name || 'Playlist').trim() || 'Playlist';
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: `${name}.m3u8`, filters: [{ name: 'M3U playlist', extensions: ['m3u8', 'm3u'] }] });
  if (res.canceled || !res.filePath) return { canceled: true };
  const lines = ['#EXTM3U'];
  for (const t of tracks) {
    const artist = String(t?.artist || '').trim();
    const title = String(t?.title || path.basename(t?.path || '', path.extname(t?.path || ''))).trim();
    const duration = Number(t?.duration) > 0 ? Math.round(Number(t.duration)) : -1;
    lines.push(`#EXTINF:${duration},${artist ? artist + ' - ' : ''}${title}`);
    lines.push(String(t?.path || ''));
  }
  await fsp.writeFile(res.filePath, lines.join('\n') + '\n', 'utf8');
  return { canceled: false, path: res.filePath, count: tracks.length };
});

function spotifyPlaylistId(input) {
  const value = String(input || '').trim();
  const m = value.match(/(?:open\.spotify\.com\/(?:embed\/)?)playlist\/([A-Za-z0-9]{22})/i) || value.match(/^spotify:playlist:([A-Za-z0-9]{22})$/i) || value.match(/^([A-Za-z0-9]{22})$/);
  return m ? m[1] : null;
}

function findSpotifyTrackList(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.trackList)) return value.trackList;
  for (const v of Object.values(value)) { const found = findSpotifyTrackList(v); if (found) return found; }
  return null;
}

ipcMain.handle('playlists:importSpotify', async (_evt, input) => {
  const id = spotifyPlaylistId(input);
  if (!id) throw new Error('Enter a valid public Spotify playlist URL.');
  const url = `https://open.spotify.com/embed/playlist/${id}`;
  const response = await net.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Spotify returned HTTP ${response.status}.`);
  const html = await response.text();
  const match = html.match(/<script[^>]+id=[\"']__NEXT_DATA__[\"'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Spotify did not expose public playlist metadata.');
  let data; try { data = JSON.parse(match[1]); } catch { throw new Error('Could not read Spotify playlist metadata.'); }
  const rows = findSpotifyTrackList(data) || [];
  const tracks = rows.map(row => {
    const title = row?.title || row?.name || '';
    const subtitle = row?.subtitle || row?.artist || '';
    const uri = row?.uri || '';
    const artists = String(subtitle).split(',').map(x => x.trim()).filter(Boolean);
    return { title: String(title).trim(), artist: artists.join(', '), spotifyUri: uri, spotifyId: String(uri).split(':').pop() };
  }).filter(t => t.title);
  const name = String(data?.props?.pageProps?.state?.data?.entity?.name || data?.props?.pageProps?.data?.entity?.name || 'Spotify Playlist').trim();
  return { id, name, sourceUrl: `https://open.spotify.com/playlist/${id}`, tracks, likelyTruncated: rows.length >= 100 };
});
ipcMain.handle('playlists:delete', async (_evt, id) => {
  const lists = await readJsonSafe(PLAYLISTS_PATH(), []);
  await writeJsonSafe(PLAYLISTS_PATH(), lists.filter(p => p.id !== id));
  return true;
});

async function writeMp3MusicBeeLove(trackPath, loved) {
  await updateMp3MusicBeeTags(trackPath, { loved: !!loved });
}

function mp4Atom(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  const size = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8);
  if (size === 0) return {offset,size:buffer.length-offset,type,header:8,end:buffer.length};
  if (size === 1) { if(offset+16>buffer.length)return null; const n=Number(buffer.readBigUInt64BE(offset+8)); if(!Number.isSafeInteger(n)||n<16||offset+n>buffer.length)return null; return {offset,size:n,type,header:16,end:offset+n}; }
  if (size < 8 || offset + size > buffer.length) return null;
  return {offset,size,type,header:8,end:offset+size};
}
function mp4Children(buffer, atom) {
  let p=atom.offset+atom.header+(atom.type==='meta'?4:0), out=[];
  while(p+8<=atom.end){const a=mp4Atom(buffer,p);if(!a||a.end>atom.end)break;out.push(a);p=a.end;} return out;
}
function mp4FindPath(buffer, atom, types, i=0) { if(i>=types.length)return atom; for(const c of mp4Children(buffer,atom)) if(c.type===types[i]) {const f=mp4FindPath(buffer,c,types,i+1);if(f)return f;} return null; }
function mp4AtomWithPayload(type,payload){const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length,0);b.write(type,4,4,'latin1');payload.copy(b,8);return b;}
function mp4FullBoxAtom(type,payload){return mp4AtomWithPayload(type,Buffer.concat([Buffer.alloc(4),payload]));}
function makeMp4FreeformLoveAtom(loved){const mean=mp4FullBoxAtom('mean',Buffer.from('com.apple.iTunes'));const name=mp4FullBoxAtom('name',Buffer.from('LOVE RATING'));const data=mp4AtomWithPayload('data',Buffer.concat([Buffer.from([0,0,0,1]),Buffer.alloc(4),Buffer.from(loved?'L':'0')]));return mp4AtomWithPayload('----',Buffer.concat([mean,name,data]));}
function parseMp4FreeformName(buffer,atom){if(atom.type!=='----')return null;let mean='',name='';for(const c of mp4Children(buffer,atom)){if(c.type==='mean'||c.type==='name'){const start=c.offset+c.header+4;const text=buffer.subarray(start,c.end).toString('utf8').replace(/\0+$/g,'');if(c.type==='mean')mean=text;else name=text;}}return {mean,name};}
function rebuildMp4Parent(buffer,parent,oldChild,newChild){const oldPayload=buffer.subarray(parent.offset+parent.header,parent.end);const rel=oldChild.offset-(parent.offset+parent.header);const before=oldPayload.subarray(0,rel),after=oldPayload.subarray(rel+oldChild.size);return mp4AtomWithPayload(parent.type,Buffer.concat([before,newChild,after]));}
async function writeMp4LoveTag(trackPath,loved){const input=await fsp.readFile(trackPath);let p=0,top=[];while(p+8<=input.length){const a=mp4Atom(input,p);if(!a)break;top.push(a);p=a.end;}const moov=top.find(a=>a.type==='moov');if(!moov)throw new Error('MP4/M4A file does not contain a moov atom.');const udta=mp4FindPath(input,moov,['udta']),meta=udta&&mp4FindPath(input,udta,['meta']),ilst=meta&&mp4FindPath(input,meta,['ilst']);if(!udta||!meta||!ilst)throw new Error('MP4/M4A file does not contain an iTunes metadata ilst atom.');const kept=[];for(const c of mp4Children(input,ilst)){const ff=parseMp4FreeformName(input,c);if(ff&&ff.mean.toLowerCase()==='com.apple.itunes'&&isBeehiveLoveFieldName(ff.name))continue;kept.push(input.subarray(c.offset,c.end));}if (loved) kept.push(makeMp4FreeformLoveAtom(true));let child=ilst,current=mp4AtomWithPayload('ilst',Buffer.concat(kept));for(const parent of [meta,udta,moov]){current=rebuildMp4Parent(input,parent,child,current);child=parent;}const out=Buffer.concat([input.subarray(0,moov.offset),current,input.subarray(moov.end)]);const temp=`${trackPath}.beehive-love-${crypto.randomBytes(6).toString('hex')}${path.extname(trackPath).toLowerCase()}`;await writeAndSyncReplacement(temp,trackPath,out);}
function mp4LoveValuesFromBuffer(input) {
  let p = 0;
  const top = [];
  while (p + 8 <= input.length) { const a = mp4Atom(input, p); if (!a) break; top.push(a); p = a.end; }
  const moov = top.find(a => a.type === 'moov');
  const ilst = moov && mp4FindPath(input, moov, ['udta', 'meta', 'ilst']);
  if (!ilst) return [];
  const values = [];
  for (const c of mp4Children(input, ilst)) {
    const ff = parseMp4FreeformName(input, c);
    if (!ff || ff.mean.toLowerCase() !== 'com.apple.itunes' || !isBeehiveLoveFieldName(ff.name)) continue;
    const d = mp4Children(input, c).find(x => x.type === 'data');
    if (!d || d.offset + d.header + 8 > d.end) continue;
    values.push(input.subarray(d.offset + d.header + 8, d.end).toString('utf8').trim().toUpperCase());
  }
  return values;
}

async function verifyLoveTag(trackPath, expected) {
  const ext = path.extname(trackPath).toLowerCase();

  // Each container has its own native MusicBee Love representation.
  // Verification deliberately checks the whole tag/container so an Unlove
  // operation cannot succeed while a duplicate/legacy Love field remains.
  if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') {
    const values = mp4LoveValuesFromBuffer(await fsp.readFile(trackPath));
    return expected ? (values.length === 1 && values[0] === 'L') : values.length === 0;
  }
  if (ext === '.flac') {
    try {
      const c = spawnTracked('metaflac', ['--export-tags-to=-', trackPath], { windowsHide: true });
      let output = '';
      c.stdout.on('data', d => { output += d.toString(); });
      const code = await new Promise((resolve, reject) => {
        c.on('error', reject);
        c.on('close', resolve);
      });
      if (code !== 0) return false;
      const lines = output.split(/\r?\n/).filter(Boolean);
      const loveLines = lines.filter(line => isBeehiveLoveFieldName(line.split('=')[0]));
      if (!expected) return loveLines.length === 0;
      return loveLines.length === 1 && /^LOVE RATING=L$/i.test(loveLines[0].trim());
    } catch {
      return false;
    }
  }

  let data = await fsp.readFile(trackPath);
  if (ext === '.wav') {
    let p = 12;
    let found = null;
    while (p + 8 <= data.length) {
      const id = data.toString('ascii', p, p + 4);
      const size = data.readUInt32LE(p + 4);
      const dataStart = p + 8;
      if (dataStart + size > data.length) break;
      if (id === 'id3 ' || id === 'ID3 ') {
        found = data.subarray(dataStart, dataStart + size);
        break;
      }
      p = dataStart + size + (size & 1);
    }
    if (!found) return !expected;
    data = found;
  }

  if (ext === '.mp3' || ext === '.wav') {
    if (data.length < 10 || data.toString('ascii', 0, 3) !== 'ID3') return !expected;
    const version = data[3] >= 4 ? 4 : 3;
    const size = readId3Size(data);
    const payload = data.subarray(10, Math.min(data.length, 10 + size));
    let loveCount = 0;
    let lovedValueCount = 0;
    let loveValueIsUnloved = false;
    for (const frame of parseId3Frames(payload, version).frames) {
      if (frame.id !== 'TXXX') continue;
      const desc = txxxDescription(frame.data).trim().toUpperCase();
      if (!isBeehiveLoveFieldName(desc)) continue;
      loveCount++;
      const body = frame.data.subarray(1);
      const nul = body.indexOf(0);
      const value = body.subarray(nul >= 0 ? nul + 1 : 0)
        .toString(frame.data[0] === 3 ? 'utf8' : 'latin1')
        .trim().toUpperCase();
      if (value === 'L') lovedValueCount++;
      if (value === '0') loveValueIsUnloved = true;
    }
    return expected ? (loveCount === 1 && lovedValueCount === 1) : (loveCount === 0);
  }

  return false;
}

async function embedLoveInFile(trackPath, loved) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  // The audio file is the source of truth. Make sure the target is actually
  // writable before touching Beehive's cache/UI state.
  await fsp.access(trackPath, fs.constants.R_OK | fs.constants.W_OK);
  const ext = path.extname(trackPath).toLowerCase();
  if (ext === '.mp3') { await writeMp3MusicBeeLove(trackPath, !!loved); if (!await verifyLoveTag(trackPath, !!loved)) throw new Error('MP3 Love tag verification failed after writing.'); return true; }
  if (ext === '.wav') { await updateWavMusicBeeTags(trackPath, { loved: !!loved }); if (!await verifyLoveTag(trackPath, !!loved)) throw new Error('WAV Love tag verification failed after writing.'); return true; }
  if (ext === '.flac') { const args=['--remove-tag=LOVE RATING','--remove-tag=LOVE',...(loved ? ['--set-tag=LOVE RATING=L'] : []),trackPath]; await runMetaflac(args); if(!await verifyLoveTag(trackPath,!!loved)) throw new Error('FLAC Love tag verification failed after writing.'); return true; }
  if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') { await writeMp4LoveTag(trackPath,!!loved); if(!await verifyLoveTag(trackPath,!!loved)) throw new Error('MP4/M4A Love tag verification failed after writing.'); return true; }
  const temp=`${trackPath}.beehive-love-${crypto.randomBytes(6).toString('hex')}${ext}`;
  try { await runFfmpeg(['-hide_banner','-loglevel','error','-y','-i',trackPath,'-map','0','-c','copy',...(loved ? ['-metadata','LOVE RATING=L'] : ['-metadata','LOVE RATING=']),temp]); await fsp.rename(temp,trackPath); if(!await verifyLoveTag(trackPath,!!loved)) throw new Error('Love tag verification failed after writing.'); return true; } catch(err){try{await fsp.unlink(temp);}catch{} throw new Error(`Could not embed Love tag: ${err.message}`);}
}
function sendTagProgress(evt, payload) {
  try { evt?.sender?.send('library:tagProgress', payload); } catch {}
}

async function updateCachedLoved(paths, loved) {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const wanted = new Set((Array.isArray(paths) ? paths : [paths])
    .filter(Boolean)
    .map(p => path.resolve(String(p))));
  let changed = false;
  for (const track of (cache.tracks || [])) {
    const trackPath = String(track?.path || '');
    if (!trackPath || !wanted.has(path.resolve(trackPath))) continue;
    if (!!track.loved !== !!loved) {
      track.loved = !!loved;
      changed = true;
    }
  }
  if (changed) await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
  return changed;
}

async function readFlacMusicBeeLove(filePath) {
  try {
    const c = spawnTracked('metaflac', ['--export-tags-to=-', filePath], { windowsHide: true });
    let output = '';
    c.stdout.on('data', d => { output += d.toString(); });
    const code = await new Promise((resolve, reject) => {
      c.on('error', reject);
      c.on('close', resolve);
    });
    if (code !== 0) return false;
    for (const line of output.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq < 0 || !isBeehiveLoveFieldName(line.slice(0, eq))) continue;
      if (isFavoriteLoveValue(line.slice(eq + 1))) return true;
    }
  } catch {}
  return false;
}

async function readMp4MusicBeeLove(filePath) {
  try { return mp4LoveValuesFromBuffer(await fsp.readFile(filePath)).some(isFavoriteLoveValue); } catch {}
  return false;
}

async function snapshotProtectedMetadata(trackPath) {
  // Artwork operations are strictly artwork-only. Capture the two user-facing
  // independent states before the native tag rewrite and verify them afterward.
  // This prevents a buggy metadata backend from silently changing Love or Rating
  // while removing/replacing pictures.
  return {
    loved: !!(await readLoveStateFromDisk(trackPath)),
    rating: Number(await readEmbeddedRating(trackPath)) || 0
  };
}

async function verifyProtectedMetadataUnchanged(trackPath, before) {
  const after = await snapshotProtectedMetadata(trackPath);
  if (!!after.loved !== !!before.loved) {
    throw new Error('Artwork operation changed the Love state; the file was not accepted.');
  }
  if (Math.abs(after.rating - before.rating) > 0.01) {
    throw new Error(`Artwork operation changed the Rating from ${before.rating} to ${after.rating}; the file was not accepted.`);
  }
  return after;
}

async function readLoveStateFromDisk(trackPath) {
  const filePath = path.resolve(String(trackPath || ''));
  if (!filePath || !fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return !!(await readMp3MusicBeeLove(filePath));
  if (ext === '.wav') return !!(await readWavMusicBeeLove(filePath));
  if (ext === '.flac') return !!(await readFlacMusicBeeLove(filePath));
  if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') return !!(await readMp4MusicBeeLove(filePath));
  try {
    const meta = await (await ensureMM()).parseFile(filePath, { duration: false, skipCovers: true });
    for (const tagList of Object.values(meta.native || {})) {
      for (const tag of (Array.isArray(tagList) ? tagList : [])) {
        const desc = String(tag?.value?.description || '').trim().toUpperCase();
        if (!isBeehiveLoveFieldName(desc)) continue;
        const value = String(tag?.value?.text ?? tag?.value ?? '').trim().toUpperCase();
        if (isFavoriteLoveValue(value)) return true;
      }
    }
  } catch {}
  return false;
}

async function setLoveForSingleTrack(evt, trackPath, loved) {
  if (!trackPath) throw new Error('Track path is required.');
  const value = !!loved;
  const absolutePath = path.resolve(String(trackPath));
  const recoveryJob = { id:crypto.randomUUID(), kind:'love', path:absolutePath, loved:value, createdAt:Date.now() };
  await persistMetadataJob(recoveryJob, 'running', 1, '');
  const workerPath = path.join(__dirname, 'metadata-worker.js');
  const operationLabel = `${value ? 'Loving' : 'Unloving'} 1 file`;

  // A single-track Love/Unlove must use the same metadata-worker path as bulk
  // operations. This is important for FLAC: the worker selects the writer by
  // extension and uses metaflac to embed MusicBee's LOVE RATING field. MP3,
  // WAV, M4A/MP4 and other supported formats use their format-specific writers.
  markLibraryInternalWrite(absolutePath);
  libraryPendingLoveWrites.set(absolutePath, value);
  libraryBulkWriteActive = true;
  if (libraryWatchDebounce) {
    clearTimeout(libraryWatchDebounce);
    libraryWatchDebounce = null;
  }

  const sendProgress = (active, phase, done, current = '') => {
    sendTagProgress(evt, {
      active,
      operation: 'love',
      operationLabel,
      phase,
      done,
      total: 1,
      updated: done,
      failed: done ? 0 : 0,
      skipped: 0,
      current
    });
  };

  sendProgress(true, 'Starting background metadata worker', 0, '');

  let child = null;
  let timer = null;
  let writeSucceeded = false;
  try {
    child = forkTracked(workerPath, [], {
      cwd: __dirname,
      execArgv: ['--max-old-space-size=512'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    child.stdout?.on('data', chunk => { const text = String(chunk || '').trim(); if (text) scanLog(`metadata worker stdout: ${text}`); });
    child.stderr?.on('data', chunk => { const text = String(chunk || '').trim(); if (text) scanLog(`metadata worker stderr: ${text}`); });

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = fn => value => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      child.once('message', finish(resolve));
      child.once('error', finish(reject));
      child.once('exit', finish((code, signal) => reject(new Error(`Metadata worker exited (${code ?? 'null'}${signal ? `, ${signal}` : ''}).`))));
      timer = setTimeout(() => finish(reject)(new Error('Metadata worker timed out after 120 seconds.')), 120000);
      child.send({ cmd: 'love', path: absolutePath, loved: value }, err => {
        if (err) finish(reject)(err);
      });
    });

    if (!result?.ok) throw new Error(result?.error || 'Metadata worker failed.');

    // The worker verifies the format-specific embedded tag. Re-read it from
    // the physical file as an independent final check before touching cache.
    const diskLoved = await readLoveStateFromDisk(absolutePath);
    if (diskLoved !== value) {
      throw new Error(`File metadata did not change to ${value ? 'Loved' : 'Unloved'} on disk.`);
    }

    await updateCachedLoved(absolutePath, value);
    await deleteMetadataJob(recoveryJob.id);
    writeSucceeded = true;
    sendProgress(true, 'Embedded Love tag verified', 1, path.basename(absolutePath));
    return true;
  } finally {
    if (!writeSucceeded) await updateMetadataJob(recoveryJob.id, 'retry', 1, 'Love operation interrupted or failed.');
    if (timer) clearTimeout(timer);
    try { child?.disconnect(); } catch {}
    try { child?.kill(); } catch {}
    libraryPendingLoveWrites.delete(absolutePath);
    libraryBulkWriteActive = false;
    libraryBulkWriteIgnoreUntil = Date.now() + 5000;
    sendTagProgress(evt, {
      active: false,
      operation: 'love',
      operationLabel: 'Love operation complete',
      phase: 'Finished',
      done: 1,
      total: 1,
      updated: writeSucceeded ? 1 : 0,
      failed: writeSucceeded ? 0 : 1,
      skipped: 0,
      current: '',
      errors: writeSucceeded ? [] : [{ path: absolutePath, error: 'Love metadata write failed.' }]
    });
  }
}

ipcMain.handle('track:toggleLove', async (evt, trackPath, value) => {
  return setLoveForSingleTrack(evt, trackPath, !!value);
});

ipcMain.handle('tracks:setLove', async (evt, trackPaths = [], loved) => {
  const requestedPaths = [...new Set((Array.isArray(trackPaths) ? trackPaths : [])
    .filter(Boolean).map(p => String(p)))];
  const value = !!loved;
  const results = { updated: 0, failed: 0, skipped: 0, errors: [] };

  // If we are adding Love, never rewrite files that are already marked as
  // favorites. The cache mirrors Beehive's authoritative Love tag state, so
  // this removes thousands of needless metadata rewrites from a "Love all"
  // operation while keeping the main process out of the file loop.
  let cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  if (!cache || !Array.isArray(cache.tracks)) cache = { tracks: [] };
  const cacheByPath = new Map(cache.tracks.map(t => [String(t.path || ''), t]));
  let paths = requestedPaths;
  if (value) {
    const alreadyLoved = new Set(
      cache.tracks.filter(t => !!t?.loved).map(t => String(t.path || ''))
    );
    paths = requestedPaths.filter(p => !alreadyLoved.has(p));
    results.skipped = requestedPaths.length - paths.length;
  }
  const total = paths.length;
  if (!total) {
    sendTagProgress(evt, {
      active: false,
      operation: 'love',
      operationLabel: 'Love operation complete',
      phase: results.skipped ? `Skipped ${results.skipped.toLocaleString()} already Loved` : 'Finished',
      done: 0,
      total: 0,
      updated: 0,
      failed: 0,
      skipped: results.skipped,
      current: ''
    });
    return results;
  }

  // Strawberry-style architecture: enqueue metadata jobs onto dedicated
  // background worker processes. The Electron main process remains responsible
  // for playback/UI IPC while workers do the expensive file I/O and tag rewrites.
  // Keep metadata writes strictly serialized. A single worker avoids competing
  // whole-file rewrites and lets the audio decoder retain disk/CPU headroom.
  const WORKER_COUNT = 1;
  const workerPath = path.join(__dirname, 'metadata-worker.js');
  const previousBulkState = libraryBulkWriteActive;
  const recoveryJobs = new Map();
  for (const p of paths) {
    const job = { id:crypto.randomUUID(), kind:'love', path:path.resolve(String(p)), loved:value, createdAt:Date.now() };
    recoveryJobs.set(path.resolve(String(p)), job);
    void persistMetadataJob(job, 'queued', 0, '');
    libraryPendingLoveWrites.set(p, value);
  }
  libraryBulkWriteActive = true;
  if (libraryWatchDebounce) {
    clearTimeout(libraryWatchDebounce);
    libraryWatchDebounce = null;
  }

  let cacheDirty = false;
  let lastCacheFlush = Date.now();
  let lastProgressAt = 0;
  let nextIndex = 0;
  let completed = 0;
  let stopped = false;
  const workers = [];

  const sendProgress = (active, current = '') => {
    const now = Date.now();
    if (active && completed !== total && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    sendTagProgress(evt, {
      active,
      operation: 'love',
      operationLabel: `${value ? 'Loving' : 'Unloving'} ${total.toLocaleString()} files${results.skipped ? ` (${results.skipped.toLocaleString()} already Loved skipped)` : ''}`,
      phase: active ? 'Embedding Love tags' : (results.failed ? 'Finished with errors' : 'Finished'),
      done: completed,
      total,
      updated: results.updated,
      failed: results.failed,
      skipped: results.skipped,
      current,
      lastError: results.errors.length ? results.errors[results.errors.length - 1] : null
    });
  };

  const flushCache = async (force = false) => {
    if (!cacheDirty) return;
    if (!force && completed % 250 !== 0 && Date.now() - lastCacheFlush < 5000) return;
    await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
    cacheDirty = false;
    lastCacheFlush = Date.now();
  };

  const createWorker = () => {
    const child = forkTracked(workerPath, [], {
      cwd: __dirname,
      execArgv: ['--max-old-space-size=512'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    const state = { child, busy: false, job: null, timer: null };
    child.stdout?.on('data', chunk => { const text = String(chunk || '').trim(); if (text) scanLog(`metadata worker stdout: ${text}`); });
    child.stderr?.on('data', chunk => { const text = String(chunk || '').trim(); if (text) scanLog(`metadata worker stderr: ${text}`); });
    workers.push(state);
    return state;
  };

  const shutdownWorker = state => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    try { state.child.removeAllListeners(); } catch {}
    try { state.child.disconnect(); } catch {}
    try { state.child.kill(); } catch {}
  };

  const finishJob = async (state, message) => {
    if (!state.job) return;
    const job = state.job;
    state.job = null;
    state.busy = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    completed++;
    if (message?.ok) {
      results.updated++;
      await deleteMetadataJob(recoveryJobs.get(path.resolve(String(job.path)))?.id);
      const track = cacheByPath.get(job.path);
      if (track) { track.loved = value; cacheDirty = true; }
    } else {
      results.failed++;
      const recovery = recoveryJobs.get(path.resolve(String(job.path)));
      await updateMetadataJob(recovery?.id, 'retry', 1, message?.error || 'Metadata worker failed.');
      results.errors.push({ path: job.path, error: message?.error || 'Metadata worker failed.' });
    }
    await flushCache(false);
    sendProgress(true, path.basename(job.path));
    dispatch(state);
    if (completed >= total) stopped = true;
  };

  const dispatch = state => {
    if (stopped || state.busy) return;
    if (nextIndex >= total) return;
    const job = { path: paths[nextIndex++], loved: value };
    state.job = job;
    state.busy = true;
    state.timer = setTimeout(async () => {
      if (!state.busy || !state.job) return;
      const timedOut = state.job.path;
      state.busy = false;
      state.job = null;
      results.failed++;
      completed++;
      results.errors.push({ path: timedOut, error: 'Metadata worker timed out after 120 seconds.' });
      sendProgress(true, path.basename(timedOut));
      try { state.child.kill(); } catch {}
      const idx = workers.indexOf(state);
      if (idx >= 0) workers[idx] = createWorker();
      dispatch(workers[idx]);
      if (completed >= total) stopped = true;
    }, 120000);
    try { state.child.send({ cmd: 'love', path: job.path, loved: value }); }
    catch (err) { finishJob(state, { ok: false, error: err?.message || String(err) }); }
  };

  sendTagProgress(evt, { active: true, operation: 'love', operationLabel: `${value ? 'Loving' : 'Unloving'} ${total.toLocaleString()} files${results.skipped ? ` (${results.skipped.toLocaleString()} already Loved skipped)` : ''}`, phase: 'Starting background metadata workers', done: 0, total, updated: 0, failed: 0, skipped: results.skipped, current: '' });

  try {
    for (let i = 0; i < WORKER_COUNT; i++) createWorker();
    for (const state of workers) {
      state.child.on('message', msg => { finishJob(state, msg).catch(err => scanLog('Metadata job completion error', { error: String(err) })); });
      state.child.on('error', err => {
        if (state.busy) finishJob(state, { ok: false, error: err?.message || String(err) }).catch(() => {});
      });
      state.child.on('exit', (code, signal) => {
        if (state.busy) finishJob(state, { ok: false, error: `Metadata worker exited (${code ?? 'null'}${signal ? `, ${signal}` : ''}).` }).catch(() => {});
      });
    }
    for (const state of workers) dispatch(state);

    while (completed < total) await new Promise(resolve => setTimeout(resolve, 100));
    await flushCache(true);
    return results;
  } finally {
    stopped = true;
    await flushCache(true).catch(() => {});
    for (const state of workers) shutdownWorker(state);
    for (const p of paths) libraryPendingLoveWrites.delete(p);
    libraryBulkWriteActive = previousBulkState;
    libraryBulkWriteIgnoreUntil = Date.now() + 5000;
    sendTagProgress(evt, { active: false, operation: 'love', operationLabel: 'Love operation complete', phase: results.failed ? 'Finished with errors' : 'Finished', done: total, total, updated: results.updated, failed: results.failed, skipped: results.skipped, current: '', errors: results.errors });
  }
});
