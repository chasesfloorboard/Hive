'use strict';
// Album grouping/ordering (extracted from renderer.js — docs/ai/ARCHITECTURE.md). Pure apart from the cover
// resolution in buildAlbums, which takes visualCoverForTrack(track) as a parameter so the module stays
// node-testable. Depends on cover-art.js for the Spotify helpers. Loaded as a plain script
// (window.HiveAlbumModel) AFTER cover-art.js, and by the tests via require().
(function (root) {
  const CoverArt = (typeof window !== 'undefined' && window.HiveCoverArt) ? window.HiveCoverArt : require('./cover-art');
  const { isSpotifyTrack, spotifyArtworkUrl } = CoverArt;
  // Numeric, accent-insensitive ordering (same options as renderer's songCollator).
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  // A stable album identity. Spotify album names are not globally unique, so prefer the album URI when given.
  function albumKey(t) {
    if (isSpotifyTrack(t) && t.albumUri) return `spotify||${String(t.albumUri).toLowerCase()}`;
    return `${(t.albumArtist || t.artist || '').toLowerCase()}||${(t.album || '').toLowerCase()}`;
  }

  // A disc/track position -> a positive integer (0 if absent/unparseable). Accepts objects and "3/12" forms.
  function mediaPositionNumber(value) {
    if (value == null) return 0;
    if (typeof value === 'object') {
      const n = Number(value.no ?? value.number ?? value.position ?? 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    const match = String(value).trim().match(/^\s*(\d+)/);
    const n = match ? Number(match[1]) : Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Album track order: disc (disk ?? disc) first, then track, then title, then path.
  function albumTrackCompare(a, b) {
    return mediaPositionNumber(a?.disk ?? a?.disc) - mediaPositionNumber(b?.disk ?? b?.disc)
      || mediaPositionNumber(a?.track) - mediaPositionNumber(b?.track)
      || collator.compare(String(a?.title || ''), String(b?.title || ''))
      || collator.compare(String(a?.path || ''), String(b?.path || ''));
  }

  // Group tracks into albums (by albumKey), order each album's tracks, sort albums by year then title.
  // visualCoverForTrack(track) resolves a track's display cover (renderer-side; reads artwork state).
  function buildAlbums(tracks, visualCoverForTrack) {
    const map = new Map();
    for (const t of tracks) {
      const key = albumKey(t);
      const visual = visualCoverForTrack(t);
      if (!map.has(key)) {
        map.set(key, { key, title: t.album, artist: t.albumArtist || t.artist, year: t.year, cover: visual, artworkUrl: spotifyArtworkUrl(t), covers: t.covers, tracks: [] });
      }
      const a = map.get(key);
      a.tracks.push(t);
      if (!a.cover && visual) { a.cover = visual; a.artworkUrl = spotifyArtworkUrl(t); a.covers = t.covers; }
      if (!a.year && t.year) a.year = t.year;
    }
    const list = Array.from(map.values());
    for (const a of list) a.tracks.sort(albumTrackCompare);
    list.sort((a, b) => (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title));
    return list;
  }

  const api = { albumKey, mediaPositionNumber, albumTrackCompare, buildAlbums };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveAlbumModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
