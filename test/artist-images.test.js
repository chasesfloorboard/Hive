'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createArtistImageProvider, primaryArtist, isAllowedImageUrl } = require('../app/main/artist-images');

const PHOTO = 'https://cdn-images.dzcdn.net/images/artist/abc123/1000x1000-000000-80-0-0.jpg';
const PLACEHOLDER = 'https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg';

// A fake fetch: `catalog` maps a search query to Deezer-style results.
function fakeFetch(catalog, calls) {
  return async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.deezer.com/search/artist')) {
      const q = new URL(url).searchParams.get('q');
      return { ok: true, json: async () => ({ data: catalog[q] || [] }) };
    }
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer };
  };
}

function makeProvider(catalog, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-artist-'));
  const calls = [];
  const provider = createArtistImageProvider({ fetch: fakeFetch(catalog, calls), fsp: fs.promises, path, crypto, dir: () => dir, ...options });
  return { provider, calls, dir };
}

test('an exact name match is downloaded once and then served from the cache', async () => {
  const { provider, calls } = makeProvider({ 'Sun Kil Moon': [{ name: 'Sun Kil Moon', picture_xl: PHOTO }] });
  const first = await provider.lookup('Sun Kil Moon');
  assert.ok(first && fs.existsSync(first));
  const before = calls.length;
  assert.equal(await provider.lookup('Sun Kil Moon'), first);
  assert.equal(calls.length, before);
});

test('only an exact name match counts, and placeholder entries without a photo are skipped', async () => {
  const { provider } = makeProvider({
    'Tyler, The Creator': [
      { name: 'Tyler, The Creator', picture_xl: PLACEHOLDER },
      { name: 'Tyler, The Creator', picture_xl: PHOTO }
    ],
    'Jesu': [{ name: 'Jesu / Sun Kil Moon', picture_xl: PHOTO }]
  });
  assert.ok(await provider.lookup('Tyler, The Creator'));
  assert.equal(await provider.lookup('Jesu'), null);
});

test('a collaboration tries the full credit first, then the lead artist', async () => {
  const { provider, calls } = makeProvider({ 'Kendrick Lamar': [{ name: 'Kendrick Lamar', picture_xl: PHOTO }] });
  assert.ok(await provider.lookup('Kendrick Lamar feat. SZA'));
  const queries = calls.filter(u => u.includes('api.deezer.com')).map(u => new URL(u).searchParams.get('q'));
  assert.deepEqual(queries, ['Kendrick Lamar feat. SZA', 'Kendrick Lamar']);
  assert.equal(primaryArtist('Simon & Garfunkel'), 'Simon');
});

test('a miss is remembered so it is not searched again on every play', async () => {
  let now = 0;
  const { provider, calls } = makeProvider({}, { now: () => now });
  assert.equal(await provider.lookup('Nobody Real'), null);
  const after = calls.length;
  assert.equal(await provider.lookup('Nobody Real'), null);
  assert.equal(calls.length, after);
  now += 7 * 60 * 60 * 1000;
  await provider.lookup('Nobody Real');
  assert.ok(calls.length > after);
});

test('concurrent lookups for one artist share a single request', async () => {
  const { provider, calls } = makeProvider({ 'Low': [{ name: 'Low', picture_xl: PHOTO }] });
  const [a, b] = await Promise.all([provider.lookup('Low'), provider.lookup('Low')]);
  assert.equal(a, b);
  assert.equal(calls.filter(u => u.includes('api.deezer.com')).length, 1);
});

test('images are only downloaded from Deezer\'s image CDN over https', () => {
  assert.equal(isAllowedImageUrl(PHOTO), true);
  assert.equal(isAllowedImageUrl('http://cdn-images.dzcdn.net/x.jpg'), false);
  assert.equal(isAllowedImageUrl('https://evil.example/dzcdn.net.jpg'), false);
  assert.equal(isAllowedImageUrl('https://dzcdn.net.evil.example/x.jpg'), false);
});
