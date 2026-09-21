'use strict';

// Minimal client for the loon protocol (https://github.com/ungive/loon),
// the same protocol Music Presence's own client-proxy uses to turn a local
// file into a temporary, authenticated, internet-reachable URL over an
// outbound-only WebSocket connection. See api/specification.md and
// api/messages.proto in a cloned loon checkout for the normative spec this
// file implements. Deliberately hand-rolled (no protobufjs dependency): the
// message set is small, fixed, and fully specified below.

const crypto = require('crypto');
const EventEmitter = require('events');
const { MiniWebSocket } = require('./ws-client');

// ---- protobuf wire format (proto3) ----

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos];
}

function writeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) { bytes.push(b | 0x80); } else { bytes.push(b); break; }
  }
  return Buffer.from(bytes);
}

function encodeField(fieldNumber, wireType, payload) {
  return Buffer.concat([writeVarint((fieldNumber << 3) | wireType), payload]);
}
function encodeVarintField(fieldNumber, value) {
  return encodeField(fieldNumber, 0, writeVarint(value));
}
function encodeLenField(fieldNumber, bytes) {
  return encodeField(fieldNumber, 2, Buffer.concat([writeVarint(bytes.length), bytes]));
}
function encodeStringField(fieldNumber, str) {
  return encodeLenField(fieldNumber, Buffer.from(String(str), 'utf8'));
}

// Decodes a message into a Map<fieldNumber, rawValue[]>. Length-delimited
// fields are returned as raw Buffers (decode again for nested messages);
// varint fields as BigInt.
function decodeMessage(buf) {
  const fields = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const [tag, afterTag] = readVarint(buf, offset);
    offset = afterTag;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    let value;
    if (wireType === 0) {
      const [v, next] = readVarint(buf, offset);
      value = v; offset = next;
    } else if (wireType === 2) {
      const [len, next] = readVarint(buf, offset);
      const lenNum = Number(len);
      value = buf.subarray(next, next + lenNum);
      offset = next + lenNum;
    } else if (wireType === 1) {
      value = buf.readBigUInt64LE(offset); offset += 8;
    } else if (wireType === 5) {
      value = BigInt(buf.readUInt32LE(offset)); offset += 4;
    } else {
      throw new Error(`loon: unsupported protobuf wire type ${wireType}`);
    }
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
    fields.get(fieldNumber).push(value);
  }
  return fields;
}

const rawOf = (fields, num) => { const a = fields.get(num); return a ? a[0] : undefined; };
const strOf = (fields, num) => { const b = rawOf(fields, num); return b === undefined ? undefined : Buffer.from(b).toString('utf8'); };
const numOf = (fields, num) => { const v = rawOf(fields, num); return v === undefined ? undefined : Number(v); };
const bufOf = (fields, num) => { const b = rawOf(fields, num); return b === undefined ? undefined : Buffer.from(b); };

// ClientMessage oneof: empty_response=1, content_header=2, content_chunk=3, close_response=4
function encodeEmptyResponse(requestId) {
  return encodeLenField(1, encodeVarintField(1, requestId));
}
function encodeContentHeader({ requestId, contentType, contentSize, maxCacheDuration, filename }) {
  let inner = Buffer.concat([
    encodeVarintField(1, requestId),
    encodeStringField(2, contentType),
    encodeVarintField(3, contentSize)
  ]);
  if (maxCacheDuration !== undefined && maxCacheDuration !== null) inner = Buffer.concat([inner, encodeVarintField(4, maxCacheDuration)]);
  if (filename) inner = Buffer.concat([inner, encodeStringField(5, filename)]);
  return encodeLenField(2, inner);
}
function encodeContentChunk({ requestId, sequence, data }) {
  const inner = Buffer.concat([
    encodeVarintField(1, requestId),
    encodeVarintField(2, sequence),
    encodeLenField(3, data)
  ]);
  return encodeLenField(3, inner);
}
function encodeCloseResponse(requestId) {
  return encodeLenField(4, encodeVarintField(1, requestId));
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const DEFAULT_CHUNK_SIZE = 65536;

class LoonClient extends EventEmitter {
  constructor({ url, reconnectDelayMs = 5000, ca = null }) {
    super();
    this.url = url;
    this.reconnectDelayMs = reconnectDelayMs;
    this.ca = ca;
    this.ws = null;
    this.hello = null;
    this.resources = new Map(); // path -> { data: Buffer, contentType: string }
    this.closedByUser = true;
    this._reconnectTimer = null;
  }

  connect() {
    this.closedByUser = false;
    this._open();
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this._reconnectTimer);
    this.hello = null;
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
  }

  get connected() { return !!this.hello; }

  _open() {
    const ws = new MiniWebSocket({ ca: this.ca });
    this.ws = ws;
    ws.on('message', (buf) => {
      try {
        this._handleServerMessage(buf);
      } catch (err) {
        this.emit('error', err);
      }
    });
    ws.on('close', () => {
      const wasConnected = this.connected;
      this.hello = null;
      if (wasConnected) this.emit('disconnected');
      if (!this.closedByUser) this._scheduleReconnect();
    });
    ws.on('error', (err) => {
      this.emit('error', err);
    });
    try {
      ws.open(this.url);
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.closedByUser) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._open(), this.reconnectDelayMs);
  }

  _send(buf) {
    try {
      if (this.ws && this.ws.isOpen()) this.ws.sendBinary(buf);
    } catch (err) {
      this.emit('error', err);
    }
  }

  _handleServerMessage(buf) {
    const fields = decodeMessage(buf);
    if (fields.has(1)) { // Hello
      const inner = decodeMessage(rawOf(fields, 1));
      const constraintsRaw = rawOf(inner, 4);
      const constraints = constraintsRaw ? decodeMessage(constraintsRaw) : new Map();
      this.hello = {
        baseUrl: strOf(inner, 1) || '',
        clientId: strOf(inner, 2) || '',
        secret: bufOf(inner, 3) || Buffer.alloc(0),
        chunkSize: numOf(constraints, 1) || DEFAULT_CHUNK_SIZE,
        maxContentSize: numOf(constraints, 2) || (16 * 1024 * 1024)
      };
      this.emit('connected', this.hello);
      return;
    }
    if (fields.has(2)) { // Request
      const inner = decodeMessage(rawOf(fields, 2));
      const requestId = numOf(inner, 1);
      const requestPath = strOf(inner, 3) || '';
      this._handleRequest(requestId, requestPath);
      return;
    }
    if (fields.has(3)) { // Success - informational only
      return;
    }
    if (fields.has(4)) { // RequestClosed
      const inner = decodeMessage(rawOf(fields, 4));
      const requestId = numOf(inner, 1);
      this._send(encodeCloseResponse(requestId));
      return;
    }
    if (fields.has(5)) { // Close
      const inner = decodeMessage(rawOf(fields, 5));
      const reason = numOf(inner, 1);
      const message = strOf(inner, 2) || '';
      this.emit('serverClose', { reason, message });
      return;
    }
  }

  _handleRequest(requestId, requestPath) {
    const resource = this.resources.get(requestPath);
    if (!resource || !resource.data || resource.data.length === 0) {
      this._send(encodeEmptyResponse(requestId));
      return;
    }
    const chunkSize = (this.hello && this.hello.chunkSize) || DEFAULT_CHUNK_SIZE;
    this._send(encodeContentHeader({
      requestId,
      contentType: resource.contentType || 'application/octet-stream',
      contentSize: resource.data.length
    }));
    let sequence = 0;
    for (let offset = 0; offset < resource.data.length; offset += chunkSize) {
      const chunk = resource.data.subarray(offset, Math.min(offset + chunkSize, resource.data.length));
      this._send(encodeContentChunk({ requestId, sequence, data: chunk }));
      sequence += 1;
    }
  }

  // Registers content under a path and returns its public URL (or null if
  // not yet connected). The same path/content combination always yields the
  // same URL for the lifetime of the connection.
  registerContent(pathName, data, contentType) {
    this.resources.set(pathName, { data, contentType });
    return this.urlFor(pathName);
  }

  unregisterContent(pathName) {
    this.resources.delete(pathName);
  }

  urlFor(pathName) {
    if (!this.hello) return null;
    const mac = crypto.createHmac('sha256', this.hello.secret)
      .update(`${this.hello.clientId}/${pathName}`)
      .digest();
    return `${this.hello.baseUrl}/${this.hello.clientId}/${base64url(mac)}/${pathName}`;
  }
}

module.exports = { LoonClient };
