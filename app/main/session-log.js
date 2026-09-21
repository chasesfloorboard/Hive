'use strict';

// Session logging, console capture, startup diagnostics, and tracked
// child-process spawning. This is foundational infrastructure most of
// main.js depends on (writeSession/crashDebug/startupDebug/spawnTracked are
// used throughout), so it's a factory that main.js calls once at startup
// and destructures — same call sites as before, just a different home for
// the definitions.
function createSessionLog({ hiveProjectRoot, startupDebugEnabled, startupDebugStartedAt }) {
  const path = require('path');
  const fs = require('fs');
  const fsp = fs.promises;
  const util = require('util');
  const { spawn, fork } = require('child_process');
  const { app } = require('electron');

  const RAW_CONSOLE = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  };
  const CONSOLE_NOISE = [
    /RUNTIME HEALTH/i,
    /PROCESS SNAPSHOT/i,
    /queue artwork warmup disabled/i,
    /propagating temporary album artwork/i,
    /temporary artwork propagation complete/i,
    /refreshing current-track cover rotation targets/i,
    /automatic artwork image loaded/i,
    /COVER CACHE LOAD/i,
    /^\[Beehive Scan\]/i
  ];

  let resolvedLogDir = null;
  let currentSessionLogPath = null;
  let sessionLogInitialized = false;
  let sessionLogWriteChain = Promise.resolve();
  let startupDebugTimer = null;
  let startupDebugStopped = false;
  const startupTrackedChildren = new Map();

  function portableLogDir() { return path.join(hiveProjectRoot, 'logs'); }
  function userLogDir() {
    try { return path.join(app.getPath('userData'), 'logs'); } catch { return path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.hive', 'logs'); }
  }
  function canWriteDirectory(dir) {
    try {
      fs.mkdirSync(dir, { recursive:true, mode:0o700 });
      const probe = path.join(dir, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return true;
    } catch { return false; }
  }
  function beehiveLogDir() {
    if (resolvedLogDir) return resolvedLogDir;
    const portable = portableLogDir();
    resolvedLogDir = canWriteDirectory(portable) ? portable : userLogDir();
    try { fs.mkdirSync(resolvedLogDir, { recursive:true, mode:0o700 }); } catch {}
    return resolvedLogDir;
  }
  function ensureBeehiveLogDir() { try { fs.mkdirSync(beehiveLogDir(), { recursive:true, mode:0o700 }); } catch {} }
  function sessionFileName(date = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `session-${date.getFullYear()}${p(date.getMonth()+1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${process.pid}.txt`;
  }
  function sessionLogPath() {
    if (!currentSessionLogPath) currentSessionLogPath = path.join(beehiveLogDir(), sessionFileName());
    return currentSessionLogPath;
  }
  function writeSession(level, source, message, details = null) {
    try {
      ensureBeehiveLogDir();
      let suffix = '';
      if (details !== null && details !== undefined) {
        try { suffix = `\n${JSON.stringify(details, null, 2)}`; } catch { suffix = `\n${String(details)}`; }
      }
      const header = sessionLogInitialized ? '' : `Hive session\nStarted: ${new Date().toISOString()}\nPID: ${process.pid}\nVersion: ${app.getVersion?.() || 'unknown'}\nLocation: ${hiveProjectRoot}\n\n`;
      sessionLogInitialized = true;
      const line = `${header}[${new Date().toISOString()}] [${level}] [${source}] ${String(message)}${suffix}\n`;
      sessionLogWriteChain = sessionLogWriteChain
        .then(() => fsp.appendFile(sessionLogPath(), line, { encoding:'utf8', mode:0o600 }))
        .catch(() => {});
    } catch {}
  }
  function flushSessionLogSync() {
    // Shutdown is the one deliberate synchronous flush: normal playback/logging
    // never blocks the Electron main thread on filesystem I/O.
    try {
      if (!sessionLogInitialized) return;
      // The async chain owns normal writes. This final marker is intentionally
      // separate and only used during process teardown.
      fs.appendFileSync(sessionLogPath(), '', { encoding:'utf8', mode:0o600 });
    } catch {}
  }
  function pruneSessionLogs() {
    try {
      const files = fs.readdirSync(beehiveLogDir())
        .filter(name => /^session-\d{8}-\d{6}-\d+\.txt$/.test(name))
        .map(name => ({ name, path:path.join(beehiveLogDir(), name), mtime:fs.statSync(path.join(beehiveLogDir(), name)).mtimeMs }))
        .sort((a,b) => b.mtime - a.mtime);
      for (const item of files.slice(20)) { try { fs.unlinkSync(item.path); } catch {} }
    } catch {}
  }
  function prettyConsole(level, args) {
    // Session logs retain all normal console traffic, but the live terminal should
    // stay quiet during playback. High-frequency stdout/stderr rendering can itself
    // contend with the desktop compositor when a terminal is attached.
    if ((level === 'log' || level === 'info' || level === 'debug') && process.env.HIVE_VERBOSE_LOGS !== '1') return;
    const text = args.map(v => typeof v === 'string' ? v : util.inspect(v, { depth:5, colors:false, compact:true, breakLength:140 })).join(' ');
    if (CONSOLE_NOISE.some(re => re.test(text))) return;
    const stamp = new Date().toLocaleTimeString([], { hour12:false });
    const tag = level.toUpperCase().padEnd(5);
    try { RAW_CONSOLE[level](`[${stamp}] ${tag} ${text}`); } catch {}
  }
  function installConsoleCapture() {
    for (const level of Object.keys(RAW_CONSOLE)) {
      console[level] = (...args) => {
        writeSession(level.toUpperCase(), 'MAIN', args.map(v => typeof v === 'string' ? v : util.inspect(v, { depth:8, colors:false, compact:false })).join(' '));
        prettyConsole(level, args);
      };
    }
  }
  function startupDebugPath() { return sessionLogPath(); }
  function startupDebug(label, details = null) {
    if (!startupDebugEnabled) return;
    const now = process.hrtime.bigint();
    const event = {
      ts: new Date().toISOString(),
      tMs: Number(now - startupDebugStartedAt) / 1e6,
      pid: process.pid,
      label,
      details,
      memory: (() => { try { const m = process.memoryUsage(); return { rss:m.rss, heapUsed:m.heapUsed, heapTotal:m.heapTotal, external:m.external }; } catch { return null; } })()
    };
    const line = JSON.stringify(event) + '\n';
    try { fs.appendFileSync(startupDebugPath(), line); } catch {}
    writeSession('DEBUG', 'STARTUP', label, details);
    if (!CONSOLE_NOISE.some(re => re.test(label))) { try { RAW_CONSOLE.log(`[Startup] ${label}${details == null ? '' : ` ${util.inspect(details, {depth:4, colors:false, compact:true})}`}`); } catch {} }
  }
  installConsoleCapture();
  writeSession('INFO', 'SESSION', 'Session started', { version: app.getVersion?.() || 'unknown', platform:process.platform, arch:process.arch, cwd:process.cwd() });
  pruneSessionLogs();

  function startupTrackedSnapshot() {
    return [...startupTrackedChildren.values()].map(x => ({ ...x }));
  }
  function startupDebugAppMetrics() {
    if (!startupDebugEnabled) return;
    let metrics = [];
    try { metrics = app.getAppMetrics().map(m => ({ type:m.type, pid:m.pid, name:m.name, cpu:m.cpu?.percent, rss:m.memory?.workingSetSize, creationTime:m.creationTime })); } catch {}
    startupDebug('PROCESS SNAPSHOT', { trackedChildren: startupTrackedSnapshot(), appMetrics: metrics });
  }
  function startStartupProfiler() {
    if (!startupDebugEnabled || startupDebugTimer) return;
    ensureBeehiveLogDir();
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
      // Keep a low-frequency diagnostic stream alive after startup. The reported
      // failure happened after playback had been idle for a while, so a 20-second
      // startup-only window cannot capture the event that actually kills the app.
      const runtimeTimer = setInterval(() => {
        startupDebugAppMetrics();
        startupDebug('RUNTIME HEALTH', { uptimeMs: Math.round(process.uptime() * 1000), trackedChildren: startupTrackedSnapshot() });
      }, 5000);
      runtimeTimer.unref?.();
      startupDebugTimer = runtimeTimer;
    }, 20000);
    startupDebugTimer.unref?.();
  }
  function stopStartupProfiler(reason='manual') {
    if (!startupDebugEnabled || startupDebugStopped) return;
    startupDebug('STARTUP DEBUG STOPPED', { reason, trackedChildren:startupTrackedSnapshot() });
    startupDebugStopped = true;
    if (startupDebugTimer) { clearTimeout(startupDebugTimer); startupDebugTimer = null; }
  }
  function spawnTracked(command, args = [], options = {}) {
    const child = spawn(command, args, options);
    if (startupDebugEnabled) {
      const key = `${child.pid}:${command}`;
      startupTrackedChildren.set(key, { pid:child.pid, kind:'spawn', command:String(command), args:(args||[]).map(String), startedMs:Number((Number(process.hrtime.bigint()-startupDebugStartedAt)/1e6).toFixed(1)), state:'running' });
      startupDebug('CHILD SPAWN', startupTrackedChildren.get(key));
      child.on('exit', (code, signal) => { const item=startupTrackedChildren.get(key); if(item){ item.state='exited'; item.code=code; item.signal=signal; item.endedMs=Number((Number(process.hrtime.bigint()-startupDebugStartedAt)/1e6).toFixed(1)); } startupDebug('CHILD EXIT', item || {pid:child.pid,command}); });
    }
    return child;
  }
  function forkTracked(modulePath, args = [], options = {}) {
    const child = fork(modulePath, args, options);
    if (startupDebugEnabled) {
      const key = `${child.pid}:fork:${modulePath}`;
      startupTrackedChildren.set(key, { pid:child.pid, kind:'fork', module:String(modulePath), args:(args||[]).map(String), startedMs:Number((Number(process.hrtime.bigint()-startupDebugStartedAt)/1e6).toFixed(1)), state:'running' });
      startupDebug('CHILD FORK', startupTrackedChildren.get(key));
      child.on('exit', (code, signal) => { const item=startupTrackedChildren.get(key); if(item){ item.state='exited'; item.code=code; item.signal=signal; item.endedMs=Number((Number(process.hrtime.bigint()-startupDebugStartedAt)/1e6).toFixed(1)); } startupDebug('CHILD EXIT', item || {pid:child.pid,module:modulePath}); });
    }
    return child;
  }
  function runtimeResourcePath(relativePath) {
    if (app.isPackaged) {
      const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', relativePath);
      if (fs.existsSync(unpackedPath)) return unpackedPath;
      return path.join(process.resourcesPath, 'app.asar', relativePath);
    }
    return path.join(hiveProjectRoot, relativePath);
  }
  function workerForkOptions(options = {}) {
    const unpackedRoot = path.join(process.resourcesPath, 'app.asar.unpacked');
    const env = { ...process.env };
    if (app.isPackaged) {
      // Worker entry points and local helpers are unpacked, while production
      // node_modules remain in app.asar. Electron's ASAR-aware loader can
      // resolve those dependencies through NODE_PATH.
      env.NODE_PATH = [path.join(process.resourcesPath, 'app.asar', 'node_modules'), env.NODE_PATH].filter(Boolean).join(path.delimiter);
    }
    return { ...options, cwd: app.isPackaged ? unpackedRoot : (options.cwd || __dirname), env };
  }
  startStartupProfiler();

  // Crash diagnostics: keep failures visible in the terminal and in a small local
  // log without changing normal playback behavior. Electron exposes renderer and
  // child-process termination through render-process-gone/child-process-gone.
  function crashDebug(label, details) {
    writeSession('ERROR', 'CRASH', label, details);
    // Keep a concise terminal signal for actual failures; the complete session remains in logs/session-*.txt.
    try { RAW_CONSOLE.error(`[CRASH] ${label}${details == null ? '' : ` ${util.inspect(details, {depth:6, colors:false, compact:true})}`}`); } catch {}
  }
  try { process.stderr.on('error', () => {}); } catch {}
  process.on('uncaughtException', err => crashDebug('MAIN uncaughtException', { message: err?.message, stack: err?.stack }));
  process.on('unhandledRejection', reason => crashDebug('MAIN unhandledRejection', { reason: reason?.stack || reason?.message || String(reason) }));

  return {
    RAW_CONSOLE,
    CONSOLE_NOISE,
    beehiveLogDir,
    ensureBeehiveLogDir,
    sessionLogPath,
    writeSession,
    flushSessionLogSync,
    pruneSessionLogs,
    installConsoleCapture,
    startupDebug,
    startupDebugAppMetrics,
    startStartupProfiler,
    stopStartupProfiler,
    spawnTracked,
    forkTracked,
    runtimeResourcePath,
    workerForkOptions,
    crashDebug,
  };
}

module.exports = { createSessionLog };
