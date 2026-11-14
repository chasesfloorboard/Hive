'use strict';

// The library database worker client. Extracted from main.js (QUALITY-ROADMAP, Database region).
//
// Hive's SQLite library index lives in a Python subprocess (app/workers/database-worker.py). This module
// owns that process and the newline-delimited JSON request/response transport over its stdio, including the
// per-request timeout that recycles a wedged worker so an awaiting library IPC handler — and the renderer
// invoke behind it — can never hang forever.
//
// Injected deps: dbPath() (the beehive.db path), spawnTracked (tracked child spawn), runtimeResourcePath
// (locate the bundled worker script), crashDebug (logging). The `ready` flag is exposed via isReady/setReady
// because initialization (recover_jobs) and the startup sequence flip it from outside.

const path = require('node:path');

function createDatabaseWorkerClient({ dbPath, spawnTracked, runtimeResourcePath, crashDebug = () => {}, requestTimeoutMs = 60000 }) {
  let databaseProcess = null;
  let databaseReady = false;
  let databaseSeq = 0;
  const databasePending = new Map();

  function startDatabaseWorker() {
    if (databaseProcess && !databaseProcess.killed) return;
    const worker = runtimeResourcePath(path.join('app', 'workers', 'database-worker.py'));
    databaseProcess = spawnTracked(process.env.BEEHIVE_PYTHON || 'python3', [worker, dbPath()], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    databaseProcess.stderr.on('data', chunk => { const text = String(chunk || '').trim(); if (text) crashDebug('DATABASE worker stderr', text); });
    const ended = (why) => {
      for (const pending of databasePending.values()) pending.reject(new Error(why));
      databasePending.clear(); databaseProcess = null; databaseReady = false;
    };
    databaseProcess.on('exit', () => ended('Database worker exited.'));
    // Python missing (or not startable): requests fail with a clear error instead of an unhandled
    // 'error' event taking down Hive's main process.
    databaseProcess.on('error', err => { crashDebug('DATABASE worker could not start', { message: err?.message || String(err) }); ended(`The library database couldn't start: ${err?.message || err}`); });
    databaseProcess.stdin?.on('error', () => {});
    databaseReady = true;
  }

  function databaseRequest(cmd, payload = {}) {
    startDatabaseWorker();
    const id = String(++databaseSeq);
    return new Promise((resolve, reject) => {
      const proc = databaseProcess;
      const timer = setTimeout(() => {
        if (!databasePending.has(id)) return;
        databasePending.delete(id);
        // Recycle the wedged worker so the next request spawns a fresh one (the scanner pool does the same).
        try { if (databaseProcess === proc) proc.kill(); } catch {}
        crashDebug('DATABASE request timed out', { cmd });
        reject(new Error(`library database request '${cmd}' timed out`));
      }, requestTimeoutMs);
      timer.unref?.();
      databasePending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      try { databaseProcess.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n'); }
      catch (err) { clearTimeout(timer); databasePending.delete(id); reject(err); }
    });
  }

  return {
    startDatabaseWorker,
    databaseRequest,
    isReady: () => databaseReady,
    setReady: (v) => { databaseReady = !!v; },
    kill: () => { try { databaseProcess?.kill(); } catch {} },
    pendingCount: () => databasePending.size,
  };
}

module.exports = { createDatabaseWorkerClient };
