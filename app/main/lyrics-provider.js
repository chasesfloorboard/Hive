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

module.exports = { cleanLyrics, selectPreferredLyrics };
