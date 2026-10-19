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
//   POST /api/love                 Love changes made on the phone: applied, or
//                                  (while acceptPhoneChanges is off) kept in the
//                                  inbox for the user to confirm in Hive
//   POST /api/plays                plays made on the phone, kept in the inbox
//   GET  /api/plays?since=         plays made in Hive, so the phone counts them too
//   GET  /api/events               server-sent events (live Love changes)
//   GET  /api/stream/track?id=     a library song's file, with Range support
//   GET  /api/playlists            Hive's own playlists, read only: library songs by
//                                  id, Apple Music and Spotify songs as Hive keeps them
//   GET  /api/remote               what Hive is playing (when remote control is on)
//   POST /api/remote               play/pause, next, previous, seek, volume
//   GET  /api/cover?name=          a library cover from Hive's covers folder
//                                  (the token may come as ?t= so any image
//                                  loader on the phone can fetch it)
//   GET  /api/stream/song?key=…    a song Hive doesn't have (Apple Music,
//                                  Spotify), streamed from YouTube Music
//                                  through Hive, as Hive itself plays them
//
// Love itself stays where Hive keeps it: in the music files. Phone changes
// go through the same setLove path as the heart button, so the embedded tag,
// the cache, the database projection and the open window all agree.
//
// Each change carries the time it was made. When both sides change the same
// track, the newer change wins; an older one is answered with the current
// state so the phone can correct itself.
//
// While acceptPhoneChanges is off, PC Love still reaches the phone but phone
// changes are not applied: they wait in the inbox ("staged"), and the user
// looks them over in Hive and applies or discards them. Phone plays always
// wait there; applied, they join Hive's own listening history and Wrapped.

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const zlib = require('zlib');

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 47800;
const DISCOVERY_PORT = 47801;
const DISCOVERY_REQUEST = 'HIVELINK_DISCOVER';
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const MAX_EVENTS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INBOX_PLAYS = 50000;

// The inbox as saved: Love by song id, plays in a list. Anything malformed is dropped.
function cleanInbox(raw) {
  const loves = {};
  for (const [id, l] of Object.entries(raw?.loves && typeof raw.loves === 'object' ? raw.loves : {})) {
    if (id && l && typeof l === 'object') loves[id] = { id, loved: !!l.loved, at: Number(l.at) || 0, deviceId: String(l.deviceId || '') };
  }
  const plays = (Array.isArray(raw?.plays) ? raw.plays : []).filter(p => p && p.id && p.playedAt && p.clientId)
    .map(p => ({ id: String(p.id), playedAt: Number(p.playedAt), listenedMs: Number(p.listenedMs) || 0, deviceId: String(p.deviceId || ''), clientId: String(p.clientId) }));
  return { loves, plays };
}

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

function createHiveLink({ dataDir, getTracks, setLove, onPaired, streamSong = null, coversDir = null, remote = null, getPlaylists = null, getPlays = null, recordPlays = null, onInbox = () => {}, log = () => {}, port = DEFAULT_PORT, discoveryPort = DISCOVERY_PORT, acceptPhoneChanges = false }) {
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
        lastChangeAt: raw.lastChangeAt && typeof raw.lastChangeAt === 'object' ? raw.lastChangeAt : {},
        remoteControl: !!raw.remoteControl,
        inbox: cleanInbox(raw.inbox)
      };
    } catch {
      return { serverId: crypto.randomUUID(), devices: [], seq: 0, events: [], lastChangeAt: {}, inbox: cleanInbox(null) };
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
      addresses: lanAddresses(),
      streams: { track: true, song: !!streamSong },
      remote: !!remote && !!state.remoteControl,
      plays: !!getPlays,
      // Phone changes waiting for the user in Hive.
      inbox: inboxSummary()
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

  function authenticate(req, url) {
    const header = String(req.headers.authorization || '');
    // Covers alone accept the token in the address: image loaders can't always send headers.
    const fromQuery = url && url.pathname === '/api/cover' ? String(url.searchParams.get('t') || '') : '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : fromQuery;
    if (!token) return null;
    const hash = sha256(token);
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
    if (!acceptPhoneChanges) {
      // Kept for the user to confirm in Hive; the newest change per song wins.
      const staged = Array.isArray(changes) ? changes.slice(0, 500) : [];
      for (const c of staged) {
        const id = String(c?.id || '');
        if (!id) continue;
        const at = num(c?.at) || Date.now();
        const prior = state.inbox.loves[id];
        if (!prior || prior.at <= at) state.inbox.loves[id] = { id, loved: !!c.loved, at, deviceId: device.id };
      }
      inboxChanged();
      return { seq: state.seq, results: staged.map(c => ({ clientChangeId: c?.clientChangeId ?? null, id: String(c?.id || ''), status: 'staged' })) };
    }
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

  // ---- plays and the inbox -------------------------------------------------

  // Plays made on the phone wait here until the user applies them; each is
  // known by the phone's own id for it, so a resend never counts twice.
  function stagePlays(device, plays) {
    const seen = new Set(state.inbox.plays.map(p => `${p.deviceId}:${p.clientId}`));
    let added = 0;
    for (const p of Array.isArray(plays) ? plays.slice(0, 5000) : []) {
      const clientId = String(p?.clientId ?? '');
      const id = String(p?.id || '');
      const playedAt = num(p?.playedAt);
      if (!clientId || !id || !playedAt || seen.has(`${device.id}:${clientId}`)) continue;
      seen.add(`${device.id}:${clientId}`);
      state.inbox.plays.push({ id, playedAt, listenedMs: Math.max(0, num(p?.listenedMs)), deviceId: device.id, clientId });
      added++;
    }
    if (state.inbox.plays.length > MAX_INBOX_PLAYS) state.inbox.plays.splice(0, state.inbox.plays.length - MAX_INBOX_PLAYS);
    if (added) inboxChanged();
    return { staged: added };
  }

  // Hive's own plays after a time, for the phone's counts and Wrap.
  async function playsSince(since) {
    if (!getPlays) return { plays: [] };
    const tracks = await getTracks();
    const byPath = new Map(tracks.filter(t => t?.path).map(t => [path.resolve(String(t.path)), t]));
    const plays = [];
    for (const e of await getPlays(since)) {
      const track = e?.path ? byPath.get(path.resolve(String(e.path))) : null;
      if (!track) continue;
      plays.push({ id: trackIdFor(track), playedAt: num(e.playedAt), listenedMs: Math.round(num(e.duration) * 1000), eventId: String(e.id || '') });
      if (plays.length >= 5000) break;
    }
    return { plays };
  }

  function inboxChanged() { saveSoon(); try { onInbox(inboxSummary()); } catch {} }

  function inboxSummary() {
    return { loves: Object.keys(state.inbox.loves).length, plays: state.inbox.plays.length };
  }

  // The inbox as the user reviews it: songs by name, newest first.
  async function inbox() {
    const tracks = await getTracks();
    const byId = new Map(tracks.map(t => [trackIdFor(t), t]));
    const nameOf = id => { const t = byId.get(id); return t ? { title: text(t.title), artist: text(t.artist), album: text(t.album), path: String(t.path), loved: t.loved === true || t.loved === 'True' } : null; };
    const deviceName = id => state.devices.find(d => d.id === id)?.name || 'A phone';
    const loves = Object.values(state.inbox.loves).map(l => ({ ...l, device: deviceName(l.deviceId), track: nameOf(l.id) })).filter(l => l.track).sort((a, b) => b.at - a.at);
    const plays = state.inbox.plays.map(p => ({ ...p, device: deviceName(p.deviceId), track: nameOf(p.id) })).filter(p => p.track).sort((a, b) => b.playedAt - a.playedAt);
    return { loves, plays };
  }

  // Applies what the user chose: Love through the heart button's own path,
  // plays into Hive's listening history. What isn't chosen stays.
  async function applyInbox({ loves = true, plays = true } = {}) {
    const tracks = await getTracks();
    const byId = new Map(tracks.map(t => [trackIdFor(t), t]));
    let lovesApplied = 0, playsApplied = 0;
    if (loves) {
      for (const change of Object.values(state.inbox.loves)) {
        const track = byId.get(change.id);
        delete state.inbox.loves[change.id];
        if (!track || (!!track.loved === change.loved)) continue;
        const absolute = path.resolve(String(track.path));
        pendingOrigins.set(absolute, { origin: change.deviceId, at: change.at });
        try { await setLove(absolute, change.loved); lovesApplied++; } catch (err) { pendingOrigins.delete(absolute); log('Hive Link inbox Love failed', err?.message || String(err)); }
      }
    }
    if (plays && recordPlays) {
      const ready = state.inbox.plays.map(p => ({ ...p, track: byId.get(p.id) })).filter(p => p.track);
      state.inbox.plays = [];
      if (ready.length) { await recordPlays(ready); playsApplied = ready.length; }
    }
    inboxChanged();
    saveNow();
    return { lovesApplied, playsApplied, ...inboxSummary() };
  }

  function discardInbox({ loves = true, plays = true } = {}) {
    if (loves) state.inbox.loves = {};
    if (plays) state.inbox.plays = [];
    inboxChanged();
    saveNow();
    return inboxSummary();
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
        file: path.basename(String(t.path)),
        cover: /^[a-f0-9]{40}\.(jpe?g|png|webp)$/i.test(String(t.cover || '')) ? String(t.cover) : ''
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

    const device = authenticate(req, url);
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
      case 'POST /api/plays':
        return send(res, 200, stagePlays(device, (await readJson(req))?.plays));
      case 'GET /api/plays':
        return send(res, 200, await playsSince(num(url.searchParams.get('since'))));
      case 'GET /api/playlists':
        return send(res, 200, { playlists: await playlistsPayload() });
      case 'GET /api/remote':
        return remoteState(res);
      case 'POST /api/remote':
        return remoteCommand(res, await readJson(req));
      case 'GET /api/cover':
        return sendCover(res, String(url.searchParams.get('name') || ''));
      case 'GET /api/stream/track':
        return streamTrack(req, res, String(url.searchParams.get('id') || ''));
      case 'GET /api/stream/song':
        return streamExternalSong(req, res, url.searchParams);
      case 'GET /api/events':
        return openEvents(req, res, device);
      case 'POST /api/unpair':
        unpair(device.id);
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: 'Unknown endpoint.' });
    }
  }

  // ---- playlists (read only) -----------------------------------------------

  const COVER_FILE = /^[a-f0-9]{40}\.(jpe?g|png|webp)$/i;
  async function playlistsPayload() {
    if (!getPlaylists) return [];
    const lists = (await getPlaylists()) || [];
    const byPath = new Map((await getTracks()).filter(t => t?.path).map(t => [path.resolve(String(t.path)), t]));
    return lists.filter(p => p && !p.smart && Array.isArray(p.tracks)).map(p => {
      const kept = p.podcastEpisodes || {};
      const songs = p.tracks.map(entry => {
        const ref = String(entry || '');
        const stream = /^ytm:(apple|spotify):(.+)$/.exec(ref);
        if (stream) {
          const k = kept[ref] || {};
          return { kind: 'stream', key: `${stream[1] === 'apple' ? 'am' : 'sp'}:${stream[2]}`, title: text(k.title), artist: text(k.artist), album: text(k.album),
            duration: Math.round(num(k.duration) * 1000), cover: COVER_FILE.test(String(k.cover || '')) ? String(k.cover) : '' };
        }
        if (/^[a-z]+:/i.test(ref)) return null; // radio, podcasts and the like stay on the PC
        const track = byPath.get(path.resolve(ref));
        return track ? { kind: 'track', id: trackIdFor(track) } : null;
      }).filter(Boolean);
      return { id: String(p.id || ''), name: text(p.name) || 'Playlist', source: text(p.source), cover: COVER_FILE.test(String(p.cover || '')) ? String(p.cover) : '',
        artworkUrl: /^https:\/\//.test(String(p.artworkUrl || p.cover || '')) ? String(p.artworkUrl || p.cover) : '', updatedAt: num(p.updatedAt), songs };
    }).filter(p => p.id && p.songs.length);
  }

  // ---- remote control ------------------------------------------------------
  // Off until the user turns it on in Hive's settings: the phone then sees what
  // Hive is playing and can play/pause, skip, seek and set the volume.

  function setRemoteControl(on) { state.remoteControl = !!on; saveSoon(); }
  const remoteAllowed = () => !!remote && !!state.remoteControl;

  async function remoteState(res) {
    if (!remoteAllowed()) return send(res, 403, { error: 'Turn on remote control in Hive: Settings › Connections › Hive Mobile.' });
    const p = remote.state() || {};
    const track = p.track || null;
    let id = '';
    if (track?.path && !/^[a-z]+:/i.test(String(track.path))) {
      const wanted = path.resolve(String(track.path));
      const hit = (await getTracks()).find(t => t?.path && path.resolve(String(t.path)) === wanted);
      id = hit ? trackIdFor(hit) : '';
    }
    return send(res, 200, {
      playing: !!track && !p.paused,
      id,
      title: text(track?.title), artist: text(track?.artist), album: text(track?.album),
      cover: /^[a-f0-9]{40}\.(jpe?g|png|webp)$/i.test(String(track?.cover || '')) ? String(track.cover) : '',
      position: Math.round(num(p.position) * 1000), duration: Math.round(num(p.duration) * 1000),
      volume: Number.isFinite(Number(p.volume)) ? Number(p.volume) : 1,
      shuffle: !!p.shuffle, repeat: num(p.repeat)
    });
  }

  const REMOTE_COMMANDS = { play: 'PLAY', pause: 'PAUSE', toggle: 'PLAYPAUSE', next: 'NEXT', previous: 'PREVIOUS' };
  function remoteCommand(res, body) {
    if (!remoteAllowed()) return send(res, 403, { error: 'Turn on remote control in Hive: Settings › Connections › Hive Mobile.' });
    const cmd = String(body?.command || '');
    if (REMOTE_COMMANDS[cmd]) remote.command(REMOTE_COMMANDS[cmd]);
    else if (cmd === 'seek' && Number.isFinite(Number(body.positionMs))) remote.command(`SEEK\t${Math.max(0, Number(body.positionMs)) / 1000}`);
    else if (cmd === 'volume' && Number.isFinite(Number(body.volume))) remote.command(`VOLUME\t${Math.max(0, Math.min(1, Number(body.volume)))}`);
    else return send(res, 400, { error: 'Unknown command.' });
    return send(res, 200, { ok: true });
  }

  // ---- streaming -----------------------------------------------------------

  const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' };

  // A cover from Hive's covers folder; only plain cover file names, nothing else on disk.
  async function sendCover(res, name) {
    if (!coversDir || !/^[a-f0-9]{40}\.(jpe?g|png|webp)$/i.test(name)) return send(res, 404, { error: 'No such cover.' });
    const file = path.join(coversDir, name);
    let data;
    try { data = await fs.promises.readFile(file); } catch { return send(res, 404, { error: 'No such cover.' }); }
    const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=86400' });
    res.end(data);
  }

  // A library song's file, by its Hive Link id. Only files Hive lists are served.
  async function streamTrack(req, res, id) {
    const track = (await getTracks()).find(t => t && t.path && trackIdFor(t) === id);
    if (!track || /^[a-z]+:/i.test(String(track.path))) return send(res, 404, { error: 'No such song.' });
    const file = path.resolve(String(track.path));
    let size;
    try { size = (await fs.promises.stat(file)).size; } catch { return send(res, 404, { error: 'The file is gone.' }); }
    const type = AUDIO_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range || ''));
    let start = 0, end = size - 1;
    if (m) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(size - 1, Number(m[2])); }
      else if (m[2]) start = Math.max(0, size - Number(m[2]));
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    }
    res.writeHead(m ? 206 : 200, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    });
    const body = fs.createReadStream(file, { start, end });
    res.on('close', () => body.destroy());
    body.pipe(res);
  }

  // A song from Apple Music or Spotify that Hive doesn't have: found on
  // YouTube Music and streamed through Hive, so the phone needs nothing more.
  async function streamExternalSong(req, res, params) {
    if (!streamSong) return send(res, 404, { error: 'This Hive cannot stream songs it does not have.' });
    const song = {
      key: String(params.get('key') || ''), title: String(params.get('title') || ''), artist: String(params.get('artist') || ''),
      album: String(params.get('album') || ''), duration: num(params.get('duration'))
    };
    if (!/^(am|sp):[A-Za-z0-9._-]{1,64}$/.test(song.key) || !song.title) return send(res, 400, { error: 'Which song?' });
    let r;
    try { r = await streamSong(song, req.headers.range || ''); }
    catch (err) { return send(res, 502, { error: err?.message || String(err) }); }
    res.writeHead(r.status || 206, r.headers || {});
    const body = r.body && typeof r.body.getReader === 'function' ? Readable.fromWeb(r.body) : r.body;
    if (!body) return res.end();
    res.on('close', () => { try { body.destroy(); } catch {} });
    body.on('error', () => { try { res.destroy(); } catch {} });
    body.pipe(res);
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
    setRemoteControl,
    remoteControl: () => !!state.remoteControl,
    unpair,
    notifyLoveChanged,
    info,
    inbox,
    inboxSummary,
    applyInbox,
    discardInbox,
    devices: () => state.devices.map(({ tokenHash, ...rest }) => rest)
  };
}

module.exports = { createHiveLink, trackIdFor, DEFAULT_PORT, DISCOVERY_PORT, PROTOCOL_VERSION };
