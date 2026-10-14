const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSearch, parseCollection, parseAppleMusicUrl, artworkUrl } = require('../app/main/apple-music');

const page = sections => `<html><script type="application/json" id="serialized-server-data">${JSON.stringify({ data: [{ data: { sections } }] })}</script></html>`;
const art = { dictionary: { url: 'https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.{f}' } };

test('Apple Music links are recognised', () => {
  assert.deepEqual(parseAppleMusicUrl('https://music.apple.com/us/playlist/head-trip-2026/pl.d0cf5286b211472493688eefc64bb728'), { storefront: 'us', kind: 'playlist', id: 'pl.d0cf5286b211472493688eefc64bb728' });
  assert.deepEqual(parseAppleMusicUrl('https://music.apple.com/gb/album/pink/1282780744?i=1'), { storefront: 'gb', kind: 'album', id: '1282780744' });
  assert.equal(parseAppleMusicUrl('https://example.com/us/playlist/x/pl.1'), null);
  assert.equal(artworkUrl(art, 300), 'https://is1-ssl.mzstatic.com/image/thumb/x/300x300bb.jpg');
});

test('search pages give playlists and albums once each', () => {
  const lock = (kind, id, title, curator) => ({ titleLinks: [{ title }], subtitleLinks: curator ? [{ title: curator }] : [], artwork: art, contentDescriptor: { kind, identifiers: { storeAdamID: id }, url: `https://music.apple.com/us/${kind}/x/${id}` } });
  const r = parseSearch(page([{ items: [lock('playlist', 'pl.1', 'Head Trip 2026', '')] }, { items: [lock('playlist', 'pl.1', 'Head Trip 2026', 'Goldenvoice'), lock('album', '9', 'Pink', 'Four Tet'), { contentDescriptor: { kind: 'song' } }] }]));
  assert.deepEqual(r.playlists.map(p => [p.id, p.name, p.curator]), [['pl.1', 'Head Trip 2026', 'Goldenvoice']]);
  assert.deepEqual(r.albums.map(p => p.name), ['Pink']);
});

test('playlist pages give the header and tracks', () => {
  const c = parseCollection(page([
    { id: 'playlist-detail-header-section - pl.1', items: [{ title: 'Head Trip 2026', subtitleLinks: [{ title: 'Goldenvoice' }], artwork: art }] },
    { id: 'track-list', itemKind: 'trackLockup', items: [{ title: 'Locked', duration: 509539, subtitleLinks: [{ title: 'Four Tet' }], tertiaryLinks: [{ title: 'Pink' }], artwork: art, contentDescriptor: { kind: 'song', identifiers: { storeAdamID: '1282781095' }, url: 'u' } }] }
  ]));
  assert.equal(c.name, 'Head Trip 2026');
  assert.equal(c.curator, 'Goldenvoice');
  assert.deepEqual([c.tracks[0].appleId, c.tracks[0].artist, c.tracks[0].album, c.tracks[0].duration], ['1282781095', 'Four Tet', 'Pink', 509.539]);
  assert.equal(parseCollection('<html></html>'), null);
});
