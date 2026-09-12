'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}

function scoreResult(item, album, artist) {
  const a = normalizeText(album), gotA = normalizeText(item.collectionName || item.releaseGroupTitle || item.title);
  const ar = normalizeText(artist), gotAr = normalizeText(item.artistName || item.artist);
  let score = 0;
  if (gotA === a) score += 100; else if (gotA.includes(a) || a.includes(gotA)) score += 55;
  if (ar && gotAr === ar) score += 45; else if (ar && (gotAr.includes(ar) || ar.includes(gotAr))) score += 20;
  if (item.source === 'MusicBrainz') score += 8;
  if (Number(item.width || 0) >= 1000 && Number(item.height || 0) >= 1000) score += 5;
  return score;
}

function cacheKey(url) { return crypto.createHash('sha256').update(String(url || '')).digest('hex'); }

function createArtworkCache(root) {
  const dir = path.resolve(root);
  async function ensure() { await fsp.mkdir(dir, { recursive: true, mode: 0o700 }); }
  async function lookup(url) {
    await ensure();
    const key = cacheKey(url);
    const metaPath = path.join(dir, `${key}.json`);
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      if (!meta?.path || !fs.existsSync(meta.path)) return null;
      return meta;
    } catch { return null; }
  }
  async function put(url, imagePath, meta = {}) {
    await ensure();
    const key = cacheKey(url);
    const ext = path.extname(imagePath) || '.jpg';
    const target = path.join(dir, `${key}${ext}`);
    if (path.resolve(imagePath) !== path.resolve(target)) {
      try { await fsp.copyFile(imagePath, target); } catch { return null; }
    }
    const record = { key, sourceUrl: String(url), path: target, cachedAt: Date.now(), ...meta };
    await fsp.writeFile(path.join(dir, `${key}.json`), JSON.stringify(record), 'utf8');
    return record;
  }
  return { lookup, put, cacheKey };
}

const providers = Object.freeze([
  { id: 'musicbrainz-caa', name: 'MusicBrainz / Cover Art Archive' },
  { id: 'itunes', name: 'iTunes' }
]);

module.exports = { normalizeText, scoreResult, createArtworkCache, providers };
