'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const bracketNoise = /\s*[(\[][^)\]]*(edition|version|bonus|deluxe|remaster|disc|explicit|single|ep|re-issue)[^)\]]*[)\]]/gi;
const possessive = /(\p{L}+)'s\b/giu;
const karaokeJunk = ['karaoke', 'tribute', 'in the style of', 'originally performed by', 'a tribute to', 'instrumental version'];

function cleanCoverBrackets(text) {
  return String(text || '').replace(bracketNoise, '').trim();
}

function decipherCoverQuery(query) {
  const q = String(query || '').trim().replace(possessive, '$1');
  const byMatch = q.match(/^(.*?)\s+by\s+(.*)$/i);
  if (byMatch) {
    return { artist: byMatch[2].trim(), album: cleanCoverBrackets(byMatch[1].trim()), title: '' };
  }
  if (q.includes(' - ')) {
    const parts = q.split(' - ');
    return { artist: parts[0].trim(), album: cleanCoverBrackets(parts.slice(1).join(' - ').trim()), title: '' };
  }
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return { artist: words[0], album: cleanCoverBrackets(words.slice(1).join(' ')), title: '' };
  }
  return { artist: q, album: '', title: '' };
}

function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}

function scoreResult(item, album, artist, title = '') {
  const gotA = String(item.collectionName || item.releaseGroupTitle || item.title || '');
  const gotAr = String(item.artistName || item.artist || '');
  const gotALower = gotA.toLowerCase();
  const gotArLower = gotAr.toLowerCase();
  if (karaokeJunk.some(j => gotALower.includes(j) || gotArLower.includes(j))) return -999;

  let score = 0;
  const a = normalizeText(album);
  const cleanGotA = normalizeText(cleanCoverBrackets(gotA));
  const normGotA = normalizeText(gotA);

  if (a) {
    if (normGotA === a || cleanGotA === a) score += 120;
    else if (normGotA.includes(a) || a.includes(normGotA) || cleanGotA.includes(a) || a.includes(cleanGotA)) score += 70;
  }

  const ar = normalizeText(artist);
  const normGotAr = normalizeText(gotAr);
  if (ar) {
    if (normGotAr === ar) score += 150;
    else if (normGotAr.includes(ar) || ar.includes(normGotAr)) score += 100;
    else score -= 80;
  }

  if (title) {
    const t = normalizeText(title);
    if (t && (normGotA.includes(t) || cleanGotA.includes(t))) score += 50;
  }

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

module.exports = { normalizeText, scoreResult, createArtworkCache, providers, cleanCoverBrackets, decipherCoverQuery };
