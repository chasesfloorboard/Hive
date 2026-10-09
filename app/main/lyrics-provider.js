'use strict';

function cleanLyrics(value) {
  return typeof value === 'string' ? value.replace(/^\uFEFF/, '').trim() : '';
}

/**
 * Pick the lyrics payload Hive should display/save. Synchronized LRC text is
 * always preferred over plain text when both are available.
 */
function selectPreferredLyrics(result) {
  const syncedLyrics = cleanLyrics(result?.syncedLyrics);
  const plainLyrics = cleanLyrics(result?.plainLyrics);
  const source = cleanLyrics(result?.source) || 'unknown';
  if (syncedLyrics) return { lyrics: syncedLyrics, synced: true, source };
  if (plainLyrics) return { lyrics: plainLyrics, synced: false, source };
  return null;
}

// The song's own title for a lyrics search. Tags often carry credits in
// brackets -- "Supervillain Intro (Prod. By Doom) (Feat. Mr. Chop)" -- that
// lyrics sites leave out, so the search never matched. Credit and edition
// labels are dropped; meaningful ones like "(Remix)" or "(Live)" stay.
const CREDIT_BRACKET = /^\s*(?:feat\.?|ft\.?|featuring|prod\.?|produced|co-prod\.?|with)\b|remaster|explicit|clean version|album version|single version|radio edit|bonus track/i;
function lyricsSearchTitle(title) {
  const original = String(title || '').trim();
  const stripped = original
    .replace(/\s*[(\[]([^()\[\]]*)[)\]]/g, (whole, inner) => (CREDIT_BRACKET.test(inner) ? '' : whole))
    .replace(/\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return stripped || original;
}

module.exports = { cleanLyrics, selectPreferredLyrics, lyricsSearchTitle };
