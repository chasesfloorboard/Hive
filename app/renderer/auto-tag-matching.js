'use strict';
// Pure matching/ranking logic for the MusicBrainz "auto-tag album" feature: rank the
// candidate releases, map local files to a release's tracks, score a file<->track pair,
// and diff the tags that would change. Extracted from renderer.js
// (docs/ai/ARCHITECTURE.md). Dual-mode: `window.HiveAutoTagMatching` for the app,
// `module.exports` for node tests. A createX(deps) factory — only normalizeForSearch is
// injected — so the match thresholds, the by-elimination rule and the ranking bonuses
// (the bits that silently corrupt tags when they regress) are directly unit-testable.
// The DOM/IO (search, select, apply) stays in renderer and calls across this seam.
(function () {
  function createAutoTagMatching(deps = {}) {
    const { normalizeForSearch } = deps;
    if (typeof normalizeForSearch !== 'function') throw new Error('createAutoTagMatching needs { normalizeForSearch() }');

    // A filename with its extension and any leading track number stripped, normalised —
    // a fallback title when the file has no title tag.
    function autoTagFilenameStem(track) {
      const raw = String(track?.path || '').split(/[\\/]/).pop() || '';
      return normalizeForSearch(raw.replace(/\.[^.]+$/, '').replace(/^\s*\d{1,3}[\s._-]+/, ''));
    }

    // The leading integer of a "3" or "3/12" track/disc value, else 0.
    function autoTagTrackNumber(value) {
      const n = Number.parseInt(String(value ?? '').split('/')[0], 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    // True when a local track is missing any of title/artist/album/albumArtist.
    function autoTagNeedsMetadata(track) {
      const title = String(track?.title || '').trim();
      const artist = String(track?.artist || '').trim();
      const album = String(track?.album || '').trim();
      const albumArtist = String(track?.albumArtist || '').trim();
      return !title || !artist || !album || !albumArtist;
    }

    // The tags that would actually change if `remote`/`release` were applied to `local`
    // (only non-empty desired values that differ from the current value).
    function autoTagChangedFields(local, remote, release) {
      if (!local?.path || !remote) return {};
      const desired = {
        album: String(release?.title || '').trim(),
        albumArtist: String(release?.artist || '').trim(),
        artist: String(remote?.artist || release?.artist || '').trim(),
        title: String(remote?.title || '').trim(),
        track: String(remote?.position || '').trim(),
        disk: String(remote?.disc || '').trim(),
        year: String(release?.year || '').trim(),
        publisher: String(release?.label || '').trim()
      };
      const fields = {};
      const comparable = value => normalizeForSearch(value);
      for (const [key, value] of Object.entries(desired)) {
        if (!value) continue;
        const current = String(local?.[key] ?? '').trim();
        if (comparable(current) !== comparable(value)) fields[key] = value;
      }
      return fields;
    }

    // How confidently a local file matches a remote track: title (exact or stem), track
    // and disc numbers, artist, and a near-equal duration all add to the score.
    function autoTagMatchScore(local, remote) {
      const localTitle = normalizeForSearch(local?.title || '');
      const remoteTitle = normalizeForSearch(remote?.title || '');
      const fileStem = autoTagFilenameStem(local);
      const remoteStem = normalizeForSearch(remote?.title || '');
      let score = 0;
      if (localTitle && remoteTitle && localTitle === remoteTitle) score += 100;
      else if (fileStem && remoteStem && (fileStem === remoteStem || fileStem.includes(remoteStem) || remoteStem.includes(fileStem))) score += 80;
      const lt = autoTagTrackNumber(local?.track), rt = autoTagTrackNumber(remote?.position);
      const ld = autoTagTrackNumber(local?.disk), rd = autoTagTrackNumber(remote?.disc);
      if (lt && rt && lt === rt) score += 45;
      if (ld && rd && ld === rd) score += 10;
      const la = normalizeForSearch(local?.artist || '');
      const ra = normalizeForSearch(remote?.artist || '');
      if (la && ra && (la === ra || la.includes(ra) || ra.includes(la))) score += 12;
      const durationLocal = Number(local?.duration || 0), durationRemote = Number(remote?.duration || 0);
      if (durationLocal > 0 && durationRemote > 0 && Math.abs(durationLocal - durationRemote) <= 2.5) score += 25;
      return score;
    }

    // Greedily pair local files to release tracks by descending score, each used once.
    // A weak positional guess (score < 45) is refused, except the safe single
    // leftover-file/leftover-track elimination, which avoids position-based corruption.
    function buildAutoTagMapping(localTracks, remoteTracks) {
      const locals = (localTracks || []).map((track, index) => ({ track, index, needs: autoTagNeedsMetadata(track) }));
      const remotes = (remoteTracks || []).map((track, index) => ({ track, index }));
      const candidates = [];
      for (const remote of remotes) {
        for (const local of locals) {
          const score = autoTagMatchScore(local.track, remote.track);
          if (score > 0) candidates.push({ localIndex:local.index, remoteIndex:remote.index, score });
        }
      }
      candidates.sort((a,b) => b.score - a.score || a.localIndex - b.localIndex || a.remoteIndex - b.remoteIndex);
      const usedLocal = new Set(), usedRemote = new Set(), mapping = [];
      for (const candidate of candidates) {
        if (usedLocal.has(candidate.localIndex) || usedRemote.has(candidate.remoteIndex)) continue;
        // Do not use a weak positional guess when multiple possible files exist.
        if (candidate.score < 45) continue;
        usedLocal.add(candidate.localIndex); usedRemote.add(candidate.remoteIndex);
        mapping.push({ ...candidate, local:locals[candidate.localIndex].track, remote:remotes[candidate.remoteIndex].track });
      }
      const remainingLocals = locals.filter(x => !usedLocal.has(x.index));
      const remainingRemotes = remotes.filter(x => !usedRemote.has(x.index));
      // If the album has exactly one incomplete local file and exactly one remote
      // track left, elimination is safe and avoids position-based corruption.
      if (remainingLocals.length === 1 && remainingRemotes.length === 1) {
        mapping.push({ localIndex:remainingLocals[0].index, remoteIndex:remainingRemotes[0].index, score:50, local:remainingLocals[0].track, remote:remainingRemotes[0].track, byElimination:true });
      }
      return mapping;
    }

    // Order candidate releases best-first: a Single whose name is in a lone file's title
    // is strongly preferred; otherwise releases whose track count is closest to (and at
    // least) the local file count rank above shorter ones.
    function rankAutoTagReleases(results, localTracks) {
      const wanted = localTracks.length;
      const loneTitle = wanted === 1 ? normalizeForSearch(localTracks[0]?.title || autoTagFilenameStem(localTracks[0]) || '') : '';
      const bonus = item => {
        const type = String(item.releaseType || '').toLowerCase();
        if (loneTitle && type === 'single' && loneTitle.includes(normalizeForSearch(item.collectionName || ''))) return 50;
        if (!wanted || !item.trackCount) return 0;
        return item.trackCount >= wanted ? Math.max(0, 20 - (item.trackCount - wanted)) : -40;
      };
      return results
        .map((item, index) => ({ item, index, rank: Number(item.score || 0) + bonus(item) }))
        .sort((a, b) => b.rank - a.rank || a.index - b.index)
        .map(({ item }) => item);
    }

    return { rankAutoTagReleases, autoTagNeedsMetadata, autoTagChangedFields, autoTagFilenameStem, autoTagTrackNumber, autoTagMatchScore, buildAutoTagMapping };
  }

  const exported = { createAutoTagMatching };
  if (typeof window !== 'undefined') window.HiveAutoTagMatching = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
