'use strict';

// ID3v2 frame parsing/construction helpers shared by the MP3 metadata write
// path in main.js. Pure functions over Buffers — no Electron or main.js
// process state, so this module is safe to unit test in isolation.

function id3Synchsafe(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
}

function readId3Size(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  return ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
}

function musicBeePopmValue(stars) {
  // MusicBee's MP3 POPM values are discrete, including half-stars.
  // 0.5..5.0 => 13, 1, 54, 64, 118, 128, 186, 196, 242, 255.
  const values = [0, 13, 1, 54, 64, 118, 128, 186, 196, 242, 255];
  const halfSteps = Math.max(0, Math.min(10, Math.round((Number(stars) || 0) * 2)));
  return values[halfSteps];
}

function musicBeePopmByte(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? Math.round(n) : 0;
}

function musicBeePopmStars(raw) {
  const values = [0, 13, 1, 54, 64, 118, 128, 186, 196, 242, 255];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  let best = 0, bestDistance = Infinity;
  for (let i = 1; i < values.length; i++) {
    const distance = Math.abs(values[i] - n);
    if (distance < bestDistance) { bestDistance = distance; best = i; }
  }
  return best / 2;
}

function id3FrameSize(buf, version) {
  if (!buf || buf.length < 4) return -1;
  return version >= 4
    ? ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f)
    : buf.readUInt32BE(0);
}

function parseId3Frames(payload, version) {
  const frames = [];
  let pos = 0;
  while (pos + 10 <= payload.length) {
    const id = payload.toString('ascii', pos, pos + 4);

    // Valid ID3 padding is zero bytes at the end of the tag. Older Beehive
    // builds could accidentally append a frame after that padding, however.
    // Strawberry/TagLib reads the frame list rather than treating the first
    // zero byte as an absolute end marker, so recover those frames here too.
    if (/^\x00{4}$/.test(id)) {
      let next = pos;
      while (next < payload.length && payload[next] === 0) next++;
      if (next + 10 <= payload.length) {
        const nextId = payload.toString('ascii', next, next + 4);
        const nextSize = id3FrameSize(payload.subarray(next + 4, next + 8), version);
        if (/^[A-Z0-9]{4}$/.test(nextId) && nextSize > 0 && next + 10 + nextSize <= payload.length) {
          pos = next;
          continue;
        }
      }
      break;
    }

    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = id3FrameSize(payload.subarray(pos + 4, pos + 8), version);
    if (frameSize <= 0 || pos + 10 + frameSize > payload.length) break;
    frames.push({ id, data: payload.subarray(pos + 10, pos + 10 + frameSize), raw: payload.subarray(pos, pos + 10 + frameSize) });
    pos += 10 + frameSize;
  }
  return { frames, trailing: payload.subarray(pos) };
}

function txxxDescription(data) {
  if (!data || !data.length) return '';
  const encoding = data[0];
  const body = data.subarray(1);
  if (encoding === 0 || encoding === 3) {
    const nul = body.indexOf(0);
    return body.subarray(0, nul >= 0 ? nul : body.length).toString(encoding === 3 ? 'utf8' : 'latin1').trim();
  }
  if (encoding === 1 || encoding === 2) {
    // MusicBee commonly uses UTF-16LE for TXXX when Unicode text is required.
    let end = body.length;
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) { end = i; break; }
    }
    try { return body.subarray(0, end).toString('utf16le').replace(/^﻿/, '').trim(); } catch { return ''; }
  }
  return '';
}

function makeId3Frame(id, data, version) {
  const size = version >= 4 ? id3Synchsafe(data.length) : (() => { const b = Buffer.alloc(4); b.writeUInt32BE(data.length); return b; })();
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.alloc(2), data]);
}

function makeMusicBeeLoveFrame(version, value = 'L') {
  // MusicBee's Love field: TXXX, encoding 0 (ISO-8859-1), description
  // "LOVE RATING". Beehive uses L for Loved and 0 for Unloved.
  const data = Buffer.concat([
    Buffer.from([0]),
    Buffer.from('LOVE RATING', 'latin1'),
    Buffer.from([0]),
    Buffer.from(String(value), 'latin1')
  ]);
  return makeId3Frame('TXXX', data, version);
}

function makeMusicBeePopmFrame(stars, version, counter = 0) {
  const value = musicBeePopmValue(stars);
  // Strawberry/TagLib keeps the POPM frame even when the rating is cleared;
  // it changes only the POPM rating byte to 0. Mirror that behavior.
  // MusicBee's POPM structure is:
  // "MusicBee" + NUL + rating byte + 32-bit play counter.
  // Preserve the existing counter when only the rating changes, matching
  // Strawberry's behavior of changing POPM.rating without resetting counter.
  const safeCounter = Number.isFinite(Number(counter)) && Number(counter) >= 0
    ? Math.min(0xFFFFFFFF, Math.floor(Number(counter)))
    : 0;
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(safeCounter >>> 0, 0);
  const data = Buffer.concat([
    Buffer.from('MusicBee', 'latin1'),
    Buffer.from([0, value]),
    counterBuf
  ]);
  return makeId3Frame('POPM', data, version);
}

function makeFMPSRatingFrame(stars, version) {
  const value = Math.max(0, Math.min(1, (Number(stars) || 0) / 5));
  const text = String(value);
  const data = Buffer.concat([
    Buffer.from([3]), // UTF-8, matching TagLib's text-frame semantics.
    Buffer.from('FMPS_Rating', 'utf8'),
    Buffer.from([0]),
    Buffer.from(text, 'utf8')
  ]);
  return makeId3Frame('TXXX', data, version);
}

module.exports = {
  id3Synchsafe,
  readId3Size,
  musicBeePopmValue,
  musicBeePopmByte,
  musicBeePopmStars,
  id3FrameSize,
  parseId3Frames,
  txxxDescription,
  makeId3Frame,
  makeMusicBeeLoveFrame,
  makeMusicBeePopmFrame,
  makeFMPSRatingFrame,
};
