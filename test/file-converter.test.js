const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ffmpegArgs, outputPath, formatSpec } = require('../app/main/file-converter');

test('ffmpeg arguments keep tags, copy cover where possible and never overwrite', () => {
  const mp3 = ffmpegArgs('/in.flac', '/out.mp3', { format: 'mp3', quality: 'v0' });
  assert.ok(mp3.includes('-n'), 'refuses to overwrite');
  assert.deepEqual(mp3.slice(mp3.indexOf('-map_metadata'), mp3.indexOf('-map_metadata') + 2), ['-map_metadata', '0']);
  assert.ok(mp3.join(' ').includes('-map 0:v? -c:v copy -disposition:v attached_pic'));
  assert.ok(mp3.join(' ').includes('-c:a libmp3lame -q:a 0'));
  const opus = ffmpegArgs('/in.flac', '/out.opus', { format: 'opus', quality: '160' });
  assert.ok(!opus.includes('0:v?'), 'ogg covers are embedded afterwards, not as a stream');
  assert.ok(opus.join(' ').includes('-c:a libopus -b:a 160k'));
  assert.ok(ffmpegArgs('/a', '/b.m4a', { format: 'aac', quality: 'nope' }).join(' ').includes('-b:a 256k'), 'unknown quality falls back to the format default');
  assert.throws(() => formatSpec('wma'));
});

test('output paths: new extension, template folders, numbered when taken', () => {
  assert.equal(outputPath('/m/a/song.flac', { destination: '/out', format: 'mp3' }), path.join('/out', 'song.mp3'));
  assert.equal(outputPath('/m/a/song.flac', { format: 'opus' }), path.join('/m/a', 'song.opus'), 'beside the original');
  assert.equal(outputPath('/m/a/song.flac', { destination: '/out', relative: path.join('Artist', 'Album', '01 - Song.flac'), format: 'aac' }), path.join('/out', 'Artist', 'Album', '01 - Song.m4a'));
  assert.equal(outputPath('/m/song.flac', { format: 'flac' }), path.join('/m', 'song (2).flac'), 'never the input itself');
  assert.equal(outputPath('/m/song.flac', { destination: '/o', format: 'mp3', exists: p => p === path.join('/o', 'song.mp3') }), path.join('/o', 'song (2).mp3'));
});
