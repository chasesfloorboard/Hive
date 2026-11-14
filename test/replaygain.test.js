'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replayGainDbToLinear, replayGainPeakValue, r128GainToReplayGainText } = require('../app/renderer/replaygain');

test('replayGainDbToLinear converts dB to a linear multiplier, defaulting to unity', () => {
  assert.equal(replayGainDbToLinear('0 dB'), 1);
  assert.ok(Math.abs(replayGainDbToLinear('-6.0 dB') - Math.pow(10, -6 / 20)) < 1e-12);
  assert.ok(Math.abs(replayGainDbToLinear('+3.5') - Math.pow(10, 3.5 / 20)) < 1e-12, 'bare number + no "dB"');
  assert.equal(replayGainDbToLinear(''), 1, 'absent -> unity');
  assert.equal(replayGainDbToLinear(null), 1);
  assert.equal(replayGainDbToLinear('not a number'), 1);
});

test('replayGainPeakValue parses a positive peak, else 0', () => {
  assert.equal(replayGainPeakValue('0.97'), 0.97);
  assert.equal(replayGainPeakValue('1.0'), 1);
  assert.equal(replayGainPeakValue('0'), 0, 'zero/negative -> 0');
  assert.equal(replayGainPeakValue('-0.5'), 0);
  assert.equal(replayGainPeakValue(''), 0);
  assert.equal(replayGainPeakValue(null), 0);
});

test('r128GainToReplayGainText converts Q7.8 R128 gain to a ReplayGain dB string (+5 dB reference offset)', () => {
  assert.equal(r128GainToReplayGainText('0'), '5.00 dB', '0 R128 (-23 LUFS) -> +5 dB vs ReplayGain -18 LUFS');
  assert.equal(r128GainToReplayGainText('-256'), '4.00 dB', '-256 = -1 dB -> 5 - 1');
  assert.equal(r128GainToReplayGainText('256'), '6.00 dB');
  assert.equal(r128GainToReplayGainText(''), '', 'absent -> empty');
  assert.equal(r128GainToReplayGainText('xyz'), '');
});
