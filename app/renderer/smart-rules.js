'use strict';
// Smart-playlist rule matching / dedup / sort (extracted from renderer.js — docs/ai/ARCHITECTURE.md). The
// matching pipeline is pure; the few stateful bits are INJECTED so the module stays node-testable and so a
// wrong field-type can't silently break Favorites. createSmartRules(deps) returns the pipeline; renderer
// wires the real resolvers, tests pass fakes. The stateful source/evaluate layer stays in renderer.
// Loaded as a plain script (window.HiveSmartRules) and by the tests via require().
(function (root) {
  function createSmartRules(deps) {
    const {
      normalizeMetadataText = (v) => String(v || ''),
      playlistNamesFor = () => '',          // smartPlaylistNamesFor(path): the playlist names a track is in
      virtualValue = () => '',              // hivebeeVirtualValue(track, key): a user-defined virtual field
      shuffleForPlayback = (a) => a,         // the seeded playback shuffle
      now = () => Date.now(),                // injectable clock for relative-date rules
    } = deps || {};

    const smartNum = (v) => Number(v || 0);
    const smartText = (v) => normalizeMetadataText(v);

    // One getter per field: a rule reads only its own field.
    const SMART_FIELD_GETTERS = {
      title: t => t.title, artist: t => t.artist, album: t => t.album, albumArtist: t => t.albumArtist,
      genre: t => t.genre, composer: t => t.composer, publisher: t => t.publisher, conductor: t => t.conductor,
      comment: t => normalizeMetadataText(t.comment), grouping: t => t.grouping, copyright: t => t.copyright,
      originalArtist: t => t.originalArtist, originalAlbum: t => t.originalAlbum, originalYear: t => t.originalYear,
      language: t => t.language, mood: t => t.mood, occasion: t => t.occasion, keywords: t => t.keywords,
      tempo: t => t.tempo, bpm: t => t.tempo, isrc: t => t.isrc, barcode: t => t.barcode,
      year: t => smartNum(t.year), releaseDate: t => smartText(t.releaseDate || t.year || ''), plays: t => smartNum(t.playCount), skipCount: t => smartNum(t.skipCount), rating: t => smartNum(t.rating), love: t => t.loved ? 'Loved' : 'Not Loved', favorite: t => !!t.loved,
      duration: t => smartNum(t.duration), time: t => smartNum(t.duration), sampleRate: t => smartNum(t.sampleRate), bitrate: t => smartNum(t.bitrate),
      track: t => smartNum(t.track), disc: t => smartNum(t.disk ?? t.disc), trackCount: t => smartNum(t.trackCount), discCount: t => smartNum(t.discCount),
      addedAt: t => smartNum(t.addedAt), dateAdded: t => smartNum(t.addedAt), lastPlayedAt: t => smartNum(t.lastPlayedAt),
      playlist: t => playlistNamesFor(t.path),
      path: t => smartText(t.path), codec: t => smartText(t.codec), fileType: t => smartText(t.codec), channels: t => smartNum(t.channels),
      season: t => smartText(t.season), ticketed: t => smartText(t.ticketed), trackGain: t => smartText(t.trackGain), sortAlbum: t => smartText(t.sortAlbum || t.album),
      sortAlbumArtist: t => smartText(t.sortAlbumArtist || t.albumArtist), sortArtist: t => smartText(t.sortArtist || t.artist), sortComposer: t => smartText(t.sortComposer || t.composer), sortTitle: t => smartText(t.sortTitle || t.title),
      videoKind: t => smartText(t.videoKind), virtual1: t => virtualValue(t, 'virtual1'), virtual2: t => virtualValue(t, 'virtual2'), virtual3: t => virtualValue(t, 'virtual3'),
      lyrics: t => normalizeMetadataText(t.lyrics), albumRating: t => smartNum(t.albumRating), quality: t => smartText(t.quality),
    };

    function smartFieldValue(t, field) {
      // A song's own custom tag of that name wins.
      const custom = t.customTags;
      if (custom && Object.prototype.hasOwnProperty.call(custom, field) && custom[field] !== undefined) return custom[field];
      const get = SMART_FIELD_GETTERS[field];
      const value = get ? get(t) : undefined;
      return value !== undefined ? value : smartText(t[field]);
    }

    function smartRelativeSpanMs(text) {
      const m = String(text || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([hdwmy]?)$/);
      if (!m) return 0;
      const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30.4375 * 86400e3, y: 365.25 * 86400e3 }[m[2] || 'd'];
      return Number(m[1]) * unit;
    }

    function smartCompare(t, rule) {
      const value = smartFieldValue(t, rule.field), op = rule.op, target = rule.value ?? '';
      if (rule.field === 'favorite') return op === 'is' ? value === (target === 'true') : value !== (target === 'true');
      if (rule.field === 'love') { const wanted = String(target).toLowerCase(); return op === 'is' ? String(value).toLowerCase() === wanted : String(value).toLowerCase() !== wanted; }
      // MusicBee-style relative dates: "in the last 30d / 2w / 6m / 1y / 12h" (a bare number means days).
      if (op === 'inLast' || op === 'notInLast') {
        const span = smartRelativeSpanMs(target); if (!span) return false;
        const when = Number(value) || 0, inside = when > 0 && when >= now() - span;
        return op === 'inLast' ? inside : !inside;
      }
      const numericFields = ['year', 'originalYear', 'plays', 'skipCount', 'rating', 'duration', 'sampleRate', 'bitrate', 'track', 'disc', 'trackCount', 'discCount', 'addedAt', 'lastPlayedAt', 'channels', 'tempo', 'quality'];
      if (numericFields.includes(rule.field)) {
        const n = Number(target); if (!Number.isFinite(n)) return false;
        if (op === 'eq') return Number(value) === n; if (op === 'gt') return Number(value) > n; if (op === 'gte') return Number(value) >= n; if (op === 'lt') return Number(value) < n; if (op === 'lte') return Number(value) <= n;
        return false;
      }
      const a = String(value).toLowerCase(), b = String(target).toLowerCase();
      if (op === 'contains') return a.includes(b); if (op === 'notcontains') return !a.includes(b); if (op === 'is') return a === b; if (op === 'not') return a !== b; if (op === 'starts') return a.startsWith(b); if (op === 'ends') return a.endsWith(b); if (op === 'empty') return !a.trim(); if (op === 'notempty') return !!a.trim();
      return false;
    }

    function smartDeduplicate(tracks) {
      const seen = new Set(), out = [];
      for (const t of tracks) {
        const key = String(t.path || '').toLowerCase();
        const identity = String(t.title || '').trim().toLowerCase() + '|' + String(t.artist || '').trim().toLowerCase() + '|' + String(t.duration || 0);
        const k = identity || key;
        if (seen.has(k)) continue;
        seen.add(k); out.push(t);
      }
      return out;
    }

    function sortSmartTracks(out, sort) {
      if (sort === 'random') return shuffleForPlayback(out);
      if (sort === 'title') out.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' }));
      else if (sort === 'artist') out.sort((a, b) => String(a.artist || '').localeCompare(String(b.artist || ''), undefined, { numeric: true, sensitivity: 'base' }));
      else if (sort === 'album') out.sort((a, b) => String(a.album || '').localeCompare(String(b.album || ''), undefined, { numeric: true, sensitivity: 'base' }));
      else if (sort === 'playsDesc') out.sort((a, b) => Number(b.playCount || 0) - Number(a.playCount || 0));
      else if (sort === 'ratingDesc') out.sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0));
      else if (sort === 'lastPlayedDesc') out.sort((a, b) => Number(b.lastPlayedAt || 0) - Number(a.lastPlayedAt || 0));
      else out.sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0));
      return out;
    }

    return { smartNum, smartText, SMART_FIELD_GETTERS, smartFieldValue, smartRelativeSpanMs, smartCompare, smartDeduplicate, sortSmartTracks };
  }

  const api = { createSmartRules };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveSmartRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
