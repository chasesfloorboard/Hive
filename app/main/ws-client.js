'use strict';

// Minimal RFC 6455 WebSocket client over Node's own net/tls sockets.
//
// Written by hand instead of using node-datachannel's WebSocket (already a
// dependency, tried first) because that implementation has two hard
// limitations that make it unusable against a self-hosted loon deployment:
// it does not support HTTP Basic Auth on the handshake (logs "HTTP
// authentication support for WebSocket is not implemented" and gets 401),
// and it enforces strict TLS certificate verification with no override,
// which rejects a Caddy `tls internal` self-signed certificate outright.
// Both are exactly what a personal, self-hosted loon+bore deployment uses.
//
// This intentionally implements only what the loon protocol needs: binary
// messages, ping/pong, and a clean close. No text-message API, no
// fragmentation support beyond what's required to receive it defensively.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { URL } = require('url');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA };

function maskPayload(payload, mask) {
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ mask[i % 4];
  return out;
}

function encodeFrame(opcode, payload, masked) {
  const len = payload.length;
  const parts = [];
  let firstByte = 0x80 | opcode; // FIN=1
  parts.push(Buffer.from([firstByte]));
  const maskBit = masked ? 0x80 : 0x00;
  if (len < 126) {
    parts.push(Buffer.from([maskBit | len]));
  } else if (len <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = maskBit | 126;
    b.writeUInt16BE(len, 1);
    parts.push(b);
  } else {
    const b = Buffer.alloc(9);
    b[0] = maskBit | 127;
    b.writeBigUInt64BE(BigInt(len), 1);
    parts.push(b);
  }
  if (masked) {
    const mask = crypto.randomBytes(4);
    parts.push(mask);
    parts.push(maskPayload(payload, mask));
  } else {
    parts.push(payload);
  }
  return Buffer.concat(parts);
}

class MiniWebSocket extends EventEmitter {
  // `ca`, when given, pins TLS trust to that specific certificate authority
  // (e.g. a self-hosted deployment's own internal CA) instead of the system
  // trust store, so only that known server -- not "any" certificate -- is
  // accepted. Verification (`rejectUnauthorized`) always stays on; pinning
  // narrows *which* certificates pass, it never disables the check itself.
  constructor({ ca = null, headers = {} } = {}) {
    super();
    this.ca = ca;
    this.extraHeaders = headers;
    this.socket = null;
    this._recvBuffer = Buffer.alloc(0);
    this._handshakeDone = false;
    this._expectedAccept = '';
    this._open = false;
  }

  open(urlString) {
    const url = new URL(urlString);
    const isSecure = url.protocol === 'wss:';
    const port = url.port ? Number(url.port) : (isSecure ? 443 : 80);
    const key = crypto.randomBytes(16).toString('base64');
    this._expectedAccept = crypto.createHash('sha1').update(key + GUID).digest('base64');

    const connectOptions = { host: url.hostname, port };
    const onConnect = () => {
      const headerLines = [
        `GET ${url.pathname || '/'} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13'
      ];
      if (url.username) {
        const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password || '')}`).toString('base64');
        headerLines.push(`Authorization: Basic ${auth}`);
      }
      for (const [k, v] of Object.entries(this.extraHeaders)) headerLines.push(`${k}: ${v}`);
      this.socket.write(headerLines.join('\r\n') + '\r\n\r\n');
    };

    const tlsOptions = { ...connectOptions, servername: url.hostname };
    if (this.ca) tlsOptions.ca = this.ca;
    this.socket = isSecure
      ? tls.connect(tlsOptions, onConnect)
      : net.connect(connectOptions, onConnect);

    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => { this._open = false; this.emit('close'); });
  }

  isOpen() { return this._open; }

  _onData(chunk) {
    this._recvBuffer = Buffer.concat([this._recvBuffer, chunk]);
    if (!this._handshakeDone) {
      const headerEnd = this._recvBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headerText = this._recvBuffer.subarray(0, headerEnd).toString('utf8');
      this._recvBuffer = this._recvBuffer.subarray(headerEnd + 4);
      const statusLine = headerText.split('\r\n')[0] || '';
      const statusMatch = statusLine.match(/^HTTP\/1\.\d (\d+)/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      if (status !== 101) {
        this.emit('error', new Error(`WebSocket handshake failed with HTTP ${status || 'unknown'}: ${statusLine}`));
        try { this.socket.destroy(); } catch {}
        return;
      }
      const acceptMatch = headerText.match(/Sec-WebSocket-Accept:\s*(\S+)/i);
      if (!acceptMatch || acceptMatch[1] !== this._expectedAccept) {
        this.emit('error', new Error('WebSocket handshake failed: invalid Sec-WebSocket-Accept'));
        try { this.socket.destroy(); } catch {}
        return;
      }
      this._handshakeDone = true;
      this._open = true;
      this.emit('open');
    }
    this._parseFrames();
  }

  _parseFrames() {
    for (;;) {
      const buf = this._recvBuffer;
      if (buf.length < 2) return;
      const firstByte = buf[0];
      const opcode = firstByte & 0x0f;
      const secondByte = buf[1];
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < offset + 2) return;
        payloadLen = buf.readUInt16BE(offset); offset += 2;
      } else if (payloadLen === 127) {
        if (buf.length < offset + 8) return;
        payloadLen = Number(buf.readBigUInt64BE(offset)); offset += 8;
      }
      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4); offset += 4;
      }
      if (buf.length < offset + payloadLen) return;
      let payload = buf.subarray(offset, offset + payloadLen);
      if (masked) payload = maskPayload(payload, mask);
      this._recvBuffer = buf.subarray(offset + payloadLen);
      this._handleFrame(opcode, Buffer.from(payload));
    }
  }

  _handleFrame(opcode, payload) {
    if (opcode === OPCODE.BINARY || opcode === OPCODE.TEXT || opcode === OPCODE.CONTINUATION) {
      this.emit('message', payload);
      return;
    }
    if (opcode === OPCODE.PING) {
      this._sendFrame(OPCODE.PONG, payload);
      return;
    }
    if (opcode === OPCODE.PONG) {
      return;
    }
    if (opcode === OPCODE.CLOSE) {
      this._open = false;
      try { this._sendFrame(OPCODE.CLOSE, Buffer.alloc(0)); } catch {}
      try { this.socket.end(); } catch {}
      return;
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.socket) return;
    this.socket.write(encodeFrame(opcode, payload, true));
  }

  sendBinary(buffer) {
    if (!this._open) return false;
    this._sendFrame(OPCODE.BINARY, Buffer.from(buffer));
    return true;
  }

  close() {
    this._open = false;
    try { this._sendFrame(OPCODE.CLOSE, Buffer.alloc(0)); } catch {}
    try { this.socket && this.socket.end(); } catch {}
  }

  forceClose() {
    this._open = false;
    try { this.socket && this.socket.destroy(); } catch {}
  }
}

module.exports = { MiniWebSocket };
