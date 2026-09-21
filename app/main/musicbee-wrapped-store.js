'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { musicBeeImportPlayId } = require('./musicbee-wrapped-import');

function storeRoot(root) { return root; }
function yearDir(root, year) { return path.join(storeRoot(root), String(year)); }
function safeYear(year) {
  const n = Number(year);
  if (!Number.isInteger(n) || n < 1900 || n > 3000) throw new Error('Invalid MusicBee Wrapped year.');
  return n;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function tag(name, value) { return `    <${name}>${xmlEscape(value)}</${name}>`; }
function emptyTag(name) { return `    <${name} />`; }
function playXml(play) {
  const value = key => play?.[key] == null ? '' : String(play[key]);
  const lines = ['  <TrackPlay>'];
  const fields = [
    ['FileUrl', value('fileUrl')], ['Title', value('title')], ['Artist', value('artist')],
    ['Album', value('album')], ['AlbumArtist', value('albumArtist')], ['Genre', value('genre')],
    ['Year', value('year')], ['Duration', String(Math.max(0, Number(play?.durationMs) || 0))],
    ['PlayedAt', value('playedAt')], ['PlayDuration', String(Math.max(0, Number(play?.playDuration) || 0))],
    ['PlaylistName', value('playlistName')], ['ListeningMode', value('listeningMode')]
  ];
  for (const [name, val] of fields) lines.push(val ? tag(name, val) : emptyTag(name));
  lines.push('  </TrackPlay>');
  return lines.join('\n');
}

function metadataFor(year, plays, now = new Date()) {
  const rows = Array.isArray(plays) ? plays : [];
  const totalSeconds = rows.reduce((sum, p) => sum + Math.max(0, Number(p?.playDuration) || 0), 0);
  const sorted = rows.map(p => ({ ...p, _time: Date.parse(String(p?.playedAt || '')) || 0 })).filter(p => p._time > 0).sort((a,b) => a._time - b._time);
  const count = map => {
    const m = new Map();
    for (const p of rows) { const k = String(p || '').trim(); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
  };
  const trackCounts = new Map();
  for (const p of rows) {
    const k = `${String(p?.artist || '').trim()} - ${String(p?.title || '').trim()}`.replace(/^ - | - $/g, '');
    if (k) trackCounts.set(k, (trackCounts.get(k) || 0) + 1);
  }
  const topTrack = [...trackCounts.entries()].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
  return {
    year, totalPlays: rows.length, totalMinutes: Math.round(totalSeconds / 60),
    firstPlay: sorted[0]?.playedAt || '', lastPlay: sorted.at(-1)?.playedAt || '',
    topArtist: count(rows.map(p => p?.artist)), topTrack,
    topGenre: count(rows.map(p => p?.genre)), lastUpdated: now.toISOString()
  };
}

function metadataXml(metadata) {
  const m = metadata || {};
  return `<?xml version="1.0"?>\n<YearMetadata xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${[
    ['Year', m.year], ['TotalPlays', m.totalPlays], ['TotalMinutes', m.totalMinutes], ['FirstPlay', m.firstPlay],
    ['LastPlay', m.lastPlay], ['TopArtist', m.topArtist], ['TopTrack', m.topTrack], ['TopGenre', m.topGenre], ['LastUpdated', m.lastUpdated]
  ].map(([k,v]) => `  <${k}>${xmlEscape(v)}</${k}>`).join('\n')}\n</YearMetadata>\n`;
}

function historyXml(plays) {
  const rows = Array.isArray(plays) ? plays : [];
  return `<?xml version="1.0"?>\n<PlayHistory xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n  <Plays>\n${rows.map(playXml).join('\n')}\n  </Plays>\n</PlayHistory>\n`;
}

async function writeYearStore(userData, year, plays, metadata = null, backupXml = null) {
  year = safeYear(year);
  const dir = yearDir(userData, year);
  await fsp.mkdir(dir, { recursive: true });
  const rows = Array.isArray(plays) ? plays : [];
  const meta = metadata || metadataFor(year, rows);
  await fsp.writeFile(path.join(dir, 'play_history.xml'), historyXml(rows), 'utf8');
  await fsp.writeFile(path.join(dir, 'year_metadata.xml'), metadataXml(meta), 'utf8');
  await fsp.writeFile(path.join(dir, 'plays.json'), JSON.stringify(rows, null, 2) + '\n', 'utf8');
  if (backupXml) {
    const backupPath = path.join(dir, 'play_history_backup.xml');
    if (!fs.existsSync(backupPath)) await fsp.writeFile(backupPath, String(backupXml), 'utf8');
  }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: 2, year, updatedAt: Date.now(), source: 'MusicBeeWrapped', playCount: rows.length, hasOriginalBackup: fs.existsSync(path.join(dir, 'play_history_backup.xml')) }, null, 2) + '\n', 'utf8');
  return { dir, metadata: meta, plays: rows };
}

async function readStoredYear(userData, year) {
  year = safeYear(year);
  const dir = yearDir(userData, year);
  try {
    const rows = JSON.parse(await fsp.readFile(path.join(dir, 'plays.json'), 'utf8'));
    if (!Array.isArray(rows)) return null;
    return { dir, plays: rows };
  } catch { return null; }
}

async function mergeImportedYear(userData, group) {
  const year = safeYear(group.year);
  const existing = await readStoredYear(userData, year);
  const byId = new Map();
  for (const play of existing?.plays || []) byId.set(musicBeeImportPlayId(year, play), play);
  for (const play of Array.isArray(group.plays) ? group.plays : []) byId.set(musicBeeImportPlayId(year, play), play);
  const merged = [...byId.entries()].sort((a,b) => {
    const at = Date.parse(String(a[1]?.playedAt || '')) || 0;
    const bt = Date.parse(String(b[1]?.playedAt || '')) || 0;
    return at - bt;
  }).map(([,play]) => play);
  const result = await writeYearStore(userData, year, merged, null, group.backupXml || null);
  return { ...result, addedFromImport: Math.max(0, merged.length - (existing?.plays?.length || 0)) };
}

function trackKey(play) {
  const norm = value => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  return `${norm(play?.title)}\u0000${norm(play?.artist)}\u0000${norm(play?.album)}`;
}

async function exportArchive(userData, destinationPath) {
  const root = storeRoot(userData);
  const temp = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  const python = String.raw`import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        year_dir=os.path.join(root,name)
        if not os.path.isdir(year_dir) or not name.isdigit(): continue
        for fn in ('play_history.xml','year_metadata.xml','play_history_backup.xml'):
            src=os.path.join(year_dir,fn)
            if os.path.isfile(src): z.write(src, arcname=os.path.join(name,fn))
if not os.path.getsize(out): raise RuntimeError('Export archive is empty.')`;
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await execFileAsync('python3', ['-c', python, root, temp], { encoding: 'utf8', timeout: 30000 });
    await fsp.rename(temp, destinationPath);
    return destinationPath;
  } catch (err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not export MusicBee Wrapped archive: ${err.stderr || err.message}`);
  }
}

async function appendHiveEvent(userData, event) {
  const year = new Date(Number(event?.playedAt || 0)).getFullYear();
  if (year < 1900 || year > 3000) return false;
  const existing = await readStoredYear(userData, year);
  if (!existing) return false;
  const play = {
    fileUrl: event.path || event.legacyFileUrl || '', title: event.title || '', artist: event.artist || '',
    album: event.album || '', albumArtist: event.albumArtist || '', genre: event.genre || '', year: '',
    durationMs: Math.round(Math.max(0, Number(event.trackDuration) || 0) * 1000), playedAt: new Date(Number(event.playedAt)).toISOString(),
    playDuration: Math.round(Math.max(0, Number(event.duration) || 0)), playlistName: event.playlistName || 'Library', listeningMode: event.listeningMode || '',
    source: 'hive'
  };
  const id = musicBeeImportPlayId(year, play);
  const ids = new Set(existing.plays.map(p => musicBeeImportPlayId(year, p)));
  if (ids.has(id)) return false;
  await writeYearStore(userData, year, [...existing.plays, play]);
  return true;
}

module.exports = { storeRoot, yearDir, metadataFor, writeYearStore, readStoredYear, mergeImportedYear, exportArchive, appendHiveEvent, trackKey };
