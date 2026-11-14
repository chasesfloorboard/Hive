'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bearerTokenTransportOk, isLoopbackAddress } = require('../app/main/hive-link');

test('isLoopbackAddress recognises loopback (and only loopback)', () => {
  for (const a of ['127.0.0.1', '127.0.0.5', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['192.168.1.4', '100.64.0.1', '10.0.0.2', '', null, undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
});

test('before the encrypted port is up, nothing is enforced (back-compat / pairing bootstrap)', () => {
  assert.equal(bearerTokenTransportOk({ tlsReady: false, encrypted: false, remoteAddress: '192.168.1.9' }), true);
});

test('with TLS up, a bearer token over TLS is always fine', () => {
  assert.equal(bearerTokenTransportOk({ tlsReady: true, encrypted: true, remoteAddress: '192.168.1.9' }), true);
  assert.equal(bearerTokenTransportOk({ tlsReady: true, encrypted: true, remoteAddress: '100.64.0.1' }), true);
});

test('with TLS up, a cleartext bearer token from a NETWORK peer is refused', () => {
  assert.equal(bearerTokenTransportOk({ tlsReady: true, encrypted: false, remoteAddress: '192.168.1.9' }), false, 'home LAN peer');
  assert.equal(bearerTokenTransportOk({ tlsReady: true, encrypted: false, remoteAddress: '100.64.0.1' }), false, 'Tailscale peer must use TLS');
});

test('with TLS up, a cleartext bearer token over loopback/USB is still allowed (not sniffable)', () => {
  assert.equal(bearerTokenTransportOk({ tlsReady: true, encrypted: false, remoteAddress: '127.0.0.1' }), true, 'loopback');
  assert.equal(bearerTokenTransportOk({ tlsReady: true, encrypted: false, remoteAddress: '::1' }), true, 'ipv6 loopback');
  assert.equal(bearerTokenTransportOk({ tlsReady: true, encrypted: false, remoteAddress: '::ffff:127.0.0.1' }), true, 'adb-reverse / USB');
});
