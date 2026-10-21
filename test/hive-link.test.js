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

function setup({ acceptPhoneChanges = true, streamSong = null, coversDir = null, remote = null, getPlaylists = null, getPlays = null, spotifySearch = null, songTarget = null, onSongAdded = undefined, acceptPhonePlays = false, getWrap = null, getWrapYears = null } = {}) {
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
    songTarget,
    onSongAdded,
    acceptPhonePlays,
    getWrap,
    getWrapYears,
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

// The playlists and remote-control hooks were once pasted into an unrelated
// console.info() object in main.js instead of the createHiveLink() options,
// so /api/playlists answered [] and /api/remote 403 even with remote control
// allowed. The unit tests above inject both directly and couldn't see that.
test('main.js hands Hive Link its playlists and remote-control hooks', () => {
  const main = fs.readFileSync(path.join(__dirname, '../app/main/main.js'), 'utf8');
  const start = main.indexOf('hiveLink = createHiveLink({');
  assert.ok(start > 0);
  let depth = 0, end = main.indexOf('{', start);
  for (let i = end; i < main.length; i += 1) {
    if (main[i] === '{') depth += 1;
    else if (main[i] === '}' && --depth === 0) { end = i; break; }
  }
  const options = main.slice(start, end);
  assert.match(options, /\bgetPlaylists:/);
  assert.match(options, /\bremote:\s*\{/);
  assert.doesNotMatch(main.slice(main.indexOf("console.info('[MPRIS] artwork resolution'"), main.indexOf("console.info('[MPRIS] artwork resolution'") + 400), /getPlaylists|remote:/);
});

// The phone resends a staged Love until it's settled. If "staged" were final,
// the phone's next full sync copied Hive's old state back over the change and
// a phone Love was undone the next time the app opened.
test('a resent staged Love reports staged, then unchanged once applied, or stale once discarded', async t => {
  const ctx = setup({ acceptPhoneChanges: false });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const send = async (id, loved, at) => (await request(ctx.port, 'POST', '/api/love', { token, body: { changes: [{ clientChangeId: 7, id, loved, at }] } })).body.results[0];

  assert.equal((await send('a1', true, 1000)).status, 'staged');
  assert.equal((await send('a1', true, 1000)).status, 'staged', 'still waiting in the inbox');
  await ctx.link.applyInbox({});
  assert.deepEqual(await send('a1', true, 1000), { clientChangeId: 7, id: 'a1', status: 'unchanged', loved: true });

  assert.equal((await send('b2', false, 2000)).status, 'staged');
  ctx.link.discardInbox({});
  const overruled = await send('b2', false, 2000);
  assert.equal(overruled.status, 'stale');
  assert.equal(overruled.loved, true, "the phone takes Hive's state back");
  assert.equal(ctx.tracks[1].loved, true);
  assert.equal((await send('b2', false, 3000)).status, 'staged', 'a newer phone change is a new request');
});

// ---- song sync: files from the phone ----

function putSong(port, token, query, data, { length = data.length } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/songs?${new URLSearchParams(query)}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Length': length } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function songSetup() {
  const music = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-link-music-'));
  const added = [];
  const ctx = setup({
    songTarget: async meta => path.join(music, meta.artist || 'Unknown Artist', meta.album || 'Unknown Album', `${meta.title}.${meta.ext}`),
    onSongAdded: async p => { added.push(p); }
  });
  return { ...ctx, music, added };
}

test('a song the PC lacks is saved into the library and announced; no part file is left', async t => {
  const ctx = songSetup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const data = Buffer.from('fake audio bytes '.repeat(1000));
  const res = await putSong(ctx.port, token, { title: 'Alive', artist: 'Pearl Jam', album: 'Ten', duration: 341000, ext: 'm4a' }, data);
  assert.deepEqual([res.status, res.body.status], [200, 'saved']);
  const saved = path.join(ctx.music, 'Pearl Jam', 'Ten', 'Alive.m4a');
  assert.deepEqual(fs.readFileSync(saved), data);
  assert.deepEqual(ctx.added, [saved]);
  assert.deepEqual(fs.readdirSync(path.dirname(saved)), ['Alive.m4a']);

  // Same name again (a different recording): kept beside it, never overwritten.
  const again = await putSong(ctx.port, token, { title: 'Alive', artist: 'Pearl Jam', album: 'Ten', duration: 600000, ext: 'm4a' }, Buffer.from('other'));
  assert.equal(again.body.status, 'saved');
  assert.deepEqual(fs.readdirSync(path.dirname(saved)).sort(), ['Alive (2).m4a', 'Alive.m4a']);
  assert.deepEqual(fs.readFileSync(saved), data);
});

test('a song Hive already has is not saved again, even under another format', async t => {
  const ctx = songSetup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const res = await putSong(ctx.port, token, { title: 'Black', artist: 'Pearl Jam', album: 'Ten', duration: 343500, ext: 'm4a' }, Buffer.from('x'.repeat(50)));
  assert.deepEqual(res.body, { status: 'exists', id: 'a1' });
  assert.deepEqual(fs.readdirSync(ctx.music), []);
  assert.deepEqual(ctx.added, []);
});

test('songs are refused when receiving is off, or when they are not audio', async t => {
  const ctx = songSetup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  assert.equal((await request(ctx.port, 'GET', '/api/info', { token })).body.songs.receive, true);
  assert.equal((await putSong(ctx.port, token, { title: 'x', artist: 'y', ext: 'exe' }, Buffer.from('MZ'))).status, 415);
  ctx.link.setReceiveSongs(false);
  assert.equal((await request(ctx.port, 'GET', '/api/info', { token })).body.songs.receive, false);
  assert.equal((await putSong(ctx.port, token, { title: 'New', artist: 'Someone', ext: 'mp3' }, Buffer.from('abc'))).status, 403);
  assert.deepEqual(fs.readdirSync(ctx.music), []);
});

test('a song cut off mid-send leaves nothing behind', async t => {
  const ctx = songSetup();
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: ctx.port, method: 'PUT', path: `/api/songs?${new URLSearchParams({ title: 'Cut', artist: 'Off', album: 'A', ext: 'mp3' })}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Length': 100000 } });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(5000));
    setTimeout(() => { req.destroy(); resolve(); }, 100);
  });
  await new Promise(r => setTimeout(r, 200));
  const dir = path.join(ctx.music, 'Off', 'A');
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  assert.deepEqual(ctx.added, []);
});

// ---- Yearly Wrap: phone plays count at once, and the phone shows Hive's Wrap ----

test('with acceptPhonePlays, phone plays count at once and a resend never counts twice', async t => {
  const ctx = setup({ acceptPhonePlays: true });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const plays = [{ clientId: '1', id: 'a1', playedAt: 5000, listenedMs: 200000 }, { clientId: '2', id: 'gone', playedAt: 6000, listenedMs: 1 }];
  const first = (await request(ctx.port, 'POST', '/api/plays', { token, body: { plays } })).body;
  assert.deepEqual(first, { staged: 0, counted: 1, unknown: ['2'] });
  assert.deepEqual(ctx.recorded.map(p => [p.track.title, p.playedAt]), [['Black', 5000]]);
  assert.deepEqual(ctx.link.inboxSummary(), { loves: 0, plays: 0 }, 'nothing waits in the inbox');
  const again = (await request(ctx.port, 'POST', '/api/plays', { token, body: { plays } })).body;
  assert.equal(again.counted, 0);
  assert.equal(ctx.recorded.length, 1);
});

test('counted play ids survive a restart', async t => {
  const ctx = setup({ acceptPhonePlays: true });
  await waitListening(ctx.port);
  const token = await pair(ctx);
  const plays = [{ clientId: '9', id: 'a1', playedAt: 7000, listenedMs: 1000 }];
  await request(ctx.port, 'POST', '/api/plays', { token, body: { plays } });
  ctx.link.stop();
  await new Promise(r => setTimeout(r, 700)); // the state save is debounced
  const again = createHiveLink({ dataDir: ctx.dataDir, port: ctx.port, discoveryPort: ctx.port + 1, getTracks: async () => ctx.tracks, setLove: async () => {}, acceptPhonePlays: true, recordPlays: async p => { ctx.recorded.push(...p); } });
  again.start();
  t.after(() => again.stop());
  await waitListening(ctx.port);
  assert.equal((await request(ctx.port, 'POST', '/api/plays', { token, body: { plays } })).body.counted, 0);
  assert.equal(ctx.recorded.length, 1);
});

test("the phone gets Hive's own Wrap, with covers it can fetch and no recent-plays list", async t => {
  const wrap = {
    year: 2026, totalSeconds: 3600, totalPlays: 12, uniqueArtists: 3, uniqueAlbums: 4, longestStreak: 2,
    topTrack: { key: 'Black\u0000Pearl Jam', plays: 5, album: 'Ten', cover: 'mbcover://' + 'a'.repeat(40) + '.jpg' },
    topArtists: [{ name: 'Pearl Jam', plays: 5, cover: '/home/me/.covers/' + 'b'.repeat(40) + '.png' }],
    topAlbums: [{ album: 'Ten', artist: 'Pearl Jam', plays: 5, cover: 'https://example.com/ten.jpg' }],
    rows: [{ title: 'secret' }]
  };
  const ctx = setup({ getWrap: async year => ({ ...wrap, year }), getWrapYears: async () => [2026, 2025] });
  t.after(() => ctx.link.stop());
  await waitListening(ctx.port);
  const token = await pair(ctx);
  assert.equal((await request(ctx.port, 'GET', '/api/info', { token })).body.wrap, true);
  assert.deepEqual((await request(ctx.port, 'GET', '/api/wrap/years', { token })).body, { years: [2026, 2025] });
  const got = (await request(ctx.port, 'GET', '/api/wrap?year=2025', { token })).body;
  assert.equal(got.year, 2025);
  assert.equal(got.totalPlays, 12);
  assert.equal(got.rows, undefined);
  assert.equal(got.topTrack.cover, 'a'.repeat(40) + '.jpg');
  assert.equal(got.topArtists[0].cover, 'b'.repeat(40) + '.png');
  assert.equal(got.topAlbums[0].cover, 'https://example.com/ten.jpg');
});
