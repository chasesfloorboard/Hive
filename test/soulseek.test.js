'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SoulseekClient, Out, In, frame, initFrame, framer, Code, sharedFile, searchResultBody, parseSearchResult, candidates, titleOf } = require('../app/main/soulseek');
const { createSoulseekDownloads, albumQuery } = require('../app/main/soulseek-downloads');

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// A Soulseek server and one peer ("alice", sharing `files`), on localhost.
async function fakeNetwork(files, { deny = false } = {}) {
  const seen = { shared: null, queued: [] };
  let clientPort = 0;
  // alice's side of any message connection, hers or ours.
  const talk = sock => {
    sock.on('data', framer(body => {
      // The first frame is our client's PeerInit (uint8 code), then uint32-coded messages.
      if (body[0] === Code.PEER_INIT && body.length < 64 && !sock.__init) { sock.__init = true; return; }
      const r = new In(body);
      const code = r.u32();
      if (code === Code.QUEUE_UPLOAD) {
        const name = r.str();
        seen.queued.push(name);
        if (deny) { sock.write(frame(Code.UPLOAD_DENIED, new Out().str(name).str('Banned').bytes())); return; }
        const data = files[name];
        sock.write(frame(Code.TRANSFER_REQUEST, new Out().u32(1).u32(77).str(name).u64(data.length).bytes()));
      } else if (code === Code.TRANSFER_RESPONSE) {
        const token = r.u32();
        if (!r.bool()) return;
        const name = seen.queued.at(-1);
        const f = net.connect({ host: '127.0.0.1', port: clientPort }, () => {
          f.write(initFrame(Code.PEER_INIT, new Out().str('alice').str('F').u32(0).bytes()));
          f.write(new Out().u32(token).bytes());
        });
        let offset = Buffer.alloc(0);
        f.on('data', c => { if (offset.length < 8) { offset = Buffer.concat([offset, c]); if (offset.length >= 8) f.end(files[name]); } });
        f.on('error', () => {});
      }
    }));
    sock.on('error', () => {});
  };
  const peer = net.createServer(talk);
  const peerPort = await listen(peer);
  const server = net.createServer(sock => {
    sock.on('data', framer(body => {
      const r = new In(body);
      const code = r.u32();
      if (code === Code.LOGIN) sock.write(frame(Code.LOGIN, new Out().bool(true).str('Welcome').u32(0).bytes()));
      else if (code === Code.SET_WAIT_PORT) clientPort = r.u32();
      else if (code === Code.SHARED_FOLDERS_FILES) seen.shared = [r.u32(), r.u32()];
      else if (code === Code.GET_PEER_ADDRESS) {
        const user = r.str();
        sock.write(frame(Code.GET_PEER_ADDRESS, new Out().str(user).u8(1).u8(0).u8(0).u8(127).u32(peerPort).bytes()));
      } else if (code === Code.FILE_SEARCH) {
        const token = r.u32();
        // alice answers on her own connection to us.
        const s = net.connect({ host: '127.0.0.1', port: clientPort }, () => {
          s.write(initFrame(Code.PEER_INIT, new Out().str('alice').str('P').u32(0).bytes()));
          const shared = Object.entries(files).map(([p, d]) => ({ path: p, size: d.length, bitrate: 1000, lengthSec: 200 }));
          s.write(frame(Code.SEARCH_RESPONSE, searchResultBody('alice', token, shared, true, 5000, 0)));
        });
        s.__init = true;
        talk(s);
        s.on('error', () => {});
      }
    }));
    sock.on('error', () => {});
  });
  const port = await listen(server);
  return { port, seen, close: () => { server.close(); peer.close(); } };
}

test('search results survive the wire, Latin-1 and huge Soulseek NS sizes included', () => {
  const body = searchResultBody('bob', 9, [{ path: 'Music\\Slint\\Spiderland\\01 Breadcrumb Trail.flac', size: 30_000_000, bitrate: 900, lengthSec: 355 }], true, 2048, 3);
  const r = parseSearchResult(body);
  assert.equal(r.user, 'bob');
  assert.equal(r.token, 9);
  assert.equal(r.files[0].name, '01 Breadcrumb Trail.flac');
  assert.equal(r.files[0].folder, 'Music\\Slint\\Spiderland');
  assert.equal(r.files[0].extension, 'flac');
  assert.equal(r.files[0].lengthSec, 355);
  assert.equal(r.freeSlot, true);
  assert.equal(r.queue, 3);
  const latin = Buffer.concat([new Out().u32(4).bytes(), Buffer.from([0x53, 0x69, 0x67, 0xf3])]);
  assert.equal(new In(latin).str(), 'Sigó');
  const ns = Buffer.from([1, 0, 0, 0, 9, 9, 9, 255]);
  assert.equal(new In(ns).fileSize(), 1);
});

test('the picker matches a tracklist by title, prefers the chosen format and free slots', () => {
  const wanted = [{ title: 'Breadcrumb Trail', durationMs: 355000 }, { title: 'Nosferatu Man', durationMs: 335000 }, { title: "Don, Aman", durationMs: 386000 }];
  const folder = (fmt, len = [355, 335, 386]) => ['01 Slint - Breadcrumb Trail', '02 Nosferatu Man', '03 Don, Aman'].map((n, i) => sharedFile(`M\\Slint - Spiderland\\${n}.${fmt}`, 1, { lengthSec: len[i], bitrate: fmt === 'mp3' ? 320 : 900 }));
  const results = [
    { user: 'mp3guy', files: folder('mp3'), freeSlot: true, speed: 9000, queue: 0 },
    { user: 'flacguy', files: folder('flac'), freeSlot: true, speed: 9000, queue: 0 },
    { user: 'wrong', files: folder('flac', [100, 100, 100]), freeSlot: true, speed: 9000, queue: 0 },
  ];
  const lossless = candidates('Slint', wanted, results, 'lossless');
  assert.equal(lossless[0].user, 'flacguy');
  assert.equal(lossless[0].files.size, 3);
  assert.ok(!lossless.some(p => p.user === 'wrong'), 'lengths that disagree are not the album');
  assert.equal(candidates('Slint', wanted, results, 'mp3')[0].user, 'mp3guy');
  assert.equal(titleOf('01 Slint - Breadcrumb Trail.flac', 'Slint'), 'Breadcrumb Trail');
  assert.equal(albumQuery('Fontaines D.C., Someone', 'Romance (Deluxe Edition)'), 'Fontaines D.C. Romance');
});

test('the client logs in sharing nothing, finds a file and downloads it whole', async () => {
  const data = Buffer.alloc(300_000, 7);
  const net0 = await fakeNetwork({ 'Music\\Slint\\Spiderland\\01 Breadcrumb Trail.flac': data });
  const client = new SoulseekClient({ username: 'hive-test', password: 'x', host: '127.0.0.1', port: net0.port, listenPorts: [0, 0] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slsk-'));
  try {
    await client.login();
    const found = await new Promise(resolve => client.search('Slint Spiderland', resolve));
    assert.equal(found.user, 'alice');
    assert.deepEqual(net0.seen.shared, [0, 0]);
    const target = path.join(dir, 'song.flac');
    let last = 0;
    await client.download('alice', found.files[0].path, target, 5000, b => { last = b; });
    assert.equal(fs.readFileSync(target).length, data.length);
    assert.equal(last, data.length);
  } finally { client.close(); net0.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the client turns down anyone asking it for files', async () => {
  const client = new SoulseekClient({ username: 'hive-test', password: 'x' });
  const sent = [];
  const sock = { write: b => sent.push(b) };
  client.handlePeer('mallory', sock, frame(Code.QUEUE_UPLOAD, new Out().str('C:\\secret.flac').bytes()).subarray(4));
  client.handlePeer('mallory', sock, frame(Code.TRANSFER_REQUEST, new Out().u32(0).u32(5).str('C:\\secret.flac').bytes()).subarray(4));
  const codes = sent.map(b => new In(b).u32() && b.readUInt32LE(4));
  assert.deepEqual(codes, [Code.UPLOAD_DENIED, Code.TRANSFER_RESPONSE]);
  const refused = new In(sent[1], 8);
  assert.equal(refused.u32(), 5);
  assert.equal(refused.bool(), false);
});

test('a peer saying no fails the download instead of waiting', async () => {
  const net0 = await fakeNetwork({ 'a\\b.flac': Buffer.alloc(10) }, { deny: true });
  const client = new SoulseekClient({ username: 'hive-test', password: 'x', host: '127.0.0.1', port: net0.port, listenPorts: [0, 0] });
  try {
    await client.login();
    await assert.rejects(client.download('alice', 'a\\b.flac', path.join(os.tmpdir(), 'never.flac'), 5000), /Banned/);
  } finally { client.close(); net0.close(); }
});

test('the download queue files an album under Artist/Album and keeps the list', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slsk-data-'));
  const music = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slsk-music-'));
  const files = ['01 Breadcrumb Trail.flac', '02 Nosferatu Man.flac'].map(n => sharedFile(`M\\Slint\\Spiderland\\${n}`, 4, { lengthSec: 0 }));
  const fakeClient = () => ({
    ended: null,
    login: async () => {},
    search(q, on) { on({ user: 'alice', files, freeSlot: true, speed: 100000, queue: 0 }); return 1; },
    stopSearch() {},
    async download(user, file, target, _ms, progress) { fs.writeFileSync(target, 'song'); progress(4, 4); },
    close() {},
  });
  let added = null;
  const changes = [];
  const d = createSoulseekDownloads({ dataDir, settings: async () => ({ username: 'u', password: 'p', quality: 'lossless' }), musicFolder: async () => music,
    createClient: fakeClient, onChange: l => changes.push(l[0]?.state), onSongs: async got => { added = got; }, wait: async () => {} });
  try {
    d.add({ kind: 'album', artist: 'Slint', album: 'Spiderland', tracks: [{ title: 'Breadcrumb Trail' }, { title: 'Nosferatu Man', loved: true }] });
    for (let i = 0; i < 50 && !added; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(added.length, 2);
    assert.ok(fs.existsSync(path.join(music, 'Slint', 'Spiderland', '02 Nosferatu Man.flac')));
    assert.equal(added[1].loved, true);
    assert.equal(d.list()[0].state, 'done');
    assert.ok(changes.includes('searching') && changes.includes('downloading'));
    const again = createSoulseekDownloads({ dataDir, settings: async () => ({}), musicFolder: async () => music, createClient: fakeClient });
    assert.equal(again.list()[0].message, 'Downloaded Spiderland');
    again.clearFinished();
    assert.equal(again.list().length, 0);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(music, { recursive: true, force: true }); }
});

test('a peer offering a different size than the search showed is turned down', async () => {
  const net0 = await fakeNetwork({ 'a\\b.flac': Buffer.alloc(1000, 1) });
  const client = new SoulseekClient({ username: 'hive-test', password: 'x', host: '127.0.0.1', port: net0.port, listenPorts: [0, 0] });
  try {
    await client.login();
    await assert.rejects(client.download('alice', 'a\\b.flac', path.join(os.tmpdir(), 'never.flac'), 5000, () => {}, 999), /different file/);
  } finally { client.close(); net0.close(); }
});

test('the queue keeps extensions on long names and fails (not hangs) without a music folder', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slsk-data-'));
  const music = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slsk-music-'));
  const long = `01 - Kendrick Lamar - Sing About Me, I'm Dying of Thirst (feat. Someone Else) [2012 Remaster].flac`;
  const files = [sharedFile(`M\\K\\GKMC\\${long}`, 4)];
  const client = () => ({ ended: null, login: async () => {}, search(q, on) { on({ user: 'a', files, freeSlot: true, speed: 1, queue: 0 }); return 1; }, stopSearch() {},
    async download(u, f, target) { fs.writeFileSync(target, 'song'); }, close() {} });
  try {
    let got = null;
    const d = createSoulseekDownloads({ dataDir, settings: async () => ({ username: 'u', password: 'p' }), musicFolder: async () => music, createClient: client, onSongs: async g => { got = g; }, wait: async () => {} });
    d.add({ kind: 'track', artist: 'Kendrick Lamar', tracks: [{ title: "Sing About Me, I'm Dying of Thirst" }] });
    for (let i = 0; i < 50 && !got; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(path.extname(got[0].path), '.flac');
    const noneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slsk-data-'));
    t.after(() => fs.rmSync(noneDir, { recursive: true, force: true }));
    const none = createSoulseekDownloads({ dataDir: noneDir, settings: async () => ({ username: 'u', password: 'p' }),
      musicFolder: async () => { throw new Error('Add a music folder in Hive (Settings › Library) first.'); }, createClient: client, wait: async () => {} });
    none.add({ kind: 'track', artist: 'X', tracks: [{ title: 'Y' }] });
    for (let i = 0; i < 50 && none.list()[0].state !== 'failed'; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(none.list()[0].state, 'failed');
    assert.match(none.list()[0].message, /music folder/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(music, { recursive: true, force: true }); }
});
