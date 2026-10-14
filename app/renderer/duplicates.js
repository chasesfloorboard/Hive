'use strict';
// Hive "Find duplicates" (MusicBee: Tools > Find duplicates). Pure
// grouping and keep-best ranking; the renderer shows the groups. Loaded as a
// plain script (window.HiveDuplicates) and via require() by tests.
(function (root) {
  const VERSION_NOISE = /\s*[([](?:\d{4}\s+)?(?:remaster(?:ed)?|re-?master(?:ed)?|deluxe|bonus track|explicit|clean|album version|single version|mono|stereo)(?:\s+(?:version|edition|\d{4}))*[)\]]\s*/gi;

  function normalise(text, { ignoreVersions = true } = {}) {
    let s = String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (ignoreVersions) s = s.replace(VERSION_NOISE, ' ');
    s = s.replace(/\s*(?:feat\.?|ft\.?|featuring)\s.+$/, ''); // "feat." credits
    return s.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  const LOSSLESS = /^(flac|alac|ape|wavpack|wv|wav|aiff?|pcm|tta|dsd)/i;
  function qualityScore(t) {
    const codec = String(t?.codec || t?.path || '').toLowerCase();
    const lossless = LOSSLESS.test(String(t?.codec || '')) || /\.(flac|wav|aiff?|ape|wv|alac)$/i.test(String(t?.path || ''));
    return [lossless ? 1 : 0, Number(t?.bitDepth || 0), Number(t?.bitrate || 0), Number(t?.sampleRate || 0), Number(t?.playCount || 0), Number(t?.rating || 0), -codec.length];
  }
  function compareQuality(a, b) {
    const x = qualityScore(a), y = qualityScore(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return String(a?.path || '').localeCompare(String(b?.path || ''));
  }

  // Groups of 2+ tracks that look like the same recording. Tracks whose
  // lengths differ by more than `toleranceSeconds` stay apart (a live take,
  // an extended mix). Each group is sorted best-quality first.
  function findDuplicates(tracks, { matchAlbum = false, ignoreVersions = true, toleranceSeconds = 3 } = {}) {
    const buckets = new Map();
    for (const t of tracks || []) {
      if (!t?.path) continue;
      const title = normalise(t.title, { ignoreVersions });
      if (!title) continue;
      const key = [normalise(t.artist || t.albumArtist, { ignoreVersions }), title, matchAlbum ? normalise(t.album, { ignoreVersions }) : ''].join('\u0000');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
    const groups = [];
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      // Split by duration so different versions with one title stay apart.
      const sorted = list.slice().sort((a, b) => Number(a.duration || 0) - Number(b.duration || 0));
      let cluster = [sorted[0]];
      const flush = () => { if (cluster.length > 1) groups.push(cluster.slice().sort(compareQuality)); };
      for (let i = 1; i < sorted.length; i++) {
        const prev = cluster[cluster.length - 1], cur = sorted[i];
        const known = Number(prev.duration) > 0 && Number(cur.duration) > 0;
        if (!toleranceSeconds || !known || Math.abs(Number(cur.duration) - Number(prev.duration)) <= toleranceSeconds) cluster.push(cur);
        else { flush(); cluster = [cur]; }
      }
      flush();
    }
    return groups.sort((a, b) => String(a[0].artist || '').localeCompare(String(b[0].artist || ''), undefined, { sensitivity: 'base' }) || String(a[0].title || '').localeCompare(String(b[0].title || ''), undefined, { sensitivity: 'base' }));
  }

  const api = { normalise, compareQuality, findDuplicates };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveDuplicates = api;
})(typeof window !== 'undefined' ? window : globalThis);
