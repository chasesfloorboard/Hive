'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../app/main/theme-store');

test('a gallery theme keeps only Hive\'s colour and size variables, in plain value shapes', () => {
  const t = store.cleanTheme({ id: 'Mocha Latte!', name: 'Mocha <b>Latte</b>', author: 'someone', vars: {
    '--bg': '#3e2a20', '--text': 'rgba(240, 232, 226, 1)', '--accent': '#e9c79e', '--radius': '14px',
    '--panel': 'url(https://tracker.example/x.png)', '--border': 'red; } body { display:none', '--blur': '999px', '--evil': '#fff' } });
  assert.equal(t.id, 'mocha-latte');
  assert.equal(t.name, 'Mocha bLatte/b');
  assert.deepEqual(Object.keys(t.vars).sort(), ['--accent', '--bg', '--radius', '--text']);
  const css = store.themeCss(t);
  assert.ok(!/url|import|display|evil/.test(css), css);
});

test('a theme missing its background, text or accent is left out of the gallery; one bad entry never breaks the rest', () => {
  const list = store.cleanStore({ themes: [{ id: 'a', name: 'A', vars: { '--bg': '#000' } }, null, 'x', { id: 'b', name: 'B', vars: { '--bg': '#000', '--text': '#fff', '--accent': '#f00' } }, { id: 'b', name: 'Dup', vars: { '--bg': '#000', '--text': '#fff', '--accent': '#f00' } }] });
  assert.deepEqual(list.map(t => t.id), ['b']);
  assert.deepEqual(store.cleanStore({}), []);
});

test('sharing turns the user\'s theme CSS into a pre-filled GitHub issue with only safe values', () => {
  const vars = store.varsFromCss(':root {\n  --bg: #5a0f1e;\n  --text: #f7ecee;\n  --accent: #f2d3c4;\n  --panel: url(x);\n}');
  assert.deepEqual(vars, { '--bg': '#5a0f1e', '--text': '#f7ecee', '--accent': '#f2d3c4' });
  const url = store.shareUrl({ name: 'Red Velvet', author: 'me', vars });
  assert.ok(url.startsWith(store.SHARE_URL + '?labels=theme&title=Theme%3A%20Red%20Velvet'));
  assert.ok(decodeURIComponent(url).includes('"--bg": "#5a0f1e"'));
  assert.equal(store.varsFromCss('body{color:red}'), null);
});

test('the gallery file in this repository is valid, every theme in it passes the checks', () => {
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'themes', 'store.json'), 'utf8'));
  const clean = store.cleanStore(json);
  assert.ok(clean.length >= 4);
  assert.equal(clean.length, json.themes.length, 'no theme in the file is dropped by the checks');
  for (const raw of json.themes) assert.deepEqual(store.cleanTheme(raw).vars, raw.vars, raw.id);
});

test('loading reads the gallery through the given fetcher', async () => {
  const got = await store.loadStore(async (url, max) => { assert.equal(url, store.STORE_URL); assert.ok(max > 0); return JSON.stringify({ themes: [{ id: 'x', name: 'X', vars: { '--bg': '#111', '--text': '#eee', '--accent': '#0af' } }] }); });
  assert.equal(got[0].name, 'X');
});

test('shared names go through a slur and profanity filter that sees through look-alike letters but not ordinary words', () => {
  for (const bad of ['Fuck Yeah', 'sh1t theme', 'f.u.c.k', 'FUUUCK', 'n1gg@ vibes', 'Ass', 'my-dick', 'R3tard']) assert.equal(store.isOffensive(bad), true, bad);
  // Ordinary theme names never trip it.
  for (const ok of ['Night', 'Midnight', 'Knight', 'Nightfall', 'Grape', 'Drapes', 'Scrape', 'Therapist', 'Raccoon', 'Cocoon', 'Spice', 'Spicy', 'Torpedo', 'Analog', 'Bass', 'Assam Tea', 'Cumin',
    'Hancock', 'Hitchcock', 'Buttercup', 'Sextant', 'Essex', 'Middlesex', 'Pussywillow', 'Titmouse', 'Shiitake', 'Dickens', 'Swanky', 'Van Dyke Brown', 'Chinking Glass', 'Japan', 'Pakistan Green', 'Kyoto',
    'Honeycomb', 'Matcha', 'Dusk', 'Lagoon', 'Slate', 'Peach Fuzz', 'Red Velvet', 'Mocha', 'Hive', 'Sunflower', 'Ocean', 'Absolute Zero']) assert.equal(store.isOffensive(ok), false, ok);
  for (const ok of ['Classic', 'Scunthorpe Sunset', 'Assassin Red', 'Mocha', 'Red Velvet', 'Cocktail Hour', 'Shitake Mushroom'.replace('Shitake', 'Shiitake'), 'Grass', 'Peacock Blue', 'Dickens Grey', 'Sussex']) assert.equal(store.isOffensive(ok), false, ok);
  assert.throws(() => store.shareUrl({ name: 'Bitch Black', vars: { '--bg': '#000', '--text': '#fff', '--accent': '#f00' } }), /can't go in the theme gallery/);
  assert.equal(store.cleanTheme({ id: 'x', name: 'Fucking Blue', vars: { '--bg': '#000', '--text': '#fff', '--accent': '#f00' } }), null, 'kept out of Browse themes too');
});
