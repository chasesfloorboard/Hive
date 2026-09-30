'use strict';

// Native GStreamer playback backend bridge. GStreamer owns the actual audio
// sink, clock, buffering, seeking and gapless transitions; the main process
// only sends transport commands over stdin and receives lightweight
// tab-separated events over an extra stdio pipe (fd 3; stdout on Windows).
//
// Linux compiles the helper from source on first use (pkg-config + cc) and
// uses the system GStreamer. Windows ships a prebuilt helper plus a trimmed
// GStreamer runtime as extra resources (see scripts/build-windows.sh):
//   <resources>/native/beehive-gstreamer-player.exe
//   <resources>/GStreamer/{bin, lib/gstreamer-1.0, libexec/gstreamer-1.0}
//
// This is a factory rather than a bare module because it needs a handful of
// main.js-level things (logging, path helpers, the current main window) —
// passing them in as `deps` keeps this file independently testable instead
// of reaching back into main.js's shared closure state.
const { resolveLaunchOutput, scheduleExclusiveReleaseRestore } = require('./audio-output-manager');

function createGstreamerBridge(deps) {
  const {
    runtimeResourcePath,
    userDataDir,
    spawnTracked,
    crashDebug,
    writeSession,
    getMainWindow,
    startupDebugEnabled = false,
    gstreamerTraceEnabled = false,
    getAudioOutputDevice = () => '',
    readyTimeoutMs,
  } = deps;

  const path = require('path');
  const fs = require('fs');
  const crypto = require('crypto');
  const { execFileSync } = require('child_process');

  let gstreamerProcess = null;
  let gstreamerReady = false;
  let gstreamerCompileAttempted = false;
  let gstreamerRuntimeReady = false;
  let gstreamerShuttingDown = false;
  let gstreamerRestartAttempts = 0;
  let gstreamerStartupFailed = false;
  let gstreamerEventBuffer = '';
  let gstreamerReadyWaiters = [];

  function gstreamerHelperSource() { return runtimeResourcePath(path.join('app', 'native', 'gstreamer-player.c')); }
  const isWindows = process.platform === 'win32';
  // How long the helper may take to report READY before it is treated as hung.
  // gst_init() builds GStreamer's plugin registry on a helper's first run by
  // loading every plugin through gst-plugin-scanner. On Windows, with Defender
  // scanning each bundled DLL, that took far longer than the old 1.5 s: the
  // helper was killed mid-scan, the registry was never saved, and playback
  // stayed off for the session until a relaunch happened to finish in time.
  const gstreamerReadyTimeoutMs = readyTimeoutMs ?? 60000;
  function gstreamerHelperBinary() {
    if (isWindows) return path.join(process.resourcesPath || '', 'native', 'beehive-gstreamer-player.exe');
    return path.join(userDataDir(), 'beehive-gstreamer-player');
  }

  // The helper's environment: the chosen output, and on Windows the bundled
  // GStreamer runtime -- first on PATH so its DLLs win over any other
  // GStreamer install, with plugins, the plugin scanner and the plugin
  // registry cache pinned to Hive's own copies.
  function helperSpawnEnv(device) {
    const env = { ...process.env, HIVE_AUDIO_OUTPUT_DEVICE: device };
    if (!isWindows) return env;
    const gst = path.join(process.resourcesPath || '', 'GStreamer');
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'Path';
    env[pathKey] = [path.join(gst, 'bin'), env[pathKey]].filter(Boolean).join(';');
    env.GST_PLUGIN_SYSTEM_PATH_1_0 = path.join(gst, 'lib', 'gstreamer-1.0');
    env.GST_PLUGIN_PATH_1_0 = '';
    env.GST_PLUGIN_SCANNER_1_0 = path.join(gst, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe');
    env.GST_REGISTRY_1_0 = path.join(userDataDir(), 'gstreamer-registry-1.0.bin');
    return env;
  }

  function ensureGstreamerHelper() {
    if (isWindows) {
      gstreamerReady = fs.existsSync(gstreamerHelperBinary());
      return gstreamerReady;
    }
    if (process.platform !== 'linux') return false;
    if (gstreamerCompileAttempted) return !!gstreamerReady;
    gstreamerCompileAttempted = true;
    try {
      const source = gstreamerHelperSource();
      if (!fs.existsSync(source)) return false;
      const out = gstreamerHelperBinary();
      const stamp = `${out}.sha256`;
      const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
      let recordedHash = '';
      try { recordedHash = fs.readFileSync(stamp, 'utf8').trim(); } catch {}
      const rebuild = !fs.existsSync(out) || recordedHash !== sourceHash;
      if (rebuild) {
        // The native helper uses the core GStreamer API. The ordinary
        // user-volume slider path runs a 50ms retargeting ramp driven by a
        // GstPadProbe on the volume element's sink pad (see
        // begin_user_volume_ramp/volume_ramp_probe_cb in gstreamer-player.c)
        // -- not a GstController, and not a persistent timer: it
        // self-terminates once the ramp reaches its target. During an active
        // ramp, gain is applied by directly scaling each buffer's raw PCM
        // samples (gstreamer-audio-1.0's GstAudioInfo) rather than stepping
        // the element's own "volume" property once per buffer, so the ramp
        // is smooth regardless of how large the incoming buffers are.
        const pkgs = ['gstreamer-1.0', 'gstreamer-audio-1.0'];
        const cflags = execFileSync('pkg-config', ['--cflags', ...pkgs], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
        const libs = execFileSync('pkg-config', ['--libs', ...pkgs], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
        execFileSync('cc', [source, '-O2', '-o', out, ...cflags, ...libs, '-pthread', '-lm'], { stdio: 'ignore' });
        fs.chmodSync(out, 0o755);
        fs.writeFileSync(stamp, `${sourceHash}\n`, { encoding: 'utf8', mode: 0o600 });
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
      gstreamerStartupFailed = false;
      // A bit-perfect (alsa:) output is only used when the card is actually
      // free; otherwise play through the same DAC's shared sink and tell the
      // renderer why (see resolveLaunchOutput).
      const launchOutput = resolveLaunchOutput(String(getAudioOutputDevice() || '').trim());
      if (launchOutput.fallback) {
        writeSession('WARN', 'AUDIO OUTPUT', launchOutput.reason, { device: launchOutput.device || 'system-default' });
        const win = getMainWindow();
        try { if (win && !win.isDestroyed()) win.webContents.send('gstreamer:event', { name: 'BIT_PERFECT_UNAVAILABLE', value: launchOutput.reason }); } catch {}
      }
      gstreamerProcess = spawnTracked(gstreamerHelperBinary(), [], {
        stdio: isWindows ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe', 'pipe'],
        env: helperSpawnEnv(launchOutput.device),
        windowsHide: true
      });
      // Whenever this helper exits -- output switch, restart, crash, or Hive
      // quitting -- hand an exclusively-held card back to PipeWire properly.
      if (launchOutput.bitPerfect) gstreamerProcess.once('exit', () => { scheduleExclusiveReleaseRestore(launchOutput.restore); });
      // GStreamer owns the real-time-ish audio path. Do not deliberately nice the
      // helper below normal priority: doing so can starve the native transport and
      // make short ramp/transport transitions audible as stutter or clicks under
      // desktop load. UI/background workloads must yield to the audio owner.
      gstreamerProcess.stdio[2].on('data', chunk => {
        const text = chunk.toString('utf8').trim();
        if (text) crashDebug('GSTREAMER stderr', text);
      });
      (isWindows ? gstreamerProcess.stdout : gstreamerProcess.stdio[3]).on('data', chunk => {
        gstreamerEventBuffer += chunk.toString('utf8');
        let idx;
        while ((idx = gstreamerEventBuffer.indexOf('\n')) >= 0) {
          const line = gstreamerEventBuffer.slice(0, idx).replace(/\r$/, '');
          gstreamerEventBuffer = gstreamerEventBuffer.slice(idx + 1);
          const tab = line.indexOf('\t');
          const name = tab >= 0 ? line.slice(0, tab) : line;
          const value = tab >= 0 ? line.slice(tab + 1) : '';
          if (name === 'TRACE' && gstreamerTraceEnabled) {
            const traceFields = String(value || '').split('\t');
            writeSession('DEBUG', 'GSTREAMER', traceFields.slice(1).join('\t') || traceFields[0] || 'trace');
          }
          if (name === 'READY') {
            if (startupDebugEnabled) crashDebug('GSTREAMER READY', { helper: gstreamerHelperBinary() });
            gstreamerRuntimeReady = true;
            gstreamerRestartAttempts = 0;
            const waiters = gstreamerReadyWaiters.splice(0);
            waiters.forEach(resolve => resolve(true));
          }
          if (name === 'ERROR' && !gstreamerRuntimeReady) {
            const waiters = gstreamerReadyWaiters.splice(0);
            waiters.forEach(resolve => resolve(false));
          }
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.webContents.send('gstreamer:event', { name, value }); } catch {}
          }
        }
      });
      gstreamerProcess.on('exit', (code, signal) => {
        crashDebug('GSTREAMER exit', { code, signal, unexpected: !gstreamerShuttingDown });
        const exiting = gstreamerProcess;
        gstreamerProcess = null;
        gstreamerRuntimeReady = false;
        const mainWindow = getMainWindow();
        if (!gstreamerShuttingDown && !gstreamerStartupFailed && mainWindow && !mainWindow.isDestroyed()) {
          try { mainWindow.webContents.send('gstreamer:event', { name: 'PROCESS_EXIT', value: `code=${code ?? 'null'} signal=${signal ?? 'null'}` }); } catch {}
          // A persistent helper disappearing is recoverable. Retry a few times
          // with a delay so a broken native installation cannot create a hot
          // respawn loop or consume the UI thread.
          if (gstreamerRestartAttempts < 3) {
            gstreamerRestartAttempts++;
            const attempt = gstreamerRestartAttempts;
            setTimeout(() => {
              if (gstreamerShuttingDown || gstreamerProcess) return;
              const ok = startGstreamerProcess();
              crashDebug('GSTREAMER AUTO-RESTART', { attempt, ok });
            }, 750).unref?.();
          }
        }
        void exiting;
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
        if (!gstreamerRuntimeReady && gstreamerProcess) {
          gstreamerStartupFailed = true;
          const failedProcess = gstreamerProcess;
          gstreamerProcess = null;
          gstreamerRuntimeReady = false;
          try { failedProcess.kill(); } catch {}
          crashDebug('GSTREAMER READY TIMEOUT', { timeoutMs: gstreamerReadyTimeoutMs });
        }
        resolve(!!gstreamerRuntimeReady);
      }, gstreamerReadyTimeoutMs);
    });
  }

  async function restartGstreamerProcess() {
    // Explicit user-directed recovery boundary after a native decoder/sink fault.
    // Do not reuse the failed playbin instance: a malformed stream can leave the
    // decoder/pipeline in a state that is not safely recoverable by another LOAD.
    const existing = gstreamerProcess;
    if (existing && !existing.killed) {
      gstreamerShuttingDown = true;
      gstreamerStartupFailed = true;
      try { existing.stdin?.write('QUIT\n'); } catch {}
      await new Promise(resolve => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { try { existing.kill(); } catch {} finish(); }, 1000);
        existing.once('exit', finish);
      });
    }
    gstreamerProcess = null;
    gstreamerRuntimeReady = false;
    gstreamerReadyWaiters.splice(0).forEach(resolve => resolve(false));
    gstreamerRestartAttempts = 0;
    gstreamerStartupFailed = false;
    gstreamerShuttingDown = false;
    crashDebug('GSTREAMER EXPLICIT RESTART', { reason: 'user-directed audio recovery' });
    return await gstreamerStatus();
  }

  function sendGstreamerCommand(command) {
    if (!startGstreamerProcess() || !gstreamerProcess?.stdin?.writable) return false;
    try { gstreamerProcess.stdin.write(String(command).replace(/\n/g, '') + '\n'); return true; } catch { return false; }
  }

  // Used on app quit: ask the helper to exit cleanly, then hard-kill shortly
  // after if it hasn't. Mirrors the previous inline main.js shutdown logic.
  function requestQuit() {
    gstreamerShuttingDown = true;
    if (gstreamerProcess && !gstreamerProcess.killed && gstreamerProcess.stdin?.writable) {
      // The GStreamer helper owns a persistent audio pipeline. Explicitly tell
      // it to quit before Electron exits; otherwise an orphaned helper can keep
      // the previous song playing and the next Beehive launch can start a second
      // helper, producing two songs at once.
      try {
        gstreamerProcess.stdin.write('QUIT\n');
        gstreamerProcess.stdin.end();
      } catch {}
      const dying = gstreamerProcess;
      setTimeout(() => { try { if (dying && !dying.killed) dying.kill('SIGTERM'); } catch {} }, 1000).unref?.();
    }
  }

  return {
    ensureGstreamerHelper,
    startGstreamerProcess,
    gstreamerStatus,
    restartGstreamerProcess,
    sendGstreamerCommand,
    requestQuit,
  };
}

module.exports = { createGstreamerBridge };
