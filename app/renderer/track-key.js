'use strict';
// Stable track identities for play counting (extracted from renderer.js — see docs/ai/ARCHITECTURE.md).
// Pure helpers only. Loaded as a plain script (window.HiveTrackKey) and by the tests via require().
(function (root) {
  // A track must accumulate at least this much listening time before a play counts.
  const PLAY_COUNT_QUALIFY_MS = 5000;

  // The identity used for play counting: the local file path, else a stream URI/URL.
  function playCountTrackKey(t) {
    return String(t?.path || t?.spotifyUri || t?.streamUrl || '');
  }

  // A richer identity used to tell one listening session from another (adds title/artist/album).
  function wrapTrackKey(t) {
    return [t?.path, t?.spotifyUri, t?.streamUrl, t?.title, t?.artist, t?.album].map(v => String(v || '')).join('|');
  }

  const api = { PLAY_COUNT_QUALIFY_MS, playCountTrackKey, wrapTrackKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveTrackKey = api;
})(typeof window !== 'undefined' ? window : globalThis);
