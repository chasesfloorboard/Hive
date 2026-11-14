'use strict';
// Pure (de)serialization of the play queue / session snapshot. Extracted from
// renderer.js (docs/ai/ARCHITECTURE.md — renderer de-monolith). Dual-mode:
// `window.HiveQueueSerialize` for the app (loaded before renderer.js, which
// destructures the three names), `module.exports` for node tests. No DOM, no app
// state — every input is an argument, so this is fully unit-testable, which matters
// because the savedAt/queueSavedAt tie-break and the donor-borrow below are exactly
// the fiddly, regression-prone bits that used to hide inside the monolith.
(function () {
  // Flatten a live queue track to the minimal, stable shape persisted in a snapshot.
  function serializeQueueTrack(t) {
    if (!t?.path) return null;
    // loved/rating/ratingRaw are a backstop only -- the authoritative source
    // is always libraryTrackByPath, resolved at the point of use (context
    // menu, playbar Love button, etc.) since embedded tags can change after a
    // queue was saved. Carrying them here just means a restored queue entry
    // is never blankly "not Loved" before that resolution has a chance to run.
    return { path:String(t.path), source:String(t.source||'local'), spotifyUri:String(t.spotifyUri||''), spotifyId:String(t.spotifyId||''), spotifyContextUri:String(t.spotifyContextUri||t.contextUri||''), contextUri:String(t.contextUri||t.spotifyContextUri||''), streamUrl:String(t.streamUrl||''), title:String(t.title||''), artist:String(t.artist||''), album:String(t.album||''), albumUri:String(t.albumUri||''), albumArtist:String(t.albumArtist||''), duration:Number(t.duration)||0, cover:String(t.cover||''), artworkUrl:String(t.artworkUrl||''), spotifyArtworkCacheFile:String(t.spotifyArtworkCacheFile||''), year:String(t.year||''), podcastId:String(t.podcastId||''), podcastFeedUrl:String(t.podcastFeedUrl||''), podcastDescription:String(t.podcastDescription||''), pubDate:String(t.pubDate||''), loved:!!t.loved, rating:Number(t.rating)||0, ratingRaw:Number(t.ratingRaw)||0,
      // Streamed songs: where they came from, for "Open in …" after a restart.
      ...(t.appleMusicUrl ? { appleMusicUrl:String(t.appleMusicUrl) } : {}), ...(t.ytVideoId ? { ytVideoId:String(t.ytVideoId) } : {}), ...(t.genre ? { genre:String(t.genre) } : {}) };
  }

  // Rebuild queue entries from a snapshot. `byPath` maps a path to its live library
  // track; streamed entries carry their own data, local entries re-resolve against it.
  function restoreQueueItems(items, paths, byPath, allowSerializedLocal = false) {
    if (!Array.isArray(items) || !items.length) {
      // A paths-only snapshot (the backend playback-state.json) is normally
      // restored before the library has loaded, so byPath is empty. Keep a
      // minimal local entry instead of dropping the track; queue rows re-resolve
      // against the library object once it arrives (populateQueueVirtualRow).
      return (paths||[]).map(p => {
        const key = String(p || '');
        if (!key) return null;
        return byPath.get(key) || (allowSerializedLocal ? { path:key, source:'local', title:key.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') } : null);
      }).filter(Boolean);
    }
    return items.map(item => {
      if (item && (item.source === 'spotify' || item.source === 'podcast' || item.source === 'youtube')) return {...item};
      const pathKey = String(item?.path || item || '');
      return byPath.get(pathKey) || (allowSerializedLocal && item && item.path ? {...item} : null);
    }).filter(Boolean);
  }

  // Picks the queue snapshot to restore. Ordered by queueSavedAt, which only
  // queue saves write: the backend file's savedAt is bumped by every transport
  // (position) save, including the one on shutdown right after the queue save,
  // so comparing savedAt made the paths-only backend copy win almost every
  // time. On a tie the snapshot with serialized queueItems wins, and a
  // paths-only winner borrows queueItems from a snapshot of the same queue.
  function pickQueueSnapshot(snapshots) {
    const usable = (snapshots || []).filter(s => Array.isArray(s?.paths) && s.paths.length);
    if (!usable.length) return null;
    const queueTime = s => Number(s.queueSavedAt ?? s.savedAt) || 0;
    const hasItems = s => Array.isArray(s.queueItems) && s.queueItems.length > 0;
    const best = usable.reduce((a, b) => {
      if (queueTime(b) !== queueTime(a)) return queueTime(b) > queueTime(a) ? b : a;
      return hasItems(b) && !hasItems(a) ? b : a;
    });
    if (hasItems(best)) return best;
    const samePaths = s => s.paths.length === best.paths.length && s.paths.every((p, i) => String(p) === String(best.paths[i]));
    const donor = usable.find(s => s !== best && hasItems(s) && samePaths(s));
    // The backend file never stores the pre-shuffle order either.
    return donor ? {
      ...best,
      queueItems: donor.queueItems,
      shuffleBasePaths: best.shuffleBasePaths?.length ? best.shuffleBasePaths : donor.shuffleBasePaths,
      shuffleBaseItems: best.shuffleBaseItems?.length ? best.shuffleBaseItems : donor.shuffleBaseItems
    } : best;
  }

  const exported = { serializeQueueTrack, restoreQueueItems, pickQueueSnapshot };
  if (typeof window !== 'undefined') window.HiveQueueSerialize = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
