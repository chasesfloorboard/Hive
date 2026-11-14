'use strict';

// Hive's play-stats.json access, serialized. Extracted from main.js (QUALITY-ROADMAP, Native playback/stats
// region). play-stats.json holds per-track play counts, ratings and history. Mutations are serialized so a
// clear operation cannot race a play/rating write and accidentally restore an old play count: every writer
// runs one at a time through withStatsMutation. readStats/writeStats are convenience wrappers over the
// injected safe JSON layer for the common whole-file read-modify-write; callers that also touch the audio
// files (rating/play-count embedding) still run their own body inside withStatsMutation.

function createPlayStatsStore({ statsPath, readJsonSafe, writeJsonSafe }) {
  let statsMutationChain = Promise.resolve();

  // Run `task` after any in-flight stats mutation settles (success or failure), and chain the next behind it.
  // Returns task's result. (A rejected task still advances the chain so one failure can't wedge all writers.)
  function withStatsMutation(task) {
    const run = statsMutationChain.then(task, task);
    statsMutationChain = run.catch(() => {});
    return run;
  }

  async function readStats(fallback = {}) {
    return readJsonSafe(statsPath(), fallback);
  }

  async function writeStats(data) {
    return writeJsonSafe(statsPath(), data);
  }

  return { withStatsMutation, readStats, writeStats };
}

module.exports = { createPlayStatsStore };
