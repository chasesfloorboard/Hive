const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const HOST_PERMISSIONS = ['library.read', 'player.read', 'player.control', 'spectrum.read', 'media.artwork', 'ui.view', 'ui.sandbox', 'settings'];

test('the bundled Monstercat Visualizer has a valid manifest using only known permissions', () => {
  const dir = path.join(root, 'resources', 'hive-plugins', 'monstercat-visualizer');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'hive-plugin');
  assert.match(manifest.id, /^[a-zA-Z0-9._-]{1,80}$/);
  for (const permission of manifest.permissions) assert.ok(HOST_PERMISSIONS.includes(permission), permission);
  assert.ok(fs.existsSync(path.join(dir, 'plugin.js')));
  assert.ok(fs.existsSync(path.join(dir, 'style.css')));
});

test('plugin host exposes explicit lifecycle and capability surfaces without granting filesystem access', () => {
  const source = read('app/renderer/renderer.js');
  const block = source.slice(source.indexOf('// ---------------- Hive community plugin host API v2'));
  assert.match(block, /lifecycle:\{ onUnload:/);
  assert.match(block, /spectrum\.read/);
  assert.match(block, /library\.read/);
  assert.doesNotMatch(block, /require\(['"]fs['"]\)/);
  assert.doesNotMatch(block, /require\(['"]child_process['"]\)/);
});

test('plugin enable state is persisted and disabled plugins are not executed', () => {
  const main = read('app/main/main.js');
  assert.match(main, /plugins:setEnabled/);
  assert.match(main, /manifest\.enabledByDefault !== false/);
  const renderer = read('app/renderer/renderer.js');
  assert.match(renderer, /if\(!plugin\.enabled\) continue/);
  assert.match(renderer, /setPluginEnabled/);
});

// Runs the bundled plugin the way plugins:run does (new Function('Hive', src))
// against a fake host that enforces the manifest's permissions like the real one.
async function loadVisualizer() {
  const dir = path.join(root, 'resources', 'hive-plugins', 'monstercat-visualizer');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const need = permission => { if (!manifest.permissions.includes(permission)) throw new Error(`missing permission ${permission}`); };
  const views = [];
  const Hive = {
    settings: { load: async () => (need('settings'), {}), onChange: () => (need('settings'), () => {}) },
    player: { getCurrent: () => (need('player.read'), null), getCoverUrl: () => (need('player.read'), null) },
    media: { getArtistImage: async () => (need('media.artwork'), null) },
    audio: { onSpectrum: () => (need('spectrum.read'), () => {}) },
    events: { on: (name) => (need(name === 'spectrum' ? 'spectrum.read' : 'player.read'), () => {}) },
    ui: { registerView: definition => { need('ui.view'); views.push(definition); return () => {}; } }
  };
  await new Function('Hive', fs.readFileSync(path.join(dir, 'plugin.js'), 'utf8'))(Hive);
  return views;
}

test('the Visualizer registers one sidebar view named Visualizer', async () => {
  const views = await loadVisualizer();
  assert.equal(views.length, 1);
  assert.equal(views[0].id, 'visualizer');
  assert.equal(views[0].title, 'Visualizer');
  assert.equal(typeof views[0].mount, 'function');
  assert.equal(typeof views[0].unmount, 'function');
});

test('Visualizer shaping: 63 bars by default and music reaches full height', async () => {
  const { shapeFrame, createGain, DEFAULTS } = (await loadVisualizer())[0].internals;
  const frame = peak => Array.from({ length: 64 }, (_, i) => (i === 20 ? peak : peak * 0.6));
  const gain = createGain();
  let bars;
  for (let i = 0; i < 30; i++) bars = shapeFrame(frame(0.74), gain, { ...DEFAULTS }, 0.033);
  assert.equal(bars.length, 63);
  assert.ok(Math.max(...bars) > 0.95, `music peak ${Math.max(...bars)}`);
});

test('Visualizer bars stay down in silence and quiet passages instead of rising', async () => {
  const { shapeFrame, createGain, DEFAULTS } = (await loadVisualizer())[0].internals;
  const settings = { ...DEFAULTS };
  const gain = createGain();
  const music = Array.from({ length: 64 }, () => 0.7);
  for (let i = 0; i < 30; i++) shapeFrame(music, gain, settings, 0.033);
  // Ten seconds of near-silence (dither/noise around -65 dB): the auto gain
  // used to climb until this noise filled the bars.
  const noise = Array.from({ length: 64 }, (_, i) => 0.17 + (i % 3) * 0.01);
  let bars;
  for (let i = 0; i < 300; i++) bars = shapeFrame(noise, gain, settings, 0.033);
  assert.ok(Math.max(...bars) === 0, `silence peak ${Math.max(...bars)}`);
  // A quiet passage (-48 dB) after that shows short bars, not full ones.
  const quiet = Array.from({ length: 64 }, () => 0.4);
  for (let i = 0; i < 300; i++) bars = shapeFrame(quiet, gain, settings, 0.033);
  assert.ok(Math.max(...bars) < 0.75, `quiet passage peak ${Math.max(...bars)}`);
});

test('Visualizer resampling keeps a single-band peak at full height', async () => {
  const { resample } = (await loadVisualizer())[0].internals;
  const bands = new Array(64).fill(0); bands[20] = 1;
  assert.equal(Math.max(...resample(bands, 63)), 1);
  assert.equal(Math.max(...resample(bands, 32)), 1);
  assert.equal(resample([0, 1], 4).length, 4);
});

test('Visualizer Monstercat smoothing spreads a peak to its neighbours by 1/1.5 per bar', async () => {
  const { monstercatSpread } = (await loadVisualizer())[0].internals;
  const out = monstercatSpread([0, 0, 0.9, 0, 0]);
  assert.equal(out[2], 0.9);
  assert.ok(Math.abs(out[1] - 0.6) < 1e-9 && Math.abs(out[3] - 0.6) < 1e-9);
  assert.ok(Math.abs(out[0] - 0.4) < 1e-9);
});

test('Visualizer bars rise quickly and fall over the configured time', async () => {
  const { stepBars } = (await loadVisualizer())[0].internals;
  const rising = [0];
  stepBars(rising, [1], 1 / 60, 90);
  assert.ok(rising[0] > 0.7, `rise after one frame: ${rising[0]}`);
  const falling = [1];
  stepBars(falling, [0], 1 / 60, 90);
  assert.ok(falling[0] > 0.7 && falling[0] < 1, `fall after one frame: ${falling[0]}`);
  for (let i = 0; i < 120; i++) stepBars(falling, [0], 1 / 60, 90);
  assert.equal(falling[0], 0);
});

test('Visualizer clamps saved settings, so 9999 bars becomes the 128 maximum', async () => {
  const { sanitizeSettings } = (await loadVisualizer())[0].internals;
  assert.equal(sanitizeSettings({ barCount: 9999 }).barCount, 128);
  assert.equal(sanitizeSettings({ barCount: 'abc' }).barCount, 63);
  assert.equal(sanitizeSettings({ sensitivity: 1, decayMs: 99999 }).sensitivity, 15);
  assert.equal(sanitizeSettings({ decayMs: 99999 }).decayMs, 400);
});
