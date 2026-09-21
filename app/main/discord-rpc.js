'use strict';

// Minimal Discord IPC client for Rich Presence (the same local Unix-socket
// protocol the official discord-rpc library and every third-party Rich
// Presence client use). Intentionally hand-rolled and dependency-free: the
// protocol is a small fixed binary framing over a JSON payload.
//
// Frame: <int32 LE opcode><int32 LE length><payload bytes>
// Opcodes: 0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG.

const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function socketCandidates() {
  const paths = [];
  const bases = [
    process.env.XDG_RUNTIME_DIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    '/tmp'
  ].filter(Boolean);
  const subdirs = ['', 'app/com.discordapp.Discord', 'snap.discord'];
  for (const base of bases) {
    for (const sub of subdirs) {
      for (let i = 0; i < 10; i += 1) {
        paths.push(require('path').join(base, sub, `discord-ipc-${i}`));
      }
    }
  }
  return paths;
}

class DiscordRPC extends EventEmitter {
  constructor({ clientId, reconnectDelayMs = 10000 }) {
    super();
    this.clientId = String(clientId || '');
    this.reconnectDelayMs = reconnectDelayMs;
    this.socket = null;
    this.ready = false;
    this.closedByUser = true;
    this._reconnectTimer = null;
    this._recvBuffer = Buffer.alloc(0);
  }

  connect() {
    this.closedByUser = false;
    this._tryConnect();
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this._reconnectTimer);
    this.ready = false;
    try {
      if (this.socket) this._writeFrame(OP.CLOSE, {});
    } catch {}
    try { this.socket && this.socket.end(); } catch {}
    this.socket = null;
  }

  _scheduleReconnect() {
    if (this.closedByUser) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._tryConnect(), this.reconnectDelayMs);
  }

  _tryConnect() {
    const candidates = socketCandidates();
    const attempt = (index) => {
      if (index >= candidates.length) {
        this.emit('error', new Error('No Discord IPC socket found (is Discord running?)'));
        this._scheduleReconnect();
        return;
      }
      const socketPath = candidates[index];
      const socket = net.createConnection(socketPath);
      let settled = false;
      socket.once('connect', () => {
        settled = true;
        this.socket = socket;
        this._recvBuffer = Buffer.alloc(0);
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => {
          const wasReady = this.ready;
          this.ready = false;
          this.socket = null;
          if (wasReady) this.emit('disconnected');
          this._scheduleReconnect();
        });
        socket.on('error', (err) => this.emit('error', err));
        this._writeFrame(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
      });
      socket.once('error', () => {
        if (settled) return;
        try { socket.destroy(); } catch {}
        attempt(index + 1);
      });
    };
    attempt(0);
  }

  _writeFrame(opcode, payload) {
    if (!this.socket) return;
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(opcode, 0);
    header.writeInt32LE(json.length, 4);
    try { this.socket.write(Buffer.concat([header, json])); } catch (err) { this.emit('error', err); }
  }

  _onData(chunk) {
    this._recvBuffer = Buffer.concat([this._recvBuffer, chunk]);
    for (;;) {
      if (this._recvBuffer.length < 8) return;
      const opcode = this._recvBuffer.readInt32LE(0);
      const length = this._recvBuffer.readInt32LE(4);
      if (this._recvBuffer.length < 8 + length) return;
      const payload = this._recvBuffer.subarray(8, 8 + length);
      this._recvBuffer = this._recvBuffer.subarray(8 + length);
      this._handleFrame(opcode, payload);
    }
  }

  _handleFrame(opcode, payload) {
    if (opcode === OP.PING) {
      try { this.socket.write(Buffer.concat([(() => { const h = Buffer.alloc(8); h.writeInt32LE(OP.PONG, 0); h.writeInt32LE(payload.length, 4); return h; })(), payload])); } catch {}
      return;
    }
    if (opcode === OP.CLOSE) {
      this.ready = false;
      this.emit('disconnected');
      return;
    }
    if (opcode !== OP.FRAME) return;
    let message;
    try { message = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (message && message.cmd === 'DISPATCH' && message.evt === 'READY') {
      this.ready = true;
      this.emit('ready');
      return;
    }
    if (message && message.evt === 'ERROR') {
      this.emit('error', new Error(message.data && message.data.message || 'Discord RPC error'));
    }
  }

  setActivity(activity) {
    if (!this.ready) return false;
    this._writeFrame(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: crypto.randomUUID()
    });
    return true;
  }

  clearActivity() {
    if (!this.ready) return false;
    this._writeFrame(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: null },
      nonce: crypto.randomUUID()
    });
    return true;
  }
}

module.exports = { DiscordRPC };
