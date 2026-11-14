'use strict';
// ReplayGain parse/convert math (extracted from renderer.js — docs/ai/ARCHITECTURE.md). Pure helpers only;
// renderer.js keeps the stateful mode selection and tag reading. Loaded as a plain script
// (window.HiveReplayGain) and by the tests via require().
(function (root) {
  // A ReplayGain "X.XX dB" gain tag -> a linear gain multiplier (1 when absent/unparseable).
  function replayGainDbToLinear(db) {
    const n = Number.parseFloat(String(db ?? '').replace(/dB/i, '').trim());
    return Number.isFinite(n) ? Math.pow(10, n / 20) : 1;
  }

  // A ReplayGain peak tag -> a positive peak value (0 when absent/unparseable).
  function replayGainPeakValue(value) {
    const n = Number.parseFloat(String(value ?? '').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // An R128_TRACK_GAIN / R128_ALBUM_GAIN Q7.8 integer (Opus/Vorbis) -> the equivalent ReplayGain "X.XX dB"
  // text. R128 is referenced to -23 LUFS and ReplayGain to -18 LUFS, hence the +5 dB offset.
  function r128GainToReplayGainText(raw) {
    const q = Number.parseInt(String(raw ?? '').trim(), 10);
    return Number.isFinite(q) ? `${(q / 256 + 5).toFixed(2)} dB` : '';
  }

  const api = { replayGainDbToLinear, replayGainPeakValue, r128GainToReplayGainText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveReplayGain = api;
})(typeof window !== 'undefined' ? window : globalThis);
