const test = require('node:test');
const assert = require('node:assert/strict');
const { readId3LoveFromBuffer } = require('../app/main/musicbee-love');

function synchsafe(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
}
function frameTxxx(encoding, description, values) {
  let desc, sep, value;
  if (encoding === 0 || encoding === 3) {
    const enc = encoding === 3 ? 'utf8' : 'latin1';
    desc = Buffer.from(description, enc);
    sep = Buffer.from([0]);
    value = Buffer.from(values.join('\0'), enc);
  } else {
    const le = encoding === 1 ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0);
    const encodeLE = text => Buffer.from(text, 'utf16le');
    const encode = text => {
      const b = encodeLE(text);
      if (encoding !== 2) return b;
      const out = Buffer.from(b);
      for (let i = 0; i + 1 < out.length; i += 2) { const a = out[i]; out[i] = out[i + 1]; out[i + 1] = a; }
      return out;
    };
    desc = Buffer.concat([le, encode(description)]);
    sep = Buffer.from([0, 0]);
    value = Buffer.concat(values.map((v, i) => i ? Buffer.concat([Buffer.from([0,0]), encode(v)]) : encode(v)));
  }
  const body = Buffer.concat([Buffer.from([encoding]), desc, sep, value]);
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from('TXXX'), size, Buffer.from([0,0]), body]);
}
function makeTag(frames) {
  const payload = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3,0,0]), synchsafe(payload.length), payload]);
}

test('MP3 Love recognizes L when the same Love field contains U and L', () => {
  for (const encoding of [0, 3, 1, 2]) {
    const tag = makeTag([frameTxxx(encoding, 'LOVE RATING', ['U', 'L'])]);
    assert.equal(readId3LoveFromBuffer(tag), true, `encoding ${encoding}`);
  }
});

test('MP3 Love recognizes L in a later separate TXXX frame after U', () => {
  const tag = makeTag([
    frameTxxx(0, 'LOVE RATING', ['U']),
    frameTxxx(0, 'LOVE RATING', ['L'])
  ]);
  assert.equal(readId3LoveFromBuffer(tag), true);
});

test('MP3 Love recognizes historical Love field aliases', () => {
  for (const name of ['LOVE', 'LOVERATING', 'MUSICBEE/LOVE RATING', 'MUSICBEE/LOVERATING']) {
    const tag = makeTag([frameTxxx(3, name, ['L'])]);
    assert.equal(readId3LoveFromBuffer(tag), true, name);
  }
});

test('MP3 Love does not treat U alone as Loved', () => {
  const tag = makeTag([frameTxxx(3, 'LOVE RATING', ['U'])]);
  assert.equal(readId3LoveFromBuffer(tag), false);
});
