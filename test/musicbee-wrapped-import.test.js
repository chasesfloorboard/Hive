'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { readMusicBeeWrappedArchive, musicBeeImportPlayId } = require('../app/main/musicbee-wrapped-import');

test('MusicBee Wrapped importer reads yearly history + metadata pairs and ignores backups', async () => {
  const archive = path.join(__dirname, 'fixtures', 'musicbee-wrapped-sample.zip');
  const result = await readMusicBeeWrappedArchive(archive);
  assert.equal(result.years.length, 1);
  assert.equal(result.years[0].year, 2024);
  assert.equal(result.years[0].plays.length, 2);
  assert.equal(result.years[0].metadata.totalPlays, 2);
  assert.equal(result.years[0].metadata.totalMinutes, 5);
  assert.equal(result.years[0].plays[0].durationMs, 180000);
  assert.equal(result.years[0].plays[0].playDuration, 120);
  assert.equal(result.years[0].plays[0].listeningMode, 'Shuffle');
});

test('MusicBee Wrapped play IDs are deterministic for idempotent re-imports', () => {
  const play = { fileUrl: 'S:\\Music\\Artist - Song.mp3', playedAt: '2024-06-01T12:00:00-07:00', title: 'Song', artist: 'Artist', album: 'Album', playDuration: 120, durationMs: 180000 };
  assert.equal(musicBeeImportPlayId(2024, play), musicBeeImportPlayId(2024, {...play}));
  assert.notEqual(musicBeeImportPlayId(2024, play), musicBeeImportPlayId(2024, {...play, playDuration: 121}));
});
