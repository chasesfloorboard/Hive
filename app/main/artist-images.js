'use strict';

// Artist photos for plugins (Hive.media.getArtistImage), e.g. the Visualizer.
//
// Source: Deezer's public artist search (no API key, returns 1000px photos).
// Images are cached in the covers folder as artist-<hash>.jpg and served
// through mbcover://, so each artist is downloaded once. Misses are remembered
// for a while so a track without a match doesn't query again on every play.
//
// Factory with injected deps so it can be tested without network access.

const SEARCH_URL = 'https://api.deezer.com/search/artist';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

function normalizeArtistName(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// "A feat. B", "A & B", "A, B" -> "A": the photo should be the main artist.
function primaryArtist(value) {
  return String(value || '').split(/\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s*[;,/&]\s*/i)[0].trim();
}

function isAllowedImageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)dzcdn\.net$/i.test(parsed.hostname);
  } catch { return false; }
}

function createArtistImageProvider({ fetch, fsp, path, crypto, dir, now = Date.now, userAgent = 'Hive (artist images)' }) {
  const misses = new Map();
  const inFlight = new Map();

  function fileFor(name) {
    const key = crypto.createHash('sha1').update(normalizeArtistName(name)).digest('hex');
    return path.join(dir(), `artist-${key}.jpg`);
  }

  async function exists(file) {
    try { return (await fsp.stat(file)).size > 0; } catch { return false; }
  }

  async function search(name) {
    const url = `${SEARCH_URL}?${new URLSearchParams({ q: name, limit: '5' })}`;
    const response = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Artist search failed (${response.status}).`);
    const body = await response.json();
    const results = Array.isArray(body?.data) ? body.data : [];
    const wanted = normalizeArtistName(name);
    // Only an exact name match: a wrong person's photo is worse than none.
    // Deezer lists duplicates; those without a photo have an empty image hash
    // (".../images/artist//1000x1000-...").
    for (const item of results) {
      if (normalizeArtistName(item?.name) !== wanted) continue;
      const image = String(item.picture_xl || item.picture_big || '');
      if (image && !/\/artist\/\//.test(image) && isAllowedImageUrl(image)) return image;
    }
    return null;
  }

  async function download(url, file) {
    const response = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'image/*' } });
    if (!response.ok) throw new Error(`Artist image download failed (${response.status}).`);
    if (!/^image\//i.test(response.headers.get('content-type') || '')) throw new Error('Artist image response was not an image.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Artist image size out of range.');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, file);
  }

  async function resolve(artist) {
    const file = fileFor(artist);
    if (await exists(file)) return file;
    const missKey = normalizeArtistName(artist);
    if (misses.has(missKey) && now() - misses.get(missKey) < MISS_TTL_MS) return null;
    try {
      // The full credit first ("Simon & Garfunkel" is one artist), then the
      // lead artist of a collaboration ("A feat. B").
      const names = [...new Set([artist, primaryArtist(artist)].filter(n => normalizeArtistName(n)))];
      for (const name of names) {
        const url = await search(name);
        if (!url) continue;
        await download(url, file);
        return file;
      }
    } catch {
      // Offline or the service is down: treat like a miss for now.
    }
    misses.set(normalizeArtistName(artist), now());
    return null;
  }

  // Returns the cached file path, or null when no photo is available.
  async function lookup(artist) {
    const name = String(artist || '').trim();
    const key = normalizeArtistName(name);
    if (!key) return null;
    if (!inFlight.has(key)) inFlight.set(key, resolve(name).finally(() => inFlight.delete(key)));
    return inFlight.get(key);
  }

  return { lookup, fileFor };
}

module.exports = { createArtistImageProvider, normalizeArtistName, primaryArtist, isAllowedImageUrl };
