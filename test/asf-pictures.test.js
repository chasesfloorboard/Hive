const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAsfPictures, parsePicture } = require('../app/main/asf-pictures');

// A WM/Picture value as WMP and Mutagen write it: type, data length, MIME and description
// (UTF-16, zero-terminated), then the image.
function picture(type, mime, desc, data) {
  const len = Buffer.alloc(4); len.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from([type]), len, Buffer.from(mime + '\0', 'utf16le'), Buffer.from(desc + '\0', 'utf16le'), data]);
}
const guid = s => { const b = Buffer.from(s.replace(/-/g, ''), 'hex'); return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]); };
function object(id, body) { const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(24 + body.length)); return Buffer.concat([guid(id), size, body]); }

test('a WMA cover is read whole, with its type and MIME type', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
  const p = parsePicture(picture(3, 'image/jpeg', '', jpeg));
  assert.equal(p.format, 'image/jpeg');
  assert.equal(p.type, 'Cover (front)');
  assert.deepEqual([...p.data], [...jpeg]);
});

test('pictures in the Extended Content Description and in the Metadata Library are both found', () => {
  const small = picture(3, 'image/jpeg', 'front', Buffer.from([0xff, 0xd8, 9]));
  const big = picture(4, 'image/png', '', Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]));
  const name = Buffer.from('WM/Picture\0', 'utf16le');
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const ecd = object('D2D0A440-E307-11D2-97F0-00A0C95EA850', Buffer.concat([u16(1), u16(name.length), name, u16(1), u16(small.length), small]));
  const lib = object('44231C94-9498-49D1-A141-1D134E457054', Buffer.concat([u16(1), u16(0), u16(0), u16(name.length), u16(1), u32(big.length), name, big]));
  const ext = object('5FBF03B5-A92E-11CF-8EE3-00C00C205365', Buffer.concat([Buffer.alloc(16), u16(6), u32(lib.length), lib]));
  const objects = Buffer.concat([ecd, ext]);
  const headerSize = Buffer.alloc(8); headerSize.writeBigUInt64LE(BigInt(30 + objects.length));
  const file = Buffer.concat([guid('75B22630-668E-11CF-A6D9-00AA0062CE6C'), headerSize, u32(2), Buffer.from([1, 2]), objects]);
  const found = parseAsfPictures(file);
  assert.deepEqual(found.map(p => [p.type, p.format, p.data[0]]), [['Cover (front)', 'image/jpeg', 0xff], ['Cover (back)', 'image/png', 0x89]]);
});
