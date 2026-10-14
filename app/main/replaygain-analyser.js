'use strict';

// Hive "Analyse volume" (MusicBee's ReplayGain analysis). Loudness comes
// from ffmpeg's EBU R128 scanner; tags follow ReplayGain 2.0: gain is the
// difference to -18 LUFS, peak is the linear true peak. Album gain uses the
// duration-weighted power mean of the tracks' loudness, which matches an
// album-wide measurement closely without decoding the album twice.

const { spawn } = require('child_process');

const REFERENCE_LUFS = -18;

function parseEbur128Summary(stderr) {
  const text = String(stderr || '');
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const loudness = Number((/\bI:\s*(-?[\d.]+)\s*LUFS/.exec(summary) || [])[1]);
  const peakDb = Number((/\bPeak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(summary) || [])[1]);
  return {
    loudness: Number.isFinite(loudness) ? loudness : null,
    peak: Number.isFinite(peakDb) ? Math.pow(10, peakDb / 20) : 0
  };
}

function analyseFile(file, { ffmpeg = 'ffmpeg', spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-filter:a', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'];
    const child = spawnImpl(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    child.on('error', reject);
    child.on('close', code => {
      const result = parseEbur128Summary(stderr);
      if (code !== 0 || result.loudness === null) reject(new Error(`ffmpeg could not measure ${file}`));
      else resolve(result);
    });
  });
}

const formatGain = db => `${db >= 0 ? '+' : ''}${db.toFixed(2)} dB`;

// results: [{ path, loudness, peak, duration }] for one album.
function albumValues(results) {
  const usable = results.filter(r => Number.isFinite(r.loudness) && r.loudness > -70);
  if (!usable.length) return null;
  const weight = r => Math.max(1, Number(r.duration) || 1);
  const total = usable.reduce((n, r) => n + weight(r), 0);
  const power = usable.reduce((n, r) => n + weight(r) * Math.pow(10, r.loudness / 10), 0) / total;
  return { loudness: 10 * Math.log10(power), peak: Math.max(...usable.map(r => r.peak || 0)) };
}

function replayGainTags(track, album) {
  const tags = {
    REPLAYGAIN_TRACK_GAIN: formatGain(REFERENCE_LUFS - track.loudness),
    REPLAYGAIN_TRACK_PEAK: (track.peak || 0).toFixed(6)
  };
  if (album) {
    tags.REPLAYGAIN_ALBUM_GAIN = formatGain(REFERENCE_LUFS - album.loudness);
    tags.REPLAYGAIN_ALBUM_PEAK = (album.peak || 0).toFixed(6);
  }
  return tags;
}

module.exports = { REFERENCE_LUFS, parseEbur128Summary, analyseFile, albumValues, replayGainTags, formatGain };
