'use strict';
// Fuzzy matching of streamed tracks (Apple Music / Spotify browse results) against the
// local library: a title normaliser, the library title-index it builds, and the
// artist-aware lookup. Extracted from renderer.js (docs/ai/ARCHITECTURE.md). Dual-mode:
// `window.HiveStreamingMatch` for the app, `module.exports` for node tests. A
// createX(deps) factory — the local-track predicate and a lazy library-tracks getter are
// injected, so the matching core is unit-testable and is the shared base both the Apple
// Music and Spotify browse pages lean on.
(function () {
  function createStreamingMatch(deps = {}) {
    const { isLocalPlaybackTrack, getLibraryTracks } = deps;
    if (typeof isLocalPlaybackTrack !== 'function' || typeof getLibraryTracks !== 'function') {
      throw new Error('createStreamingMatch needs { isLocalPlaybackTrack(), getLibraryTracks() }');
    }

    // Collapse a title/artist to a comparison key: drop (feat …)/(ft …)/(with …) and
    // trailing "feat …", strip diacritics (NFKD then combining marks U+0300–U+036F),
    // map & -> and, and remove everything but [a-z0-9]. So "Beyoncé (feat. Jay-Z)" and
    // "beyonce" collapse together.
    function appleMatchKey(text) {
      return String(text || '').toLowerCase()
        .replace(/[([](feat\.?|ft\.?|with|mixed|explicit|clean)[^)\]]*[)\]]/g, ' ')
        .replace(/\s+(feat\.?|ft\.?)\s+.*$/, ' ')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    }

    // Index the local library by title key for O(1) candidate lookup.
    function appleLibraryIndex() {
      const index = new Map();
      for (const t of getLibraryTracks() || []) {
        if (!isLocalPlaybackTrack(t)) continue;
        const key = appleMatchKey(t.title);
        if (!key) continue;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(t);
      }
      return index;
    }

    // Given the title index and a streamed track, return the local track whose
    // artist/albumArtist contains the streamed track's first (primary) artist, else null.
    function appleLocalMatch(index, at) {
      const candidates = index.get(appleMatchKey(at.title)) || [];
      const firstArtist = appleMatchKey(String(at.artist || '').split(/,|&| x /i)[0]);
      return candidates.find(t => { const a = appleMatchKey(`${t.artist} ${t.albumArtist || ''}`); return firstArtist && a.includes(firstArtist); }) || null;
    }

    return { appleMatchKey, appleLibraryIndex, appleLocalMatch };
  }

  const exported = { createStreamingMatch };
  if (typeof window !== 'undefined') window.HiveStreamingMatch = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
