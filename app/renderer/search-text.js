'use strict';
// Pure text normalisation for search, typeahead and metadata matching (extracted from renderer.js —
// docs/ai/ARCHITECTURE.md). On the hottest path (every keystroke over a ~20k-track library), so it stays
// dependency-free. Loaded as a plain script (window.HiveSearchText) and by the tests via require().
(function (root) {
  // Case/accent/punctuation-folded text, space-padded so word-boundary includes() matches work.
  function foldSearchText(value) {
    return ` ${String(value || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/ß/g, 'ss')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  }

  // Lower-cased, accent-stripped, collapsed to [a-z0-9]+-separated words. Used for ASCII-only matching.
  function normalizeForSearch(value) {
    return String(value || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  // Like normalizeForSearch but without the final whitespace re-collapse (playlist/MusicBee match path).
  function normalizeMusicText(value) { return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  // Artist-search comparison value: trimmed, single-spaced, lower-cased (keeps punctuation).
  function normalizeArtistSearchValue(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // Typeahead key: locale-lower-cased, punctuation -> spaces, trimmed (keeps Unicode letters/numbers).
  function normalizeTypeaheadText(value) {
    return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  // A track's folded, searchable text: every tag value (recursing objects/arrays), minus internal fields.
  function buildTrackSearchIndex(t) {
    const values = [];
    const add = v => {
      if (v == null) return;
      if (typeof v === 'object') {
        if (Array.isArray(v)) v.forEach(add);
        else Object.values(v).forEach(add);
        return;
      }
      values.push(String(v));
    };
    Object.entries(t || {}).forEach(([key, value]) => {
      if (key === '_searchText' || key === 'covers') return;
      add(value);
    });
    return foldSearchText(values.join(' '));
  }

  const api = { foldSearchText, normalizeForSearch, normalizeMusicText, normalizeArtistSearchValue, normalizeTypeaheadText, buildTrackSearchIndex };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveSearchText = api;
})(typeof window !== 'undefined' ? window : globalThis);
