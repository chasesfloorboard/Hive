'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isAuthenticAudioBuffer,
  isAuthenticAudioFile,
  isAuthenticImageBuffer,
  assertSafeFilePath
} = require('../app/main/media-security');

test('isAuthenticAudioBuffer identifies audio headers correctly', () => {
  // MP3 with ID3
  assert.equal(isAuthenticAudioBuffer(Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00]), 'mp3'), true);
  // MP3 bare sync
  assert.equal(isAuthenticAudioBuffer(Buffer.from([0xFF, 0xFB, 0x90, 0x64]), 'mp3'), true);
  // FLAC
  assert.equal(isAuthenticAudioBuffer(Buffer.from([0x66, 0x4C, 0x61, 0x43, 0x00]), 'flac'), true);
  // WAV
  assert.equal(isAuthenticAudioBuffer(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]), 'wav'), true);
  // OGG
  assert.equal(isAuthenticAudioBuffer(Buffer.from([0x4F, 0x67, 0x67, 0x53, 0x00]), 'ogg'), true);
  // M4A
  assert.equal(isAuthenticAudioBuffer(Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41]), 'm4a'), true);
  // Non-audio / malicious payload (e.g. ELF binary or shell script)
  assert.equal(isAuthenticAudioBuffer(Buffer.from([0x7F, 0x45, 0x4C, 0x46]), 'mp3'), false);
  assert.equal(isAuthenticAudioBuffer(Buffer.from('#!/bin/bash\n'), 'flac'), false);
  assert.equal(isAuthenticAudioBuffer(Buffer.from('<html>'), 'mp3'), false);
  assert.equal(isAuthenticAudioBuffer(Buffer.alloc(0), 'mp3'), false);
});

test('isAuthenticAudioFile validates on-disk files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-security-'));
  try {
    const validFlac = path.join(tmpDir, 'test.flac');
    fs.writeFileSync(validFlac, Buffer.concat([Buffer.from([0x66, 0x4C, 0x61, 0x43]), Buffer.alloc(30)]));
    assert.equal(isAuthenticAudioFile(validFlac), true);

    const fakeMp3 = path.join(tmpDir, 'evil.mp3');
    fs.writeFileSync(fakeMp3, Buffer.from('#!/bin/sh\nrm -rf /'));
    assert.equal(isAuthenticAudioFile(fakeMp3), false);

    assert.equal(isAuthenticAudioFile(path.join(tmpDir, 'nonexistent.mp3')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('isAuthenticImageBuffer validates JPEG, PNG, and WEBP buffers', () => {
  assert.equal(isAuthenticImageBuffer(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46])), true);
  assert.equal(isAuthenticImageBuffer(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), true);
  assert.equal(isAuthenticImageBuffer(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])), true);

  // HTML or script payload
  assert.equal(isAuthenticImageBuffer(Buffer.from('<svg></svg>')), false);
  assert.equal(isAuthenticImageBuffer(Buffer.from('GIF89a')), false);
  assert.equal(isAuthenticImageBuffer(Buffer.from('evil executable payload')), false);
});

test('assertSafeFilePath rejects null bytes and traversal outside roots', () => {
  assert.throws(() => assertSafeFilePath('/music/a\0.mp3'), /null byte/);

  const root = '/mnt/music';
  assert.equal(assertSafeFilePath('/mnt/music/artist/album/song.mp3', [root]), path.resolve('/mnt/music/artist/album/song.mp3'));
  assert.throws(() => assertSafeFilePath('/etc/passwd', [root]), /Access outside allowed/);
  assert.throws(() => assertSafeFilePath('/mnt/music/../../etc/passwd', [root]), /Access outside allowed/);
});
