'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyElectronStartupFlags } = require('../app/main/electron-flags');

function fakeApp() {
  const switches = [];
  return { switches, commandLine: { appendSwitch: (k, v) => switches.push(v === undefined ? k : `${k}=${v}`) } };
}

test('on Linux the load-bearing X11/XWayland + in-process-GPU switches are applied', () => {
  const app = fakeApp();
  const nativeTheme = {};
  applyElectronStartupFlags({ app, nativeTheme, platform: 'linux' });
  assert.equal(nativeTheme.themeSource, 'system');
  assert.ok(app.switches.includes('ozone-platform=x11'), 'ozone-platform=x11');
  assert.ok(app.switches.includes('disable-features=UseOzonePlatform'), 'disable-features=UseOzonePlatform');
  assert.ok(app.switches.includes('in-process-gpu'), 'in-process-gpu');
  assert.ok(app.switches.includes('disable-gpu-vsync'), 'disable-gpu-vsync');
  assert.ok(app.switches.includes('js-flags=--max-old-space-size=8192 --expose-gc'), 'js-flags');
});

test('off Linux the X11/GPU-process switches are NOT applied, but the cross-platform ones are', () => {
  const app = fakeApp();
  applyElectronStartupFlags({ app, nativeTheme: {}, platform: 'win32' });
  assert.ok(!app.switches.some(s => s.startsWith('ozone-platform')), 'no ozone-platform off Linux');
  assert.ok(!app.switches.includes('in-process-gpu'), 'no in-process-gpu off Linux');
  assert.ok(app.switches.includes('disable-gpu-vsync'), 'disable-gpu-vsync still applied');
  assert.ok(app.switches.some(s => s.startsWith('js-flags=')), 'js-flags still applied');
});

test('a nativeTheme that throws on assignment does not abort flag application', () => {
  const app = fakeApp();
  const nativeTheme = { set themeSource(_v) { throw new Error('no'); } };
  applyElectronStartupFlags({ app, nativeTheme, platform: 'linux' });
  assert.ok(app.switches.includes('ozone-platform=x11'), 'switches still applied after a themeSource failure');
});
