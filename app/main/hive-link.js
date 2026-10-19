'use strict';

// Hive Link: the PC side of Hive Mobile.
//
// A small LAN/Tailscale server inside the Hive main process. The phone finds
// it with a UDP broadcast, pairs once with a short code shown by Hive, and
// then talks plain HTTP with a bearer token:
//
//   GET  /api/info                 server identity and library revision
//   GET  /api/library              compact track list (gzip) for matching
//   GET  /api/love/changes?since=  Love changes after a sequence number
//   POST /api/love                 apply Love changes made on the phone
//   GET  /api/events               server-sent events (live Love changes)
//
// Love itself stays where Hive keeps it: in the music files. Phone changes
// go through the same setLove path as the heart button, so the embedded tag,
// the cache, the database projection and the open window all agree.
//
// Each change carries the time it was made. When both sides change the same
// track, the newer change wins; an older one is answered with the current
// state so the phone can correct itself.

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 47800;
const DISCOVERY_PORT = 47801;
const DISCOVERY_REQUEST = 'HIVELINK_DISCOVER';
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const MAX_EVENTS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;

function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function trackIdFor(track) { return String(track?.id || sha256(path.resolve(String(track?.path || ''))).slice(0, 32)); }
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function text(value) { const v = value === undefined || value === null ? '' : String(value); return v === 'None' ? '' : v; }

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      out.push({ name, address: addr.address, tailscale: /^tailscale/i.test(name) || addr.address.startsWith('100.') });
    }
  }
  return out;
}

function createHiveLink({ dataDir, getTracks, setLove, onPaired, log = () => {}, port = DEFAULT_PORT, discoveryPort = DISCOVERY_PORT }) {
  const statePath = path.join(dataDir, 'hive-link.json');
  let state = loadState();
  let server = null;
  let discovery = null;
  let pairing = null;
  const subscribers = new Set();
  // Paths whose Love write was requested by the phone; the echo from
  // notifyLoveChanged is recorded with that device as the origin.
  const pendingOrigins = new Map();

  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return {
        serverId: raw.serverId || crypto.randomUUID(),
        devices: Array.isArray(raw.devices) ? raw.devices : [],
        seq: num(raw.seq),
        events: Array.isArray(raw.events) ? raw.events : [],
        lastChangeAt: raw.lastChangeAt && typeof raw.lastChangeAt === 'object' ? raw.lastChangeAt : {}
      };
    } catch {
      return { serverId: crypto.randomUUID(), devices: [], seq: 0, events: [], lastChangeAt: {} };
    }
  }

  let saveTimer = null;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 500);
  }
  function saveNow() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const temp = `${statePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state));
      fs.renameSync(temp, statePath);
    } catch (err) { log('Hive Link state save failed', err?.message || String(err)); }
  }

  function serverName() { return `Hive on ${os.hostname()}`; }

  function info() {
    return {
      protocol: PROTOCOL_VERSION,
      serverId: state.serverId,
      name: serverName(),
      port,
      seq: state.seq,
      addresses: lanAddresses()
    };
  }

  // ---- pairing -------------------------------------------------------------

  function startPairing() {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    pairing = { code, expiresAt: Date.now() + PAIRING_TTL_MS, attempts: 0 };
    return { code, expiresAt: pairing.expiresAt, addresses: lanAddresses(), port };
  }

  function completePairing(body) {
    if (!pairing || Date.now() > pairing.expiresAt) return { status: 410, body: { error: 'No pairing in progress. Choose "Pair phone" in Hive first.' } };
    pairing.attempts += 1;
    const supplied = String(body?.code || '').trim();
    const match = supplied.length === pairing.code.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(pairing.code));
    if (!match) {
      if (pairing.attempts >= MAX_PAIRING_ATTEMPTS) pairing = null;
      return { status: 403, body: { error: 'Wrong pairing code.' } };
    }
    pairing = null;
    const token = crypto.randomBytes(32).toString('base64url');
    const device = {
      id: crypto.randomUUID(),
      name: String(body?.deviceName || 'Phone').slice(0, 80),
      tokenHash: sha256(token),
      pairedAt: Date.now(),
      lastSeen: Date.now()
    };
    state.devices.push(device);
    saveNow();
    try { onPaired?.(device); } catch {}
    return { status: 200, body: { token, deviceId: device.id, serverId: state.serverId, name: serverName(), seq: state.seq } };
  }

  function authenticate(req) {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return null;
    const hash = sha256(header.slice(7).trim());
    const device = state.devices.find(d => d.tokenHash === hash);
    if (device) { device.lastSeen = Date.now(); saveSoon(); }
    return device || null;
  }

  function unpair(deviceId) {
    const before = state.devices.length;
    state.devices = state.devices.filter(d => d.id !== deviceId);
    for (const sub of subscribers) if (sub.deviceId === deviceId) sub.res.end();
    saveNow();
    return state.devices.length !== before;
  }

  // ---- love events ---------------------------------------------------------

  function recordLove(track, loved, at, origin) {
    const id = trackIdFor(track);
    state.seq += 1;
    const event = { seq: state.seq, id, path: String(track.path), loved: !!loved, at, origin };
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    state.lastChangeAt[id] = at;
    saveSoon();
    broadcast('love', publicEvent(event));
    return event;
  }

  function publicEvent(event) {
    return { seq: event.seq, id: event.id, loved: event.loved, at: event.at, origin: event.origin };
  }

  // Called by main.js after any successful Love write, whoever made it.
  async function notifyLoveChanged(paths, loved) {
    const wanted = (Array.isArray(paths) ? paths : [paths]).filter(Boolean).map(p => path.resolve(String(p)));
    if (!wanted.length) return;
    let byPath = null;
    for (const p of wanted) {
      const pending = pendingOrigins.get(p);
      pendingOrigins.delete(p);
      if (!byPath) {
        const tracks = await getTracks();
        byPath = new Map(tracks.map(t => [path.resolve(String(t.path || '')), t]));
      }
      const track = byPath.get(p) || { path: p };
      recordLove(track, loved, pending?.at || Date.now(), pending?.origin || 'pc');
    }
  }

  function changesSince(since) {
    const oldest = state.events.length ? state.events[0].seq : state.seq + 1;
    if (since < oldest - 1) return { reset: true, seq: state.seq, changes: [] };
    return { reset: false, seq: state.seq, changes: state.events.filter(e => e.seq > since).map(publicEvent) };
  }

  async function applyLoveChanges(device, changes) {
    const tracks = await getTracks();
    const byId = new Map(tracks.map(t => [trackIdFor(t), t]));
    const results = [];
    for (const change of Array.isArray(changes) ? changes.slice(0, 500) : []) {
      const track = byId.get(String(change?.id || ''));
      const at = num(change?.at) || Date.now();
      const key = change?.clientChangeId ?? null;
      if (!track) { results.push({ clientChangeId: key, status: 'not-found' }); continue; }
      const id = trackIdFor(track);
      const loved = !!change.loved;
      if (num(state.lastChangeAt[id]) > at) {
        results.push({ clientChangeId: key, id, status: 'stale', loved: !!track.loved, at: state.lastChangeAt[id] });
        continue;
      }
      if (!!track.loved === loved) {
        state.lastChangeAt[id] = Math.max(num(state.lastChangeAt[id]), at);
        saveSoon();
        results.push({ clientChangeId: key, id, status: 'unchanged', loved });
        continue;
      }
      const absolute = path.resolve(String(track.path));
      pendingOrigins.set(absolute, { origin: device.id, at });
      try {
        await setLove(absolute, loved);
        results.push({ clientChangeId: key, id, status: 'applied', loved });
      } catch (err) {
        pendingOrigins.delete(absolute);
        results.push({ clientChangeId: key, id, status: 'failed', error: err?.message || String(err) });
      }
    }
    return { seq: state.seq, results };
  }

  // ---- library -------------------------------------------------------------

  let libraryCache = null;
  async function libraryPayload() {
    const tracks = await getTracks();
    const rows = tracks
      .filter(t => t && t.path && !/^(ytm|podcast|radio|applemusic|spotify):/i.test(String(t.path)))
      .map(t => ({
        id: trackIdFor(t),
        title: text(t.title),
        artist: text(t.artist),
        album: text(t.album),
        albumArtist: text(t.albumArtist),
        duration: Math.round(num(t.duration) * 1000),
        track: num(t.track),
        disc: num(t.disk),
        year: text(t.year),
        genre: text(t.genre),
        loved: t.loved === true || t.loved === 'True',
        rating: num(t.rating),
        playCount: num(t.playCount),
        file: path.basename(String(t.path))
      }));
    const json = JSON.stringify({ seq: state.seq, tracks: rows });
    const etag = `"${sha256(json).slice(0, 24)}"`;
    if (libraryCache?.etag !== etag) libraryCache = { etag, gzip: zlib.gzipSync(json) };
    return libraryCache;
  }

  // ---- server-sent events --------------------------------------------------

  function broadcast(type, payload) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const sub of subscribers) {
      try { sub.res.write(frame); } catch { subscribers.delete(sub); }
    }
  }

  function openEvents(req, res, device) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: state.seq, serverId: state.serverId })}\n\n`);
    const sub = { res, deviceId: device.id };
    subscribers.add(sub);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(keepAlive); subscribers.delete(sub); });
  }

  // ---- http ----------------------------------------------------------------

  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) });
    res.end(json);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reject(new Error('Request body too large.')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch { reject(new Error('Invalid JSON.')); }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://hive.local');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/ping') return send(res, 200, { ok: true, protocol: PROTOCOL_VERSION, serverId: state.serverId });
    if (route === 'POST /api/pair') return (r => send(res, r.status, r.body))(completePairing(await readJson(req)));

    const device = authenticate(req);
    if (!device) return send(res, 401, { error: 'Not paired with this Hive.' });

    switch (route) {
      case 'GET /api/info':
        return send(res, 200, { ...info(), deviceId: device.id, deviceName: device.name });
      case 'GET /api/library': {
        const payload = await libraryPayload();
        if (req.headers['if-none-match'] === payload.etag) { res.writeHead(304, { ETag: payload.etag }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', ETag: payload.etag, 'Content-Length': payload.gzip.length });
        return res.end(payload.gzip);
      }
      case 'GET /api/love/changes':
        return send(res, 200, changesSince(num(url.searchParams.get('since'))));
      case 'POST /api/love': {
        const body = await readJson(req);
        return send(res, 200, await applyLoveChanges(device, body?.changes));
      }
      case 'GET /api/events':
        return openEvents(req, res, device);
      case 'POST /api/unpair':
        unpair(device.id);
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: 'Unknown endpoint.' });
    }
  }

  // ---- discovery -----------------------------------------------------------

  function startDiscovery() {
    discovery = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    discovery.on('message', (msg, rinfo) => {
      if (!msg.toString('utf8').startsWith(DISCOVERY_REQUEST)) return;
      const reply = Buffer.from(JSON.stringify({ hivelink: PROTOCOL_VERSION, serverId: state.serverId, name: serverName(), port }));
      discovery.send(reply, rinfo.port, rinfo.address);
    });
    discovery.on('error', err => { log('Hive Link discovery error', err?.message || String(err)); try { discovery.close(); } catch {} discovery = null; });
    discovery.bind(discoveryPort);
  }

  function start() {
    if (server) return;
    server = http.createServer((req, res) => {
      handle(req, res).catch(err => {
        log('Hive Link request failed', `${req.method} ${req.url}`, err?.message || String(err));
        if (!res.headersSent) send(res, 500, { error: err?.message || 'Internal error.' });
        else try { res.end(); } catch {}
      });
    });
    server.on('error', err => log('Hive Link server error', err?.message || String(err)));
    server.listen(port, '0.0.0.0', () => log('Hive Link listening', port));
    startDiscovery();
  }

  function stop() {
    for (const sub of subscribers) { try { sub.res.end(); } catch {} }
    subscribers.clear();
    try { server?.close(); } catch {}
    try { discovery?.close(); } catch {}
    server = null;
    discovery = null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
  }

  return {
    start,
    stop,
    startPairing,
    unpair,
    notifyLoveChanged,
    info,
    devices: () => state.devices.map(({ tokenHash, ...rest }) => rest)
  };
}

module.exports = { createHiveLink, trackIdFor, DEFAULT_PORT, DISCOVERY_PORT, PROTOCOL_VERSION };
