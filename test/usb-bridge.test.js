'use strict';
// Hive Mobile over USB: attached, authorized phones are bridged with adb reverse.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDevices } = require('../app/main/usb-bridge');

test('only attached, authorized devices are bridged', () => {
  const listing = 'List of devices attached\nR5CT00EXAMPLE\tdevice\nR58N12345\tunauthorized\nemulator-5560\tdevice\n\n';
  assert.deepEqual(parseDevices(listing), ['R5CT00EXAMPLE', 'emulator-5560']);
  assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
});
