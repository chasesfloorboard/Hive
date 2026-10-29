'use strict';
// Hive 2.0 YouTube Music streaming. Playlists come from Apple Music or
// Spotify (track lists and metadata only); the audio for songs that aren't
// in the user's library is found on YouTube Music and streamed with yt-dlp.
// Nothing is downloaded to disk: yt-dlp resolves a time-limited audio URL
// that the renderer's media element plays, like a podcast episode.
//
// Matching: search YouTube Music's "Songs" results for "artist title",
// rank by title similarity, then confirm the best candidates with their full
// details (artist overlap and length within a few seconds). Matches are
// cached on disk; stream URLs are cached in memory until they expire.
//
// Tags: whatever the source gave (Apple/iTunes: album, year, genre, cover;
// Spotify: album, album artist), YouTube Music's own album/year, and a
// MusicBrainz recording lookup for album artist, track/disc number, date and
// MBIDs.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const MB_API = 'https://musicbrainz.org/ws/2';
const MB_USER_AGENT = 'Hive/2.0 ( https://github.com/ )';

// Comparable form of a title or artist: drop "(feat. …)", "[Mixed]",
// "- Remastered 2011" and punctuation, keep remix/version words.
function normalise(text) {
  return String(text || '').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\(\[](feat\.?|ft\.?|with|mixed|explicit|clean|official[^\)\]]*|audio|lyrics?[^\)\]]*)[^\)\]]*[\)\]]/g, ' ')
    .replace(/\s+-\s+(\d{4}\s+)?remaster(ed)?.*$/, ' ')
    .replace(/\s+(feat\.?|ft\.?)\s+.*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const words = text => new Set(normalise(text).split(' ').filter(Boolean));
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return (2 * both) / (A.size + B.size);
}
// Share of the wanted words found in the other text (for artist lists,
// where YouTube adds every featured artist).
function containment(wanted, text) {
  const A = words(wanted), B = words(text);
  if (!A.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / A.size;
}
const firstArtist = artist => String(artist || '').split(/,|&| x | and | feat\.? | ft\.? /i)[0].trim();

// Score a fully-described YouTube Music candidate against the wanted song.
function scoreCandidate(want, info) {
  const titleScore = Math.max(similarity(want.title, info.track || info.title), similarity(want.title, info.title));
  const artistsText = [info.artist, ...(Array.isArray(info.artists) ? info.artists : []), info.channel].filter(Boolean).join(' ');
  const wantDur = Number(want.duration) || 0, gotDur = Number(info.duration) || 0;
  // Without a wanted artist only an exact title with the right length counts.
  const artistScore = want.artist ? containment(firstArtist(want.artist), artistsText) : (titleScore >= 0.99 && wantDur && gotDur && Math.abs(wantDur - gotDur) <= 3 ? 1 : 0);
  const diff = wantDur && gotDur ? Math.abs(wantDur - gotDur) : 0;
  const durationOk = !wantDur || !gotDur || diff <= Math.max(8, wantDur * 0.05);
  const score = titleScore * 0.55 + artistScore * 0.35 + (durationOk ? 0.1 : 0) - (wantDur && gotDur ? Math.min(0.3, diff / 120) : 0);
  return { score, titleScore, artistScore, durationOk };
}
const acceptable = s => s.artistScore >= 0.5 && ((s.durationOk && s.titleScore >= 0.5) || s.titleScore >= 0.8);

// "Bullet For My Valentine - Hand of Blood (Official Video)" -> "Hand of Blood (Official Video)"
function videoTitleWithoutArtist(title, artist) {
  const t = String(title || '');
  const dash = t.search(/\s[-–—|]\s/);
  if (dash > 0 && containment(firstArtist(artist), t.slice(0, dash)) >= 0.5) return t.slice(dash + 3);
  return t;
}

// googlevideo URLs carry their own expiry (unix seconds).
function urlExpiry(url) {
  try { const e = Number(new URL(url).searchParams.get('expire')); if (e > 0) return e * 1000; } catch {}
  return Date.now() + 60 * 60 * 1000;
}

function create({ userDataDir, net }) {
  const matchesFile = path.join(userDataDir, 'youtube-music-matches.json');
  let matches = null;
  let saveTimer = null;
  const streams = new Map(); // videoId -> { url, expires, info }
  const inflight = new Map();
  let mbChain = Promise.resolve();
  let mbLast = 0;

  // Windows runs yt-dlp.exe (its own standalone build); Linux the yt-dlp zipapp.
  const WINDOWS = process.platform === 'win32';
  const YTDLP = WINDOWS ? 'yt-dlp.exe' : 'yt-dlp';

  function ytDlpPath() {
    const candidates = [
      process.env.HIVE_YTDLP,
      path.join(userDataDir, 'bin', YTDLP),
      ...(WINDOWS ? [] : [path.join(process.env.HOME || '', '.local', 'bin', 'yt-dlp'), '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'])
    ].filter(Boolean);
    return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || '';
  }

  // yt-dlp needs a JavaScript runtime for YouTube. deno is used when installed;
  // otherwise Hive's own Electron runs as Node (ELECTRON_RUN_AS_NODE), so it works
  // on machines without Node.js too -- most Windows ones.
  function runtimeArgs() {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const hasDeno = [WINDOWS ? '' : '/usr/bin/deno', path.join(home, '.deno', 'bin', WINDOWS ? 'deno.exe' : 'deno')].some(p => p && fs.existsSync(p));
    if (hasDeno) return [];
    return ['--js-runtimes', process.versions.electron ? `node:${process.execPath}` : 'node'];
  }
  const runtimeEnv = () => (process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env);

  function ytDlp(args, timeoutMs = 45000) {
    const bin = ytDlpPath();
    if (!bin) return Promise.reject(Object.assign(new Error('Full songs aren\'t set up yet: use “Play full songs” on the Apple Music page.'), { code: 'NO_YTDLP' }));
    return new Promise((resolve, reject) => {
      execFile(bin, [...runtimeArgs(), '--no-warnings', '--no-playlist', ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: runtimeEnv(), windowsHide: true }, (err, stdout, stderr) => {
        // What went wrong goes to the log; the message people see doesn't say where songs come from.
        if (err) { console.warn('[full songs]', String(stderr || err.message).trim().split('\n').pop()); return reject(new Error("Couldn't load the full song.")); }
        resolve(stdout);
      });
    });
  }

  async function installYtDlp() {
    const dir = path.join(userDataDir, 'bin');
    await fsp.mkdir(dir, { recursive: true });
    const res = await net.fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP}`, { headers: { 'User-Agent': 'Hive/2.0' } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const target = path.join(dir, YTDLP);
    await fsp.writeFile(`${target}.tmp`, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    await fsp.rename(`${target}.tmp`, target);
    return status();
  }

  async function status() {
    const bin = ytDlpPath();
    let version = '';
    if (bin) { try { version = String(await ytDlp(['--version'], 15000)).trim(); } catch {} }
    return { installed: !!bin, path: bin, version };
  }

  async function loadMatches() {
    if (matches) return matches;
    try { matches = JSON.parse(await fsp.readFile(matchesFile, 'utf8')) || {}; } catch { matches = {}; }
    return matches;
  }
  function saveMatchesSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await fsp.writeFile(`${matchesFile}.tmp`, JSON.stringify(matches)); await fsp.rename(`${matchesFile}.tmp`, matchesFile); } catch {}
    }, 1000);
  }

  async function videoInfo(videoId) {
    const cached = streams.get(videoId);
    if (cached && cached.expires - Date.now() > 5 * 60 * 1000) return cached.info;
    const raw = await ytDlp(['-j', '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio', `https://music.youtube.com/watch?v=${videoId}`]);
    const info = JSON.parse(raw);
    if (!/^https:\/\//.test(String(info.url || ''))) throw new Error('No audio came for this song.');
    const slim = { id: info.id, title: info.title, track: info.track, artist: info.artist, artists: info.artists, album: info.album,
      release_year: info.release_year, release_date: info.release_date, duration: info.duration, channel: info.channel, url: info.url,
      ext: info.ext, acodec: info.acodec, thumbnail: info.thumbnail };
    streams.set(videoId, { url: slim.url, expires: urlExpiry(slim.url), info: slim });
    return slim;
  }

  async function searchSongs(query) {
    const raw = await ytDlp(['--flat-playlist', '-J', '--playlist-end', '6', `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`], 30000);
    const data = JSON.parse(raw);
    return (data.entries || []).filter(e => e?.id).map(e => ({ id: String(e.id), title: String(e.title || '') }));
  }

  async function searchVideos(query) {
    const raw = await ytDlp(['--flat-playlist', '-J', `ytsearch5:${query}`], 30000);
    const data = JSON.parse(raw);
    return (data.entries || []).filter(e => e?.id).map(e => ({ id: String(e.id), title: String(e.title || '') }));
  }

  // Find the YouTube Music song for { title, artist, album, duration }.
  async function findMatch(want) {
    const query = `${firstArtist(want.artist)} ${normalise(want.title)}`.trim();
    const results = await searchSongs(query);
    const ranked = results.map(r => ({ ...r, pre: similarity(want.title, r.title) })).sort((a, b) => b.pre - a.pre).slice(0, 3);
    let best = null;
    const consider = info => { if (!info) return; const s = scoreCandidate(want, info); if (!best || s.score > best.s.score) best = { info, s }; };
    // The top two are looked up together (most songs are settled by them);
    // the third only if neither fits.
    (await Promise.all(ranked.slice(0, 2).map(c => videoInfo(c.id).catch(() => null)))).forEach(consider);
    if (!(best && acceptable(best.s)) && ranked[2]) consider(await videoInfo(ranked[2].id).catch(() => null));
    if (best && acceptable(best.s)) return best.info;
    // Some songs are only on YouTube as videos ("Artist - Title (Official
    // Video)"). Search videos, strip the artist prefix, and require the
    // length to match, since a video's title is less reliable.
    const videos = await searchVideos(query).catch(() => []);
    let bestVideo = null;
    const vRanked = videos.map(v => ({ ...v, pre: containment(want.title, v.title) })).filter(v => v.pre >= 0.6).sort((a, b) => b.pre - a.pre).slice(0, 2);
    for (const info of await Promise.all(vRanked.map(v => videoInfo(v.id).catch(() => null)))) {
      if (!info) continue;
      const cleaned = { ...info, title: videoTitleWithoutArtist(info.title, want.artist) };
      const s = scoreCandidate(want, cleaned);
      if (s.durationOk && s.titleScore >= 0.6 && s.artistScore >= 0.5 && (!bestVideo || s.score > bestVideo.s.score)) bestVideo = { info, s };
    }
    return bestVideo ? bestVideo.info : null;
  }

  // Resolve a Hive track (path "ytm:…" plus title/artist/album/duration)
  // to a playable stream. Concurrent requests for one track share work.
  async function resolve(track, { fresh = false } = {}) {
    const key = String(track?.path || '');
    if (!key.startsWith('ytm:')) throw new Error('Not a streamed song.');
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const all = await loadMatches();
      // A saved match whose artist doesn't fit the song (an older, looser
      // match) is redone.
      const saved = all[key];
      if (saved && track.artist && saved.artist && containment(firstArtist(track.artist), saved.artist) < 0.5) { delete all[key]; track = { ...track, ytVideoId: '' }; }
      let videoId = String(track.ytVideoId || all[key]?.videoId || '');
      if (fresh && videoId) streams.delete(videoId); // the old link expired or was refused
      let info = null;
      if (videoId) { try { info = await videoInfo(videoId); } catch { info = null; } }
      if (!info) {
        info = await findMatch({ title: track.title, artist: track.artist, album: track.album, duration: track.duration });
        if (!info) throw new Error(`Couldn't find “${track.title}” to play in full.`);
        videoId = info.id;
      }
      all[key] = { videoId, title: info.track || info.title, artist: info.artist || '', at: Date.now() };
      saveMatchesSoon();
      return {
        streamUrl: info.url, videoId, expires: streams.get(videoId)?.expires || 0,
        youtube: { title: info.track || info.title, artist: info.artist || '', album: info.album || '', year: String(info.release_year || ''), duration: Number(info.duration) || 0,
          thumbnail: /^https:\/\//.test(String(info.thumbnail || '')) ? String(info.thumbnail) : '' }
      };
    })();
    inflight.set(key, job);
    try { return await job; } finally { inflight.delete(key); }
  }

  // Prepare songs before they're clicked: match each on YouTube Music and
  // fetch its audio link (valid for hours), two at a time. A newer list
  // replaces the old one, so this always follows the current queue.
  let prefetchList = [], prefetchRunning = 0, prefetchGeneration = 0;
  function isReady(track) {
    const id = matches?.[String(track?.path || '')]?.videoId;
    const s = id && streams.get(id);
    return !!(s && s.expires - Date.now() > 20 * 60 * 1000);
  }
  async function prefetchWorker(generation) {
    prefetchRunning++;
    try {
      while (generation === prefetchGeneration && prefetchList.length) {
        const track = prefetchList.shift();
        if (isReady(track)) continue;
        try { await resolve(track); } catch { /* not on YouTube Music: it'll say so when played */ }
        await new Promise(r => setTimeout(r, 250)); // stay gentle with YouTube
      }
    } finally { prefetchRunning--; }
  }
  // mode 'queue' replaces the list (the play queue comes first); 'append'
  // adds a browsed playlist's first songs after whatever is waiting.
  async function prefetch(tracks, { mode = 'queue' } = {}) {
    await loadMatches();
    const wanted = (Array.isArray(tracks) ? tracks : []).filter(t => String(t?.path || '').startsWith('ytm:')).slice(0, 60).filter(t => !isReady(t));
    if (mode === 'append') {
      const have = new Set(prefetchList.map(t => t.path));
      prefetchList.push(...wanted.filter(t => !have.has(t.path)));
      prefetchList = prefetchList.slice(0, 80);
      if (prefetchRunning < 2) for (let i = prefetchRunning; i < 2; i++) void prefetchWorker(prefetchGeneration);
      return prefetchList.length;
    }
    const generation = ++prefetchGeneration;
    prefetchList = wanted;
    for (let i = 0; i < 2; i++) void prefetchWorker(generation);
    return prefetchList.length;
  }

  // MusicBrainz (1 request a second, as its terms ask).
  function mbJson(url) {
    const run = async () => {
      const wait = Math.max(0, 1100 - (Date.now() - mbLast));
      if (wait) await new Promise(r => setTimeout(r, wait));
      mbLast = Date.now();
      const res = await net.fetch(url, { headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
      return res.json();
    };
    const p = mbChain.then(run, run);
    mbChain = p.catch(() => {});
    return p;
  }
  const luceneQuote = v => `"${String(v || '').replace(/["\\]/g, ' ').trim()}"`;

  // Tags for one song from MusicBrainz: the best recording whose title and
  // artist match, preferring an official album release.
  async function musicBrainzTags({ title, artist, album, duration }) {
    const q = `recording:${luceneQuote(normalise(title))} AND artist:${luceneQuote(firstArtist(artist))}`;
    const data = await mbJson(`${MB_API}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=8`);
    let best = null;
    for (const rec of data.recordings || []) {
      const credit = (rec['artist-credit'] || []).map(c => `${c.name}${c.joinphrase || ''}`).join('');
      const t = similarity(title, rec.title), a = containment(firstArtist(artist), credit);
      const lenOk = !duration || !rec.length || Math.abs(rec.length / 1000 - duration) <= Math.max(8, duration * 0.05);
      if (t < 0.6 || a < 0.5 || !lenOk) continue;
      for (const rel of rec.releases || []) {
        const official = rel.status === 'Official' ? 1 : 0;
        const albumMatch = album ? similarity(album, rel.title) : 0;
        const type = rel['release-group']?.['primary-type'];
        const score = t + a + official * 0.3 + albumMatch * 0.8 + (type === 'Album' ? 0.15 : type === 'Single' || type === 'EP' ? 0.05 : 0);
        if (!best || score > best.score) best = { score, rec, rel, credit };
      }
    }
    if (!best) return null;
    const { rec, rel, credit } = best;
    const medium = (rel.media || [])[0] || {};
    const trackOnRelease = (medium.track || [])[0] || {};
    const trackNumber = Number(trackOnRelease.number) || (Number.isFinite(Number(medium['track-offset'])) ? Number(medium['track-offset']) + 1 : 0);
    const relArtist = (rel['artist-credit'] || []).map(c => `${c.name}${c.joinphrase || ''}`).join('') || credit;
    return {
      title: rec.title, artist: credit, album: rel.title, albumArtist: relArtist,
      year: String(rec['first-release-date'] || rel.date || '').slice(0, 4),
      date: String(rel.date || ''),
      trackNumber, trackTotal: Number(medium['track-count']) || 0,
      discNumber: Number(medium.position) || 0,
      musicbrainzRecordingId: rec.id, musicbrainzReleaseId: rel.id, musicbrainzReleaseGroupId: rel['release-group']?.id || '',
      isrc: (rec.isrcs || [])[0] || ''
    };
  }

  // Serve a byte range of a video's audio for the media element. YouTube
  // refuses open-ended requests ("bytes=0-", which is what a media element
  // sends) and a short answer would look like the end of the song, so the
  // whole requested range is returned as one stream that is filled with
  // bounded 2 MB requests as the player reads it. A refused link is
  // replaced once with a fresh one.
  const CHUNK = 2 * 1024 * 1024;
  async function fetchChunk(videoId, from, to) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) streams.delete(videoId);
      const info = await videoInfo(videoId);
      const res = await net.fetch(info.url, { headers: { Range: `bytes=${from}-${to}` } });
      if (res.status === 403 || res.status === 410) continue;
      if (!res.ok) throw new Error(`The song server answered ${res.status}`);
      return res;
    }
    throw new Error('The song server refused the audio stream.');
  }
  async function streamRange(videoId, rangeHeader) {
    const m = /bytes=(\d+)-(\d*)/.exec(String(rangeHeader || ''));
    const start = m ? Number(m[1]) : 0;
    const wantedEnd = m && m[2] ? Number(m[2]) : Infinity;
    const first = await fetchChunk(videoId, start, Math.min(wantedEnd, start + CHUNK - 1));
    const total = Number(/\/(\d+)$/.exec(first.headers.get('content-range') || '')?.[1]) || 0;
    const end = Math.min(wantedEnd, total ? total - 1 : start + CHUNK - 1);
    let next = start + CHUNK, current = first.body.getReader(), cancelled = false;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          while (!cancelled) {
            const { value, done } = await current.read();
            if (value?.length) { controller.enqueue(value); return; }
            if (!done) continue;
            if (next > end) { controller.close(); return; }
            const res = await fetchChunk(videoId, next, Math.min(end, next + CHUNK - 1));
            next += CHUNK;
            current = res.body.getReader();
          }
        } catch (err) { controller.error(err); }
      },
      cancel() { cancelled = true; try { current.cancel(); } catch {} }
    });
    return { status: 206, total, start, end, contentType: first.headers.get('content-type') || 'audio/webm', body };
  }

  // Save a song's audio as <dir>/<baseName>.mp3: YouTube's best audio,
  // converted by ffmpeg to VBR V0 MP3 (~245 kbps). Returns the file path.
  async function downloadAudio(videoId, dir, baseName) {
    await fsp.mkdir(dir, { recursive: true });
    // YouTube now and then refuses a download (HTTP 403); a retry a moment
    // later usually goes through.
    let out = '', lastErr = null;
    for (let attempt = 0; attempt < 3 && !out; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, attempt * 2500));
      try {
        out = await ytDlp(['-f', 'bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-overwrites', '--no-part', '--retries', '5',
          '-o', path.join(dir, `${baseName}.%(ext)s`), '--print', 'after_move:filepath', `https://music.youtube.com/watch?v=${videoId}`], 10 * 60 * 1000);
      } catch (err) { lastErr = err; }
    }
    if (!out) throw lastErr || new Error("Couldn't load the full song.");
    const file = String(out).trim().split('\n').filter(Boolean).pop() || '';
    if (!file || !fs.existsSync(file)) throw new Error("The full song didn't download.");
    return file;
  }

  return { status, installYtDlp, resolve, prefetch, findMatch, musicBrainzTags, streamRange, downloadAudio };
}

module.exports = { create, normalise, similarity, containment, videoTitleWithoutArtist, scoreCandidate, acceptable, urlExpiry };
