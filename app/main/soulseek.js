'use strict';

// A download-only Soulseek client for Hive on the PC, as Hive Mobile has
// (mobile/.../soulseek/): log in, search, pick the folder that best matches
// an album's tracklist, and fetch its songs. It shares nothing (it tells the
// server so) and turns down anyone asking it for files.
//
// The wire format follows Nicotine+'s documentation (pynicotine/
// slskmessages.py): little-endian integers, strings as a uint32 length then
// UTF-8. Server and peer messages are framed uint32 length, uint32 code,
// body; peer init messages uint32 length, uint8 code, body; file connections
// carry raw values. Experimental clients identify as major version 177.

const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const CLIENT_VERSION = 177;
const CLIENT_MINOR_VERSION = 1;

const Code = {
  LOGIN: 1, SET_WAIT_PORT: 2, GET_PEER_ADDRESS: 3, CONNECT_TO_PEER: 18, FILE_SEARCH: 26, SET_STATUS: 28,
  SHARED_FOLDERS_FILES: 35, RELOGGED: 41, HAVE_NO_PARENT: 71, CANT_CONNECT_TO_PEER: 1001,
  PIERCE_FIREWALL: 0, PEER_INIT: 1,
  SHARED_FILE_LIST_REQUEST: 4, SEARCH_RESPONSE: 9, TRANSFER_REQUEST: 40, TRANSFER_RESPONSE: 41,
  QUEUE_UPLOAD: 43, PLACE_IN_QUEUE_RESPONSE: 44, UPLOAD_FAILED: 46, UPLOAD_DENIED: 50,
};

// ---- wire ----

class Out {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(Buffer.from([v & 0xff])); return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v) >>> 0); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); return this; }
  str(s) { const b = Buffer.from(String(s), 'utf8'); this.u32(b.length); this.parts.push(b); return this; }
  bytes() { return Buffer.concat(this.parts); }
}

class In {
  constructor(buf, pos = 0) { this.b = buf; this.pos = pos; }
  get remaining() { return this.b.length - this.pos; }
  need(n) { if (this.remaining < n) throw new Error('Message ended early'); }
  u8() { this.need(1); return this.b[this.pos++]; }
  bool() { return this.u8() !== 0; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.pos); this.pos += 4; return v; }
  u64() { this.need(8); const v = Number(this.b.readBigUInt64LE(this.pos)); this.pos += 8; return v; }
  str() {
    const n = this.u32(); this.need(n);
    const raw = this.b.subarray(this.pos, this.pos + n); this.pos += n;
    const text = raw.toString('utf8');
    // Older clients send Latin-1: a replacement character means it wasn't UTF-8.
    return text.includes('�') ? raw.toString('latin1') : text;
  }
  // An IPv4 address, sent with its bytes reversed.
  ip() { this.need(4); const s = [3, 2, 1, 0].map(i => this.b[this.pos + i]).join('.'); this.pos += 4; return s; }
  // A file size; Soulseek NS sends sizes over 2 GiB with garbage in the top half.
  fileSize() { this.need(8); if (this.b[this.pos + 7] === 255) { const v = this.u32(); this.pos += 4; return v; } return this.u64(); }
  skip(n) { this.need(n); this.pos += n; }
}

const frame = (code, body) => Buffer.concat([new Out().u32(body.length + 4).u32(code).bytes(), body]);
const initFrame = (code, body) => Buffer.concat([new Out().u32(body.length + 1).u8(code).bytes(), body]);

// Splits a stream into length-prefixed frames, handing each frame's content (after the length) to onFrame.
// Chunks are kept as they come and joined once a frame is complete, so a big frame isn't copied over and over.
function framer(onFrame, max = 64 * 1024 * 1024) {
  let chunks = [], have = 0;
  return chunk => {
    chunks.push(chunk); have += chunk.length;
    while (have >= 4) {
      if (chunks[0].length < 4) chunks = [Buffer.concat(chunks)];
      const len = chunks[0].readUInt32LE(0);
      if (len < 1 || len > max) throw new Error(`Message of ${len} bytes`);
      if (have < 4 + len) break;
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, have);
      const body = all.subarray(4, 4 + len);
      const rest = all.subarray(4 + len);
      chunks = rest.length ? [rest] : []; have = rest.length;
      onFrame(body);
    }
  };
}

// Peers send search results (compressed) and short messages; anything bigger isn't a real client.
const PEER_MAX = 8 * 1024 * 1024;

const msg = {
  login: (user, pass) => frame(Code.LOGIN, new Out().str(user).str(pass).u32(CLIENT_VERSION)
    .str(crypto.createHash('md5').update(user + pass).digest('hex')).u32(CLIENT_MINOR_VERSION).bytes()),
  setWaitPort: port => frame(Code.SET_WAIT_PORT, new Out().u32(port).bytes()),
  getPeerAddress: user => frame(Code.GET_PEER_ADDRESS, new Out().str(user).bytes()),
  connectToPeer: (token, user, type) => frame(Code.CONNECT_TO_PEER, new Out().u32(token).str(user).str(type).bytes()),
  fileSearch: (token, query) => frame(Code.FILE_SEARCH, new Out().u32(token).str(query).bytes()),
  setStatusOnline: () => frame(Code.SET_STATUS, new Out().u32(2).bytes()),
  sharedFoldersFiles: (folders, files) => frame(Code.SHARED_FOLDERS_FILES, new Out().u32(folders).u32(files).bytes()),
  haveNoParent: () => frame(Code.HAVE_NO_PARENT, new Out().bool(true).bytes()),
  cantConnectToPeer: (token, user) => frame(Code.CANT_CONNECT_TO_PEER, new Out().u32(token).str(user).bytes()),
  pierceFirewall: token => initFrame(Code.PIERCE_FIREWALL, new Out().u32(token).bytes()),
  peerInit: (me, type) => initFrame(Code.PEER_INIT, new Out().str(me).str(type).u32(0).bytes()),
  queueUpload: file => frame(Code.QUEUE_UPLOAD, new Out().str(file).bytes()),
  transferAllowed: token => frame(Code.TRANSFER_RESPONSE, new Out().u32(token).bool(true).bytes()),
  transferRefused: (token, reason) => frame(Code.TRANSFER_RESPONSE, new Out().u32(token).bool(false).str(reason).bytes()),
  uploadDenied: (file, reason) => frame(Code.UPLOAD_DENIED, new Out().str(file).str(reason).bytes()),
};

function sharedFile(path, size, attrs = {}) {
  const p = String(path).replace(/\//g, '\\');
  const name = p.slice(p.lastIndexOf('\\') + 1);
  return { path: p, size, bitrate: attrs.bitrate || 0, lengthSec: attrs.lengthSec || 0, vbr: !!attrs.vbr, sampleRate: attrs.sampleRate || 0, bitDepth: attrs.bitDepth || 0,
    name, folder: p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : '', extension: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '' };
}

// A FileSearchResponse body (zlib-compressed).
function parseSearchResult(body) {
  const r = new In(zlib.inflateSync(body, { maxOutputLength: 32 * 1024 * 1024 }));
  const user = r.str();
  const token = r.u32();
  const n = Math.min(r.u32(), 100000);
  const files = [];
  for (let i = 0; i < n; i++) {
    r.u8();
    const name = r.str();
    const size = r.fileSize();
    r.skip(r.u32()); // extension, obsolete
    const attrs = {};
    const count = Math.min(r.u32(), 64);
    for (let a = 0; a < count; a++) {
      const code = r.u32(), value = r.u32();
      if (code === 0) attrs.bitrate = value; else if (code === 1) attrs.lengthSec = value; else if (code === 2) attrs.vbr = value !== 0;
      else if (code === 4) attrs.sampleRate = value; else if (code === 5) attrs.bitDepth = value;
    }
    files.push(sharedFile(name, size, attrs));
  }
  return { user, token, files, freeSlot: r.bool(), speed: r.u32(), queue: r.u32() };
}

// ---- client ----

class SoulseekClient {
  constructor({ username, password, host = 'server.slsknet.org', port = 2242, listenPorts = [2234, 2244], log = () => {} }) {
    Object.assign(this, { username, password, host, port, listenPorts, log });
    this.searches = new Map();
    this.addresses = new Map();
    this.indirect = new Map();
    this.peers = new Map();
    this.queued = new Map();
    this.byToken = new Map();
    this.sockets = new Set();
    this.nextToken = (Date.now() & 0x3fffffff) + 1;
    this.ended = null;
  }

  token() { this.nextToken = (this.nextToken + 1) >>> 0; return this.nextToken; }
  track(sock) { this.sockets.add(sock); sock.on('close', () => this.sockets.delete(sock)); return sock; }

  // Logs in and announces Hive (sharing nothing). Resolves to the server's greeting.
  async login() {
    const server = this.track(net.connect({ host: this.host, port: this.port }));
    server.setKeepAlive(true, 30000);
    this.server = server;
    const greeting = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The Soulseek server didn't answer")), 20000);
      server.once('error', err => { clearTimeout(timer); reject(err); });
      server.once('close', () => { clearTimeout(timer); reject(new Error('The Soulseek server closed the connection')); });
      let loggedIn = false;
      server.on('data', framer(body => {
        const r = new In(body);
        const code = r.u32();
        if (!loggedIn) {
          if (code !== Code.LOGIN) return;
          clearTimeout(timer);
          if (!r.bool()) {
            const reason = r.str();
            reject(new Error({ INVALIDPASS: 'Wrong Soulseek password', INVALIDUSERNAME: "That Soulseek username isn't allowed", SVRFULL: 'The Soulseek server is full; try again later' }[reason] || `Soulseek refused the login (${reason})`));
            return;
          }
          loggedIn = true;
          resolve(r.str());
          return;
        }
        try { this.handleServer(code, r); } catch {}
      }));
      server.write(msg.login(this.username, this.password));
    });
    server.on('close', () => { if (!this.ended) this.ended = 'Lost the connection to the Soulseek server'; });
    server.on('error', () => {});
    const port = await this.listen();
    for (const m of [msg.setWaitPort(port), msg.setStatusOnline(), msg.sharedFoldersFiles(0, 0), msg.haveNoParent()]) server.write(m);
    this.log(`Logged in to Soulseek as ${this.username} (listening on ${port})`);
    return greeting;
  }

  handleServer(code, r) {
    if (code === Code.GET_PEER_ADDRESS) {
      const user = r.str(), ip = r.ip(), port = r.u32();
      this.addresses.get(user)?.(ip, port); this.addresses.delete(user);
    } else if (code === Code.CONNECT_TO_PEER) {
      const user = r.str(), type = r.str(), ip = r.ip(), port = r.u32(), token = r.u32();
      this.connectBack(user, type, ip, port, token);
    } else if (code === Code.CANT_CONNECT_TO_PEER) {
      const token = r.u32(); this.indirect.get(token)?.(null); this.indirect.delete(token);
    } else if (code === Code.RELOGGED) {
      this.ended = 'Logged in to Soulseek somewhere else (Hive on your phone, or Seeker?)';
      this.server?.destroy();
    }
  }

  sendServer(buf) { if (!this.server || this.server.destroyed) throw new Error('Not logged in to Soulseek'); this.server.write(buf); }

  listen() {
    const [first, last] = this.listenPorts;
    return new Promise(resolve => {
      const tryPort = p => {
        if (p > last) return resolve(0);
        const srv = net.createServer(sock => this.accept(this.track(sock)));
        srv.once('error', () => tryPort(p + 1));
        srv.listen(p, () => { this.listener = srv; resolve(srv.address().port); });
      };
      tryPort(first);
    });
  }

  // A connection a peer opened to us: a direct PeerInit, or the PierceFirewall answering our ConnectToPeer.
  // Whatever follows the init frame in the same read (a peer can send its first message straight after) goes to the next reader.
  accept(sock) {
    sock.setTimeout(30000, () => sock.destroy());
    let head = Buffer.alloc(0);
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      if (head.length < 4) return;
      const len = head.readUInt32LE(0);
      if (len < 1 || len > 4096) { sock.destroy(); return; }
      if (head.length < 4 + len) return;
      sock.removeListener('data', onData);
      const rest = head.subarray(4 + len);
      const r = new In(head.subarray(4, 4 + len));
      try {
        const code = r.u8();
        if (code === Code.PIERCE_FIREWALL) { const t = r.u32(); const waiting = this.indirect.get(t); this.indirect.delete(t); if (waiting) waiting(sock, rest); else sock.destroy(); }
        else if (code === Code.PEER_INIT) { const user = r.str(); const type = r.str(); if (type === 'P') this.startPeer(user, sock, rest); else if (type === 'F') this.receiveFile(sock, rest, user); else sock.destroy(); }
        else sock.destroy();
      } catch { sock.destroy(); }
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  }

  // The server asks us to connect to a peer who couldn't reach us.
  connectBack(user, type, ip, port, token) {
    if (type !== 'P' && type !== 'F') return;
    const sock = this.track(net.connect({ host: ip, port }));
    sock.setTimeout(10000, () => sock.destroy());
    sock.once('error', () => { try { this.sendServer(msg.cantConnectToPeer(token, user)); } catch {} });
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.write(msg.pierceFirewall(token));
      if (type === 'P') this.startPeer(user, sock); else this.receiveFile(sock, null, user);
    });
  }

  // A message connection to user: direct to their address, else the server's indirect connection.
  async peer(user) {
    const open = this.peers.get(user);
    if (open && !open.destroyed) return open;
    const [ip, port] = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No address for ${user}`)), 15000);
      this.addresses.set(user, (i, p) => { clearTimeout(timer); resolve([i, p]); });
      this.sendServer(msg.getPeerAddress(user));
    });
    const direct = port > 0 && ip !== '0.0.0.0' ? await new Promise(resolve => {
      const sock = net.connect({ host: ip, port });
      const timer = setTimeout(() => { sock.destroy(); resolve(null); }, 8000);
      sock.once('error', () => { clearTimeout(timer); resolve(null); });
      sock.once('connect', () => { clearTimeout(timer); sock.write(msg.peerInit(this.username, 'P')); resolve(this.track(sock)); });
    }) : null;
    const sock = direct || await new Promise((resolve, reject) => {
      const token = this.token();
      const timer = setTimeout(() => { this.indirect.delete(token); reject(new Error(`Couldn't connect to ${user}`)); }, 20000);
      this.indirect.set(token, (s, rest) => { clearTimeout(timer); if (s) { s.__rest = rest; resolve(s); } else reject(new Error(`Couldn't connect to ${user}`)); });
      this.sendServer(msg.connectToPeer(token, user, 'P'));
    });
    this.startPeer(user, sock, sock.__rest);
    return sock;
  }

  startPeer(user, sock, rest) {
    const old = this.peers.get(user);
    if (!old || old.destroyed) this.peers.set(user, sock);
    sock.setTimeout(0);
    sock.on('error', () => {});
    sock.on('close', () => { if (this.peers.get(user) === sock) this.peers.delete(user); });
    const onFrame = framer(body => { try { this.handlePeer(user, sock, body); } catch {} }, PEER_MAX);
    sock.on('data', chunk => { try { onFrame(chunk); } catch { sock.destroy(); } });
    if (rest?.length) onFrame(rest);
  }

  handlePeer(user, sock, body) {
    const r = new In(body);
    const code = r.u32();
    if (code === Code.SEARCH_RESPONSE) {
      if (!this.searches.size) return;
      const res = parseSearchResult(body.subarray(4));
      this.searches.get(res.token)?.({ ...res, user: user || res.user });
    } else if (code === Code.TRANSFER_REQUEST) {
      const direction = r.u32(), token = r.u32(), file = r.str();
      const size = direction === 1 ? r.u64() : 0;
      const t = this.queued.get(`${user}\n${file}`);
      // Only the file the search showed: a peer can't make Hive take something else (or something endless).
      if (direction === 1 && t && !t.finished && t.expected > 0 && size !== t.expected) { sock.write(msg.transferRefused(token, 'Cancelled')); t.fail(`${user} offered a different file`); }
      else if (direction === 1 && t && !t.finished) { t.size = size; this.byToken.set(`${user}\n${token}`, t); sock.write(msg.transferAllowed(token)); }
      else sock.write(msg.transferRefused(token, direction === 1 ? 'Cancelled' : 'File not shared.'));
    } else if (code === Code.QUEUE_UPLOAD) {
      sock.write(msg.uploadDenied(r.str(), 'File not shared.'));
    } else if (code === Code.PLACE_IN_QUEUE_RESPONSE) {
      const file = r.str(); const t = this.queued.get(`${user}\n${file}`); if (t) t.place = r.u32();
    } else if (code === Code.UPLOAD_DENIED) {
      const file = r.str(); this.queued.get(`${user}\n${file}`)?.fail(`${user}: ${r.str()}`);
    } else if (code === Code.UPLOAD_FAILED) {
      const file = r.str(); const t = this.queued.get(`${user}\n${file}`); if (t && !t.started) t.fail(`${user} couldn't send it`);
    }
  }

  // Searches the network; onResult runs for each peer's answer until stopSearch.
  search(query, onResult) {
    const token = this.token();
    this.searches.set(token, onResult);
    this.sendServer(msg.fileSearch(token, query));
    return token;
  }
  stopSearch(token) { this.searches.delete(token); }

  // Asks user for file and saves it to target: up to startWithinMs for the peer to start sending, then as long as bytes come.
  async download(user, file, target, startWithinMs, onProgress = () => {}, expected = 0) {
    let resolveDone, rejectDone, resolveStart;
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
    const started = new Promise(res => { resolveStart = res; });
    const t = { user, file, target, onProgress, expected: Number(expected) || 0, size: 0, place: 0, started: false, finished: false,
      start() { this.started = true; resolveStart(); },
      ok(p) { this.finished = true; resolveDone(p); },
      fail(why) { if (this.finished) return; this.finished = true; rejectDone(new Error(why)); resolveStart(); } };
    done.catch(() => {});
    const key = `${user}\n${file}`;
    this.queued.set(key, t);
    try {
      let conn = await this.peer(user);
      conn.write(msg.queueUpload(file));
      let resent = 0;
      const deadline = Date.now() + startWithinMs;
      while (!t.started && !t.finished) {
        if (Date.now() > deadline) throw new Error(`${user} didn't start sending in time`);
        await Promise.race([started, new Promise(r => setTimeout(r, 1000))]);
        // A reused connection the peer was just closing loses the request: ask again on a new one.
        if (!t.started && !t.finished && conn.destroyed && resent < 2) { resent++; conn = await this.peer(user); conn.write(msg.queueUpload(file)); }
      }
      return await done;
    } finally {
      this.queued.delete(key);
      for (const [k, v] of this.byToken) if (v === t) this.byToken.delete(k);
    }
  }

  // A file connection: the peer's token, our offset (0: always whole files), then the bytes.
  // Only the user we accepted the transfer from can fill it; anything going wrong fails that song, never Hive.
  receiveFile(sock, rest, user = '') {
    const fs = require('node:fs');
    const path = require('node:path');
    let t = null, got = 0, out = null, lastReport = 0, head = Buffer.alloc(0), ended = false;
    sock.setTimeout(60000, () => sock.destroy());
    const finish = err => {
      if (!t || ended) return;
      ended = true;
      sock.removeListener('data', onData);
      if (err || got < t.size) { out?.destroy(); sock.destroy(); t.fail(err?.message || `${t.user} stopped sending`); return; }
      t.onProgress(got, t.size);
      out.end(() => t.ok(t.target));
    };
    const onData = chunk => {
      try {
        if (!t) {
          head = Buffer.concat([head, chunk]);
          if (head.length < 4) return;
          const key = `${user}\n${head.readUInt32LE(0)}`;
          t = this.byToken.get(key) || null;
          if (!t) { sock.destroy(); return; }
          this.byToken.delete(key);
          t.start();
          if (!(t.size > 0)) { finish(new Error(`${t.user} sent an empty file`)); return; }
          sock.write(new Out().u64(0).bytes());
          fs.mkdirSync(path.dirname(t.target), { recursive: true });
          out = fs.createWriteStream(t.target);
          out.on('error', err => finish(err));
          chunk = head.subarray(4);
          if (!chunk.length) return;
        }
        const take = chunk.subarray(0, Math.max(0, t.size - got));
        out.write(take);
        got += take.length;
        const now = Date.now();
        if (now - lastReport > 500) { lastReport = now; t.onProgress(got, t.size); }
        if (got >= t.size) { sock.end(); finish(null); }
      } catch (err) { if (t) finish(err); else sock.destroy(); }
    };
    sock.on('data', onData);
    sock.on('error', err => finish(err));
    sock.on('close', () => { if (t && got < t.size) finish(null); });
    if (rest?.length) onData(rest);
  }

  close() {
    try { this.listener?.close(); } catch {}
    for (const s of this.sockets) try { s.destroy(); } catch {}
    this.sockets.clear();
    this.peers.clear();
  }
}

// ---- picking the folder ----

const AUDIO = new Set(['flac', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'aiff', 'aif', 'alac']);
const DISC = /^(cd|disc|disk)\s*\d+.*$/i;
const LEADING_NUMBER = /^\s*(\d{1,3}[\s._-]+|\d-\d{1,2}[\s._-]+|[a-d]\d{1,2}[\s._-]+)/i;
const FEATURING = /[(\[](feat\.?|ft\.?|with)[^)\]]*[)\]]/gi;

function norm(v) {
  return String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(FEATURING, ' ').replace(/[^a-z0-9]+/g, '');
}

// A file's song title as its name gives it: no extension, track number or artist prefix.
function titleOf(fileName, artist) {
  let t = String(fileName).replace(/\.[^.]*$/, '').replace(LEADING_NUMBER, '');
  const a = norm(artist);
  const dash = /\s[-–]\s/.exec(t);
  if (dash && a) {
    const before = norm(t.slice(0, dash.index));
    if (before.includes(a) || (a.includes(before) && before.length >= 3)) t = t.slice(dash.index + dash[0].length);
  }
  return t.replace(LEADING_NUMBER, '');
}

function formatOf(f) {
  if (['flac', 'alac', 'wav', 'aiff', 'aif'].includes(f.extension)) return f.bitDepth > 16 ? 'lossless-hi' : 'lossless';
  if (f.extension === 'mp3') return f.bitrate >= 315 && !f.vbr ? 'mp3-320' : f.bitrate >= 220 ? 'mp3-v0' : f.bitrate >= 190 ? 'mp3-256' : f.bitrate === 0 ? 'mp3' : 'mp3-low';
  if (f.extension === 'm4a' || f.extension === 'aac') return f.bitrate > 0 && f.bitrate <= 200 ? 'aac-low' : 'aac';
  return 'other';
}

const FORMAT_SCORE = {
  lossless: { lossless: 30, 'lossless-hi': 27, 'mp3-320': 22, 'mp3-v0': 20, aac: 16, 'mp3-256': 15, mp3: 10 },
  mp3: { 'mp3-320': 30, 'mp3-v0': 28, 'mp3-256': 22, lossless: 18, aac: 18, 'lossless-hi': 15, mp3: 12 },
};

// Which file is which wanted track: by title (and length when both are known), else, for a folder of exactly the album, in order by length.
function matchFiles(artist, wanted, files) {
  const names = files.map(f => norm(titleOf(f.name, artist)));
  const used = new Array(files.length).fill(false);
  const out = new Map();
  const lengthOk = (w, f) => !(w.durationMs > 0) || !(f.lengthSec > 0) || Math.abs(w.durationMs / 1000 - f.lengthSec) <= 4;
  wanted.forEach((w, i) => {
    const t = norm(w.title);
    if (!t) return;
    let best = -1, bestCost = Infinity;
    files.forEach((f, j) => {
      const n = names[j];
      if (used[j] || !lengthOk(w, f) || !n) return;
      if (!(n === t || n.includes(t) || (t.includes(n) && n.length >= 4))) return;
      const cost = (n === t ? 0 : 1000) + Math.abs(n.length - t.length) + (w.durationMs > 0 && f.lengthSec > 0 ? Math.abs(Math.floor(w.durationMs / 1000) - f.lengthSec) : 0);
      if (cost < bestCost) { bestCost = cost; best = j; }
    });
    if (best >= 0) { used[best] = true; out.set(i, files[best]); }
  });
  if (out.size < wanted.length && files.length === wanted.length && wanted.every(w => w.durationMs > 0)) {
    const ordered = [...files].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
    if (ordered.every((f, i) => f.lengthSec > 0 && Math.abs(wanted[i].durationMs / 1000 - f.lengthSec) <= 2)) return new Map(wanted.map((_, i) => [i, ordered[i]]));
  }
  return out;
}

// Each peer's album folder (CD1/CD2 subfolders counted together, one format at a time), matched to the
// tracklist; folders missing much of it are left out, the rest ranked by how much they have, the format,
// and how soon the peer can send.
function candidates(artist, wanted, results, quality = 'lossless') {
  if (!wanted.length) return [];
  const single = wanted.length === 1;
  const picks = [];
  for (const r of results) {
    const groups = new Map();
    for (const f of r.files) {
      if (!AUDIO.has(f.extension)) continue;
      const last = f.folder.slice(f.folder.lastIndexOf('\\') + 1);
      const album = DISC.test(last) && f.folder.includes('\\') ? f.folder.slice(0, f.folder.lastIndexOf('\\')) : f.folder;
      const key = `${album}\n${formatOf(f)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    for (const [key, files] of groups) {
      const matched = matchFiles(artist, wanted, files);
      const coverage = matched.size / wanted.length;
      if (single && !matched.size) continue;
      if (!single && (coverage < 0.75 || matched.size < Math.min(wanted.length, 2))) continue;
      const [folder, format] = key.split('\n');
      const score = coverage * 100 + (FORMAT_SCORE[quality]?.[format] || 0) + (r.freeSlot ? 25 : 0)
        + Math.min(Math.log(1 + r.speed / 1024) * 1.2, 12) - Math.min(r.queue, 50) / 5
        // A whole discography shared as one folder is slower to sift and often mislabelled.
        - (!single && files.length > wanted.length * 3 ? 10 : 0);
      picks.push({ user: r.user, folder, files: matched, score, freeSlot: r.freeSlot, format });
    }
  }
  return picks.sort((a, b) => b.score - a.score);
}

// A search response as a peer sends it (for tests).
function searchResultBody(user, token, files, freeSlot, speed, queue) {
  const o = new Out().str(user).u32(token).u32(files.length);
  for (const f of files) {
    const attrs = [[0, f.bitrate || 0], [1, f.lengthSec || 0], ...(f.sampleRate ? [[4, f.sampleRate]] : []), ...(f.bitDepth ? [[5, f.bitDepth]] : [])];
    o.u8(1).str(f.path).u64(f.size).str('').u32(attrs.length);
    for (const [c, v] of attrs) o.u32(c).u32(v);
  }
  o.bool(freeSlot).u32(speed).u32(queue).u32(0);
  return zlib.deflateSync(o.bytes());
}

module.exports = { SoulseekClient, Code, Out, In, frame, initFrame, framer, msg, sharedFile, parseSearchResult, searchResultBody, candidates, matchFiles, titleOf, norm, CLIENT_VERSION };
