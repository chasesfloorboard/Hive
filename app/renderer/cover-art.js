'use strict';
// Cover-art URL building (extracted from renderer.js — docs/ai/ARCHITECTURE.md). Pure URL/string logic; the
// two functions that wrap a bare local path as mbcover:// take the resolver (window.beehive.coverUrl) as an
// argument so they stay node-testable. Loaded as a plain script (window.HiveCoverArt) and by tests via require.
(function (root) {
  function isSpotifyTrack(t) { return String(t?.source || '').toLowerCase() === 'spotify' && !!t?.spotifyUri; }

  // A spotify:image:<id> provider URI -> its https URL; anything else is trimmed and returned as-is.
  function normalizeSpotifyArtworkSource(value) {
    const source = String(value || '').trim();
    if (/^spotify:image:/i.test(source)) {
      const id = source.slice('spotify:image:'.length).trim();
      if (/^[A-Za-z0-9_-]+$/.test(id)) return `https://i.scdn.co/image/${id}`;
    }
    return source;
  }

  // The first http(s) artwork URL for a Spotify track, else ''.
  function spotifyArtworkUrl(t) {
    if (!isSpotifyTrack(t)) return '';
    for (const value of [t?.artworkUrl, t?.cover]) {
      const url = normalizeSpotifyArtworkSource(value);
      if (/^https?:\/\//i.test(url)) return url;
    }
    return '';
  }

  // The cached artwork for a Spotify track, resolved through the mbcover: resolver (coverUrl); '' when none.
  function spotifyCachedArtworkSrc(t, coverUrl) {
    if (!isSpotifyTrack(t) || !t?.spotifyArtworkCacheFile) return '';
    return (typeof coverUrl === 'function' ? coverUrl(String(t.spotifyArtworkCacheFile)) : null) || '';
  }

  let placeholderCache = null;
  function placeholderCover() {
    if (placeholderCache) return placeholderCache;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='100%' height='100%' fill='%231c1c22'/><text x='50%' y='55%' font-size='60' text-anchor='middle' fill='%233a3a44' font-family='sans-serif'>♪</text></svg>`;
    placeholderCache = `data:image/svg+xml;utf8,${svg}`;
    return placeholderCache;
  }

  // A cover file/URL -> a browser-ready src. Idempotent: an already-resolved URL (http/data/blob/mbcover/
  // mbfile) is returned unchanged -- a real bug once double-wrapped mbcover://mbcover%3A... so covers went
  // blank. A bare local path is wrapped via coverUrl; nothing -> the no-cover placeholder.
  function coverSrc(coverFile, coverUrl) {
    const normalized = normalizeSpotifyArtworkSource(coverFile);
    if (/^(?:https?:\/\/|data:image\/|blob:|mbcover:\/\/|mbfile:\/\/)/i.test(normalized)) return normalized;
    return (typeof coverUrl === 'function' ? coverUrl(normalized) : null) || placeholderCover();
  }

  const api = { isSpotifyTrack, normalizeSpotifyArtworkSource, spotifyArtworkUrl, spotifyCachedArtworkSrc, placeholderCover, coverSrc };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveCoverArt = api;
})(typeof window !== 'undefined' ? window : globalThis);
