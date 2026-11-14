'use strict';

// config.json access, serialized. Extracted from main.js (QUALITY-ROADMAP, Persistence 4). Every change
// to config.json goes through updateConfig, one at a time: writers used to read-modify-write it unlocked,
// so two at once (a UI-state save and adding a folder) each overwrote the other's change. The read-modify-
// write runs inside the safe JSON layer's per-path lock (withJsonFileLock). `folders` is always coerced to
// a list (a fresh profile had none, and adding a folder threw). Depends only on the injected json-store.

function createConfigStore({ configPath, readJsonSafe, writeJsonSafe, withJsonFileLock }) {
  // A config object is always a plain object with a `folders` array.
  function normalize(raw) {
    const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { folders: [] };
    if (!Array.isArray(config.folders)) config.folders = [];
    return config;
  }

  // Read the current config, normalised. (Callers that only read may still use readJsonSafe directly; this
  // is the canonical shape.)
  async function readConfig() {
    return normalize(await readJsonSafe(configPath(), { folders: [] }));
  }

  // Serialized read-modify-write. `mutate(config)` may be async; whatever it returns is returned to the
  // caller after the (possibly mutated) config is written back.
  function updateConfig(mutate) {
    return withJsonFileLock(configPath(), async () => {
      const config = normalize(await readJsonSafe(configPath(), { folders: [] }));
      const result = await mutate(config);
      await writeJsonSafe(configPath(), config);
      return result;
    });
  }

  return { normalize, readConfig, updateConfig };
}

module.exports = { createConfigStore };
