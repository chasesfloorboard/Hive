'use strict';
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { execFile } = require('child_process');

async function readMusicBeeWrappedArchive(archivePath) {
  if (!archivePath || !fs.existsSync(archivePath)) throw new Error('MusicBee Wrapped archive was not found.');
  const stat = await fsp.stat(archivePath);
  if (stat.size > 100 * 1024 * 1024) throw new Error('MusicBee Wrapped archive is too large (maximum 100 MB).');
  const python = String.raw`import json, os, sys, zipfile, xml.etree.ElementTree as ET

archive = sys.argv[1]
MAX_ENTRY = 20 * 1024 * 1024

def clean_name(name):
    name = str(name).replace('\\', '/')
    if name.startswith('/') or name.startswith('\\'):
        raise ValueError('Archive contains an absolute path.')
    parts = [p for p in name.split('/') if p not in ('', '.')]
    if '..' in parts:
        raise ValueError('Archive contains a path traversal entry.')
    return '/'.join(parts)

def text(parent, name, default=''):
    node = parent.find(name)
    return default if node is None or node.text is None else node.text

def parse_history(data):
    if b'<!DOCTYPE' in data[:4096].upper() or b'<!ENTITY' in data[:4096].upper():
        raise ValueError('XML declarations are not supported in imported archives.')
    root = ET.fromstring(data)
    plays_node = root.find('Plays')
    if plays_node is None:
        raise ValueError('play_history.xml is missing its Plays collection.')
    rows = []
    for node in plays_node.findall('TrackPlay'):
        rows.append({
            'fileUrl': text(node, 'FileUrl'), 'title': text(node, 'Title'), 'artist': text(node, 'Artist'),
            'album': text(node, 'Album'), 'albumArtist': text(node, 'AlbumArtist'), 'genre': text(node, 'Genre'),
            'year': text(node, 'Year'), 'durationMs': float(text(node, 'Duration', '0') or 0),
            'playedAt': text(node, 'PlayedAt'), 'playDuration': float(text(node, 'PlayDuration', '0') or 0),
            'playlistName': text(node, 'PlaylistName'), 'listeningMode': text(node, 'ListeningMode')
        })
    return rows

def parse_metadata(data):
    if b'<!DOCTYPE' in data[:4096].upper() or b'<!ENTITY' in data[:4096].upper():
        raise ValueError('XML declarations are not supported in imported archives.')
    root = ET.fromstring(data)
    return {
        'year': int(text(root, 'Year', '0') or 0), 'totalPlays': int(float(text(root, 'TotalPlays', '0') or 0)),
        'totalMinutes': int(float(text(root, 'TotalMinutes', '0') or 0)), 'firstPlay': text(root, 'FirstPlay'),
        'lastPlay': text(root, 'LastPlay'), 'topArtist': text(root, 'TopArtist'), 'topTrack': text(root, 'TopTrack'),
        'topGenre': text(root, 'TopGenre'), 'lastUpdated': text(root, 'LastUpdated')
    }

with zipfile.ZipFile(archive, 'r') as z:
    infos = z.infolist()
    files = {}
    for info in infos:
        name = clean_name(info.filename)
        if not name or name.endswith('/'):
            continue
        if info.is_dir() or info.file_size > MAX_ENTRY:
            if info.file_size > MAX_ENTRY:
                raise ValueError('Archive contains an XML entry larger than 20 MB.')
            continue
        files[name] = info
    histories = {}
    metadata = {}
    backups = {}
    for name, info in files.items():
        base = os.path.basename(name).lower()
        if base not in ('play_history.xml', 'year_metadata.xml', 'play_history_backup.xml'):
            continue
        data = z.read(info)
        if base == 'play_history.xml': histories[os.path.dirname(name)] = parse_history(data)
        elif base == 'year_metadata.xml': metadata[os.path.dirname(name)] = parse_metadata(data)
        elif base == 'play_history_backup.xml': backups[os.path.dirname(name)] = data.decode('utf-8', errors='replace')
    groups = []
    for directory, plays in histories.items():
        meta = metadata.get(directory)
        if meta is None:
            raise ValueError(f'Missing year_metadata.xml beside {directory or "play_history.xml"}.')
        year = int(meta.get('year') or 0)
        if year < 1900 or year > 3000:
            raise ValueError('year_metadata.xml contains an invalid year.')
        groups.append({'directory': directory, 'year': year, 'metadata': meta, 'plays': plays, 'backupXml': backups.get(directory, '')})
    if not groups:
        raise ValueError('No play_history.xml + year_metadata.xml pairs were found in the archive.')
    print(json.dumps({'years': groups}, separators=(',', ':')))`;
  return new Promise((resolve, reject) => {
    execFile('python3', ['-c', python, archivePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message || 'Could not read MusicBee Wrapped archive.').trim()));
      try { resolve(JSON.parse(stdout)); } catch (err) { reject(new Error(`Could not parse MusicBee Wrapped import data: ${err.message}`)); }
    });
  });
}

function musicBeeImportPlayId(year, play) {
  // playedAt must be normalized to its parsed instant, not hashed as a raw
  // string: the exact same play re-serialized in a different timestamp
  // format (e.g. a "-07:00" offset vs. a reformatted UTC "Z" string for the
  // same instant) must still produce the same id, or it silently survives
  // as a duplicate play through every merge that follows.
  const playedAtMs = Date.parse(String(play?.playedAt ?? '')) || 0;
  const raw = [year, play?.fileUrl, playedAtMs, play?.title, play?.artist, play?.album, play?.playDuration, play?.durationMs].map(v => String(v ?? '')).join('\u0000');
  return `musicbee:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}


module.exports = { readMusicBeeWrappedArchive, musicBeeImportPlayId };
