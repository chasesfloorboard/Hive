'use strict';

// Shared WAV RIFF/ID3 compatibility reader. Keep this independent from the
// Electron main process so the scanner and metadata worker cannot drift apart.
const fs = require('fs');
const fsp = fs.promises;

const MAX_ID3_CHUNK_BYTES = 32 * 1024 * 1024;

function readId3Size(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  return ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
}

function musicBeePopmStars(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const map = { 13: .5, 1: 1, 54: 1.5, 64: 2, 118: 2.5, 128: 3, 186: 3.5, 196: 4, 242: 4.5, 255: 5 };
  return map[n] !== undefined ? map[n] : Math.max(0, Math.min(5, Math.round((n / 255) * 10) / 2));
}

function decodeId3TextBytes(bytes, encoding) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!input.length) return '';
  if (encoding === 0) return input.toString('latin1');
  if (encoding === 3) return input.toString('utf8');
  if (encoding === 1 || encoding === 2) {
    const body = Buffer.from(encoding === 1 && input.length >= 2 && input[0] === 0xff && input[1] === 0xfe ? input.subarray(2) : input);
    const bigEndian = encoding === 2 || (encoding === 1 && input.length >= 2 && input[0] === 0xfe && input[1] === 0xff);
    const normalized = bigEndian ? Buffer.from(body) : body;
    if (bigEndian) for (let i = 0; i + 1 < normalized.length; i += 2) [normalized[i], normalized[i + 1]] = [normalized[i + 1], normalized[i]];
    return normalized.toString('utf16le');
  }
  return '';
}

function splitId3TextField(body, encoding) {
  const input = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  if (encoding === 0 || encoding === 3) {
    const nul = input.indexOf(0);
    return [input.subarray(0, nul < 0 ? input.length : nul), input.subarray(nul < 0 ? input.length : nul + 1)];
  }
  if (encoding === 1 || encoding === 2) {
    for (let i = 0; i + 1 < input.length; i += 2) {
      if (input[i] === 0 && input[i + 1] === 0) return [input.subarray(0, i), input.subarray(i + 2)];
    }
    return [input, Buffer.alloc(0)];
  }
  return [Buffer.alloc(0), Buffer.alloc(0)];
}

function isFavoriteLoveValue(value) {
  return ['L', 'Y', 'YES', 'TRUE', '1', 'LOVE', 'LOVED', 'FAVORITE', 'FAVOURITE'].includes(String(value ?? '').trim().toUpperCase());
}

function isBeehiveLoveFieldName(value) {
  return ['LOVE RATING', 'LOVE', 'LOVERATING', 'MUSICBEE/LOVE RATING', 'MUSICBEE LOVE RATING'].includes(String(value ?? '').trim().toUpperCase());
}

function id3FrameSize(bytes, major) {
  if (bytes.length < 4) return -1;
  return major >= 4
    ? ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f)
    : bytes.readUInt32BE(0);
}

function parseId3LoveAndRating(tag) {
  const result = { loved: false, rating: 0, ratingRaw: 0 };
  if (!Buffer.isBuffer(tag) || tag.length < 10 || tag.toString('ascii', 0, 3) !== 'ID3') return result;
  const major = tag[3] >= 4 ? 4 : 3;
  const declaredSize = readId3Size(tag);
  if (declaredSize <= 0 || declaredSize > tag.length - 10) return result;
  const payload = tag.subarray(10, 10 + declaredSize);
  for (let pos = 0; pos + 10 <= payload.length;) {
    const id = payload.toString('ascii', pos, pos + 4);
    if (/^\x00{4}$/.test(id)) {
      let next = pos;
      while (next < payload.length && payload[next] === 0) next++;
      if (next + 10 <= payload.length && /^[A-Z0-9]{4}$/.test(payload.toString('ascii', next, next + 4))) { pos = next; continue; }
      break;
    }
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = id3FrameSize(payload.subarray(pos + 4, pos + 8), major);
    if (size <= 0 || pos + 10 + size > payload.length) break;
    const frame = payload.subarray(pos + 10, pos + 10 + size);
    if (id === 'POPM') {
      const nul = frame.indexOf(0);
      if (nul >= 0 && nul + 1 < frame.length && frame.subarray(0, nul).toString('latin1').trim().toLowerCase() === 'musicbee') {
        const raw = frame[nul + 1];
        result.ratingRaw = Math.max(result.ratingRaw, raw);
        result.rating = Math.max(result.rating, musicBeePopmStars(raw));
      }
    } else if (id === 'TXXX') {
      const encoding = frame[0];
      if ([0, 1, 2, 3].includes(encoding)) {
        const [description, value] = splitId3TextField(frame.subarray(1), encoding);
        if (isBeehiveLoveFieldName(decodeId3TextBytes(description, encoding).replace(/^\uFEFF/, '').trim()) && isFavoriteLoveValue(decodeId3TextBytes(value, encoding).replace(/^\uFEFF/, '').trim())) result.loved = true;
      }
    }
    pos += 10 + size;
  }
  return result;
}

async function readWavMusicBeeTags(filePath) {
  const result = { loved: false, rating: 0, ratingRaw: 0 };
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await fd.read(header, 0, 12, 0);
      if (bytesRead < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return result;
      const stat = await fd.stat();
      for (let pos = 12; pos + 8 <= stat.size;) {
        const chunk = Buffer.alloc(8);
        if ((await fd.read(chunk, 0, 8, pos)).bytesRead < 8) break;
        const id = chunk.toString('ascii', 0, 4);
        const size = chunk.readUInt32LE(4);
        const start = pos + 8;
        const next = start + size + (size & 1);
        if (next > stat.size || next < start) break;
        if ((id === 'id3 ' || id === 'ID3 ') && size >= 10 && size <= MAX_ID3_CHUNK_BYTES) {
          const tag = Buffer.alloc(size);
          await fd.read(tag, 0, size, start);
          const parsed = parseId3LoveAndRating(tag);
          result.loved ||= parsed.loved;
          result.rating = Math.max(result.rating, parsed.rating);
          result.ratingRaw = Math.max(result.ratingRaw, parsed.ratingRaw);
        }
        pos = next;
      }
    } finally { await fd.close(); }
  } catch {}
  return result;
}

async function readWavMusicBeeLove(filePath) { return (await readWavMusicBeeTags(filePath)).loved; }
async function readWavMusicBeePopmRaw(filePath) { return (await readWavMusicBeeTags(filePath)).ratingRaw; }

module.exports = { readWavMusicBeeTags, readWavMusicBeeLove, readWavMusicBeePopmRaw, parseId3LoveAndRating, decodeId3TextBytes, isBeehiveLoveFieldName, isFavoriteLoveValue, musicBeePopmStars };
