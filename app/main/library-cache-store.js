'use strict';

// In-memory owner of the library cache (library.json + its .gz sidecar).
//
// The cache is tens of MB for a large library. Every Love click used to read
// and JSON.parse the whole file, then stringify, fsync and gzip it all again --
// about half a second of blocked main process and ~85 MB of disk writes per
// click. This keeps the parsed cache in memory while it is in use and coalesces
// writes, so a burst of edits costs one save.
//
// get() hands out the shared object: callers mutate it and pass it to set(),
// exactly as they used to with a fresh read + write. flush() must run before
// anything reads the files directly (library:getCached) and before quit.
function createLibraryCacheStore({
  read,
  write,
  flushDelayMs = 1500,
  idleEvictMs = 60000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {}
}) {
  let data = null;
  let generation = 0;
  let loading = null;
  let dirty = false;
  let flushTimer = null;
  let evictTimer = null;
  let writing = Promise.resolve();
  let writesInFlight = 0;

  const unref = (timer) => { try { timer?.unref?.(); } catch {} return timer; };

  // Keeping ~100+ MB of parsed tracks resident forever isn't worth it; the
  // next edit after an idle minute pays one parse.
  function scheduleEvict() {
    if (evictTimer) clearTimer(evictTimer);
    evictTimer = unref(setTimer(() => {
      evictTimer = null;
      if (!dirty && !flushTimer) data = null;
    }, idleEvictMs));
  }

  async function get() {
    scheduleEvict();
    if (data) return data;
    if (!loading) {
      const startedAt = generation;
      loading = Promise.resolve()
        .then(() => read())
        .then((value) => {
          if (startedAt !== generation) return data;
          if (!data && value && typeof value === 'object') data = value;
          return data;
        })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  function set(next) {
    generation++;
    data = next;
    dirty = true;
    scheduleEvict();
    if (!flushTimer) flushTimer = unref(setTimer(() => { flushTimer = null; flush().catch(onError); }, flushDelayMs));
  }

  function flush() {
    if (flushTimer) { clearTimer(flushTimer); flushTimer = null; }
    writing = writing.catch(() => {}).then(async () => {
      if (!dirty) return;
      dirty = false;
      const snapshot = data;
      writesInFlight++;
      try {
        await write(snapshot);
      } catch (err) {
        // Keep the change pending so the next flush (or quit) retries it.
        if (data === snapshot) dirty = true;
        throw err;
      } finally {
        writesInFlight--;
      }
    });
    return writing;
  }

  // The files were deleted/reset elsewhere; drop memory and any pending save
  // so a delayed flush can't bring the old cache back.
  async function clear() {
    if (flushTimer) { clearTimer(flushTimer); flushTimer = null; }
    dirty = false;
    data = null;
    generation++;
    await writing.catch(() => {});
    data = null;
  }

  return { get, set, flush, clear, needsFlush: () => dirty || writesInFlight > 0 };
}

module.exports = { createLibraryCacheStore };
