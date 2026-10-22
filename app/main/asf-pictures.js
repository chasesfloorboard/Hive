// Pictures embedded in WMA/ASF files (WM/Picture), read straight from the
// ASF header. music-metadata 11 misreads them (its WM/Picture parser starts
// from the wrong place in memory and doesn't step past the MIME type's
// terminator), so every WMA cover came out cut and unreadable; version 12
// fixes it but needs Node 22, newer than Hive's Electron. Same result shape
// as music-metadata's pictures: { format, type, description, data }.
const fs = require('fs');

// GUIDs as they appear on disk (mixed-endian).
const guid = s => { const h = s.replace(/-/g, ''); const b = Buffer.from(h, 'hex'); return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]); };
const HEADER = guid('75B22630-668E-11CF-A6D9-00AA0062CE6C');
const EXTENDED_CONTENT = guid('D2D0A440-E307-11D2-97F0-00A0C95EA850');
const HEADER_EXTENSION = guid('5FBF03B5-A92E-11CF-8EE3-00C00C205365');
const METADATA_LIBRARY = guid('44231C94-9498-49D1-A141-1D134E457054');
const BYTE_ARRAY = 1;

// The ID3 picture types, which WM/Picture shares.
const TYPES = ['Other', 'File icon', 'Other file icon', 'Cover (front)', 'Cover (back)', 'Leaflet page', 'Media', 'Lead artist', 'Artist', 'Conductor',
  'Band', 'Composer', 'Lyricist', 'Recording location', 'During recording', 'During performance', 'Screen capture', 'Bright colored fish',
  'Illustration', 'Band logotype', 'Publisher logotype'];

const utf16 = (buf, start, end) => buf.subarray(start, end).toString('utf16le').replace(/\u0000+$/, '');

/** One WM/Picture value: type, data length, MIME type and description (UTF-16, zero-terminated), then the image. */
function parsePicture(v) {
  if (v.length < 9) return null;
  const typeId = v[0];
  const size = v.readUInt32LE(1);
  let p = 5;
  const text = () => { const start = p; while (p + 1 < v.length && (v[p] || v[p + 1])) p += 2; const s = utf16(v, start, p); p += 2; return s; };
  const format = text();
  const description = text();
  if (p > v.length) return null;
  const data = v.subarray(p, Math.min(v.length, p + size));
  return data.length ? { format: format || 'image/jpeg', type: TYPES[typeId] || 'Other', description, data } : null;
}

/** The pictures in an ASF header (its Extended Content Description, and the Metadata Library for big ones). */
function parseAsfPictures(buf) {
  const out = [];
  if (buf.length < 30 || !buf.subarray(0, 16).equals(HEADER)) return out;
  const walk = (start, end) => {
    let p = start;
    while (p + 24 <= end) {
      const id = buf.subarray(p, p + 16);
      const size = Number(buf.readBigUInt64LE(p + 16));
      if (size < 24 || p + size > end) break;
      const body = p + 24;
      if (id.equals(EXTENDED_CONTENT)) {
        let q = body + 2;
        for (let n = buf.readUInt16LE(body); n > 0 && q + 6 <= p + size; n--) {
          const nameLen = buf.readUInt16LE(q); const name = utf16(buf, q + 2, q + 2 + nameLen); q += 2 + nameLen;
          const type = buf.readUInt16LE(q); const len = buf.readUInt16LE(q + 2); q += 4;
          if (name === 'WM/Picture' && type === BYTE_ARRAY) { const pic = parsePicture(buf.subarray(q, q + len)); if (pic) out.push(pic); }
          q += len;
        }
      } else if (id.equals(HEADER_EXTENSION)) {
        // Reserved GUID (16), reserved (2), extension data size (4), then nested objects.
        walk(body + 22, p + size);
      } else if (id.equals(METADATA_LIBRARY)) {
        let q = body + 2;
        for (let n = buf.readUInt16LE(body); n > 0 && q + 12 <= p + size; n--) {
          const nameLen = buf.readUInt16LE(q + 4); const type = buf.readUInt16LE(q + 6); const len = buf.readUInt32LE(q + 8); q += 12;
          const name = utf16(buf, q, q + nameLen); q += nameLen;
          if (name === 'WM/Picture' && type === BYTE_ARRAY) { const pic = parsePicture(buf.subarray(q, q + len)); if (pic) out.push(pic); }
          q += len;
        }
      }
      p += size;
    }
  };
  // The Header Object: GUID, size, object count (4), two reserved bytes, then its objects.
  const headerSize = Number(buf.readBigUInt64LE(16));
  walk(30, Math.min(buf.length, headerSize));
  return out;
}

/** Reads just the file's ASF header (where pictures live) and returns its pictures. */
async function readAsfPictures(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const head = Buffer.alloc(30);
    await fd.read(head, 0, 30, 0);
    if (!head.subarray(0, 16).equals(HEADER)) return [];
    const size = Math.min(Number(head.readBigUInt64LE(16)), 64 * 1024 * 1024);
    const buf = Buffer.alloc(size);
    await fd.read(buf, 0, size, 0);
    return parseAsfPictures(buf);
  } finally { await fd.close(); }
}

module.exports = { readAsfPictures, parseAsfPictures, parsePicture };
