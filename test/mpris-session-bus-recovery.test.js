const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'mpris.js'), 'utf8');

test('MPRIS requests the well-known name without queueing behind a stale owner', () => {
  assert.match(source, /requestName\(SERVICE, dbus\.NameFlag\?\.DO_NOT_QUEUE \?\? 4\)/);
  assert.match(source, /primaryOwner = dbus\.RequestNameReply\?\.PRIMARY_OWNER \?\? 1/);
  assert.match(source, /if \(reply !== primaryOwner && reply !== alreadyOwner\)/);
});

test('MPRIS automatically re-registers after a session-bus disconnect', () => {
  assert.match(source, /bus\.on\?\.\('error',/);
  assert.match(source, /bus\.on\?\.\('close',/);
  assert.match(source, /_scheduleReconnect\('close'\)/);
  assert.match(source, /this\.reconnectTimer = setTimeout\(\(\) => \{/);
  assert.match(source, /void this\.start\(\)\.catch\(\(\) => \{\}\)/);
});

test('MPRIS preserves state while reconnecting', () => {
  assert.match(source, /this\.state = \{ track: null/);
  assert.match(source, /await this\.update\(this\.state\)/);
  assert.match(source, /this\.root = null; this\.player = null; this\.running = false/);
});
