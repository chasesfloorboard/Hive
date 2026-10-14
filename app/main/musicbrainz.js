'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const API = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';
const USER_AGENT = 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz) (offline-first music player)';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

function norm(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function quote(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cacheKey(kind, value) {
  return `${kind}:${norm(value).replace(/ /g, '_')}`;
}

function createClient({ cacheFile, fetchImpl = global.fetch } = {}) {
  let cache = {};
  let cacheLoaded = false;
  let lastRequest = 0;
  let requestChain = Promise.resolve();

  async function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const raw = await fsp.readFile(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') cache = parsed;
    } catch {}
  }

  async function saveCache() {
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, JSON.stringify(cache), 'utf8');
      await fsp.rename(tmp, cacheFile);
    } catch (err) {
      console.warn('[MusicBrainz] cache save failed:', err.message);
    }
  }

  async function getCached(key) {
    await loadCache();
    const item = cache[key];
    if (!item) return null;
    if (Date.now() - Number(item.savedAt || 0) > CACHE_TTL) return null;
    return item.value;
  }

  async function putCached(key, value) {
    await loadCache();
    cache[key] = { savedAt: Date.now(), value };
    await saveCache();
  }

  async function networkJson(url, headers = {}) {
    // MusicBrainz asks clients to stay at or below one request per second.
    requestChain = requestChain.then(async () => {
      const wait = Math.max(0, 1000 - (Date.now() - lastRequest));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastRequest = Date.now();
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', ...headers }
      });
      if (!response.ok) throw new Error(`MusicBrainz request failed (${response.status}).`);
      return response.json();
    });
    return requestChain;
  }

  async function searchReleaseGroups({ album, artist, limit = 5 } = {}) {
    album = String(album || '').trim();
    artist = String(artist || '').trim();
    if (!album) return [];

    const exactKey = cacheKey('release-group', `${album}\n${artist}`);
    const cached = await getCached(exactKey);
    if (cached) return cached;

    const clauses = [`releasegroup:"${quote(album)}"`];
    if (artist) clauses.push(`artist:"${quote(artist)}"`);
    const params = new URLSearchParams({ query: clauses.join(' AND '), fmt: 'json', limit: String(Math.min(10, Math.max(1, limit))) });
    let data;
    try {
      data = await networkJson(`${API}/release-group/?${params.toString()}`);
    } catch (err) {
      // If the network is unavailable, the cache is still useful. Never turn an
      // online enrichment failure into a failure of the local player/editor.
      console.warn('[MusicBrainz] search unavailable:', err.message);
      return [];
    }

    const groups = Array.isArray(data?.['release-groups']) ? data['release-groups'] : [];
    const wantedAlbum = norm(album);
    const wantedArtist = norm(artist);
    const results = groups.map((rg) => {
      const artistName = Array.isArray(rg['artist-credit'])
        ? rg['artist-credit'].map(c => c?.name || c?.artist?.name || '').filter(Boolean).join('')
        : '';
      const title = String(rg.title || '').trim();
      const releases = Array.isArray(rg.releases) ? rg.releases : [];
      const release = releases[0] || null;
      const score = Number(rg.score || 0);
      const exactTitle = norm(title) === wantedAlbum;
      const exactArtist = !wantedArtist || norm(artistName) === wantedArtist;
      return {
        source: 'MusicBrainz',
        collectionName: title,
        artistName,
        releaseYear: rg['first-release-date'] ? String(rg['first-release-date']).slice(0, 4) : '',
        releaseGroupId: rg.id || null,
        releaseId: release?.id || null,
        mbid: rg.id || null,
        score: score + (exactTitle ? 100 : 0) + (exactArtist ? 50 : 0),
        artworkUrl: rg.id ? `${CAA}/release-group/${encodeURIComponent(rg.id)}/front-1200` : null,
        width: 1200,
        height: 1200
      };
    }).filter(item => item.collectionName && item.artworkUrl);

    // Prefer exact title matches; when the artist was supplied, exact artist
    // matches are preferred too. This keeps automatic lookup conservative.
    results.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const out = results.slice(0, 5);
    await putCached(exactKey, out);
    return out;
  }


  async function searchReleases({ album, artist, limit = 20 } = {}) {
    album = String(album || '').trim();
    artist = String(artist || '').trim();
    if (!album) return [];
    const exactKey = cacheKey('release-v4', `${album}\n${artist}`);
    const cached = await getCached(exactKey);
    if (cached) return cached;
    const clauses = [`release:"${quote(album)}"`];
    if (artist) clauses.push(`artist:"${quote(artist)}"`);
    const params = new URLSearchParams({ query: clauses.join(' AND '), fmt: 'json', limit: String(Math.min(25, Math.max(1, limit))), inc: 'artist-credits' });
    let data;
    try {
      data = await networkJson(`${API}/release/?${params.toString()}`);
    } catch (err) {
      console.warn('[MusicBrainz] release search unavailable:', err.message);
      return [];
    }
    const releases = Array.isArray(data?.releases) ? data.releases : [];
    const wantedAlbum = norm(album);
    const wantedArtist = norm(artist);
    const results = releases.map((release) => {
      const artistName = Array.isArray(release['artist-credit'])
        ? release['artist-credit'].map(c => c?.name || c?.artist?.name || '').filter(Boolean).join('')
        : '';
      const title = String(release.title || '').trim();
      const exactTitle = norm(title) === wantedAlbum;
      const exactArtist = !wantedArtist || norm(artistName) === wantedArtist;
      const score = Number(release.score || 0) + (exactTitle ? 100 : 0) + (exactArtist ? 60 : 0);
      return {
        source: 'MusicBrainz',
        collectionName: title,
        artistName,
        releaseYear: release.date ? String(release.date).slice(0, 4) : '',
        releaseCountry: release.country || '',
        releaseStatus: release.status || '',
        releaseGroupId: release['release-group']?.id || null,
        releaseId: release.id || null,
        mbid: release.id || null,
        score,
        // score adds exact-title/artist bonuses for ranking (up to 260); the
        // UI shows MusicBrainz's own 0-100 relevance instead.
        matchPercent: Math.max(0, Math.min(100, Number(release.score || 0))),
        trackCount: Number(release['track-count'] || 0) || 0,
        // Album / Single / EP: an album and its lead single often share a title.
        releaseType: String(release['release-group']?.['primary-type'] || ''),
        format: Array.isArray(release.media) ? [...new Set(release.media.map(m => m?.format).filter(Boolean))].join(' + ') : '',
        // Search results carry no cover-art-archive flags, so thumbnails use the
        // release group's front, which CAA resolves from any release that has art.
        thumbUrl: release['release-group']?.id ? `${CAA}/release-group/${encodeURIComponent(release['release-group'].id)}/front-250` : null,
        artworkUrl: release.id ? `${CAA}/release/${encodeURIComponent(release.id)}/front-1200` : null,
        width: 1200,
        height: 1200
      };
    }).filter(item => item.collectionName && item.artworkUrl);
    results.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const out = results.slice(0, 10);
    await putCached(exactKey, out);
    return out;
  }

  async function identify({ title, artist, album } = {}) {
    title = String(title || '').trim();
    artist = String(artist || '').trim();
    album = String(album || '').trim();
    if (!title && !album) return null;

    const key = cacheKey('identify', `${title}\n${artist}\n${album}`);
    const cached = await getCached(key);
    if (cached) return cached;

    const releaseGroups = await searchReleaseGroups({ album, artist, limit: 5 });
    const best = releaseGroups[0] || null;
    const result = best ? {
      recordingTitle: title,
      artist,
      album,
      releaseGroupMbid: best.releaseGroupId,
      releaseMbid: best.releaseId,
      matchedAlbum: best.collectionName,
      matchedArtist: best.artistName,
      score: best.score,
      artworkUrl: best.artworkUrl
    } : null;
    await putCached(key, result);
    return result;
  }

  async function getReleaseDetails(releaseId) {
    releaseId = String(releaseId || '').trim();
    if (!releaseId) return null;
    const key = cacheKey('release-details-v2', releaseId);
    const cached = await getCached(key);
    if (cached) return cached;
    let data;
    try {
      data = await networkJson(`${API}/release/${encodeURIComponent(releaseId)}?fmt=json&inc=recordings+artist-credits+release-groups+media`);
    } catch (err) {
      console.warn('[MusicBrainz] release details unavailable:', err.message);
      return null;
    }
    const tracks = [];
    for (const medium of (Array.isArray(data?.media) ? data.media : [])) {
      const disc = Number(medium?.position || 1) || 1;
      const mediumTracks = Array.isArray(medium?.tracks) ? medium.tracks : [];
      for (let i = 0; i < mediumTracks.length; i++) {
        const tr = mediumTracks[i] || {};
        const rec = tr.recording || {};
        const credits = Array.isArray(rec['artist-credit']) ? rec['artist-credit'] : [];
        const artist = credits.map(c => c?.name || c?.artist?.name || '').filter(Boolean).join('');
        tracks.push({
          disc,
          position: Number(tr.position || i + 1) || i + 1,
          title: String(tr.title || rec.title || '').trim(),
          artist: artist || '',
          recordingMbid: rec.id || null,
          lengthMs: Number(tr.length || rec.length || 0) || 0
        });
      }
    }
    const credits = Array.isArray(data?.['artist-credit']) ? data['artist-credit'] : [];
    const artist = credits.map(c => c?.name || c?.artist?.name || '').filter(Boolean).join('');
    const result = {
      releaseId: data.id || releaseId,
      releaseGroupId: data['release-group']?.id || null,
      title: String(data.title || '').trim(),
      artist,
      date: String(data.date || '').trim(),
      year: data.date ? String(data.date).slice(0,4) : '',
      country: String(data.country || '').trim(),
      status: String(data.status || '').trim(),
      label: Array.isArray(data['label-info']) ? String(data['label-info'][0]?.label?.name || '').trim() : '',
      catalogNumber: Array.isArray(data['label-info']) ? String(data['label-info'][0]?.['catalog-number'] || '').trim() : '',
      barcode: String(data.barcode || '').trim(),
      artworkUrl: releaseArtworkUrl(data, releaseId),
      tracks
    };
    await putCached(key, result);
    return result;
  }

  // Many releases (e.g. a 1991 DE pressing) have no art of their own, and
  // /release/<id>/front-1200 404s -- the auto-tag preview then showed a broken
  // image and claimed "shared cover ready". Use the release's own front only
  // when CAA says it exists, else the release group's front, else nothing.
  function releaseArtworkUrl(data, releaseId) {
    const id = data?.id || releaseId;
    const caa = data?.['cover-art-archive'];
    if (id && (!caa || caa.front)) return `${CAA}/release/${encodeURIComponent(id)}/front-1200`;
    const groupId = data?.['release-group']?.id;
    return groupId ? `${CAA}/release-group/${encodeURIComponent(groupId)}/front-1200` : null;
  }

  return { searchReleaseGroups, searchReleases, identify, getReleaseDetails };
}

module.exports = { createClient, API, CAA, USER_AGENT };
