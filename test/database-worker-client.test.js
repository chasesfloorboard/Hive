'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDatabaseWorkerClient } = require('../app/main/database-worker-client');

// A fake child process standing in for the Python database worker.
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.writes = [];
  proc.stdin = { write: (s) => { proc.writes.push(s); return true; }, on: () => {} };
  proc.kill = () => { proc.killed = true; proc.emit('exit'); };
  // Reply to the Nth (0-based) request with {ok,result} or {ok:false,error}
  proc.reply = (reqIndex, payload) => {
    const sent = JSON.parse(proc.writes[reqIndex]);
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ id: sent.id, ...payload }) + '\n'));
  };
  return proc;
}

function makeClient(opts = {}) {
  const procs = [];
  const spawnTracked = () => { const p = makeFakeProc(); procs.push(p); return p; };
  const client = createDatabaseWorkerClient({
    dbPath: () => '/tmp/test.db',
    spawnTracked,
    runtimeResourcePath: (rel) => '/runtime/' + rel,
    crashDebug: () => {},
    ...opts,
  });
  return { client, procs };
}

test('a request writes a JSON line and resolves with the worker reply', async () => {
  const { client, procs } = makeClient();
  const p = client.databaseRequest('get_track_paths', { limit: 5 });
  assert.equal(procs.length, 1, 'worker spawned lazily on first request');
  const sent = JSON.parse(procs[0].writes[0]);
  assert.equal(sent.cmd, 'get_track_paths');
  assert.equal(sent.limit, 5);
  assert.ok(sent.id, 'request carries an id');
  procs[0].reply(0, { ok: true, result: ['a.flac', 'b.flac'] });
  assert.deepEqual(await p, ['a.flac', 'b.flac']);
});

test('a worker error reply rejects the request', async () => {
  const { client, procs } = makeClient();
  const p = client.databaseRequest('compact');
  procs[0].reply(0, { ok: false, error: 'disk full' });
  await assert.rejects(p, /disk full/);
});

test('isReady()/setReady() reflect spawn and external flips', () => {
  const { client } = makeClient();
  assert.equal(client.isReady(), false, 'not ready before any worker starts');
  client.startDatabaseWorker();
  assert.equal(client.isReady(), true, 'ready once spawned');
  client.setReady(false);
  assert.equal(client.isReady(), false);
  client.setReady(true);
  assert.equal(client.isReady(), true);
});

test('a wedged worker request times out, kills the worker, and rejects', async () => {
  const { client, procs } = makeClient({ requestTimeoutMs: 20 });
  const p = client.databaseRequest('replace_library');
  // The client unref()s its timeout timer (a pending request must never hold the app open on
  // quit), so on an otherwise-idle event loop the timer would not keep the loop alive long
  // enough to fire. Hold a ref'd keepalive across the await so the 20ms timeout actually runs
  // here; without it the loop drains first and the test cancels ("resolution still pending").
  const keepAlive = setInterval(() => {}, 5);
  try {
    await assert.rejects(p, /timed out/);
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(procs[0].killed, true, 'the wedged worker was recycled');
});

test('worker exit rejects every in-flight request', async () => {
  const { client, procs } = makeClient();
  const p1 = client.databaseRequest('a');
  const p2 = client.databaseRequest('b');
  procs[0].emit('exit');
  await assert.rejects(p1, /exited/);
  await assert.rejects(p2, /exited/);
  assert.equal(client.pendingCount(), 0, 'no dangling pending requests after exit');
});

test('kill() terminates the worker', () => {
  const { client, procs } = makeClient();
  client.startDatabaseWorker();
  client.kill();
  assert.equal(procs[0].killed, true);
});

test('startDatabaseWorker does not spawn a second live worker', () => {
  const { client, procs } = makeClient();
  client.startDatabaseWorker();
  client.startDatabaseWorker();
  assert.equal(procs.length, 1, 'idempotent while the worker is alive');
});
