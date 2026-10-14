'use strict';
// Hive equaliser model (MusicBee-compatible). Pure logic only: preset
// parsing/serialising in MusicBee's .sde format, band layouts, the native
// helper's EQ command, and genre auto-selection. Loaded as a plain script
// (window.HiveEqualiser) by the renderer and via require() by main/tests.
(function (root) {
  // MusicBee's own centre frequencies for its 10- and 15-band modes.
  const FREQUENCIES = {
    10: [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
    15: [31.25, 49.2, 77.5, 122, 192.3, 302.9, 477, 751.3, 1183.3, 1863.7, 2935.3, 4623.1, 7281.4, 11468.3, 18062.5]
  };
  const MIN_DB = -15;
  const MAX_DB = 12; // GStreamer's equalizer tops out at +12 dB
  const MANUAL = 'Manual';
  const AUTO_GENRE = 'Auto-Select by Genre';

  const clampDb = v => Math.max(MIN_DB, Math.min(MAX_DB, Number.isFinite(Number(v)) ? Number(v) : 0));
  const bandCountOf = n => (Number(n) === 15 ? 15 : 10);

  function flatPreset(name = MANUAL, bands = 10) {
    const count = bandCountOf(bands);
    return { name, bands: count, preamp: 0, gains: new Array(count).fill(0) };
  }

  // Each band's width spans halfway to its neighbours on a log scale, so the
  // bands tile the spectrum without gaps (10-band: 1 octave, 15-band: ~2/3).
  function bandwidths(freqs) {
    return freqs.map((f, i) => {
      const ratio = i < freqs.length - 1 ? freqs[i + 1] / f : f / freqs[i - 1];
      return f * (Math.sqrt(ratio) - 1 / Math.sqrt(ratio));
    });
  }

  // MusicBee .sde: an INI [Equalizer] section with LeftPreamp/RightPreamp,
  // Left1..LeftN/Right1..RightN and Bands=N. Hive's EQ is stereo-linked, so
  // the two channels are averaged.
  function parseSde(text, name = '') {
    const values = {};
    for (const raw of String(text || '').split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Za-z]+\d*)\s*=\s*(.*?)\s*$/);
      if (m) values[m[1].toLowerCase()] = m[2];
    }
    const count = bandCountOf(values.bands || (values.left11 !== undefined ? 15 : 10));
    const num = k => Number.parseFloat(String(values[k] ?? '0').replace(',', '.')) || 0;
    const avg = (l, r) => (values[r] === undefined ? num(l) : (num(l) + num(r)) / 2);
    const gains = [];
    for (let i = 1; i <= count; i++) gains.push(clampDb(avg(`left${i}`, `right${i}`)));
    return { name: String(name), bands: count, preamp: clampDb(avg('leftpreamp', 'rightpreamp')), gains };
  }

  function serializeSde(preset) {
    const p = normalisePreset(preset);
    const fmt = v => (Math.round(v * 10) / 10).toFixed(1);
    const lines = ['[Equalizer]', `LeftPreamp=${fmt(p.preamp)}`, `RightPreamp=${fmt(p.preamp)}`];
    p.gains.forEach((g, i) => { lines.push(`Left${i + 1}=${fmt(g)}`, `Right${i + 1}=${fmt(g)}`); });
    lines.push(`Bands=${p.bands}`);
    return lines.join('\r\n') + '\r\n';
  }

  function normalisePreset(preset) {
    const count = bandCountOf(preset?.bands);
    const gains = Array.from({ length: count }, (_, i) => clampDb(preset?.gains?.[i]));
    return { name: String(preset?.name || MANUAL), bands: count, preamp: clampDb(preset?.preamp), gains };
  }

  // Re-sample a preset onto the other band layout (switching 10 <-> 15 bands
  // keeps the curve's shape) by interpolating gain over log frequency.
  function resample(preset, bands) {
    const src = normalisePreset(preset);
    const count = bandCountOf(bands);
    if (count === src.bands) return src;
    const from = FREQUENCIES[src.bands].map(Math.log);
    const gains = FREQUENCIES[count].map(f => {
      const x = Math.log(f);
      if (x <= from[0]) return src.gains[0];
      if (x >= from[from.length - 1]) return src.gains[src.gains.length - 1];
      const i = from.findIndex((v, k) => x >= v && x <= from[k + 1]);
      const t = (x - from[i]) / (from[i + 1] - from[i]);
      return Math.round((src.gains[i] + t * (src.gains[i + 1] - src.gains[i])) * 10) / 10;
    });
    return { ...src, bands: count, gains };
  }

  // Native helper command: EQ\t<enabled>\t<preamp dB>\t<freq:gain:width,...>
  function eqCommand(preset, enabled) {
    if (!enabled || !preset) return 'EQ\t0\t0';
    const p = normalisePreset(preset);
    const freqs = FREQUENCIES[p.bands];
    const widths = bandwidths(freqs);
    const bands = freqs.map((f, i) => `${f}:${p.gains[i]}:${widths[i].toFixed(2)}`).join(',');
    return `EQ\t1\t${p.preamp}\t${bands}`;
  }

  // MusicBee's "Auto-Select by Genre": use the preset named like the
  // playing track's genre (case/punctuation-insensitive; "Hip Hop/Rap"
  // matches "Hip-Hop"), else the fallback.
  function presetForGenre(presets, genre, fallback) {
    const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const parts = String(genre || '').split(/[;/,|]+/).map(key).filter(Boolean);
    for (const part of parts) {
      const hit = (presets || []).find(p => key(p.name) === part || (part.startsWith(key(p.name)) && key(p.name).length >= 3));
      if (hit) return hit;
    }
    return fallback || null;
  }

  // Built-in starting points (10-band). Users add their own or import
  // MusicBee .sde files; these are only seeded when the folder is empty.
  const BUILT_IN = [
    ['Flat', 0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    ['Bass Booster', -3, [6, 5, 4, 2.5, 1, 0, 0, 0, 0, 0]],
    ['Bass Reducer', 0, [-6, -5, -4, -2.5, -1, 0, 0, 0, 0, 0]],
    ['Treble Booster', -3, [0, 0, 0, 0, 0, 1, 2.5, 4, 5, 6]],
    ['Treble Reducer', 0, [0, 0, 0, 0, 0, -1, -2.5, -4, -5, -6]],
    ['Vocal Booster', -2, [-2, -2, -1, 1, 3, 3.5, 3, 1.5, 0, -1]],
    ['Loudness', -4, [5, 4, 1.5, 0, -1, 0, 0, 1.5, 4, 3]],
    ['Small Speakers', -3, [4.5, 4, 3, 1.5, 0, -0.5, 0, 1, 2, 2.5]],
    ['Spoken Word', -1, [-4, -2, 0, 1, 3, 4, 4, 2, 0, -3]],
    ['Acoustic', -2, [3.5, 3, 2.5, 1, 1.5, 1.5, 2.5, 3, 2.5, 1.5]],
    ['Classical', -1, [3.5, 3, 2.5, 2, -1, -1, 0, 2, 2.5, 3]],
    ['Dance', -3, [4, 6, 4.5, 0, 1.5, 3, 4.5, 4, 3, 0]],
    ['Electronic', -3, [4, 3.5, 1, 0, -2, 2, 1, 1.5, 4, 5]],
    ['Hip-Hop', -3, [5, 4, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3]],
    ['Jazz', -2, [3.5, 2.5, 1, 2, -1.5, -1.5, 0, 1.5, 3, 3.5]],
    ['Pop', -2, [-1, -0.5, 0, 2, 4, 4, 2, 0, -0.5, -1]],
    ['RnB', -3, [2.5, 6.5, 5, 1.5, -2.5, -1.5, 2, 2.5, 3, 3.5]],
    ['Rock', -3, [5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5]],
    ['Metal', -3, [4.5, 4, 2, 0, -2, -1, 1, 3, 4, 3]],
    ['Reggae', -2, [0, 0, 0, -3, 0, 3.5, 3.5, 0, 0, 0]]
  ].map(([name, preamp, gains]) => ({ name, bands: 10, preamp, gains }));

  const api = { FREQUENCIES, MIN_DB, MAX_DB, MANUAL, AUTO_GENRE, BUILT_IN, flatPreset, bandwidths, parseSde, serializeSde, normalisePreset, resample, eqCommand, presetForGenre };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveEqualiser = api;
})(typeof window !== 'undefined' ? window : globalThis);
