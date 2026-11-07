'use strict';
// Small files laid out like real songs, for the audio signature. Hive Mobile's
// AudioSignatureTest builds the very same bytes and expects the same signatures.
function audio(n, seed) { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) % 251; return b; }
function id3v2(bodyLength, fill) {
  const h = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (bodyLength >> 21) & 0x7f, (bodyLength >> 14) & 0x7f, (bodyLength >> 7) & 0x7f, bodyLength & 0x7f]);
  return Buffer.concat([h, Buffer.alloc(bodyLength, fill)]);
}
function id3v1(fill) { return Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125, fill)]); }
function flacBlock(type, length, last, fill) { return Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]), Buffer.alloc(length, fill)]); }
function box(type, body) { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); }
function chunk(id, body) { const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); }

/** Pairs of the same audio with different tags ([a], [b]) and new audio ([other]), per kind. */
function fixtures() {
  const big = audio(3 * 1024 * 1024 + 17, 3); // past the two 1 MB samples
  return {
    mp3: { a: Buffer.concat([id3v2(20, 1), audio(3000, 1), id3v1(2)]), b: Buffer.concat([id3v2(300, 9), audio(3000, 1)]), other: Buffer.concat([id3v2(20, 1), audio(3000, 2)]) },
    bigmp3: { a: Buffer.concat([id3v2(40, 1), big]), b: Buffer.concat([id3v2(4000, 5), big, id3v1(1)]), other: Buffer.concat([id3v2(40, 1), big.subarray(0, big.length - 1), Buffer.from([255])]) },
    flac: { a: Buffer.concat([Buffer.from('fLaC'), flacBlock(0, 34, false, 1), flacBlock(4, 10, true, 2), audio(2000, 4)]), b: Buffer.concat([Buffer.from('fLaC'), flacBlock(0, 34, false, 1), flacBlock(4, 90, false, 3), flacBlock(6, 500, true, 4), audio(2000, 4)]), other: Buffer.concat([Buffer.from('fLaC'), flacBlock(0, 34, false, 1), flacBlock(4, 10, true, 2), audio(2001, 4)]) },
    m4a: { a: Buffer.concat([box('ftyp', Buffer.alloc(8, 1)), box('moov', Buffer.alloc(12, 2)), box('mdat', audio(2500, 5))]), b: Buffer.concat([box('ftyp', Buffer.alloc(8, 1)), box('mdat', audio(2500, 5)), box('moov', Buffer.alloc(700, 3))]), other: Buffer.concat([box('ftyp', Buffer.alloc(8, 1)), box('moov', Buffer.alloc(12, 2)), box('mdat', audio(2500, 6))]) },
    wav: { a: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), chunk('fmt ', Buffer.alloc(16, 1)), chunk('data', audio(1001, 7))]), b: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), chunk('fmt ', Buffer.alloc(16, 1)), chunk('LIST', Buffer.alloc(60, 4)), chunk('data', audio(1001, 7))]), other: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), chunk('fmt ', Buffer.alloc(16, 1)), chunk('data', audio(1001, 8))]) },
  };
}
module.exports = { fixtures };
