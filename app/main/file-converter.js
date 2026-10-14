'use strict';

// Hive File Converter (MusicBee's "Convert format"): ffmpeg conversions
// with tags kept (-map_metadata) and cover art copied where the container
// allows it. Ogg/Opus can't take an attached picture through ffmpeg, so the
// caller embeds the cover afterwards (see tag_helper embed_ogg_cover).

const path = require('path');

const FORMATS = {
  mp3: { label: 'MP3', ext: '.mp3', cover: 'stream', defaultQuality: 'v0', qualities: { v0: ['-c:a', 'libmp3lame', '-q:a', '0'], v2: ['-c:a', 'libmp3lame', '-q:a', '2'], 320: ['-c:a', 'libmp3lame', '-b:a', '320k'], 192: ['-c:a', 'libmp3lame', '-b:a', '192k'] }, extra: ['-id3v2_version', '3'] },
  aac: { label: 'AAC (.m4a)', ext: '.m4a', cover: 'stream', defaultQuality: '256', qualities: { 256: ['-c:a', 'aac', '-b:a', '256k'], 192: ['-c:a', 'aac', '-b:a', '192k'], 128: ['-c:a', 'aac', '-b:a', '128k'] }, extra: ['-movflags', '+faststart'] },
  opus: { label: 'Opus', ext: '.opus', cover: 'tagger', defaultQuality: '160', qualities: { 192: ['-c:a', 'libopus', '-b:a', '192k'], 160: ['-c:a', 'libopus', '-b:a', '160k'], 128: ['-c:a', 'libopus', '-b:a', '128k'], 96: ['-c:a', 'libopus', '-b:a', '96k'] }, extra: [] },
  vorbis: { label: 'Ogg Vorbis', ext: '.ogg', cover: 'tagger', defaultQuality: 'q6', qualities: { q8: ['-c:a', 'libvorbis', '-q:a', '8'], q6: ['-c:a', 'libvorbis', '-q:a', '6'], q4: ['-c:a', 'libvorbis', '-q:a', '4'] }, extra: [] },
  flac: { label: 'FLAC', ext: '.flac', cover: 'stream', defaultQuality: '8', qualities: { 8: ['-c:a', 'flac', '-compression_level', '8'], 5: ['-c:a', 'flac', '-compression_level', '5'] }, extra: [] }
};

function formatSpec(format, quality) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown format: ${format}`);
  // (Numeric object keys iterate in ascending order, so never rely on "first".)
  const q = spec.qualities[quality] ? String(quality) : spec.defaultQuality;
  return { ...spec, quality: q, codecArgs: spec.qualities[q] };
}

// Arguments for one conversion. sampleRate 0 = keep.
function ffmpegArgs(input, output, { format, quality, sampleRate = 0, embedArtwork = true } = {}) {
  const spec = formatSpec(format, quality);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', input, '-map', '0:a:0'];
  if (embedArtwork && spec.cover === 'stream') args.push('-map', '0:v?', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  args.push('-map_metadata', '0', ...spec.codecArgs, ...spec.extra);
  if (Number(sampleRate) > 0) args.push('-ar', String(Number(sampleRate)));
  args.push(output);
  return args;
}

// Output path: same name (or the organiser's relative path) under the
// destination folder, with the new extension; " (2)" etc. if taken.
function outputPath(input, { destination, relative, format, exists = () => false }) {
  const spec = formatSpec(format);
  const rel = relative || path.basename(input);
  const stemRel = rel.slice(0, rel.length - path.extname(rel).length);
  let out = path.join(destination || path.dirname(input), stemRel + spec.ext);
  const stem = out.slice(0, out.length - spec.ext.length);
  for (let n = 2; exists(out) || path.resolve(out) === path.resolve(input); n++) out = `${stem} (${n})${spec.ext}`;
  return out;
}

module.exports = { FORMATS, formatSpec, ffmpegArgs, outputPath };
