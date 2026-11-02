'use strict';
// Plugins run sandboxed (app/renderer/plugin-sandbox.js is Hive's side, plugin-frame.js runs in the
// plugin's frame). Stable home for the sandbox's tests: edit in place.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const { permissionForCall, permissionForEvent, allowed } = require('../app/renderer/plugin-sandbox.js');
const { hivePluginFrame } = require('../app/renderer/plugin-frame.js');

test('each request and event needs its declared permission', () => {
  assert.equal(permissionForCall('player.play'), 'player.control');
  assert.equal(permissionForCall('player.next'), 'player.control');
  assert.equal(permissionForCall('media.artistImage'), 'media.artwork');
  assert.equal(permissionForCall('settings.save'), 'settings');
  assert.equal(permissionForCall('ui.toast'), '');
  assert.equal(permissionForCall('fs.read'), null, 'anything Hive does not know is refused');
  assert.equal(permissionForCall('constructor'), null);
  assert.equal(permissionForEvent('spectrum'), 'spectrum.read');
  assert.equal(permissionForEvent('track-change'), 'player.read');
  assert.equal(permissionForEvent('library'), 'library.read');
  const plugin = { permissions: ['player.read'] };
  assert.equal(allowed(plugin, 'player.read'), true);
  assert.equal(allowed(plugin, 'player.control'), false);
  assert.equal(allowed(plugin, ''), true);
  assert.equal(allowed(plugin, null), false);
});

// Runs the frame's runtime against a stand-in window: `sent` is what it posts to Hive, `deliver`
// sends it a message from Hive.
function fakeFrame() {
  const sent = [];
  const listeners = [];
  const parent = { postMessage: m => sent.push(m) };
  const el = () => ({ style: { setProperty() {} }, classList: { add() {} }, appendChild() {}, remove() {}, textContent: '', hidden: false });
  // The runtime reads `window` and `document` as messages arrive, so these stay for the file's tests.
  global.window = { parent, addEventListener: (type, fn) => type === 'message' && listeners.push(fn) };
  global.document = { title: '', head: el(), body: el(), documentElement: el(), createElement: el };
  hivePluginFrame();
  const deliver = async data => { for (const fn of listeners) await fn({ source: parent, data: { hive: true, ...data } }); };
  return { sent, deliver, listeners, parent };
}
const init = (js, permissions = []) => ({ type: 'init', plugin: { id: 'test.plugin', name: 'Test', permissions, js, css: '' }, theme: {}, cache: { current: { path: '/a.mp3', title: 'A' }, cover: 'mbcover://a.jpg' } });

test('the frame tells Hive it is ready, then runs the plugin it is sent', async () => {
  const { sent, deliver } = fakeFrame();
  assert.deepEqual(sent[0], { hive: true, type: 'ready' });
  await deliver(init(`Hive.ui.toast('hello')`));
  assert.ok(sent.some(m => m.type === 'call' && m.method === 'ui.toast' && m.args[0] === 'hello'));
  assert.ok(sent.some(m => m.type === 'loaded' && m.ok === true));
});

test('a plugin without a permission is refused in the frame, before Hive is even asked', async () => {
  const { sent, deliver } = fakeFrame();
  await deliver(init(`Hive.player.getCurrent()`, ['settings']));
  const loaded = sent.find(m => m.type === 'loaded');
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /lacks permission: player\.read/);
  assert.ok(!sent.some(m => m.type === 'call'));
});

test('permitted reads answer at once from the copies Hive sent', async () => {
  const { sent, deliver } = fakeFrame();
  await deliver(init(`
    const t = Hive.player.getCurrent();
    if (t.title !== 'A' || Hive.player.getCoverUrl() !== 'mbcover://a.jpg') throw new Error('wrong copy');
    Hive.events.on('track-change', next => Hive.ui.toast(next.title + ' ' + Hive.player.getCoverUrl()));
  `, ['player.read']));
  assert.ok(sent.find(m => m.type === 'loaded').ok);
  await deliver({ type: 'event', name: 'track-change', payload: { path: '/b.mp3', title: 'B' }, cover: 'mbcover://b.jpg' });
  assert.ok(sent.some(m => m.method === 'ui.toast' && m.args[0] === 'B mbcover://b.jpg'));
});

test('requests wait for Hive\'s answer, and a refusal reaches the plugin as an error', async () => {
  const { sent, deliver } = fakeFrame();
  await deliver(init(`
    Hive.settings.load().then(s => Hive.ui.toast('bars ' + s.bars));
    Hive.player.next().catch(e => Hive.ui.toast('refused: ' + e.message));
  `, ['settings', 'player.control']));
  const load = sent.find(m => m.method === 'settings.load');
  const next = sent.find(m => m.method === 'player.next');
  await deliver({ type: 'reply', call: load.call, ok: true, value: { bars: 63 } });
  await deliver({ type: 'reply', call: next.call, ok: false, error: 'no' });
  await new Promise(r => setImmediate(r));
  assert.ok(sent.some(m => m.method === 'ui.toast' && m.args[0] === 'bars 63'));
  assert.ok(sent.some(m => m.method === 'ui.toast' && m.args[0] === 'refused: no'));
});

test('the frame ignores messages that are not from Hive', async () => {
  const { sent, listeners } = fakeFrame();
  for (const fn of listeners) await fn({ source: { postMessage() {} }, data: { hive: true, ...init(`Hive.ui.toast('x')`) } });
  assert.equal(sent.length, 1, 'only its own "ready"');
});

test('the frame page allows only its own boot script, no network, and has no origin', () => {
  const html = read('app/renderer/plugin-frame.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const hash = crypto.createHash('sha256').update(script).digest('base64');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, new RegExp(`script-src 'sha256-${hash.replace(/[+/=]/g, '\\$&')}' 'unsafe-eval';`), 'the CSP hash must match the inline boot script');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /https?:/);
  assert.match(script, /e\.source!==parent/, 'the boot script only takes the runtime from Hive');
  const sandbox = read('app/renderer/plugin-sandbox.js');
  assert.match(sandbox, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(sandbox, /allow-same-origin|allow-popups|allow-top-navigation|allow-forms/);
});

test('Hive\'s own window no longer runs plugin code or allows eval', () => {
  const html = read('app/renderer/index.html');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(read('app/main/preload.js'), /runPlugin|plugins:run/);
  const main = read('app/main/main.js');
  assert.doesNotMatch(main, /plugins:run/);
  assert.doesNotMatch(read('app/renderer/renderer.js'), /window\.HivePlugin\b/);
  // Frames get no network, WebRTC included.
  assert.match(main, /webRequest\.onBeforeRequest\([\s\S]{0,200}details\.frame\?\.parent[\s\S]{0,80}cancel: true/);
  assert.match(main, /setWebRTCIPHandlingPolicy\('disable_non_proxied_udp'\)/);
});
