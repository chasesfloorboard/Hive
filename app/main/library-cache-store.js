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

  // Apply a SYNCHRONOUS mutation to the LIVE cache object and persist it. Prefer this over
  // get()-await-work-then-set(cachedRef) for any caller that awaits between reading and writing: the
  // mutation lands on whatever `data` is current the moment it runs (e.g. a scan result that arrived during
  // the caller's await), instead of silently overwriting it with the stale snapshot the caller captured
  // earlier. `fn` must not await — do the slow work before calling mutate and pass a synchronous apply.
  async function mutate(fn) {
    const current = (await get()) || { tracks: [] };
    const next = fn(current);
    set(next === undefined ? current : next);
    return data;
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

  // A monotonic content version: bumps on every set()/clear() (i.e. every mutation callers persist).
  // Hive Link uses it to skip rebuilding the phone library payload when nothing changed.
  return { get, set, mutate, flush, clear, needsFlush: () => dirty || writesInFlight > 0, generation: () => generation };
}

module.exports = { createLibraryCacheStore };
