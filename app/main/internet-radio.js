'use strict';
// Hive 2.0 internet radio (MusicBee's Web → Radio). Stations come from the
// free radio-browser.info directory or are added by URL. Streams play
// through the renderer's media element like podcast episodes; this module
// only searches the directory, resolves .pls/.m3u links to a stream URL,
// and reads the station's current song title from its ICY metadata.

const DIRECTORY = 'https://all.api.radio-browser.info/json';
const USER_AGENT = 'Hive/2.0 (music player; internet radio)';

// Chromium's media element can't play HLS, so those stations are left out.
function stationFromDirectory(s) {
  if (!s || !s.url_resolved && !s.url) return null;
  if (Number(s.hls) === 1 || /\.m3u8(\?|$)/i.test(String(s.url_resolved || s.url))) return null;
  return {
    id: String(s.stationuuid || s.url_resolved || s.url),
    name: String(s.name || '').trim() || 'Unnamed station',
    url: String(s.url_resolved || s.url),
    homepage: String(s.homepage || ''),
    favicon: String(s.favicon || ''),
    tags: String(s.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 4),
    country: String(s.country || ''),
    codec: String(s.codec || ''),
    bitrate: Number(s.bitrate) || 0
  };
}

// First stream URL in a .pls or .m3u playlist, or '' when there is none.
function parsePlaylist(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const pls = line.match(/^File\d+\s*=\s*(\S+)/i);
    if (pls && /^https?:\/\//i.test(pls[1])) return pls[1];
    if (/^https?:\/\//i.test(line)) return line;
  }
  return '';
}

// ICY metadata block: StreamTitle='Artist - Title';StreamUrl='...';
function parseIcyMetadata(text) {
  const m = String(text || '').match(/StreamTitle='((?:[^']|'(?!;))*)'/);
  const title = m ? m[1].replace(/\0+$/, '').trim() : '';
  if (!title) return null;
  const dash = title.indexOf(' - ');
  return dash > 0 ? { raw: title, artist: title.slice(0, dash).trim(), title: title.slice(dash + 3).trim() } : { raw: title, artist: '', title };
}

function create({ net }) {
  async function getJson(path) {
    const res = await net.fetch(`${DIRECTORY}${path}`, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Radio directory answered ${res.status}`);
    return res.json();
  }

  async function search(query, limit = 60) {
    const q = String(query || '').trim().slice(0, 100);
    const n = Math.max(1, Math.min(200, Number(limit) || 60));
    const common = `limit=${n}&hidebroken=true&order=clickcount&reverse=true`;
    let rows;
    if (!q) rows = await getJson(`/stations/topclick/${n}?hidebroken=true`);
    else {
      // Match the name first, then fill up with stations tagged with the query (a genre).
      const [byName, byTag] = await Promise.all([
        getJson(`/stations/search?name=${encodeURIComponent(q)}&${common}`),
        getJson(`/stations/search?tag=${encodeURIComponent(q.toLowerCase())}&${common}`).catch(() => [])
      ]);
      const seen = new Set();
      rows = [...byName, ...byTag].filter(s => !seen.has(s.stationuuid) && seen.add(s.stationuuid));
    }
    return rows.map(stationFromDirectory).filter(Boolean).slice(0, n);
  }

  // A station URL may be a playlist file; return the stream inside it.
  async function resolve(url) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('Station URLs must start with http:// or https://');
    if (!/\.(pls|m3u)(\?|$)/i.test(u)) return u;
    const res = await net.fetch(u, { headers: { 'User-Agent': USER_AGENT } });
    const found = parsePlaylist(await res.text());
    if (!found) throw new Error('No stream found in that playlist');
    return found;
  }

  // Read just enough of the stream to reach the first metadata block.
  async function nowPlaying(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await net.fetch(String(url), { headers: { 'Icy-MetaData': '1', 'User-Agent': USER_AGENT }, signal: controller.signal });
      const metaint = Number(res.headers.get('icy-metaint')) || 0;
      if (!metaint || !res.body || metaint > 512 * 1024) return null;
      const reader = res.body.getReader();
      let buf = Buffer.alloc(0);
      while (buf.length < metaint + 1 + 255 * 16) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = Buffer.concat([buf, Buffer.from(value)]);
        if (buf.length > metaint) {
          const len = buf[metaint] * 16;
          if (len === 0) return null;
          if (buf.length >= metaint + 1 + len) return parseIcyMetadata(buf.subarray(metaint + 1, metaint + 1 + len).toString('utf8'));
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return { search, resolve, nowPlaying };
}

module.exports = { create, stationFromDirectory, parsePlaylist, parseIcyMetadata };
