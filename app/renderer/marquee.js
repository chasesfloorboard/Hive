'use strict';
// Scrolling-marquee behaviour for a title too long for its box: it glides across to show
// the rest, then back (the playbar's always; a tab's while hovered — see .marquee in
// styles.css). Extracted from renderer.js (docs/ai/ARCHITECTURE.md). Dual-mode:
// `window.HiveMarquee` for the app, `module.exports` for node tests. The overflow
// decision + animation-timing math is a pure helper (marqueeMetrics); createMarquee owns
// the one shared ResizeObserver and the DOM wiring, with document/window/rAF/ResizeObserver
// injectable so it can be exercised with stubs.
(function () {
  // Given the track's rendered width and the box's visible width, decide whether to
  // scroll and, if so, the shift distance and the round-trip duration. Pure.
  function marqueeMetrics(scrollWidth, clientWidth) {
    const shift = Math.ceil(scrollWidth - clientWidth);
    const on = shift > 2; // a couple of px of overflow isn't worth animating
    // About 32px a second while moving; the moves take 70% of each round trip.
    return { on, shift, shiftPx: `${-shift}px`, timeS: `${Math.max(7, (2 * shift / 32) / 0.7).toFixed(1)}s` };
  }

  function createMarquee(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    const win = deps.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) throw new Error('createMarquee needs a document and window');
    const RO = deps.ResizeObserver || win.ResizeObserver;
    const raf = deps.requestAnimationFrame || (win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (cb) => cb());

    const resize = new RO((entries) => { for (const entry of entries) measureMarquee(entry.target); });

    function setMarqueeText(box, text) {
      if (box.dataset.marqueeText === text && box.firstElementChild?.classList.contains('marquee-track')) return;
      box.dataset.marqueeText = text;
      box.innerHTML = '<span class="marquee-track"></span>';
      box.firstElementChild.textContent = text;
      marquee(box);
    }

    function marquee(box) {
      if (!box) return;
      let track = box.firstElementChild;
      if (!track?.classList.contains('marquee-track') || box.childNodes.length !== 1) {
        track = doc.createElement('span');
        track.className = 'marquee-track';
        track.append(...box.childNodes);
        box.appendChild(track);
      }
      box.classList.add('marquee');
      resize.observe(box);
      raf(() => measureMarquee(box));
    }

    function measureMarquee(box) {
      const track = box.firstElementChild;
      if (!track) return;
      const metrics = marqueeMetrics(track.scrollWidth, box.clientWidth);
      box.classList.toggle('marquee-on', metrics.on);
      if (!metrics.on) return;
      box.style.setProperty('--marquee-shift', metrics.shiftPx);
      box.style.setProperty('--marquee-time', metrics.timeS);
    }

    return { setMarqueeText, marquee, measureMarquee };
  }

  const exported = { createMarquee, marqueeMetrics };
  if (typeof window !== 'undefined') window.HiveMarquee = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
