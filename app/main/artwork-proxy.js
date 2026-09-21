'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// Tiny localhost-only artwork server used by MPRIS consumers such as Music Presence.
// It exposes only Beehive's cached cover files and never binds to the LAN.
class ArtworkProxy {
  constructor(coversDir) {
    this.coversDir = () => path.resolve(typeof coversDir === 'function' ? coversDir() : coversDir);
    this.server = null;
    this.port = 0;
    this.host = '127.0.0.1';
  }

  async start() {
    if (this.server && this.port) return this.port;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(err => {
        try {
          if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
        } catch {}
        if (err?.code !== 'ENOENT') console.warn('[ArtworkProxy] request failed:', err?.message || err);
      });
    });

    await new Promise((resolve, reject) => {
      const onError = err => { server.off('listening', onListening); reject(err); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, this.host);
    });

    this.server = server;
    this.port = server.address()?.port || 0;
    if (!this.port) {
      try { server.close(); } catch {}
      this.server = null;
      throw new Error('Artwork proxy did not receive a port.');
    }
    console.info('[ArtworkProxy] Listening on', `${this.host}:${this.port}`);
    return this.port;
  }

  async handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const parsed = new URL(req.url || '/', `http://${this.host}`);
    if (!parsed.pathname.startsWith('/cover/')) {
      res.writeHead(404);
      res.end();
      return;
    }

    const encodedName = parsed.pathname.slice('/cover/'.length);
    let name;
    try { name = decodeURIComponent(encodedName); } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // Only a single basename is accepted. This prevents directory traversal and
    // keeps the endpoint limited to Beehive's cover cache.
    if (!name || name !== path.basename(name) || name.includes('\\') || name.includes('\0')) {
      res.writeHead(404);
      res.end();
      return;
    }

    const root = this.coversDir();
    const filePath = path.join(root, name);
    const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(rootPrefix)) {
      res.writeHead(404);
      res.end();
      return;
    }

    let stat;
    try { stat = await fsp.stat(resolved); } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }

    // Resolve symlinks as an extra containment check so this cannot become a
    // general local-file server even if a symlink appears in the cache.
    try {
      const realRoot = await fsp.realpath(root);
      const realFile = await fsp.realpath(resolved);
      const realPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (!realFile.startsWith(realPrefix)) {
        res.writeHead(404);
        res.end();
        return;
      }
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }

    const ext = path.extname(name).toLowerCase();
    const mime = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
      '.avif': 'image/avif'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(resolved).on('error', () => {
      try { res.destroy(); } catch {}
    }).pipe(res);
  }

  urlFor(filePath) {
    if (!this.server || !this.port || !filePath) return '';
    const name = path.basename(String(filePath));
    if (!name) return '';
    return `http://${this.host}:${this.port}/cover/${encodeURIComponent(name)}`;
  }

  stop() {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    try { server.close(); } catch {}
  }
}

module.exports = { ArtworkProxy };
