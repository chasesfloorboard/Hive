'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLibraryScanLock, LIBRARY_SCAN_CANCELLED } = require('../app/main/library-scan-lock');

test('LIBRARY_SCAN_CANCELLED is a stable code exported both ways', () => {
  assert.equal(LIBRARY_SCAN_CANCELLED, 'LIBRARY_SCAN_CANCELLED');
  const lock = createLibraryScanLock();
  assert.equal(lock.LIBRARY_SCAN_CANCELLED, LIBRARY_SCAN_CANCELLED);
});

test('acquireLibraryScanLock serializes: the second holder waits for the first to release', async () => {
  const lock = createLibraryScanLock();
  const order = [];
  const release1 = await lock.acquireLibraryScanLock();
  // second acquire must not resolve until release1() is called
  let gotSecond = false;
  const p2 = lock.acquireLibraryScanLock().then(r => { gotSecond = true; return r; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(gotSecond, false, 'second acquire is still blocked while the first holds the lock');
  order.push('first-work');
  release1();
  const release2 = await p2;
  order.push('second-work');
  assert.equal(gotSecond, true);
  release2();
  assert.deepEqual(order, ['first-work', 'second-work']);
});

test('cancelActiveLibraryScan flips every registered token and fires onCancel once', () => {
  const logs = [];
  const lock = createLibraryScanLock({ scanLog: (m) => logs.push(m) });
  let onCancelCalls = 0;
  const token = { cancelled: false, onCancel: () => { onCancelCalls++; } };
  lock.registerActiveScan(token);
  assert.equal(lock.activeScanCount(), 1);

  assert.equal(lock.cancelActiveLibraryScan(), true, 'reports it cancelled something');
  assert.equal(token.cancelled, true);
  assert.equal(onCancelCalls, 1);
  assert.deepEqual(logs, ['SCAN CANCEL REQUESTED']);

  // calling again does nothing (already cancelled) and does not re-log
  assert.equal(lock.cancelActiveLibraryScan(), false);
  assert.equal(onCancelCalls, 1);
  assert.equal(logs.length, 1);
});

test('the unregister fn removes a token so a later cancel no longer touches it', () => {
  const lock = createLibraryScanLock();
  const token = { cancelled: false, onCancel: null };
  const end = lock.registerActiveScan(token);
  end();
  assert.equal(lock.activeScanCount(), 0);
  assert.equal(lock.cancelActiveLibraryScan(), false, 'nothing active to cancel');
  assert.equal(token.cancelled, false, 'finished scan is not retro-cancelled');
});

test('cancelActiveLibraryScan on an empty registry is a quiet no-op', () => {
  const logs = [];
  const lock = createLibraryScanLock({ scanLog: (m) => logs.push(m) });
  assert.equal(lock.cancelActiveLibraryScan(), false);
  assert.equal(logs.length, 0, 'nothing logged when nothing was cancelled');
});
