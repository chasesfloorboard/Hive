'use strict';
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function md5(value) { return crypto.createHash('md5').update(String(value), 'utf8').digest('hex'); }
function clean(value) { return String(value ?? '').trim(); }

function lastFmSignature(params, secret) {
  const body = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null && k !== 'format' && k !== 'callback').sort()
    .map(k => `${k}${params[k]}`).join('');
  return md5(body + secret);
}

async function postForm(url, params, headers = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) body.set(key, String(value));
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Hive/1.0.0 (scrobbling)', ...headers },
    body: body.toString()
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Scrobble request failed (${response.status})`);
  return text;
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Hive/1.0.0 (scrobbling)', ...headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Scrobble request failed (${response.status})`);
  try { return JSON.parse(text); } catch { throw new Error('Scrobble service returned invalid JSON.'); }
}

class ScrobblingService {
  constructor(readConfig, writeConfig, { userData } = {}) {
    this.readConfig = readConfig;
    this.writeConfig = writeConfig;
    this.userData = typeof userData === 'function' ? userData : () => String(userData || '');
    this.cachePath = path.join(this.userData(), 'scrobble-queue.json');
    this.cacheLoaded = false;
    this.pending = [];
    this.flushPromise = null;
    this.lastFmSession = null;
    this.current = null;
    this.lastNowPlayingKey = '';
    this.lastSubmittedKey = '';
    setImmediate(() => { void this.loadCache().then(() => this.flushPending()).catch(() => {}); });
  }

  async loadCache() {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.cachePath, 'utf8'));
      this.pending = Array.isArray(parsed?.items) ? parsed.items.filter(item => item && item.id && item.service && item.metadata && item.timestamp) : [];
    } catch { this.pending = []; }
  }

  async saveCache() {
    await fsp.mkdir(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
    if (!this.pending.length) {
      try { await fsp.rm(this.cachePath, { force: true }); } catch {}
      return;
    }
    const tmp = `${this.cachePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, items: this.pending }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, this.cachePath);
  }

  async config() {
    const cfg = await this.readConfig();
    return {
      enabled: !!cfg?.scrobbling?.enabled,
      thresholdPercent: Math.max(1, Math.min(100, Number(cfg?.scrobbling?.thresholdPercent) || 50)),
      thresholdSeconds: Math.max(30, Math.min(3600, Number(cfg?.scrobbling?.thresholdSeconds) || 240)),
      includePodcasts: !!cfg?.scrobbling?.includePodcasts,
      listenbrainz: { enabled: !!cfg?.scrobbling?.listenbrainz?.enabled, token: clean(cfg?.scrobbling?.listenbrainz?.token) },
      lastfm: { enabled: !!cfg?.scrobbling?.lastfm?.enabled, apiKey: clean(cfg?.scrobbling?.lastfm?.apiKey), sharedSecret: clean(cfg?.scrobbling?.lastfm?.sharedSecret), sessionKey: clean(cfg?.scrobbling?.lastfm?.sessionKey) }
    };
  }

  async save(patch = {}) {
    const cfg = await this.readConfig();
    const current = cfg?.scrobbling || {};
    const next = {
      ...current,
      enabled: patch.enabled == null ? !!current.enabled : !!patch.enabled,
      thresholdPercent: Math.max(1, Math.min(100, Number(patch.thresholdPercent ?? current.thresholdPercent) || 50)),
      thresholdSeconds: Math.max(30, Math.min(3600, Number(patch.thresholdSeconds ?? current.thresholdSeconds) || 240)),
      includePodcasts: patch.includePodcasts == null ? !!current.includePodcasts : !!patch.includePodcasts,
      listenbrainz: { ...(current.listenbrainz || {}), ...(patch.listenbrainz || {}) },
      lastfm: { ...(current.lastfm || {}), ...(patch.lastfm || {}) }
    };
    if (patch.listenbrainz?.token != null && clean(patch.listenbrainz.token)) next.listenbrainz.token = clean(patch.listenbrainz.token);
    if (patch.lastfm?.apiKey != null && clean(patch.lastfm.apiKey)) next.lastfm.apiKey = clean(patch.lastfm.apiKey);
    if (patch.lastfm?.sharedSecret != null && clean(patch.lastfm.sharedSecret)) next.lastfm.sharedSecret = clean(patch.lastfm.sharedSecret);
    if (patch.lastfm?.sessionKey != null && clean(patch.lastfm.sessionKey)) next.lastfm.sessionKey = clean(patch.lastfm.sessionKey);
    await this.writeConfig({ ...cfg, scrobbling: next });
    return await this.config();
  }

  async beginLastFmAuth() {
    const cfg = await this.config();
    if (!cfg.lastfm.apiKey || !cfg.lastfm.sharedSecret) throw new Error('Enter a Last.fm API key and shared secret first.');
    const data = await getJson(`https://ws.audioscrobbler.com/2.0/?method=auth.getToken&api_key=${encodeURIComponent(cfg.lastfm.apiKey)}&format=json`);
    const token = clean(data?.token);
    if (!token) throw new Error(data?.message || 'Last.fm did not return an authorization token.');
    const authUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(cfg.lastfm.apiKey)}&token=${encodeURIComponent(token)}`;
    this.lastFmSession = { token, createdAt: Date.now() };
    return { url: authUrl, token };
  }

  async finishLastFmAuth() {
    const cfg = await this.config();
    const token = clean(this.lastFmSession?.token);
    if (!token) throw new Error('Start Last.fm authorization in Hive first.');
    const params = { method: 'auth.getSession', api_key: cfg.lastfm.apiKey, token, format: 'json' };
    params.api_sig = lastFmSignature(params, cfg.lastfm.sharedSecret);
    const data = await getJson('https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams(params).toString());
    const key = clean(data?.session?.key);
    if (!key) throw new Error(data?.message || 'Last.fm authorization was not completed.');
    const result = await this.save({ lastfm: { sessionKey: key, enabled: true } });
    this.lastFmSession = null;
    return result;
  }

  trackStarted(track) {
    this.current = { key: this.trackKey(track), track, startedAt: Date.now(), submitted: false };
    this.lastNowPlayingKey = '';
    this.lastSubmittedKey = '';
  }

  trackKey(track) { return [track?.source, track?.path, track?.spotifyUri, track?.streamUrl, track?.title, track?.artist, track?.album].map(clean).join('|'); }

  metadata(track) {
    const artist = clean(track?.artist || track?.albumArtist || 'Unknown Artist');
    const title = clean(track?.title || 'Unknown Track');
    const album = clean(track?.album);
    const additional = {};
    const recording = clean(track?.musicBrainzRecordingId || track?.musicbrainz_recordingid || track?.MUSICBRAINZ_TRACKID);
    const release = clean(track?.musicBrainzReleaseId || track?.musicbrainz_albumid || track?.MUSICBRAINZ_ALBUMID);
    const artistMbid = clean(track?.musicBrainzArtistId || track?.musicbrainz_artistid);
    if (recording) additional.recording_mbid = recording;
    if (release) additional.release_mbid = release;
    if (artistMbid) additional.artist_mbids = [artistMbid];
    if (track?.spotifyUri) additional.spotify_id = clean(track.spotifyUri).split(':').pop();
    return { artist, title, album, additional };
  }

  servicesForConfig(cfg) {
    const services = [];
    if (cfg.listenbrainz.enabled && cfg.listenbrainz.token) services.push('listenbrainz');
    if (cfg.lastfm.enabled && cfg.lastfm.apiKey && cfg.lastfm.sharedSecret && cfg.lastfm.sessionKey) services.push('lastfm');
    return services;
  }

  async sendNowPlaying(track) {
    const cfg = await this.config();
    if (!cfg.enabled || !track || (track.source === 'podcast' && !cfg.includePodcasts)) return false;
    const key = this.trackKey(track);
    if (key === this.lastNowPlayingKey) return true;
    const meta = this.metadata(track);
    const tasks = [];
    if (cfg.listenbrainz.enabled && cfg.listenbrainz.token) tasks.push(fetch('https://api.listenbrainz.org/1/submit-listens', {
      // ListenBrainz's API requires the literal "Token " prefix, not just the
      // bare user token -- every request was silently rejected with 401
      // without it.
      method: 'POST', headers: { Authorization: `Token ${cfg.listenbrainz.token}`, 'Content-Type': 'application/json', 'User-Agent': 'Hive/1.0.0 (ListenBrainz)' },
      body: JSON.stringify({ listen_type: 'playing_now', payload: [{ track_metadata: { artist_name: meta.artist, track_name: meta.title, release_name: meta.album || undefined, additional_info: meta.additional } }] })
    }).then(r => { if (!r.ok) throw new Error(`ListenBrainz ${r.status}`); return true; }).catch(() => false));
    if (cfg.lastfm.enabled && cfg.lastfm.apiKey && cfg.lastfm.sharedSecret && cfg.lastfm.sessionKey) {
      const p = { method: 'track.updateNowPlaying', api_key: cfg.lastfm.apiKey, artist: meta.artist, track: meta.title, sk: cfg.lastfm.sessionKey };
      if (meta.album) p.album = meta.album;
      p.format = 'json'; p.api_sig = lastFmSignature(p, cfg.lastfm.sharedSecret);
      tasks.push(postForm('https://ws.audioscrobbler.com/2.0/', p).then(() => true).catch(() => false));
    }
    if (!tasks.length) return false;
    const results = await Promise.all(tasks);
    if (results.some(Boolean)) this.lastNowPlayingKey = key;
    return results.every(Boolean);
  }

  makePendingItems(track, timestamp, services) {
    const meta = this.metadata(track);
    const trackKey = this.trackKey(track);
    return services.map(service => ({
      id: md5(`${service}|${trackKey}|${timestamp}`), service, timestamp,
      metadata: meta, trackKey, createdAt: Date.now()
    }));
  }

  async enqueue(track, timestamp, services) {
    await this.loadCache();
    const items = this.makePendingItems(track, timestamp, services);
    const existing = new Set(this.pending.map(item => item.id));
    for (const item of items) if (!existing.has(item.id)) this.pending.push(item);
    await this.saveCache();
  }

  async submitItem(item, cfg) {
    const meta = item.metadata || {};
    if (item.service === 'listenbrainz' && cfg.listenbrainz.enabled && cfg.listenbrainz.token) {
      const response = await fetch('https://api.listenbrainz.org/1/submit-listens', {
        method: 'POST', headers: { Authorization: `Token ${cfg.listenbrainz.token}`, 'Content-Type': 'application/json', 'User-Agent': 'Hive/1.0.0 (ListenBrainz)' },
        body: JSON.stringify({ listen_type: 'single', payload: [{ listened_at: item.timestamp, track_metadata: { artist_name: meta.artist, track_name: meta.title, release_name: meta.album || undefined, additional_info: meta.additional } }] })
      });
      if (!response.ok) throw new Error(`ListenBrainz ${response.status}`);
      return true;
    }
    if (item.service === 'lastfm' && cfg.lastfm.enabled && cfg.lastfm.apiKey && cfg.lastfm.sharedSecret && cfg.lastfm.sessionKey) {
      const p = { method: 'track.scrobble', api_key: cfg.lastfm.apiKey, artist: meta.artist, track: meta.title, timestamp: item.timestamp, sk: cfg.lastfm.sessionKey };
      if (meta.album) p.album = meta.album;
      p.format = 'json'; p.api_sig = lastFmSignature(p, cfg.lastfm.sharedSecret);
      await postForm('https://ws.audioscrobbler.com/2.0/', p);
      return true;
    }
    return true; // Service was disabled/reconfigured after the listen was queued.
  }

  async flushPending() {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = (async () => {
      await this.loadCache();
      if (!this.pending.length) return;
      const cfg = await this.config();
      if (!cfg.enabled) return;
      const keep = [];
      for (const item of this.pending) {
        try { await this.submitItem(item, cfg); }
        catch { keep.push(item); }
      }
      this.pending = keep;
      await this.saveCache();
    })().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  async submit(track) {
    const cfg = await this.config();
    const current = this.current;
    if (!cfg.enabled || !track || !current || current.key !== this.trackKey(track) || current.submitted || (track.source === 'podcast' && !cfg.includePodcasts)) return false;
    const services = this.servicesForConfig(cfg);
    if (!services.length) { current.submitted = true; this.lastSubmittedKey = current.key; return true; }
    const timestamp = Math.floor((current.startedAt || Date.now()) / 1000);
    await this.enqueue(track, timestamp, services);
    await this.flushPending();
    await this.loadCache();
    const ids = new Set(this.makePendingItems(track, timestamp, services).map(item => item.id));
    const remaining = this.pending.some(item => ids.has(item.id));
    current.submitted = !remaining;
    if (current.submitted) this.lastSubmittedKey = current.key;
    return current.submitted;
  }

  // artist.getsimilar is a public Last.fm method -- it only needs the API
  // key, not the shared secret/session used for scrobbling, so it works even
  // if the user has never authorized Last.fm, as long as they've entered a
  // key in Settings > Community.
  async getSimilarArtists(artistName, limit = 30) {
    const cfg = await this.config();
    const name = clean(artistName);
    if (!name) return [];
    if (!cfg.lastfm.apiKey) throw new Error('Add a Last.fm API key in Settings > Community to use Play Similar.');
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(name)}&api_key=${encodeURIComponent(cfg.lastfm.apiKey)}&format=json&limit=${encodeURIComponent(limit)}`;
    const data = await getJson(url);
    if (data?.error) throw new Error(clean(data?.message) || 'Last.fm could not find similar artists.');
    const matches = Array.isArray(data?.similarartists?.artist) ? data.similarartists.artist : [];
    return matches.map(a => clean(a?.name)).filter(Boolean);
  }

  async status() {
    const cfg = await this.config();
    await this.loadCache();
    return {
      enabled: cfg.enabled,
      thresholdPercent: cfg.thresholdPercent,
      thresholdSeconds: cfg.thresholdSeconds,
      includePodcasts: cfg.includePodcasts,
      listenbrainz: { enabled: cfg.listenbrainz.enabled, configured: !!cfg.listenbrainz.token },
      lastfm: { enabled: cfg.lastfm.enabled, configured: !!(cfg.lastfm.apiKey && cfg.lastfm.sharedSecret && cfg.lastfm.sessionKey) },
      pendingCount: this.pending.length
    };
  }
}

module.exports = { ScrobblingService };
