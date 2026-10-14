const test = require('node:test');
const assert = require('node:assert/strict');
const EQ = require('../app/renderer/equaliser');

const CLUB_SDE = '[Equalizer]\r\nLeftPreamp=0.0\r\nRightPreamp=0.0\r\nLeft1=0.1\r\nRight1=0.1\r\nLeft2=0.1\r\nRight2=0.1\r\nLeft3=2.3\r\nRight3=2.3\r\nLeft4=3.5\r\nRight4=3.5\r\nLeft5=3.5\r\nRight5=3.5\r\nLeft6=3.5\r\nRight6=3.5\r\nLeft7=2.6\r\nRight7=2.6\r\nLeft8=0.1\r\nRight8=0.1\r\nLeft9=0.1\r\nRight9=0.1\r\nLeft10=0.2\r\nRight10=0.2\r\nBands=10\r\n';

test('reads a MusicBee .sde preset', () => {
  const p = EQ.parseSde(CLUB_SDE, 'Club');
  assert.equal(p.name, 'Club');
  assert.equal(p.bands, 10);
  assert.equal(p.preamp, 0);
  assert.deepEqual(p.gains, [0.1, 0.1, 2.3, 3.5, 3.5, 3.5, 2.6, 0.1, 0.1, 0.2]);
});

test('reads 15-band presets and averages unlinked channels', () => {
  const lines = ['[Equalizer]', 'LeftPreamp=-2.0', 'RightPreamp=-4.0', 'Bands=15'];
  for (let i = 1; i <= 15; i++) lines.push(`Left${i}=${i}`, `Right${i}=${i}`);
  const p = EQ.parseSde(lines.join('\n'), 'x');
  assert.equal(p.bands, 15);
  assert.equal(p.preamp, -3);
  assert.equal(p.gains[14], EQ.MAX_DB, 'gains clamp to what the native EQ supports');
});

test('a preset survives a save/load round trip', () => {
  const original = { name: 'Mine', bands: 10, preamp: -2.5, gains: [6, 5, 4, 2.5, 1, 0, -1, -2, -3, -4] };
  assert.deepEqual(EQ.parseSde(EQ.serializeSde(original), 'Mine'), original);
});

test('native EQ command lists every band with MusicBee frequencies, or turns the EQ off', () => {
  assert.equal(EQ.eqCommand(EQ.parseSde(CLUB_SDE, 'Club'), false), 'EQ\t0\t0');
  const [cmd, enabled, preamp, bands] = EQ.eqCommand(EQ.parseSde(CLUB_SDE, 'Club'), true).split('\t');
  assert.equal(cmd, 'EQ'); assert.equal(enabled, '1'); assert.equal(preamp, '0');
  const parts = bands.split(',').map(b => b.split(':').map(Number));
  assert.equal(parts.length, 10);
  assert.deepEqual(parts.map(p => p[0]), EQ.FREQUENCIES[10]);
  assert.equal(parts[3][1], 3.5);
  // One-octave bands: width is f * (sqrt2 - 1/sqrt2) ~= 0.707 f.
  assert.ok(Math.abs(parts[5][2] - 707.11) < 0.1);
});

test('switching 10 <-> 15 bands keeps the curve shape', () => {
  const bass = { name: 'b', bands: 10, preamp: -3, gains: [6, 5, 4, 2.5, 1, 0, 0, 0, 0, 0] };
  const wide = EQ.resample(bass, 15);
  assert.equal(wide.bands, 15);
  assert.equal(wide.gains.length, 15);
  assert.equal(wide.gains[0], 6);
  assert.equal(wide.gains[14], 0);
  assert.ok(wide.gains[3] < 6 && wide.gains[3] > 2.5);
  assert.equal(wide.preamp, -3);
});

test('auto-select by genre matches preset names loosely and falls back', () => {
  const presets = [{ name: 'Hip-Hop' }, { name: 'Rock' }, { name: 'Jazz' }];
  const fallback = { name: 'Flat' };
  assert.equal(EQ.presetForGenre(presets, 'Hip Hop/Rap', fallback).name, 'Hip-Hop');
  assert.equal(EQ.presetForGenre(presets, 'rock', fallback).name, 'Rock');
  assert.equal(EQ.presetForGenre(presets, 'Electronica', fallback).name, 'Flat');
  assert.equal(EQ.presetForGenre(presets, '', fallback).name, 'Flat');
});
