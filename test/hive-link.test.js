'use strict';
// Hive Link is the PC side of Hive Mobile. These tests drive the real HTTP
// server and UDP discovery socket against an in-memory library: pairing,
// authentication, the library listing, phone Love changes going through the
// injected setLove (the heart button's path in main.js), newer-change-wins
// conflict handling, the change log, and live server-sent events.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { createHiveLink, trackIdFor } = require('../app/main/hive-link');

let nextPort = 48100 + Math.floor(Math.random() * 500) * 2;

function setup({ acceptPhoneChanges = true, streamSong = null, coversDir = null, remote = null, getPlaylists = null, getPlays = null, spotifySearch = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-link-'));
  const tracks = [
    { id: 'a1', path: '/music/Pearl Jam - Black.mp3', title: 'Black', artist: 'Pearl Jam', album: 'Ten', duration: '343.2', loved: false },
    { id: 'b2', path: '/music/Huge.mp3', title: 'Huge', artist: 'Boris', album: 'Heavy Rocks', duration: '201.0', loved: true },
    { path: 'ytm:abc', title: 'Streamed', artist: 'Someone', loved: false }
  ];
  const setLoveCalls = [];
  const recorded = [];
  const port = nextPort; nextPort += 2;
  const link = createHiveLink({
    dataDir,
    port,
    discoveryPort: port + 1,
    acceptPhoneChanges,
    streamSong,
    coversDir,
    remote,
    getPlaylists,
    getPlays,
    spotifySearch,
    recordPlays: async plays => { recorded.push(...plays); },
    getTracks: async () => tracks,
    setLove: async (trackPath, loved) => {
      setLoveCalls.push([trackPath, loved]);
      const track = tracks.find(t => path.resolve(t.path) === trackPath);
      track.loved = loved;
      await link.notifyLoveChanged([trackPath], loved);
    }
  });
  link.start();
  return { link, tracks, setLoveCalls, recorded, port, dataDir };
}

function rawGet(port, urlPath, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function request(port, method, urlPath, { body, token, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {})
    } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        resolve({ status: res.statusCode, headers: res.headers, body: raw || !buf.length ? buf : JSON.parse(buf.toString('utf8')) });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function pair(ctx) {
  const { code } = ctx.link.startPairing();
  const res = await request(ctx.port, 'POST', '/api/pair', { body: { code, deviceName: 'Galaxy A55' } });
  assert.equal(res.status, 200);
  return res.body.token;
}

async function waitListening(port) {
  for (let i = 0; i < 50; i++) {
    try { return await request(port, 'GET', '/api/ping'); } catch { await new Promise(r => setTimeout(r, 20)); }
  }
  throw new Error('server did not start');
}

test('pairing issues a token only for the right code, and only once', async t => {
  const ctx = setup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);

  assert.equal((await request(ctx.port, 'GET', '/api/info')).status, 401);
  assert.equal((await request(ctx.port, 'POST', '/api/pair', { body: { code: '000000' } })).status, 410);

  const { code } = ctx.link.startPairing();
  const wrong = code === '123456' ? '654321' : '123456';
  assert.equal((await request(ctx.port, 'POST', '/api/pair', { body: { code: wrong } })).status, 403);
  const ok = await request(ctx.port, 'POST', '/api/pair', { body: { code, deviceName: 'Galaxy A55' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token.length > 20);
  assert.equal((await request(ctx.port, 'POST', '/api/pair', { body: { code } })).status, 410);

  const info = await request(ctx.port, 'GET', '/api/info', { token: ok.body.token });
  assert.equal(info.status, 200);
  assert.equal(info.body.deviceName, 'Galaxy A55');
  assert.deepEqual(ctx.link.devices().map(d => d.name), ['Galaxy A55']);
  assert.ok(!('tokenHash' in ctx.link.devices()[0]));
  assert.ok(!fs.readFileSync(path.join(ctx.dataDir, 'hive-link.json'), 'utf8').includes(ok.body.token));
});

test('pairing gives up after repeated wrong codes', async t => {
  const ctx = setup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const { code } = ctx.link.startPairing();
  const wrong = code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) await request(ctx.port, 'POST', '/api/pair', { body: { code: wrong } });
  assert.equal((await request(ctx.port, 'POST', '/api/pair', { body: { code } })).status, 410);
});

test('library lists local tracks with stable ids and supports ETag', async t => {
  const ctx = setup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const res = await request(ctx.port, 'GET', '/api/library', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tracks.map(r => [r.id, r.title, r.loved, r.duration]), [['a1', 'Black', false, 343200], ['b2', 'Huge', true, 201000]]);
  const again = await request(ctx.port, 'GET', '/api/library', { token, headers: {} });
  assert.equal(again.headers.etag, res.headers.etag);
  const cached = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: ctx.port, path: '/api/library', headers: { Authorization: `Bearer ${token}`, 'If-None-Match': res.headers.etag } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).on('error', reject);
  });
  assert.equal(cached, 304);
});

test('a phone Love goes through setLove and is logged with the phone as origin', async t => {
  const ctx = setup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const deviceId = ctx.link.devices()[0].id;

  const res = await request(ctx.port, 'POST', '/api/love', { token, body: { changes: [
    { clientChangeId: 1, id: 'a1', loved: true, at: 1000 },
    { clientChangeId: 2, id: 'b2', loved: true, at: 1000 },
    { clientChangeId: 3, id: 'missing', loved: true, at: 1000 }
  ] } });
  assert.deepEqual(res.body.results.map(r => r.status), ['applied', 'unchanged', 'not-found']);
  assert.deepEqual(ctx.setLoveCalls, [[path.resolve('/music/Pearl Jam - Black.mp3'), true]]);

  const changes = await request(ctx.port, 'GET', '/api/love/changes?since=0', { token });
  assert.equal(changes.body.reset, false);
  assert.deepEqual(changes.body.changes.map(c => [c.id, c.loved, c.at, c.origin]), [['a1', true, 1000, deviceId]]);
});

test('while phone changes are off, phone Love waits in the inbox and nothing is written', async t => {
  const ctx = setup({ acceptPhoneChanges: false });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);

  const res = await request(ctx.port, 'POST', '/api/love', { token, body: { changes: [{ clientChangeId: 1, id: 'a1', loved: true, at: 1000 }] } });
  assert.deepEqual(res.body.results.map(r => r.status), ['staged']);
  assert.deepEqual(ctx.link.inboxSummary(), { loves: 1, plays: 0 });
  assert.equal(ctx.setLoveCalls.length, 0);
  assert.equal(ctx.tracks[0].loved, false);
  const changes = await request(ctx.port, 'GET', '/api/love/changes?since=0', { token });
  assert.deepEqual(changes.body.changes, []);
});

test('a library song streams with Range support, and only listed files are served', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-link-audio-'));
  const file = path.join(dir, 'song.mp3');
  fs.writeFileSync(file, Buffer.from('0123456789'));
  const ctx = setup();
  ctx.tracks.push({ id: 'c3', path: file, title: 'Song', artist: 'A', duration: '1', loved: false });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);

  const part = await rawGet(ctx.port, '/api/stream/track?id=c3', token, { Range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 2-5/10');
  assert.equal(part.body.toString(), '2345');
  const whole = await rawGet(ctx.port, '/api/stream/track?id=c3', token);
  assert.equal(whole.status, 200);
  assert.equal(whole.body.toString(), '0123456789');
  assert.equal((await rawGet(ctx.port, '/api/stream/track?id=nope', token)).status, 404);
  assert.equal((await rawGet(ctx.port, '/api/stream/track?id=c3')).status, 401);
});

test('covers come only from the covers folder, with the token in the address allowed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-link-covers-'));
  const name = 'a'.repeat(40) + '.jpg';
  fs.writeFileSync(path.join(dir, name), Buffer.from('JPEG'));
  const ctx = setup({ coversDir: dir });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  assert.equal((await rawGet(ctx.port, `/api/cover?name=${name}`, token)).body.toString(), 'JPEG');
  assert.equal((await rawGet(ctx.port, `/api/cover?name=${name}&t=${token}`)).status, 200);
  assert.equal((await rawGet(ctx.port, `/api/cover?name=${name}`)).status, 401);
  assert.equal((await rawGet(ctx.port, `/api/cover?name=../hive-link.json`, token)).status, 404);
  // The address token is for covers only.
  assert.equal((await rawGet(ctx.port, `/api/library?t=${token}`)).status, 401);
});

test('remote control is off until allowed, then reports and commands playback', async t => {
  const commands = [];
  const ctx = setup({ remote: { state: () => ({ track: { path: '/music/Huge.mp3', title: 'Huge', artist: 'Boris', album: 'Heavy Rocks' }, position: 12.5, duration: 201, paused: false, volume: 0.8 }), command: c => commands.push(c) } });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  assert.equal((await request(ctx.port, 'GET', '/api/remote', { token })).status, 403);
  assert.equal((await request(ctx.port, 'POST', '/api/remote', { token, body: { command: 'next' } })).status, 403);
  assert.deepEqual(commands, []);

  ctx.link.setRemoteControl(true);
  const s = (await request(ctx.port, 'GET', '/api/remote', { token })).body;
  assert.deepEqual([s.playing, s.id, s.title, s.position, s.duration], [true, 'b2', 'Huge', 12500, 201000]);
  await request(ctx.port, 'POST', '/api/remote', { token, body: { command: 'toggle' } });
  await request(ctx.port, 'POST', '/api/remote', { token, body: { command: 'seek', positionMs: 30000 } });
  await request(ctx.port, 'POST', '/api/remote', { token, body: { command: 'volume', volume: 2 } });
  assert.equal((await request(ctx.port, 'POST', '/api/remote', { token, body: { command: 'rm -rf' } })).status, 400);
  assert.deepEqual(commands, ['PLAYPAUSE', 'SEEK\t30', 'VOLUME\t1']);
  assert.equal((await request(ctx.port, 'GET', '/api/info', { token })).body.remote, true);
});

test('playlists come read only: library songs by id, streamed songs as Hive keeps them, smart ones left out', async t => {
  const ctx = setup({ getPlaylists: async () => [
    { id: 'p1', name: 'Mix', smart: false, cover: 'b'.repeat(40) + '.jpg', tracks: ['/music/Huge.mp3', 'ytm:apple:42', 'radio:x', '/music/gone.mp3'],
      podcastEpisodes: { 'ytm:apple:42': { title: 'Saving Up', artist: 'Dom Dolla', duration: 207.5 } } },
    { id: 'fav', name: 'Favorites', smart: true, tracks: [] }
  ] });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const lists = (await request(ctx.port, 'GET', '/api/playlists', { token })).body.playlists;
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0].songs, [{ kind: 'track', id: 'b2' }, { kind: 'stream', key: 'am:42', title: 'Saving Up', artist: 'Dom Dolla', album: '', duration: 207500, cover: '' }]);
  assert.equal(lists[0].cover, 'b'.repeat(40) + '.jpg');
});

test('songs Hive lacks stream through the injected resolver', async t => {
  const calls = [];
  const ctx = setup({ streamSong: async (song, range) => {
    calls.push([song.key, song.title, range]);
    return { status: 206, headers: { 'Content-Type': 'audio/webm', 'Content-Range': 'bytes 0-2/3' }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('abc')); c.close(); } }) };
  } });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);

  const r = await rawGet(ctx.port, '/api/stream/song?key=am%3A123&title=Song&artist=A&duration=200', token, { Range: 'bytes=0-' });
  assert.equal(r.status, 206);
  assert.equal(r.body.toString(), 'abc');
  assert.deepEqual(calls, [['am:123', 'Song', 'bytes=0-']]);
  assert.equal((await rawGet(ctx.port, '/api/stream/song?key=../etc&title=x', token)).status, 400);
  const info = await request(ctx.port, 'GET', '/api/info', { token });
  assert.deepEqual(info.body.streams, { track: true, song: true });
});

test('an older phone change loses to a newer PC change', async t => {
  const ctx = setup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);

  ctx.tracks[0].loved = true;
  await ctx.link.notifyLoveChanged([ctx.tracks[0].path], true); // PC heart, at "now"
  const res = await request(ctx.port, 'POST', '/api/love', { token, body: { changes: [{ clientChangeId: 9, id: 'a1', loved: false, at: 5 }] } });
  assert.equal(res.body.results[0].status, 'stale');
  assert.equal(res.body.results[0].loved, true);
  assert.equal(ctx.setLoveCalls.length, 0);
});

test('changes since an evicted sequence ask the phone to resync', async t => {
  const ctx = setup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  for (let i = 0; i < 5005; i++) await ctx.link.notifyLoveChanged([ctx.tracks[1].path], i % 2 === 0);
  const res = await request(ctx.port, 'GET', '/api/love/changes?since=1', { token });
  assert.equal(res.body.reset, true);
  const recent = await request(ctx.port, 'GET', `/api/love/changes?since=${res.body.seq - 2}`, { token });
  assert.equal(recent.body.changes.length, 2);
});

test('live events stream PC Love changes to the phone', async t => {
  const ctx = setup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const received = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: ctx.port, path: '/api/events', headers: { Authorization: `Bearer ${token}` } }, res => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        if (buf.includes('event: hello') && !buf.includes('event: love')) ctx.link.notifyLoveChanged([ctx.tracks[0].path], true);
        const m = buf.match(/event: love\ndata: (.*)\n\n/);
        if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
      });
    });
    req.on('error', err => { if (err.code !== 'ECONNRESET') reject(err); });
  });
  assert.equal(received.id, 'a1');
  assert.equal(received.loved, true);
  assert.equal(received.origin, 'pc');
});

test('discovery answers a broadcast-style request with the server identity', async t => {
  const ctx = setup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const reply = await new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', msg => { sock.close(); resolve(JSON.parse(msg.toString())); });
    sock.on('error', reject);
    sock.send(Buffer.from('HIVELINK_DISCOVER 1'), ctx.port + 1, '127.0.0.1');
  });
  assert.equal(reply.hivelink, 1);
  assert.equal(reply.port, ctx.port);
  assert.equal(reply.serverId, ctx.link.info().serverId);
});

test('track ids fall back to a path hash when the library has none', () => {
  assert.equal(trackIdFor({ id: 'x' }), 'x');
  assert.equal(trackIdFor({ path: '/a.mp3' }), trackIdFor({ path: '/a.mp3' }));
  assert.notEqual(trackIdFor({ path: '/a.mp3' }), trackIdFor({ path: '/b.mp3' }));
});

test('inbox: applying writes Love through setLove and hands plays to Hive, discarding writes nothing', async t => {
  const ctx = setup({ acceptPhoneChanges: false });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);

  await request(ctx.port, 'POST', '/api/love', { token, body: { changes: [{ clientChangeId: 1, id: 'a1', loved: true, at: 1000 }, { clientChangeId: 2, id: 'a1', loved: false, at: 900 }] } });
  const plays = [{ clientId: '1', id: 'a1', playedAt: 5000, listenedMs: 200000 }, { clientId: '2', id: 'b2', playedAt: 6000, listenedMs: 100000 }];
  assert.equal((await request(ctx.port, 'POST', '/api/plays', { token, body: { plays } })).body.staged, 2);
  // A resend of the same plays is not counted again.
  assert.equal((await request(ctx.port, 'POST', '/api/plays', { token, body: { plays } })).body.staged, 0);

  const box = await ctx.link.inbox();
  assert.equal(box.loves.length, 1);
  assert.equal(box.loves[0].loved, true, 'the newer of two changes to one song wins');
  assert.equal(box.loves[0].device, 'Galaxy A55');
  assert.deepEqual(box.plays.map(p => p.track.title), ['Huge', 'Black']);

  const result = await ctx.link.applyInbox({});
  assert.deepEqual([result.lovesApplied, result.playsApplied, result.loves, result.plays], [1, 2, 0, 0]);
  assert.deepEqual(ctx.setLoveCalls, [[path.resolve('/music/Pearl Jam - Black.mp3'), true]]);
  assert.deepEqual(ctx.recorded.map(p => [p.track.title, p.playedAt]).sort(), [['Black', 5000], ['Huge', 6000]]);

  await request(ctx.port, 'POST', '/api/plays', { token, body: { plays: [{ clientId: '3', id: 'a1', playedAt: 7000, listenedMs: 1 }] } });
  assert.deepEqual(ctx.link.discardInbox({}), { loves: 0, plays: 0 });
  assert.equal(ctx.recorded.length, 2);
});

test('the inbox survives a restart', async t => {
  const ctx = setup({ acceptPhoneChanges: false });
  await waitListening(ctx.port);
  const token = await pair(ctx);
  await request(ctx.port, 'POST', '/api/plays', { token, body: { plays: [{ clientId: '9', id: 'b2', playedAt: 1234, listenedMs: 5 }] } });
  ctx.link.stop();
  await new Promise(r => setTimeout(r, 700));
  const again = createHiveLink({ dataDir: ctx.dataDir, port: ctx.port, discoveryPort: ctx.port + 1, getTracks: async () => ctx.tracks, setLove: async () => {} });
  t.after(() => again.stop());
  assert.deepEqual(again.inboxSummary(), { loves: 0, plays: 1 });
});

test("the phone gets Hive's own plays for library songs since a time", async t => {
  const ctx = setup({ getPlays: async since => [
    { id: 'e1', path: '/music/Huge.mp3', playedAt: 2000, duration: 180 },
    { id: 'e2', path: '/music/gone.mp3', playedAt: 3000, duration: 10 },
  ].filter(e => e.playedAt > since) });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const res = await request(ctx.port, 'GET', '/api/plays?since=1000', { token });
  assert.deepEqual(res.body.plays, [{ id: 'b2', playedAt: 2000, listenedMs: 180000, eventId: 'e1' }]);
  assert.equal((await request(ctx.port, 'GET', '/api/info', { token })).body.plays, true);
});

test('the phone searches Spotify through the PC, and hears when Spotify is not running', async t => {
  let running = true;
  const ctx = setup({ spotifySearch: async q => running ? { connected: true, data: { tracks: [{ uri: 'spotify:track:x', title: q }], albums: [], artists: [], playlists: [] } } : { connected: false } });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const res = await request(ctx.port, 'GET', '/api/spotify/search?q=halsey', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.tracks[0].title, 'halsey');
  running = false;
  assert.equal((await request(ctx.port, 'GET', '/api/spotify/search?q=halsey', { token })).status, 503);
  assert.equal((await request(ctx.port, 'GET', '/api/info', { token })).body.spotifySearch, true);
});
