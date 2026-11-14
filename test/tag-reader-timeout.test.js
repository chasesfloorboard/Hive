'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The native tag-reader pool (startTagReaderWorker/pickTagReaderWorker/runTagHelper) lives inside
// main.js, which can't be required without Electron. Like database-worker-client, a wedged worker
// must not hang its caller forever: runTagHelper now arms a per-request timeout that recycles the
// worker and rejects, and the response/exit paths clear it. Assert that robustness at the source
// (behaviour, not whitespace) so a refactor can't silently drop it and reintroduce the hang.
const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'main.js'), 'utf8');

function slice(from, to) {
  const start = main.indexOf(from);
  assert.ok(start >= 0, `expected to find ${from}`);
  const end = main.indexOf(to, start + from.length);
  assert.ok(end > start, `expected ${to} after ${from}`);
  return main.slice(start, end);
}

test('runTagHelper arms a request timeout that recycles a wedged worker and rejects', () => {
  assert.match(main, /const TAG_HELPER_REQUEST_TIMEOUT_MS\s*=\s*\d+/, 'a request-timeout constant must exist');
  const body = slice('function runTagHelper(request) {', '\n}');
  assert.match(body, /setTimeout\(/, 'the request must be guarded by a timeout');
  assert.match(body, /worker\.proc\.kill\(/, 'a timed-out (wedged) worker must be recycled');
  assert.match(body, /timed out/i, 'a timed-out request must reject, not hang');
  assert.match(body, /\.unref\(\)|\.unref\?\.\(\)/, 'the timeout timer must be unref\'d so a pending read never holds the app open');
  assert.match(body, /TAG_HELPER_REQUEST_TIMEOUT_MS/, 'the timeout uses the named constant');
});

test('the tag-reader response and exit paths clear the request timer', () => {
  // The stdout line handler, where a reply resolves/rejects a pending request.
  const responder = slice("const pending = worker.pending.get(String(msg.id));", 'pending.reject(new Error(msg.error');
  assert.match(responder, /clearTimeout\(pending\.timer\)/, 'a reply must clear its request timer');
  // The worker exit handler, which rejects everything still in flight.
  const onExit = slice("proc.on('exit', () => {", '});');
  assert.match(onExit, /clearTimeout\(pending\.timer\)/, 'a worker exit must clear the timers of in-flight requests');
  assert.match(onExit, /Native tag reader exited\./, 'a worker exit still rejects in-flight requests');
});
