'use strict';
// LRCLIB's /api/search returns fuzzy candidates. Pick the one that is really
// this song: same artist (loosely), length within a few seconds when Hive
// knows it, synced lyrics preferred, instrumental entries skipped.
const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function pickLrcLibCandidate(list, { artist = '', duration = 0, tolerance = 3 } = {}) {
  const want = fold(artist);
  const scored = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || c.instrumental) continue;
    if (!String(c.syncedLyrics || '').trim() && !String(c.plainLyrics || '').trim()) continue;
    const have = fold(c.artistName);
    if (want && have && !have.includes(want) && !want.includes(have)) continue;
    const off = Number(duration) > 0 && Number(c.duration) > 0 ? Math.abs(Number(c.duration) - Number(duration)) : null;
    if (off !== null && off > tolerance) continue;
    scored.push({ c, score: (String(c.syncedLyrics || '').trim() ? 10 : 0) - (off ?? tolerance) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.c || null;
}

module.exports = { pickLrcLibCandidate };
