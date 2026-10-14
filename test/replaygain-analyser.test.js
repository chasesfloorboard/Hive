const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RG = require('../app/main/replaygain-analyser');

test('parses the ffmpeg ebur128 summary (integrated loudness and true peak)', () => {
  const stderr = '[Parsed_ebur128_0] t: 1 M: -20 S: -20 I: -99.0 LUFS\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.2 LUFS\n\n  True peak:\n    Peak:       -0.4 dBFS\n';
  const r = RG.parseEbur128Summary(stderr);
  assert.equal(r.loudness, -14.2);
  assert.ok(Math.abs(r.peak - Math.pow(10, -0.4 / 20)) < 1e-9);
});

test('ReplayGain 2.0 tags: gain to -18 LUFS, album from duration-weighted power mean', () => {
  const tags = RG.replayGainTags({ loudness: -14.2, peak: 0.95 }, RG.albumValues([{ loudness: -14, peak: 0.9, duration: 100 }, { loudness: -14, peak: 0.97, duration: 300 }]));
  assert.equal(tags.REPLAYGAIN_TRACK_GAIN, '-3.80 dB');
  assert.equal(tags.REPLAYGAIN_TRACK_PEAK, '0.950000');
  assert.equal(tags.REPLAYGAIN_ALBUM_GAIN, '-4.00 dB');
  assert.equal(tags.REPLAYGAIN_ALBUM_PEAK, '0.970000');
  assert.equal(RG.formatGain(3), '+3.00 dB');
  assert.equal(RG.albumValues([{ loudness: null }]), null);
});

test('measures a real file with ffmpeg', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-rg-'));
  const file = path.join(dir, 'tone.flac');
  try {
    const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3', file]);
    assert.equal(made.status, 0);
    const r = await RG.analyseFile(file);
    assert.ok(r.loudness < -15 && r.loudness > -30, `loudness ${r.loudness}`);
    assert.ok(r.peak > 0 && r.peak < 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
