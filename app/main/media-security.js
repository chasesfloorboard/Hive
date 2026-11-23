'use strict';

const fs = require('fs');
const path = require('path');

function isAuthenticAudioBuffer(buf, ext = '') {
  if (!buf || buf.length < 4) return false;
  const e = String(ext || '').toLowerCase().replace(/^\./, '');

  const isMp3 = (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || // 'ID3'
                (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0); // MPEG sync
  const isFlac = buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43; // 'fLaC'
  const isOgg = buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53; // 'OggS'
  const isWav = buf.length >= 12 &&
                buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // 'RIFF'
                buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45; // 'WAVE'
  const isAiff = buf.length >= 12 &&
                 buf[0] === 0x46 && buf[1] === 0x4F && buf[2] === 0x52 && buf[3] === 0x4D && // 'FORM'
                 buf[8] === 0x41 && buf[9] === 0x49 && buf[10] === 0x46 && (buf[11] === 0x46 || buf[11] === 0x43);
  const isMp4 = (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) || // 'ftyp'
                (buf[0] === 0xFF && (buf[1] & 0xF0) === 0xF0); // ADTS sync

  if (e === 'mp3') return isMp3;
  if (e === 'flac') return isFlac;
  if (e === 'wav') return isWav;
  if (e === 'ogg' || e === 'opus') return isOgg;
  if (e === 'm4a' || e === 'aac' || e === 'alac') return isMp4;
  if (e === 'aif' || e === 'aiff') return isAiff;

  return isMp3 || isFlac || isOgg || isWav || isMp4 || isAiff;
}

function isAuthenticAudioFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 12) return false;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    const read = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (read < 4) return false;
    const ext = path.extname(filePath);
    return isAuthenticAudioBuffer(buf.subarray(0, read), ext);
  } catch {
    return false;
  }
}

function isAuthenticImageBuffer(buf) {
  if (!buf || buf.length < 8) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return true;
  // WEBP: RIFF....WEBP
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

function assertSafeFilePath(targetPath, allowedRoots = []) {
  if (!targetPath || typeof targetPath !== 'string') throw new Error('Invalid file path.');
  if (targetPath.includes('\0')) throw new Error('Path contains null bytes.');
  const resolved = path.resolve(targetPath);
  if (allowedRoots.length > 0) {
    const inside = allowedRoots.some(root => {
      const r = path.resolve(root);
      return resolved === r || resolved.startsWith(r + path.sep);
    });
    if (!inside) throw new Error('Access outside allowed directory boundaries denied.');
  }
  return resolved;
}

module.exports = {
  isAuthenticAudioBuffer,
  isAuthenticAudioFile,
  isAuthenticImageBuffer,
  assertSafeFilePath
};
