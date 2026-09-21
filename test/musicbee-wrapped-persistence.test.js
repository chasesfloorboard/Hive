'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { mergeImportedYear, readStoredYear, appendHiveEvent, exportArchive, trackKey } = require('../app/main/musicbee-wrapped-store');

async function tmpDir() { return fsp.mkdtemp(path.join(os.tmpdir(), 'hive-mb-wrap-')); }

test('MusicBee Wrapped history is persisted locally, updated, and exportable', async () => {
  const userData = await tmpDir();
  const year = 2026;
  const group = {
    year,
    directory: '2026',
    backupXml: '<?xml version="1.0"?><PlayHistory><Plays><TrackPlay /></Plays></PlayHistory>',
    metadata: { year, totalPlays: 1, totalMinutes: 1 },
    plays: [{ fileUrl: 'S:\\Music\\Song.mp3', title: 'Song', artist: 'Artist', album: 'Album', albumArtist: 'Artist', genre: 'Rock', year: '2020', durationMs: 180000, playedAt: '2026-01-01T10:00:00-08:00', playDuration: 120, playlistName: 'Library', listeningMode: 'Repeat All' }]
  };
  const imported = await mergeImportedYear(userData, group);
  assert.equal(imported.plays.length, 1);
  assert.match(await fsp.readFile(path.join(userData, '2026', 'play_history.xml'), 'utf8'), /<Title>Song<\/Title>/);
  assert.equal(await fsp.readFile(path.join(userData, '2026', 'play_history_backup.xml'), 'utf8'), group.backupXml);

  const event = { playedAt: Date.parse('2026-02-01T10:00:00-08:00'), duration: 180, trackDuration: 180, path: '/home/music/Song.mp3', title: 'Song', artist: 'Artist', album: 'Album', albumArtist: 'Artist', genre: 'Rock' };
  assert.equal(await appendHiveEvent(userData, event), true);
  const stored = await readStoredYear(userData, year);
  assert.equal(stored.plays.length, 2);
  assert.equal(trackKey(stored.plays[0]), trackKey(stored.plays[1]));

  const out = path.join(userData, 'export.zip');
  await exportArchive(userData, out);
  assert.ok((await fsp.stat(out)).size > 0);
  const names = require('child_process').execFileSync('python3', ['-c', 'import sys,zipfile; print(*zipfile.ZipFile(sys.argv[1]).namelist(), sep=chr(10))', out], { encoding: 'utf8' });
  assert.match(names, /2026\/play_history_backup\.xml/);
});
