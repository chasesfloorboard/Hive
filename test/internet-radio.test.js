const test = require('node:test');
const assert = require('node:assert/strict');
const { stationFromDirectory, parsePlaylist, parseIcyMetadata } = require('../app/main/internet-radio');

test('radio directory rows become stations and HLS streams are skipped', () => {
  const st = stationFromDirectory({ stationuuid: 'u1', name: ' Jazz FM ', url_resolved: 'https://x/jazz', tags: 'jazz,smooth jazz,,', country: 'UK', codec: 'MP3', bitrate: 128 });
  assert.deepEqual([st.id, st.name, st.url, st.tags, st.bitrate], ['u1', 'Jazz FM', 'https://x/jazz', ['jazz', 'smooth jazz'], 128]);
  assert.equal(stationFromDirectory({ stationuuid: 'u2', url_resolved: 'https://x/a.m3u8' }), null);
  assert.equal(stationFromDirectory({ stationuuid: 'u3', url: 'https://x/a', hls: 1 }), null);
});

test('pls and m3u playlists resolve to their first stream', () => {
  assert.equal(parsePlaylist('[playlist]\r\nNumberOfEntries=2\r\nFile1=http://a/stream\r\nFile2=http://b/stream\r\n'), 'http://a/stream');
  assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:-1,Station\nhttps://c/live\n'), 'https://c/live');
  assert.equal(parsePlaylist('nothing here'), '');
});

test('ICY metadata splits artist and title', () => {
  assert.deepEqual(parseIcyMetadata("StreamTitle='Larry Goldings - Solid Jack';StreamUrl='';\0\0"), { raw: 'Larry Goldings - Solid Jack', artist: 'Larry Goldings', title: 'Solid Jack' });
  assert.deepEqual(parseIcyMetadata("StreamTitle='Don't Stop';"), { raw: "Don't Stop", artist: '', title: "Don't Stop" });
  assert.equal(parseIcyMetadata("StreamTitle='';"), null);
});
