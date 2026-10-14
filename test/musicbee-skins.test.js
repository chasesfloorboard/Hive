const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMusicBeeSkin, skinToHiveTheme, contrast } = require('../app/main/musicbee-skins');

const FULL = `<?xml version="1.0"?>
<!-- Skin Name: Test Dark -->
<root><variables>
  Highlight="220,14,96"
  Primary-Text="200,200,200"
  Secondary-Text="150,150,150"
  Background="18,8,16"
</variables>
<colours id="Default">
  <element id="ApplicationBackColour" bg="Background" />
  <element id="Menu.DropDown.Default" bg="Background" fg="0,0,0" />
  <element id="Menu.DropDown.Highlight" bg="Highlight" />
</colours></root>`;

test('reads a full MusicBee XML skin and skips unreadable text colours', () => {
  const p = parseMusicBeeSkin(FULL);
  assert.equal(p.name, 'Test Dark');
  assert.deepEqual([p.colours.bg.r, p.colours.bg.g, p.colours.bg.b], [18, 8, 16]);
  assert.deepEqual([p.colours.text.r, p.colours.text.g, p.colours.text.b], [200, 200, 200], 'black-on-dark dropdown text is rejected');
  assert.deepEqual([p.colours.accent.r, p.colours.accent.g, p.colours.accent.b], [220, 14, 96]);
});

test('overlay skins (dependsOn a base skin) get a dark base and a visible accent', () => {
  const overlay = `<?xml version="1.0"?><root dependsOn="Onyx.xmlc"><variables>
theme = "61,43,31"
font_1 = "200,200,200"
</variables>
<element id="Menu.DropDown.Highlight" bg="theme" />
<element id="Panel.Body.Highlight" bg="theme" fg="font_1" /></root>`;
  const theme = skinToHiveTheme(parseMusicBeeSkin(overlay), 'Bistre');
  assert.equal(theme.name, 'Bistre');
  assert.match(theme.css, /--bg: #121215;/);
  assert.match(theme.css, /--text: #c8c8c8;/);
  const accent = theme.css.match(/--accent: #(\w{6});/)[1];
  const rgb = { r: parseInt(accent.slice(0, 2), 16), g: parseInt(accent.slice(2, 4), 16), b: parseInt(accent.slice(4, 6), 16) };
  assert.ok(contrast(rgb, { r: 18, g: 18, b: 21 }) >= 2.2, 'accent lifted to stay visible');
});

test('produces a complete Hive theme pack and rejects compiled skins', () => {
  const theme = skinToHiveTheme(parseMusicBeeSkin(FULL));
  assert.equal(theme.format, 'hive-theme');
  for (const v of ['--bg', '--panel', '--panel-strong', '--border', '--text', '--text-dim', '--text-dimmer', '--accent', '--accent-soft', '--accent-glow']) assert.match(theme.css, new RegExp(`${v}:`));
  assert.throws(() => parseMusicBeeSkin('\u0000\u0001binary'), /compiled/);
});
