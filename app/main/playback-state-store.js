'use strict';

// The renderer's playback-recovery snapshot (queue, current track, position, volume, shuffle/repeat).
// Written SYNCHRONOUSLY on renderer shutdown so the last position/queue is on disk before the window
// disappears, and periodically while playing. Extracted from main.js (QUALITY-ROADMAP, Persistence 2).
//
// Durability matters: the user-data folder can live on a portable exFAT drive, where an abrupt exit
// right after a plain rename has left a 0-byte playback-state.json in the wild — losing the queue and
// position. So every write is temp → fsync → rename. statePath is injected as a lazy getter; now() is
// injected so the savedAt/queueSavedAt stamps are testable.

function createPlaybackStateStore({ fs, path, statePath, now = () => Date.now() }) {
  function writeDurableSync(payload) {
    const target = statePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  }

  // A full queue save: validate and normalise every field into the versioned on-disk shape.
  function sanitizeSnapshot(state = {}) {
    const stamp = now();
    return {
      version: 3,
      paths: Array.isArray(state.paths) ? state.paths.map(p => String(p || '')).filter(Boolean) : [],
      currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : -1,
      currentPath: String(state.currentPath || ''),
      position: Number.isFinite(Number(state.position)) ? Math.max(0, Number(state.position)) : 0,
      shuffle: !!state.shuffle,
      repeat: Number.isInteger(Number(state.repeat)) && Number(state.repeat) >= 0 && Number(state.repeat) <= 2 ? Number(state.repeat) : 0,
      volume: Number.isFinite(Number(state.volume)) ? Math.max(0, Math.min(1, Number(state.volume))) : 1,
      selectedQueueIndex: Number.isInteger(state.selectedQueueIndex) ? state.selectedQueueIndex : -1,
      selectedIndices: Array.isArray(state.selectedIndices) ? state.selectedIndices.filter(Number.isInteger) : [],
      wasPlaying: !!state.wasPlaying,
      savedAt: stamp,
      // Only queue saves set this; transport merges keep it via ...existing.
      queueSavedAt: Number.isFinite(Number(state.queueSavedAt)) ? Number(state.queueSavedAt) : stamp
    };
  }

  // A transport-only update: keep the existing queue (paths/selection/version) and overwrite just the
  // live transport fields. (A past bug read the file asynchronously here and spread a Promise, so every
  // shutdown rewrote the file WITHOUT the queue — hence the explicit field-by-field merge.)
  function mergeTransport(existing = {}, state = {}) {
    return {
      ...existing,
      position: Number.isFinite(Number(state.position)) ? Math.max(0, Number(state.position)) : Number(existing.position || 0),
      currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : (Number.isInteger(existing.currentIndex) ? existing.currentIndex : -1),
      currentPath: state.currentPath != null ? String(state.currentPath || '') : String(existing.currentPath || ''),
      shuffle: state.shuffle == null ? !!existing.shuffle : !!state.shuffle,
      repeat: Number.isInteger(Number(state.repeat)) && Number(state.repeat) >= 0 && Number(state.repeat) <= 2 ? Number(state.repeat) : (Number.isInteger(existing.repeat) ? existing.repeat : 0),
      volume: Number.isFinite(Number(state.volume)) ? Math.max(0, Math.min(1, Number(state.volume))) : (Number.isFinite(Number(existing.volume)) ? Number(existing.volume) : 1),
      wasPlaying: state.wasPlaying == null ? !!existing.wasPlaying : !!state.wasPlaying,
      savedAt: now()
    };
  }

  // Full queue save (ipc playback-state:saveSync). Returns the written payload.
  function saveSnapshotSync(state) {
    const payload = sanitizeSnapshot(state);
    writeDurableSync(payload);
    return payload;
  }

  // Transport-only merge-and-save (ipc playback-state:updateTransportSync). Returns the written payload.
  function updateTransportSync(state) {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch {}
    const payload = mergeTransport(existing, state);
    writeDurableSync(payload);
    return payload;
  }

  return { writeDurableSync, sanitizeSnapshot, mergeTransport, saveSnapshotSync, updateTransportSync };
}

module.exports = { createPlaybackStateStore };
