'use strict';
// The synchronized cover-art rotator: one shared 4-second crossfade clock and artwork
// index for every surface showing the current track's cover (playbar, now-playing card,
// its grid card, the expanded album), so they never drift apart by even one tick.
// Extracted from renderer.js (docs/ai/ARCHITECTURE.md). Dual-mode: `window.HiveCoverRotator`
// for the app, `module.exports` for node tests. A createX(deps) factory — coverSrc and
// placeholderCover are injected, and Image/setInterval/clearInterval default to the globals
// but are injectable so the preload + rotation can be exercised with fakes. The single
// instance and the glue that collects target <img>s stay in renderer.
(function () {
  function createCoverRotator(deps = {}) {
    const { coverSrc, placeholderCover } = deps;
    if (typeof coverSrc !== 'function' || typeof placeholderCover !== 'function') {
      throw new Error('createCoverRotator needs { coverSrc, placeholderCover }');
    }
    const ImageCtor = deps.Image || (typeof Image !== 'undefined' ? Image : null);
    const setIntervalFn = deps.setInterval || (typeof setInterval !== 'undefined' ? setInterval : null);
    const clearIntervalFn = deps.clearInterval || (typeof clearInterval !== 'undefined' ? clearInterval : null);

    let timer = null;
    let items = [];
    let idx = 0;
    let imgs = [];
    let generation = 0;
    const decoded = new Map(); // source -> decoded Image

    function sourceFor(item) {
      return item && item.file ? coverSrc(item.file) : placeholderCover();
    }

    // The generation/token check is the caller's job (after the await); preload only
    // resolves the decoded Image, so it takes no token.
    function preload(src) {
      if (!src) return Promise.resolve(null);
      const existing = decoded.get(src);
      if (existing) return Promise.resolve(existing);
      const img = new ImageCtor();
      img.decoding = 'async';
      const promise = new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          if (value) decoded.set(src, img);
          resolve(value ? img : null);
        };
        img.onload = async () => {
          try { if (typeof img.decode === 'function') await img.decode(); } catch { /* decode is best-effort; the image still displays if it fails */ }
          finish(true);
        };
        img.onerror = () => finish(false);
      });
      img.src = src;
      img.__beehiveDecodePromise = promise;
      return promise;
    }

    function apply() {
      const item = items[idx];
      const src = sourceFor(item);
      imgs.forEach(img => {
        if (!img || !img.isConnected) return;
        img.style.transition = 'none';
        img.style.opacity = '1';
        img.src = src;
      });
      if (items.length > 1) preload(sourceFor(items[(idx + 1) % items.length]));
    }

    function stop() {
      clearIntervalFn(timer);
      timer = null;
      generation++;
      imgs = [];
      items = [];
      idx = 0;
    }

    async function start(coverItems, imgEls) {
      // A single rotator owns the artwork index and timer for every synchronized
      // surface. This prevents the player, queue, album card and expanded album
      // from drifting apart by even one 4-second tick.
      const nextItems = (coverItems && coverItems.length) ? coverItems.slice() : [{ file: null }];
      const nextImgs = Array.from(new Set((imgEls || []).filter(Boolean)));
      clearIntervalFn(timer);
      timer = null;
      generation++;
      const token = generation;
      items = nextItems;
      imgs = nextImgs;
      idx = 0;
      await preload(sourceFor(items[0]));
      if (token !== generation) return;
      apply();
      if (items.length > 1) {
        timer = setIntervalFn(async () => {
          const nextIndex = (idx + 1) % items.length;
          await preload(sourceFor(items[nextIndex]));
          if (token !== generation) return;
          idx = nextIndex;
          apply();
        }, 4000);
      }
    }

    function retarget(imgEls) {
      const additions = (imgEls || []).filter(Boolean).filter(img => {
        if (!img || img.dataset?.beehiveRotatorAttached === '1') return false;
        if (img.dataset) img.dataset.beehiveRotatorAttached = '1';
        return true;
      });
      if (!additions.length) return;
      imgs = Array.from(new Set([...(imgs || []), ...additions]));
      if (!items.length) return;
      const src = sourceFor(items[idx]);
      additions.forEach(img => {
        if (!img || !img.isConnected) return;
        img.style.transition = 'none';
        img.style.opacity = '1';
        if (img.src !== src) img.src = src;
      });
    }

    return { start, stop, retarget };
  }

  const exported = { createCoverRotator };
  if (typeof window !== 'undefined') window.HiveCoverRotator = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
