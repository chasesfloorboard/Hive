const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { targetRelativePath, planOrganise, safeSegment, DEFAULT_TEMPLATE } = require('../app/main/file-organiser');

const track = { path: '/m/01 - technotronic - pump up the jam.mp3', title: 'Pump Up the Jam', artist: 'Technotronic', albumArtist: '', album: 'Pump Up the Jam: The Album', track: 1, disk: 1, year: '1989', genre: 'House' };
const rel = p => p.split(/[\\/]/).join('/');

test('default MusicBee-style template builds artist/album/track folders and keeps the extension', () => {
  assert.equal(rel(targetRelativePath(track, DEFAULT_TEMPLATE)), 'Technotronic/Pump Up the Jam The Album/01 - Pump Up the Jam.mp3');
});

test('template functions: $If, $IsNull, $Upper, $Left and literal text', () => {
  assert.equal(rel(targetRelativePath(track, '$If(<Album Artist (raw)>,<Album Artist (raw)>,Singles)\\(<Year>) <Album>')), 'Singles/(1989) Pump Up the Jam The Album.mp3');
  assert.equal(rel(targetRelativePath(track, '$IsNull(<Composer>,No Composer,<Composer>)\\<Title>')), 'No Composer/Pump Up the Jam.mp3');
  assert.equal(rel(targetRelativePath(track, '$Upper($Left(<Artist>,1))\\<Artist> - <Title>')), 'T/Technotronic - Pump Up the Jam.mp3');
});

test('file names are safe on exFAT/Windows', () => {
  assert.equal(safeSegment('AC/DC: Back in Black?'), 'AC-DC Back in Black');
  assert.equal(safeSegment('Trailing dots...'), 'Trailing dots');
  assert.equal(safeSegment(''), 'Unknown');
  assert.equal(rel(targetRelativePath({ path: '/m/x.flac', title: 'What?', artist: '' }, '<Artist>\\<Title>')), 'Unknown/What.flac');
});

test('plan skips unchanged files and numbers collisions', () => {
  const root = '/music';
  const a = { ...track, path: '/music/a.mp3' };
  const b = { ...track, path: '/music/b.mp3' };
  const already = { ...track, path: path.join(root, targetRelativePath(track, '<Artist> - <Title>')) };
  const moves = planOrganise([a, b, already], { root, template: '<Artist> - <Title>' });
  assert.deepEqual(moves.map(m => rel(path.relative(root, m.to))), ['Technotronic - Pump Up the Jam (2).mp3', 'Technotronic - Pump Up the Jam (3).mp3']);
});

test('plan never targets an existing file that is not itself moving', () => {
  const moves = planOrganise([{ ...track, path: '/music/a.mp3' }], { root: '/music', template: '<Title>', exists: p => p === path.resolve('/music/Pump Up the Jam.mp3') });
  assert.equal(rel(path.relative('/music', moves[0].to)), 'Pump Up the Jam (2).mp3');
});

test('names work on Windows: no forbidden characters, trailing dots or reserved device names', () => {
  const { safeName, safeSegment } = require('../app/main/file-organiser');
  assert.equal(safeName('Knxwledge.'), 'Knxwledge');
  assert.equal(safeName('AC/DC: Live?'), 'AC_DC - Live_');
  assert.equal(safeName('CON'), 'CON_');
  assert.equal(safeName('nul.txt'), 'nul.txt_');
  assert.equal(safeName('  '), 'Untitled');
  assert.equal(safeSegment('com1'), 'com1_');
  assert.equal(safeSegment('Knxwledge.'), 'Knxwledge');
});
