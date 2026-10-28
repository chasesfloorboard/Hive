'use strict';

// Hive's Soulseek downloads on the PC, as Hive Mobile does them
// (SoulseekDownloads.kt): one album or song at a time, searched for, the best
// folder picked by its tracklist, then fetched song by song into
// <music folder>/<Artist>/<Album>/. The list survives Hive closing; a download
// that was running when Hive closed starts again, keeping the songs it got.

const fs = require('node:fs');
const path = require('node:path');
const { candidates } = require('./soulseek');

const EDITION = /\s*[(\[][^)\]]*(deluxe|remaster|edition|expanded|explicit|anniversary|bonus|version)[^)\]]*[)\]]/gi;
const RELEASE = /\s+-\s+(single|ep)$/i;

// "Artist Album" without the edition, as Seeker (and Hive Mobile) search it.
function albumQuery(artist, album) {
  const who = String(artist || '').split(/,|&| feat\.? | x /i)[0].trim();
  const what = String(album || '').replace(EDITION, '').replace(RELEASE, '').trim();
  return [who, what].filter(Boolean).join(' ');
}

const FORMAT_NAMES = { lossless: 'FLAC', 'lossless-hi': 'FLAC 24-bit', 'mp3-320': 'MP3 320', 'mp3-v0': 'MP3 V0', 'mp3-256': 'MP3 256', aac: 'AAC' };
const formatName = f => FORMAT_NAMES[f] || String(f).toUpperCase();
const safe = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/\.+$/, '').slice(0, 80) || 'Unknown';
// A file name kept short enough for any disk, its extension kept.
const safeFile = name => { const ext = path.extname(String(name)).slice(0, 8); return safe(path.basename(String(name), path.extname(String(name))).slice(0, 120)) + ext.replace(/[^.\w]/g, ''); };
const finished = j => ['done', 'partial', 'failed'].includes(j.state);

function createSoulseekDownloads({ dataDir, settings, musicFolder, createClient, onChange = () => {}, onSongs = async () => {}, log = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const file = path.join(dataDir, 'soulseek-downloads.json');
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(jobs)) jobs = []; } catch {}
  let running = false, lastSave = 0, current = null;

  const save = force => {
    const now = Date.now();
    if (!force && now - lastSave < 2000) return;
    lastSave = now;
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(jobs)); } catch {}
  };
  const change = (force = true) => {
    // Finished downloads beyond the latest 30 are forgotten.
    const done = jobs.filter(finished).sort((a, b) => b.at - a.at).slice(0, 30);
    jobs = [...jobs.filter(j => !finished(j)), ...done].sort((a, b) => b.at - a.at);
    save(force);
    onChange(list());
  };
  const job = id => jobs.find(j => j.id === id);
  const list = () => jobs.map(j => ({ ...j, songs: j.songs.map(s => ({ ...s })) }));

  // A request: { id, kind: 'album'|'track', artist, album, label, tracks: [{ title, durationMs, loved, streamPath }] }.
  function add(request) {
    const r = { ...request, tracks: (request.tracks || []).filter(t => t && t.title) };
    if (!r.tracks.length) throw new Error('Nothing to download');
    if (!r.id) r.id = `${r.kind}:${r.artist}:${r.album}:${r.kind === 'track' ? r.tracks[0].title : ''}`.toLowerCase();
    const old = job(r.id);
    if (old && !finished(old)) return old;
    jobs = [{ id: r.id, kind: r.kind === 'track' ? 'track' : 'album', artist: r.artist || '', album: r.album || '', label: r.label || r.album || r.tracks[0].title,
      tracks: r.tracks.map(t => ({ title: String(t.title), durationMs: Number(t.durationMs) || 0, loved: !!t.loved, streamPath: t.streamPath || '' })),
      songs: r.tracks.map(t => ({ title: String(t.title), state: 'waiting', percent: 0, from: '', path: '' })),
      state: 'queued', message: 'Waiting', at: Date.now() }, ...jobs.filter(j => j.id !== r.id)];
    change();
    void run();
    return job(r.id);
  }

  function clearFinished() { jobs = jobs.filter(j => !finished(j)); change(); }

  function cancel(id) {
    const j = job(id);
    if (!j || finished(j)) return;
    j.cancelled = true;
    if (current?.id === id) current.client?.close();
    else { j.state = 'failed'; j.message = 'Cancelled'; for (const s of j.songs) if (s.state !== 'done') s.state = 'missing'; change(); }
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        // Oldest first.
        const next = [...jobs].reverse().find(j => !finished(j));
        if (!next) break;
        await download(next);
      }
    } finally { running = false; }
  }

  async function download(j) {
    let s, folder;
    try { s = await settings(); folder = await musicFolder(); } catch (err) { finish(j, err.message || String(err), 'failed'); return; }
    if (!s.username || !s.password) { finish(j, 'Sign in to Soulseek in Settings › Connections', 'failed'); return; }
    const client = createClient({ username: s.username, password: s.password, log });
    current = { id: j.id, client };
    let done = j.songs.filter(x => x.state === 'done').length;
    const got = [];
    try {
      j.state = 'searching'; j.message = 'Looking on Soulseek'; change();
      await client.login();
      const wanted = j.tracks.map(t => ({ title: t.title, durationMs: t.durationMs }));
      const what = j.kind === 'track' ? j.tracks[0].title : j.album;
      const queries = [...new Set([albumQuery(j.artist, what), albumQuery('', what)])].filter(q => q.length >= 3);
      let picks = [];
      for (const query of queries) {
        const results = [];
        const token = client.search(query, r => results.push(r));
        // Answers come in over several seconds; stop early once there's a good choice.
        for (let i = 0; i < 20 && !j.cancelled; i++) {
          await wait(1000);
          if (i >= 6) {
            picks = candidates(j.artist, wanted, results, s.quality);
            if (picks.filter(p => p.freeSlot && p.files.size === wanted.length).length >= 2) break;
          }
        }
        client.stopSearch(token);
        picks = candidates(j.artist, wanted, results, s.quality);
        log(`"${query}": ${results.length} peers answered, ${picks.length} folders fit; best: ${picks.slice(0, 3).map(p => `${p.user} ${p.format} ${p.files.size}/${wanted.length} free=${p.freeSlot}`).join(', ')}`);
        if (picks.length || j.cancelled) break;
      }
      if (j.cancelled) throw new Error('Cancelled');
      if (!picks.length) { finish(j, `Couldn't find ${j.label} on Soulseek`, 'failed'); return; }

      const needed = new Set(wanted.map((_, i) => i).filter(i => j.songs[i].state !== 'done'));
      j.state = 'downloading'; j.message = `From ${picks[0].user} · ${formatName(picks[0].format)}`; change();
      const dir = path.join(folder, safe(j.artist), safe(j.kind === 'track' ? 'Singles' : j.album));
      for (const pick of picks.slice(0, 6)) {
        if (!needed.size || j.cancelled) break;
        for (const i of [...needed].sort((a, b) => a - b)) {
          const f = pick.files.get(i);
          if (!f) continue;
          const song = j.songs[i];
          Object.assign(song, { state: 'downloading', percent: 0, from: pick.user });
          j.message = `From ${pick.user} · ${formatName(pick.format)}`;
          change();
          fs.mkdirSync(dir, { recursive: true });
          const target = uniqueTarget(path.join(dir, safeFile(f.name)));
          const part = `${target}.part`;
          try {
            await client.download(pick.user, f.path, part, done === 0 ? 120000 : 300000, (bytes, size) => {
              if (size > 0) { song.percent = Math.floor(bytes * 100 / size); change(false); }
            }, f.size);
            fs.renameSync(part, target);
          } catch (err) {
            try { fs.rmSync(part, { force: true }); } catch {}
            log(`${f.name} from ${pick.user} failed: ${err.message}`);
            Object.assign(song, { state: 'waiting', percent: 0, from: '' });
            change();
            if (client.ended || j.cancelled) throw new Error(j.cancelled ? 'Cancelled' : client.ended);
            break;
          }
          log(`Got ${f.name} from ${pick.user}`);
          Object.assign(song, { state: 'done', percent: 100, path: target });
          got.push({ index: i, path: target, ...j.tracks[i] });
          needed.delete(i);
          done++;
          change();
        }
      }
      for (const i of needed) Object.assign(j.songs[i], { state: 'missing', percent: 0 });
      const missing = needed.size;
      finish(j, missing === 0 ? `Downloaded ${j.label}` : done === 0 ? `Couldn't download ${j.label}: nobody sharing it answered` : `Downloaded ${done} of ${j.songs.length} songs of ${j.label}`,
        missing === 0 ? 'done' : done === 0 ? 'failed' : 'partial');
    } catch (err) {
      log(`Stopped: ${err.message}`);
      for (const x of j.songs) if (x.state !== 'done') Object.assign(x, { state: 'missing', percent: 0 });
      finish(j, err.message === 'Cancelled' ? 'Cancelled' : `Soulseek: ${err.message || 'download failed'}`, done > 0 ? 'partial' : 'failed');
    } finally {
      client.close();
      current = null;
    }
    if (got.length) { try { await onSongs(got, j); } catch (err) { log(`Adding to the library failed: ${err.message}`); } }
  }

  function finish(j, message, state) { j.state = state; j.message = message; delete j.cancelled; change(); }

  function uniqueTarget(p) {
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
    for (let n = 2; ; n++) if (!fs.existsSync(`${base} (${n})${ext}`)) return `${base} (${n})${ext}`;
  }

  // A download running when Hive closed starts again (its finished songs stay).
  for (const j of jobs) if (!finished(j)) { j.state = 'queued'; j.message = 'Waiting'; for (const x of j.songs) if (x.state === 'downloading') Object.assign(x, { state: 'waiting', percent: 0 }); }

  return { add, list, cancel, clearFinished, busy: () => !!current, resume: () => { if (jobs.some(j => !finished(j))) void run(); } };
}

module.exports = { createSoulseekDownloads, albumQuery, formatName };
