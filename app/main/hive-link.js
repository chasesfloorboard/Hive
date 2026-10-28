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
//   GET  /api/spotify/search?q=    Spotify search through this PC's signed-in Spotify app
//   GET  /api/events               server-sent events (live Love changes)
//   GET  /api/stream/track?id=     a library song's file, with Range support
//   GET  /api/playlists            Hive's own playlists, read only: library songs by
//                                  id, Apple Music and Spotify songs as Hive keeps them
//   GET  /api/themes               Hive's themes, and the one it shows now (current)
//   GET  /api/remote               what Hive is playing (when remote control is on)
//   POST /api/remote               play/pause, next, previous, seek, volume
//   GET  /api/cover?name=          a library cover from Hive's covers folder
//                                  (the token may come as ?t= so any image
//                                  loader on the phone can fetch it)
//   GET  /api/stream/song?key=…    a song Hive doesn't have (Apple Music,
//                                  Spotify), streamed from YouTube Music
//                                  through Hive, as Hive itself plays them
//   GET  /api/wrap/years           years Hive has a Yearly Wrap for
//   GET  /api/wrap?year=           one year's Wrap, exactly as Hive shows it
//                                  (Hive's plays, imports and the phone's), so
//                                  the phone shows the same numbers
//   PUT  /api/songs?title=…        a song file from the phone that Hive doesn't
//                                  have (song sync): saved into the library
//                                  as <Artist>/<Album>/, unless Hive already
//                                  has the same song or receiving is off.
//                                  &replaces=<id> (trusted phones only): a better
//                                  copy of that song (a Soulseek download for a
//                                  YouTube one); the old file goes to the Trash
//   POST /api/songs/delete         songs the user deleted on the phone and chose
//                                  to delete here too (trusted phones only):
//                                  to the Trash, recoverable; only mod files
//                                  and extra copies whose original stays
//   POST /api/songs/tags           tags edited on the phone (trusted phones only):
//                                  {edits:[{id, tags}]}, written into Hive's files
//                                  through the tag editor's own save queue
//   PUT  /api/songs/cover?ids=…    a cover chosen on the phone (trusted phones
//                                  only), the image as the body, written as
//                                  the front cover of those songs
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
// With acceptPhonePlays, phone plays skip the inbox and count at once (each
// play's id is remembered, so a resend never counts twice); Love still waits.

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const zlib = require('zlib');
const { createIndex, normalize, artistParts } = require('./song-match');

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 47800;
const DISCOVERY_PORT = 47801;
const DISCOVERY_REQUEST = 'HIVELINK_DISCOVER';
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const PAIR_REQUEST_TTL_MS = 2 * 60 * 1000;
const MAX_EVENTS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_COVER_BYTES = 20 * 1024 * 1024;
// The tags a phone may edit in Hive's files: the tag editor's own field names.
const EDITABLE_TAGS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'track', 'disk', 'lyrics'];
const MAX_INBOX_PLAYS = 50000;
const MAX_COUNTED_PLAY_IDS = 100000;
const MAX_SONG_BYTES = 1024 * 1024 * 1024;
const SONG_EXTENSIONS = new Set(['mp3', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'wav', 'aiff', 'aif', 'wv', 'ape', 'wma', 'alac']);

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

// Game mod audio (Elden Ring, the Nurse Harrow mod) that landed in a music folder: not music.
const NOT_MUSIC = /elden\s*ring|nurse\s*harrow/i;
const isNotMusic = t => NOT_MUSIC.test([t?.path, t?.title, t?.artist, t?.album].map(text).join(' '));

/**
 * The tracks a phone may delete without losing music: mod files, and extra
 * copies of a song whose original stays (another file of the same song, as
 * old or older, still on disk). A song's only copy is never deleted for the
 * phone, whatever it asks.
 */
/** The same song by name: the same title and a shared artist, whatever the lengths. */
function sameTitleAndArtist(a, b) {
  if (!normalize(a.title) || normalize(a.title) !== normalize(b.title)) return false;
  const mine = artistParts(text(a.albumArtist) || text(a.artist));
  return [...artistParts(text(b.albumArtist) || text(b.artist))].some(x => mine.has(x));
}

async function deletableTracks(wanted, all) {
  const mtime = async p => { try { return (await fs.promises.stat(p)).mtimeMs; } catch { return null; } };
  const sameSong = (a, b) => {
    if (Math.abs(num(a.duration) - num(b.duration)) > 2) return false;
    if (num(a.fileSize) > 0 && num(a.fileSize) === num(b.fileSize)) return true;
    if (!normalize(a.title) || normalize(a.title) !== normalize(b.title)) return false;
    const mine = artistParts(text(a.albumArtist) || text(a.artist));
    return [...artistParts(text(b.albumArtist) || text(b.artist))].some(x => mine.has(x));
  };
  const going = new Set(wanted.map(t => path.resolve(String(t.path))));
  const out = [];
  for (const t of wanted) {
    if (isNotMusic(t)) { out.push(t); continue; }
    const own = await mtime(path.resolve(String(t.path)));
    if (own === null) continue;
    let kept = false;
    for (const o of all) {
      const p = o?.path && !/^[a-z]+:/i.test(String(o.path)) ? path.resolve(String(o.path)) : null;
      if (!p || going.has(p) || !sameSong(t, o)) continue;
      const theirs = await mtime(p);
      if (theirs !== null && theirs <= own) { kept = true; break; }
    }
    if (kept) out.push(t);
  }
  return out;
}

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

function createHiveLink({ dataDir, getTracks, setLove, onPaired, streamSong = null, coversDir = null, remote = null, getPlaylists = null, getPlays = null, recordPlays = null, spotifySearch = null, songTarget = null, onSongAdded = () => {}, acceptPhonePlays = false, getWrap = null, getWrapYears = null, getThemes = null, getCurrentTheme = null, onPairRequest = null, deleteSongs = null, editSongs = null, getStreamLoves = null, applyStreamLoves = null, onInbox = () => {}, log = () => {}, port = DEFAULT_PORT, discoveryPort = DISCOVERY_PORT, acceptPhoneChanges = false }) {
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
        // A phone that has been syncing (seen well after it paired) has synced with this Hive
        // before: its changes are trusted from now on (see trusted()).
        devices: (Array.isArray(raw.devices) ? raw.devices : []).map(d => d.trusted === undefined && num(d.lastSeen) - num(d.pairedAt) > 60_000 ? { ...d, trusted: true } : d),
        seq: num(raw.seq),
        events: Array.isArray(raw.events) ? raw.events : [],
        lastChangeAt: raw.lastChangeAt && typeof raw.lastChangeAt === 'object' ? raw.lastChangeAt : {},
        remoteControl: !!raw.remoteControl,
        receiveSongs: raw.receiveSongs !== false,
        countedPlays: Array.isArray(raw.countedPlays) ? raw.countedPlays.map(String).slice(-MAX_COUNTED_PLAY_IDS) : [],
        inbox: cleanInbox(raw.inbox)
      };
    } catch {
      return { serverId: crypto.randomUUID(), devices: [], seq: 0, events: [], lastChangeAt: {}, receiveSongs: true, countedPlays: [], inbox: cleanInbox(null) };
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
      // Plays go both ways: the phone sends its own when Hive can record them,
      // and fetches Hive's when Hive shares them.
      plays: !!getPlays || !!recordPlays,
      spotifySearch: !!spotifySearch,
      // Song sync: whether Hive takes song files from the phone.
      songs: { receive: !!songTarget && state.receiveSongs },
      wrap: !!getWrap,
      themes: !!getThemes,
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
    return { status: 200, body: addDevice(body?.deviceName) };
  }

  function addDevice(deviceName) {
    const token = crypto.randomBytes(32).toString('base64url');
    const device = {
      id: crypto.randomUUID(),
      name: String(deviceName || 'Phone').slice(0, 80),
      tokenHash: sha256(token),
      pairedAt: Date.now(),
      lastSeen: Date.now()
    };
    state.devices.push(device);
    saveNow();
    try { onPaired?.(device); } catch {}
    return { token, deviceId: device.id, serverId: state.serverId, name: serverName(), seq: state.seq };
  }

  // Connecting without a code: a phone on the same network asks, and the
  // person at the PC allows or refuses it once (onPairRequest asks them).
  // The phone polls with the request's secret until it has an answer.
  const pairRequests = new Map(); // id -> { id, secret, name, status, result, expiresAt }
  function requestPairing(body) {
    if (!onPairRequest) return { status: 404, body: { error: 'This Hive only pairs with a code.' } };
    const now = Date.now();
    for (const [id, r] of pairRequests) if (r.expiresAt < now) pairRequests.delete(id);
    const name = String(body?.deviceName || 'Phone').slice(0, 80);
    // One question at a time, so a device on the network can't flood the PC with prompts.
    if ([...pairRequests.values()].some(r => r.status === 'pending')) return { status: 429, body: { error: 'Hive is already asking about another device.' } };
    const r = { id: crypto.randomUUID(), secret: crypto.randomBytes(24).toString('base64url'), name, status: 'pending', result: null, expiresAt: now + PAIR_REQUEST_TTL_MS };
    pairRequests.set(r.id, r);
    Promise.resolve().then(() => onPairRequest({ id: r.id, name })).then(allow => answerPairRequest(r.id, !!allow)).catch(() => answerPairRequest(r.id, false));
    return { status: 202, body: { requestId: r.id, secret: r.secret, expiresAt: r.expiresAt } };
  }

  function answerPairRequest(id, allow) {
    const r = pairRequests.get(id);
    if (!r || r.status !== 'pending') return false;
    // An answer after the phone gave up pairs nothing.
    if (r.expiresAt < Date.now()) { pairRequests.delete(id); return false; }
    r.status = allow ? 'allowed' : 'refused';
    if (allow) r.result = addDevice(r.name);
    return true;
  }

  function pairRequestStatus(url) {
    const r = pairRequests.get(String(url.searchParams.get('id') || ''));
    const secret = String(url.searchParams.get('secret') || '');
    if (!r || secret.length !== r.secret.length || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(r.secret))) return { status: 404, body: { error: 'No such request.' } };
    if (r.status === 'allowed') { pairRequests.delete(r.id); return { status: 200, body: { status: 'allowed', ...r.result } }; }
    if (r.status === 'refused') { pairRequests.delete(r.id); return { status: 403, body: { status: 'refused', error: 'Hive on the PC refused this phone.' } }; }
    if (r.expiresAt < Date.now()) { pairRequests.delete(r.id); return { status: 410, body: { status: 'expired', error: 'Nobody answered on the PC.' } }; }
    return { status: 200, body: { status: 'pending' } };
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

  /** Whether a phone's changes apply by themselves (trusted) or wait in the inbox. */
  function setTrusted(deviceId, on) {
    const device = state.devices.find(d => d.id === deviceId);
    if (!device) return false;
    device.trusted = !!on;
    saveNow();
    return true;
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

  // A phone whose changes were accepted here before (applied from the inbox, or one
  // that has been syncing all along) has its changes applied at once; a new phone's
  // wait in the inbox for the first time.
  function trusted(device) {
    if (acceptPhoneChanges) return true;
    const id = typeof device === 'string' ? device : device?.id;
    return !!state.devices.find(d => d.id === id)?.trusted;
  }

  async function applyLoveChanges(device, changes) {
    if (!trusted(device)) {
      // Kept for the user to confirm in Hive; the newest change per song wins.
      // The phone keeps resending a change until it's settled, so each answer
      // says where it stands: still waiting ("staged"), done ("unchanged",
      // after the user applied it), or overruled ("stale", after the user
      // discarded it or changed the song in Hive since), with Hive's state.
      const tracks = await getTracks();
      const byId = new Map(tracks.map(t => [trackIdFor(t), t]));
      const results = [];
      let staged = 0;
      for (const c of Array.isArray(changes) ? changes.slice(0, 500) : []) {
        const id = String(c?.id || '');
        const key = c?.clientChangeId ?? null;
        const track = byId.get(id);
        if (!track) { results.push({ clientChangeId: key, id, status: 'not-found' }); continue; }
        const at = num(c?.at) || Date.now();
        const loved = !!c.loved;
        const pcLoved = track.loved === true || track.loved === 'True';
        const waiting = state.inbox.loves[id];
        if (pcLoved === loved && !waiting) { results.push({ clientChangeId: key, id, status: 'unchanged', loved }); continue; }
        if (num(state.lastChangeAt[id]) >= at) {
          results.push({ clientChangeId: key, id, status: 'stale', loved: pcLoved, at: state.lastChangeAt[id] });
          continue;
        }
        if (!waiting || waiting.at <= at) { state.inbox.loves[id] = { id, loved, at, deviceId: device.id }; staged++; }
        results.push({ clientChangeId: key, id, status: 'staged' });
      }
      if (staged) inboxChanged();
      return { seq: state.seq, results };
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
  // Counted at once (acceptPhonePlays): resolved to library songs and handed
  // to Hive's listening history. A play whose song Hive doesn't have comes
  // back as "unknown" for the phone to keep and send again later.
  const countedPlayIds = new Set(state.countedPlays);
  async function countPlays(device, plays) {
    const tracks = await getTracks();
    const byId = new Map(tracks.map(t => [trackIdFor(t), t]));
    const ready = [], unknown = [];
    for (const p of Array.isArray(plays) ? plays.slice(0, 5000) : []) {
      const clientId = String(p?.clientId ?? '');
      const playedAt = num(p?.playedAt);
      const key = `${device.id}:${clientId}`;
      if (!clientId || !playedAt || countedPlayIds.has(key)) continue;
      const track = byId.get(String(p?.id || ''));
      if (!track) { unknown.push(clientId); continue; }
      ready.push({ id: trackIdFor(track), playedAt, listenedMs: Math.max(0, num(p?.listenedMs)), deviceId: device.id, clientId, track });
    }
    if (ready.length) {
      await recordPlays(ready);
      for (const p of ready) { const key = `${device.id}:${p.clientId}`; countedPlayIds.add(key); state.countedPlays.push(key); }
      if (state.countedPlays.length > MAX_COUNTED_PLAY_IDS) state.countedPlays.splice(0, state.countedPlays.length - MAX_COUNTED_PLAY_IDS);
      saveSoon();
    }
    return { staged: 0, counted: ready.length, unknown };
  }

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
    // Applying a phone's changes trusts it: next time they apply by themselves.
    const from = new Set([...(loves ? Object.values(state.inbox.loves).map(l => l.deviceId) : []), ...(plays ? state.inbox.plays.map(p => p.deviceId) : [])]);
    for (const d of state.devices) if (from.has(d.id)) d.trusted = true;
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
    if (loves) {
      // Hive's state is the decision now: the phone's resend of a discarded
      // change is answered "stale" and the phone takes Hive's state back.
      for (const change of Object.values(state.inbox.loves)) {
        state.lastChangeAt[change.id] = Math.max(num(state.lastChangeAt[change.id]), change.at);
      }
      state.inbox.loves = {};
    }
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
        size: num(t.fileSize),
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
    if (route === 'POST /api/pair/request') return (r => send(res, r.status, r.body))(requestPairing(await readJson(req)));
    if (route === 'GET /api/pair/request') return (r => send(res, r.status, r.body))(pairRequestStatus(url));

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
      // Likes for streamed songs, shared with the phone (see stream-loves.js).
      // A phone whose changes wait in the inbox sees them but can't change them yet.
      case 'GET /api/streamloves':
        if (!getStreamLoves) return send(res, 404, { error: 'Not found' });
        return send(res, 200, { loves: await getStreamLoves() });
      case 'POST /api/streamloves': {
        if (!getStreamLoves || !applyStreamLoves) return send(res, 404, { error: 'Not found' });
        const changes = (await readJson(req))?.changes;
        if (!trusted(device)) return send(res, 200, { loves: await getStreamLoves(), applied: false });
        return send(res, 200, { loves: await applyStreamLoves(Array.isArray(changes) ? changes : []), applied: true });
      }
      case 'POST /api/plays': {
        const plays = (await readJson(req))?.plays;
        return send(res, 200, acceptPhonePlays && recordPlays ? await countPlays(device, plays) : stagePlays(device, plays));
      }
      case 'GET /api/themes':
        if (!getThemes) return send(res, 404, { error: 'This Hive shares no themes.' });
        return send(res, 200, { themes: await getThemes(), current: getCurrentTheme ? await getCurrentTheme() : null });
      case 'GET /api/wrap/years':
        if (!getWrapYears) return send(res, 404, { error: 'This Hive has no Yearly Wrap.' });
        return send(res, 200, { years: await getWrapYears() });
      case 'GET /api/wrap': {
        if (!getWrap) return send(res, 404, { error: 'This Hive has no Yearly Wrap.' });
        return send(res, 200, wrapForPhone(await getWrap(num(url.searchParams.get('year')) || new Date().getFullYear())));
      }
      case 'GET /api/plays':
        return send(res, 200, await playsSince(num(url.searchParams.get('since'))));
      case 'GET /api/spotify/search': {
        if (!spotifySearch) return send(res, 404, { error: 'This Hive cannot search Spotify.' });
        const r = await spotifySearch(String(url.searchParams.get('q') || '').slice(0, 200));
        if (!r?.connected) return send(res, 503, { error: "Spotify isn't running on the PC." });
        if (r.error || !r.data) return send(res, 502, { error: r.error || 'Spotify did not answer.' });
        return send(res, 200, r.data);
      }
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
      case 'PUT /api/songs':
        return receiveSong(req, res, url.searchParams, device);
      case 'POST /api/songs/delete': {
        // Only a phone already trusted here may delete, and only songs of the library, by id.
        if (!deleteSongs) return send(res, 404, { error: "This Hive doesn't delete songs for the phone." });
        if (!trusted(device)) return send(res, 403, { error: 'Apply this phone\'s changes in Hive once (Settings › Connections) before it can delete songs there.' });
        const body = await readJson(req);
        const wanted = new Set((Array.isArray(body?.ids) ? body.ids : []).slice(0, 2000).map(String));
        const all = await getTracks();
        const asked = all.filter(t => t?.path && !/^[a-z]+:/i.test(String(t.path)) && wanted.has(trackIdFor(t)));
        const tracks = await deletableTracks(asked, all);
        const result = tracks.length ? await deleteSongs(tracks.map(t => path.resolve(String(t.path))), device.name) : { deleted: [], errors: [] };
        const gone = new Set((result?.deleted || []).map(p => path.resolve(p)));
        log('Hive Link: phone deleted songs', device.name, gone.size, 'kept', asked.length - tracks.length);
        return send(res, 200, { deleted: tracks.filter(t => gone.has(path.resolve(String(t.path)))).map(trackIdFor), failed: (result?.errors || []).length, kept: asked.filter(t => !tracks.includes(t)).map(trackIdFor) });
      }
      case 'POST /api/songs/tags': {
        // Only fields the tag editor itself writes, only library songs, only from a trusted phone.
        if (!editSongs) return send(res, 404, { error: "This Hive doesn't take tag edits from the phone." });
        if (!trusted(device)) return send(res, 403, { error: 'Apply this phone\'s changes in Hive once (Settings › Connections) before it can edit songs there.' });
        const body = await readJson(req);
        const byId = new Map((await getTracks()).filter(t => t?.path && !/^[a-z]+:/i.test(String(t.path))).map(t => [trackIdFor(t), t]));
        const edits = [];
        for (const e of (Array.isArray(body?.edits) ? body.edits : []).slice(0, 2000)) {
          const t = byId.get(String(e?.id || ''));
          const tags = {};
          for (const k of EDITABLE_TAGS) if (e?.tags && Object.prototype.hasOwnProperty.call(e.tags, k)) tags[k] = text(e.tags[k]).slice(0, k === 'lyrics' ? 200_000 : 500);
          if (t && Object.keys(tags).length) edits.push({ path: path.resolve(String(t.path)), tags, id: trackIdFor(t) });
        }
        if (edits.length) await editSongs(edits.map(({ path: p, tags }) => ({ path: p, tags })), null, device.name);
        log('Hive Link: phone edited tags', device.name, edits.length);
        return send(res, 200, { edited: edits.map(e => e.id) });
      }
      case 'PUT /api/songs/cover':
        return receiveCover(req, res, url.searchParams, device);
      case 'POST /api/unpair':
        unpair(device.id);
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: 'Unknown endpoint.' });
    }
  }

  // ---- Yearly Wrap ---------------------------------------------------------
  // Hive's Wrap as is, minus the recent-plays list; covers become names the
  // phone fetches from /api/cover (or https addresses, passed through).
  function wrapCover(value) {
    const v = String(value || '');
    if (/^https:\/\//i.test(v)) return v;
    const name = path.basename(v.replace(/^mbcover:\/\/+/i, '').split(/[?#]/)[0]);
    return COVER_FILE.test(name) ? name : '';
  }
  function wrapForPhone(w) {
    const { rows, ...rest } = w || {};
    return {
      ...rest,
      topTrack: rest.topTrack ? { ...rest.topTrack, cover: wrapCover(rest.topTrack.cover) } : null,
      topArtists: (rest.topArtists || []).map(a => ({ ...a, cover: wrapCover(a.cover) })),
      topAlbums: (rest.topAlbums || []).map(a => ({ ...a, cover: wrapCover(a.cover) }))
    };
  }

  // ---- song sync: files from the phone ------------------------------------
  // The phone sends songs Hive doesn't have. Hive checks again with its own
  // copy of the phone's matcher (a stale phone view must not make duplicates),
  // asks main.js where the song goes in the library, writes it to a hidden
  // part file beside it and renames it into place, so the library watcher and
  // a half-sent song never meet.

  function setReceiveSongs(on) { state.receiveSongs = !!on; saveSoon(); }

  // A cover picked on the phone, for songs of the library by id: held in a
  // temp file while the tag editor's save queue writes it into each one.
  async function receiveCover(req, res, params, device) {
    const refuse = (status, error) => { req.resume(); return send(res, status, { error }); };
    if (!editSongs) return refuse(404, "This Hive doesn't take covers from the phone.");
    if (!trusted(device)) return refuse(403, 'Apply this phone\'s changes in Hive once (Settings › Connections) before it can change covers there.');
    const size = Number(req.headers['content-length']);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_COVER_BYTES) return refuse(413, 'That picture is too big for a cover.');
    const wanted = new Set(String(params.get('ids') || '').split(',').filter(Boolean).slice(0, 2000));
    const songs = (await getTracks()).filter(t => t?.path && !/^[a-z]+:/i.test(String(t.path)) && wanted.has(trackIdFor(t)));
    if (!songs.length) return refuse(404, 'Hive has none of those songs.');
    const chunks = []; let got = 0;
    try {
      await new Promise((resolve, reject) => {
        req.on('data', c => { got += c.length; if (got > size) { reject(new Error('More than promised.')); req.destroy(); } else chunks.push(c); });
        req.on('end', resolve); req.on('error', reject);
      });
    } catch (err) { return send(res, 400, { error: err.message }); }
    const image = Buffer.concat(chunks);
    const ext = image[0] === 0x89 && image[1] === 0x50 ? 'png' : image[0] === 0xff && image[1] === 0xd8 ? 'jpg' : '';
    if (!ext) return send(res, 415, { error: 'The cover must be a JPEG or PNG picture.' });
    const file = path.join(os.tmpdir(), `hive-link-cover-${crypto.randomUUID()}.${ext}`);
    fs.writeFileSync(file, image);
    try { await editSongs(songs.map(t => ({ path: path.resolve(String(t.path)) })), file, device.name); }
    finally { fs.rm(file, { force: true }, () => {}); }
    log('Hive Link: phone changed a cover', device.name, songs.length);
    return send(res, 200, { edited: songs.map(trackIdFor) });
  }

  async function receiveSong(req, res, params, device) {
    const refuse = (status, error) => { req.resume(); return send(res, status, { error }); };
    if (!songTarget || !state.receiveSongs) return refuse(403, "Hive isn't taking songs from the phone. Turn it on in Settings → Connections.");
    const ext = String(params.get('ext') || '').toLowerCase().replace(/^\./, '');
    if (!SONG_EXTENSIONS.has(ext)) return refuse(415, 'That is not a song file Hive plays.');
    const size = Number(req.headers['content-length']);
    if (!Number.isFinite(size) || size <= 0) return refuse(411, 'The song needs its length.');
    if (size > MAX_SONG_BYTES) return refuse(413, 'That file is too big for a song.');
    const meta = {
      title: text(params.get('title')).slice(0, 300), artist: text(params.get('artist')).slice(0, 300),
      albumArtist: text(params.get('albumArtist')).slice(0, 300), album: text(params.get('album')).slice(0, 300),
      track: num(params.get('track')), disc: num(params.get('disc')), year: text(params.get('year')).slice(0, 10),
      durationMs: num(params.get('duration')), ext
    };
    if (!meta.title) return refuse(400, 'The song needs a title.');
    const library = (await getTracks()).filter(t => t?.path && !/^[a-z]+:/i.test(String(t.path)));
    // A better copy of a song Hive has: the old one makes way, but only for a
    // trusted phone and only the same song (a phone can't trash an unrelated file this way).
    const replaces = text(params.get('replaces'));
    let old = null;
    if (replaces) {
      if (!deleteSongs) return refuse(404, "This Hive doesn't replace songs for the phone.");
      if (!trusted(device)) return refuse(403, 'Apply this phone\'s changes in Hive once (Settings › Connections) before it can replace songs there.');
      old = library.find(t => trackIdFor(t) === replaces) || null;
      if (!old) return refuse(404, 'Hive no longer has the copy this song replaces.');
      if (!sameTitleAndArtist(old, meta)) return refuse(409, 'That is a different song from the one it replaces.');
    }
    const tracks = old ? library.filter(t => t !== old) : library;
    const retire = async () => {
      if (!old) return false;
      const result = await deleteSongs([path.resolve(String(old.path))], device.name);
      const gone = (result?.deleted || []).some(p => path.resolve(p) === path.resolve(String(old.path)));
      log('Hive Link: phone replaced a song', device.name, String(old.path), gone ? 'old copy to the Trash' : 'old copy kept');
      return gone;
    };
    const index = createIndex(tracks.map(t => ({ key: trackIdFor(t), title: text(t.title), artist: text(t.artist), albumArtist: text(t.albumArtist), durationMs: Math.round(num(t.duration) * 1000) })));
    // A phone keeping its songs one to one with Hive says how many copies of this
    // song Hive already holds for its other files ("have"): one more is a new
    // version to keep. Without it, any copy of the song means Hive has it.
    const have = params.has('have') ? num(params.get('have')) : null;
    // An exact copy of a file Hive has (same size to the byte, same length) is that file, whatever its tags say.
    const twin = tracks.find(t => num(t.fileSize) === size && Math.abs(Math.round(num(t.duration) * 1000) - meta.durationMs) <= 2000);
    const existing = twin ? { key: trackIdFor(twin) } : have === null ? index.match(meta) : (index.matches(meta).length > have ? index.match(meta) : null);
    if (existing) {
      req.resume();
      // Hive already has the better copy: only the old one goes.
      if (old) return send(res, 200, { status: (await retire()) ? 'replaced' : 'exists', id: existing.key });
      return send(res, 200, { status: 'exists', id: existing.key });
    }
    let target;
    try { target = await songTarget(meta); } catch (err) { return refuse(507, err?.message || String(err)); }
    const part = path.join(path.dirname(target), `.${path.basename(target)}.hivelink-part`);
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      let received = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part, { flags: 'wx' });
        req.on('data', chunk => {
          received += chunk.length;
          if (received > size) { req.destroy(); out.destroy(); reject(new Error('More data than the song length.')); }
        });
        req.on('close', () => { if (!req.complete) { out.destroy(); reject(new Error('The phone stopped sending.')); } });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
      if (received !== size) throw new Error('The song arrived incomplete.');
      // The new copy is all here: the old one goes first, so the new one can take its name.
      const replaced = await retire();
      // The target may have appeared meanwhile (another phone, a download):
      // never overwrite a file.
      let final = target;
      for (let n = 2; fs.existsSync(final); n += 1) final = target.replace(/(\.[^.\/]+)$/, ` (${n})$1`);
      await fs.promises.rename(part, final);
      log(`Hive Link: song from ${device.name} saved`, final);
      try { await onSongAdded(final); } catch (err) { log('Hive Link song-added hook failed', err?.message || String(err)); }
      return send(res, 200, { status: replaced ? 'replaced' : 'saved' });
    } catch (err) {
      try { await fs.promises.unlink(part); } catch {}
      if (res.headersSent || res.destroyed) return;
      return send(res, 500, { error: err?.message || String(err) });
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
    // Changes a trusted phone left waiting (from before it was trusted) go in now.
    if (Object.values(state.inbox.loves).some(l => trusted(l.deviceId)) || state.inbox.plays.some(p => trusted(p.deviceId))) {
      setTimeout(() => applyInbox().catch(err => log('Hive Link inbox apply failed', err?.message || String(err))), 2000);
    }
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
    answerPairRequest,
    setTrusted,
    setRemoteControl,
    remoteControl: () => !!state.remoteControl,
    setReceiveSongs,
    receiveSongs: () => !!state.receiveSongs,
    unpair,
    notifyLoveChanged,
    // Streamed-song likes changed here: phones fetch them again.
    notifyStreamLoves: () => broadcast('streamloves', { at: Date.now() }),
    info,
    inbox,
    inboxSummary,
    applyInbox,
    discardInbox,
    devices: () => state.devices.map(({ tokenHash, ...rest }) => rest)
  };
}

module.exports = { createHiveLink, trackIdFor, DEFAULT_PORT, DISCOVERY_PORT, PROTOCOL_VERSION };
