'use strict';

// Native GStreamer playback backend bridge. GStreamer owns the actual audio
// sink, clock, buffering, seeking and gapless transitions; the main process
// only sends transport commands over stdin and receives lightweight
// tab-separated events over an extra stdio pipe (fd 3).
//
// This is a factory rather than a bare module because it needs a handful of
// main.js-level things (logging, path helpers, the current main window) —
// passing them in as `deps` keeps this file independently testable instead
// of reaching back into main.js's shared closure state.
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
  function gstreamerHelperBinary() { return path.join(userDataDir(), 'beehive-gstreamer-player'); }

  function ensureGstreamerHelper() {
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
      gstreamerProcess = spawnTracked(gstreamerHelperBinary(), [], {
        stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
        env: { ...process.env, HIVE_AUDIO_OUTPUT_DEVICE: String(getAudioOutputDevice() || '').trim() }
      });
      // GStreamer owns the real-time-ish audio path. Do not deliberately nice the
      // helper below normal priority: doing so can starve the native transport and
      // make short ramp/transport transitions audible as stutter or clicks under
      // desktop load. UI/background workloads must yield to the audio owner.
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
          crashDebug('GSTREAMER READY TIMEOUT', { timeoutMs: 1500 });
        }
        resolve(!!gstreamerRuntimeReady);
      }, 1500);
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
