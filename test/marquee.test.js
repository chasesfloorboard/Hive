'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarquee, marqueeMetrics } = require('../app/renderer/marquee');

test('marqueeMetrics scrolls only when overflow exceeds 2px, and computes shift + duration', () => {
  // No overflow -> off.
  assert.deepEqual(marqueeMetrics(100, 100).on, false);
  assert.deepEqual(marqueeMetrics(101, 100).on, false, '1px is below the 2px threshold');
  // Overflow -> on, with the negative shift in px.
  const m = marqueeMetrics(300, 100);
  assert.equal(m.on, true);
  assert.equal(m.shift, 200);
  assert.equal(m.shiftPx, '-200px');
  // Duration: max(7, (2*shift/32)/0.7) seconds, one decimal.
  assert.equal(m.timeS, `${Math.max(7, (2 * 200 / 32) / 0.7).toFixed(1)}s`);
  // A small overflow floors at the 7s minimum.
  assert.equal(marqueeMetrics(110, 100).timeS, '7.0s');
  // scrollWidth is ceil'd against clientWidth.
  assert.equal(marqueeMetrics(100.4, 97).shift, 4);
});

// A minimal stub element good enough to drive the DOM paths.
function stubBox({ scrollWidth = 0, clientWidth = 0, childTrack = false } = {}) {
  const classes = new Set();
  const track = childTrack ? makeTrack(scrollWidth) : null;
  const box = {
    dataset: {},
    innerHTML: '',
    childNodes: track ? [track] : [],
    get firstElementChild() { return this.childNodes[0] || null; },
    clientWidth,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    style: { _p: {}, setProperty(k, v) { this._p[k] = v; } },
    appendChild(n) { this.childNodes = [n]; },
    _classes: classes,
  };
  return box;
}
function makeTrack(scrollWidth = 0) {
  const classes = new Set(['marquee-track']);
  return {
    className: 'marquee-track', textContent: '', scrollWidth, childNodes: [],
    classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
    append() {},
  };
}
function fakeDeps() {
  const doc = { createElement: () => makeTrack(0) };
  const win = {};
  const observed = [];
  const RO = class { observe(t) { observed.push(t); } };
  return { document: doc, window: win, ResizeObserver: RO, requestAnimationFrame: (cb) => cb(), _observed: observed };
}

test('createMarquee needs a document and window', () => {
  assert.throws(() => createMarquee({ document: null, window: null }), /needs a document and window/);
});

test('measureMarquee toggles marquee-on and sets the CSS vars when the text overflows', () => {
  const deps = fakeDeps();
  const { measureMarquee } = createMarquee(deps);
  const overflowing = stubBox({ clientWidth: 100, childTrack: true, scrollWidth: 400 });
  measureMarquee(overflowing);
  assert.equal(overflowing._classes.has('marquee-on'), true);
  assert.equal(overflowing.style._p['--marquee-shift'], '-300px');
  assert.ok(overflowing.style._p['--marquee-time'].endsWith('s'));
  // A fitting title turns the animation off and sets no vars.
  const fitting = stubBox({ clientWidth: 100, childTrack: true, scrollWidth: 100 });
  measureMarquee(fitting);
  assert.equal(fitting._classes.has('marquee-on'), false);
  assert.equal(fitting.style._p['--marquee-shift'], undefined);
});

test('setMarqueeText rebuilds the track span and skips redundant updates', () => {
  const deps = fakeDeps();
  const { setMarqueeText } = createMarquee(deps);
  const box = stubBox({ clientWidth: 100 });
  // firstElementChild is driven by innerHTML in the real DOM; emulate the rebuild.
  let built = null;
  Object.defineProperty(box, 'innerHTML', { set() { built = makeTrack(0); box.childNodes = [built]; }, get() { return ''; } });
  setMarqueeText(box, 'Hello');
  assert.equal(box.dataset.marqueeText, 'Hello');
  assert.equal(built.textContent, 'Hello');
  assert.equal(box._classes.has('marquee'), true, 'marquee() ran and marked the box');
  assert.equal(deps._observed.length, 1, 'the box was registered with the ResizeObserver');
  // Same text + an existing marquee-track -> early return, no re-observe.
  setMarqueeText(box, 'Hello');
  assert.equal(deps._observed.length, 1, 'redundant update skipped');
});
