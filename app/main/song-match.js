'use strict';

// "Is this the same song?" across Hive and Hive Mobile. The phone and the PC
// keep separate copies (often different formats: the phone's downloads are
// m4a, Hive's mp3), so there is no shared id or file hash: a song is the same
// when its normalized title matches and its artists overlap, with duration
// choosing between duplicates (live versions, remasters, re-rips).
//
// A port of mobile/android/.../link/TrackMatcher.kt. Both must agree: Hive
// uses this to refuse a song the phone sends that it already has, and the
// phone uses its copy to decide what to send. test/fixtures/song-match-vectors.json
// is checked by both test suites.

// Re-rips and different encoders shift a track's length by a few seconds;
// anything further apart is a different recording.
const DURATION_TOLERANCE_MS = 12000;

const FEAT_PARENS = /\((feat|ft|with)\.?[^)]*\)/g;
const FEAT_TAIL = /\s(feat|ft)\.\s.*$/;
const MARKS = /\p{M}+/gu;
const NON_WORD = /[^\p{L}\p{N}]+/gu;
const ARTIST_SEPARATORS = /\s*(?:\/|;|,|&|\bfeat\.?|\bft\.?|\bx\b|\band\b)\s*/i;

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD')
    .replace(FEAT_PARENS, '')
    .replace(FEAT_TAIL, '')
    .replace(MARKS, '')
    .replace(NON_WORD, '');
}

/** Individual artist names, split on the separators taggers use. */
function artistParts(value) {
  return new Set(String(value || '').split(ARTIST_SEPARATORS).map(normalize).filter(Boolean));
}

function durationOk(a, b) {
  return a <= 0 || b <= 0 || Math.abs(a - b) <= DURATION_TOLERANCE_MS;
}

/**
 * An index over candidates ({ key, title, artist, albumArtist, durationMs });
 * match() returns the candidate that is the same song, or null.
 */
function createIndex(candidates) {
  const byTitle = new Map();
  for (const c of candidates) {
    const t = normalize(c.title);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push({ candidate: c, artists: new Set([...artistParts(c.artist), ...artistParts(c.albumArtist)]) });
  }
  return {
    match({ title, artist, albumArtist, durationMs }) {
      const entries = byTitle.get(normalize(title)) || [];
      if (!entries.length) return null;
      const mine = [...artistParts(artist), ...artistParts(albumArtist)];
      const sameArtist = entries.filter(({ artists }) => {
        const theirs = [...artists];
        return !mine.length || !theirs.length || mine.some(m => artists.has(m)) ||
          mine.some(m => theirs.some(t => m.includes(t) || t.includes(m)));
      }).map(e => e.candidate);
      if (!sameArtist.length) return null;
      const d = Number(durationMs) || 0;
      if (sameArtist.length === 1) return durationOk(Number(sameArtist[0].durationMs) || 0, d) ? sameArtist[0] : null;
      let best = null;
      for (const c of sameArtist) {
        const cd = Number(c.durationMs) || 0;
        if (!durationOk(cd, d)) continue;
        if (!best || Math.abs(cd - d) < Math.abs((Number(best.durationMs) || 0) - d)) best = c;
      }
      return best;
    }
  };
}

module.exports = { normalize, artistParts, createIndex, DURATION_TOLERANCE_MS };
