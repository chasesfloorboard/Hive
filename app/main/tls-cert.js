'use strict';

// Hive Link's own TLS certificate: a self-signed P-256 certificate made once and kept in Hive's data
// folder. No certificate authority is involved: the phone pins this exact certificate (its SHA-256),
// which it learns through /api/hello, signed with the pairing (see hive-link.js). Node can make the key
// but not a certificate, so the certificate's few DER fields are written here by hand.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, body) { return Buffer.concat([Buffer.from([tag]), len(body.length), body]); }
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
function oid(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const stack = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) stack.unshift(0x80 | (v & 0x7f));
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function integer(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function utcTime(d) {
  const p = n => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}
function generalizedTime(d) {
  const p = n => String(n).padStart(2, '0');
  return tlv(0x18, Buffer.from(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}
const time = d => (d.getUTCFullYear() < 2050 ? utcTime(d) : generalizedTime(d));
const name = cn => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));

/** A new self-signed certificate and its key: { key, cert } as PEM. */
function makeCertificate(commonName = 'Hive Link', now = new Date()) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const sigAlg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const notBefore = new Date(now.getTime() - 24 * 3600e3);
  const notAfter = new Date(now.getTime() + 20 * 365 * 24 * 3600e3);
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(crypto.randomBytes(16)),
    sigAlg,
    name(commonName),
    seq(time(notBefore), time(notAfter)),
    name(commonName),
    spki,
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // DER ECDSA signature
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = (label, buf) => `-----BEGIN ${label}-----\n${buf.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', der) };
}

/** SHA-256 of the certificate (hex, lower case): what the phone pins. */
function pinOf(certPem) { return new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase(); }

/** This Hive's certificate, made on first use and kept in [dataDir]: { key, cert, pin }. */
function loadOrCreate(dataDir) {
  const file = path.join(dataDir, 'hive-link-tls.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.key && saved?.cert) { new crypto.X509Certificate(saved.cert); return { ...saved, pin: pinOf(saved.cert) }; }
  } catch {}
  const made = makeCertificate();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ key: made.key, cert: made.cert }), { mode: 0o600 });
  return { ...made, pin: pinOf(made.cert) };
}

module.exports = { makeCertificate, loadOrCreate, pinOf };
