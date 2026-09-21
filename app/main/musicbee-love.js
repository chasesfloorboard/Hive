const fs = require('fs');
const fsp = fs.promises;

function readId3Size(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  return ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
}

function decodeId3TextBytes(bytes, encoding) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (encoding === 0) return input.toString('latin1');
  if (encoding === 1) {
    // UTF-16 with BOM. Node's utf16le handles the common LE case; BE is
    // converted explicitly so MusicBee's older UTF-16 tags remain readable.
    if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
      const swapped = Buffer.from(input.subarray(2));
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        const a = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = a;
      }
      return swapped.toString('utf16le');
    }
    const body = input.length >= 2 && input[0] === 0xff && input[1] === 0xfe ? input.subarray(2) : input;
    return body.toString('utf16le');
  }
  if (encoding === 2) {
    const swapped = Buffer.from(input);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const a = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = a;
    }
    return swapped.toString('utf16le');
  }
  if (encoding === 3) return input.toString('utf8');
  return '';
}

function splitId3TextField(body, encoding) {
  const input = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  if (encoding === 0 || encoding === 3) {
    const nul = input.indexOf(0);
    return [input.subarray(0, nul >= 0 ? nul : input.length), input.subarray(nul >= 0 ? nul + 1 : input.length)];
  }
  if (encoding === 1 || encoding === 2) {
    let nul = -1;
    for (let i = 0; i + 1 < input.length; i += 2) {
      if (input[i] === 0 && input[i + 1] === 0) { nul = i; break; }
    }
    return [input.subarray(0, nul >= 0 ? nul : input.length), input.subarray(nul >= 0 ? nul + 2 : input.length)];
  }
  return [Buffer.alloc(0), Buffer.alloc(0)];
}

function splitId3TextValues(bytes, encoding) {
  return decodeId3TextBytes(bytes, encoding)
    .replace(/^\uFEFF/, '')
    .split('\u0000')
    .map(value => value.trim())
    .filter(Boolean);
}

function isFavoriteLoveValue(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'L' || v === 'Y' || v === 'YES' || v === 'TRUE' ||
    v === '1' || v === 'LOVE' || v === 'LOVED' ||
    v === 'FAVORITE' || v === 'FAVOURITE';
}

function isBeehiveLoveFieldName(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'LOVE RATING' || v === 'LOVE' || v === 'LOVERATING' ||
    v === 'MUSICBEE/LOVE RATING' || v === 'MUSICBEE/LOVERATING' ||
    v === 'MUSICBEE LOVE RATING';
}

function readId3LoveFromBuffer(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return false;
  const major = buf[3] >= 4 ? 4 : 3;
  const flags = buf[5];
  const tagSize = readId3Size(buf);
  if (!tagSize || tagSize > 64 * 1024 * 1024) return false;
  // Trust bytes that physically exist even when a damaged ID3 header
  // over-declares the tag size. Love remains readable instead of being
  // discarded before the frame walk begins.
  const payloadEnd = Math.min(buf.length, 10 + tagSize);
  if (payloadEnd <= 10) return false;
  const payload = buf.subarray(10, payloadEnd);
  let pos = 0;

  // Extended headers precede frames. Love should not become invisible merely
  // because a tag contains one of these legal headers.
  if (major >= 3 && (flags & 0x40) && payload.length >= 4) {
    const extSize = major >= 4
      ? ((payload[0] & 0x7f) << 21) | ((payload[1] & 0x7f) << 14) | ((payload[2] & 0x7f) << 7) | (payload[3] & 0x7f)
      : payload.readUInt32BE(0);
    pos = major >= 4 ? extSize : 4 + extSize;
    if (pos > payload.length) pos = 0;
  }

  while (pos + 10 <= payload.length) {
    const id = payload.toString('ascii', pos, pos + 4);
    if (/^\x00{4}$/.test(id)) {
      let next = pos;
      while (next < payload.length && payload[next] === 0) next++;
      if (next + 10 <= payload.length && /^[A-Z0-9]{4}$/.test(payload.toString('ascii', next, next + 4))) { pos = next; continue; }
      break;
    }
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const sizeBytes = payload.subarray(pos + 4, pos + 8);
    const size = major >= 4
      ? ((sizeBytes[0] & 0x7f) << 21) | ((sizeBytes[1] & 0x7f) << 14) | ((sizeBytes[2] & 0x7f) << 7) | (sizeBytes[3] & 0x7f)
      : sizeBytes.readUInt32BE(0);
    if (size <= 0 || pos + 10 + size > payload.length) break;

    if (id === 'TXXX') {
      const frame = payload.subarray(pos + 10, pos + 10 + size);
      const encoding = frame[0];
      if (encoding === 0 || encoding === 1 || encoding === 2 || encoding === 3) {
        const [descBytes, valueBytes] = splitId3TextField(frame.subarray(1), encoding);
        const desc = decodeId3TextBytes(descBytes, encoding).replace(/^\uFEFF/, '').trim().toUpperCase();
        if (isBeehiveLoveFieldName(desc) && splitId3TextValues(valueBytes, encoding).some(isFavoriteLoveValue)) return true;
      }
    }
    pos += 10 + size;
  }
  return false;
}

async function readMp3MusicBeeLove(filePath) {
  try { return readId3LoveFromBuffer(await fsp.readFile(filePath)); } catch { return false; }
}

module.exports = { readId3LoveFromBuffer, readMp3MusicBeeLove, isFavoriteLoveValue, isBeehiveLoveFieldName };
