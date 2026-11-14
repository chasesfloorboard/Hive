'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTooltipSystem, tooltipTextFor, clampTooltipPosition } = require('../app/renderer/tooltip-system');

test('tooltipTextFor prefers data-tooltip, falls back to title, else empty', () => {
  const node = (attrs) => ({ getAttribute: (k) => attrs[k] ?? null });
  assert.equal(tooltipTextFor(node({ 'data-tooltip': 'Loved', title: 'ignored' })), 'Loved');
  assert.equal(tooltipTextFor(node({ title: 'Shuffle' })), 'Shuffle');
  assert.equal(tooltipTextFor(node({})), '');
  assert.equal(tooltipTextFor(null), '');
});

test('clampTooltipPosition offsets from the pointer when there is room', () => {
  const vp = { width: 1000, height: 800 };
  assert.deepEqual(clampTooltipPosition({ x: 100, y: 200 }, { width: 120, height: 40 }, vp), { left: 112, top: 216 });
});

test('clampTooltipPosition flips left/up near the right/bottom edge and respects the pad', () => {
  const vp = { width: 1000, height: 800 };
  // Near the right edge: 980+12+120 overflows -> flip to the left of the pointer.
  const r = clampTooltipPosition({ x: 980, y: 780 }, { width: 120, height: 40 }, vp);
  assert.equal(r.left, 980 - 120 - 12);
  assert.equal(r.top, 780 - 40 - 12);
  // A box too wide to fit on either side of the pointer is clamped to the edge pad,
  // never off-screen: near the right edge it flips left, and that flip would go
  // negative (950 - 990 - 12), so it pins to the pad instead.
  const r2 = clampTooltipPosition({ x: 950, y: 10 }, { width: 990, height: 40 }, vp);
  assert.equal(r2.left, 10, 'clamped to pad, not negative');
});

test('createTooltipSystem requires document and window', () => {
  assert.throws(() => createTooltipSystem({ document: null, window: null }), /needs a document and window/);
});

test('install() wires delegated listeners and the title MutationObserver', () => {
  const listeners = {};
  const observed = [];
  class FakeElement {}
  const fakeDoc = {
    documentElement: {},
    body: { appendChild() {} },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    createElement: () => ({ classList: { add() {}, remove() {}, contains: () => false }, style: {}, append() {} }),
    querySelectorAll: () => [],
  };
  const fakeWin = {
    Element: FakeElement,
    innerWidth: 1000, innerHeight: 800,
    MutationObserver: class { observe(target, opts) { observed.push({ target, opts }); } },
  };
  const sys = createTooltipSystem({ document: fakeDoc, window: fakeWin });
  const ret = sys.install();
  assert.equal(ret, sys, 'install returns the api for chaining');
  assert.deepEqual(Object.keys(listeners).sort(), ['pointermove', 'pointerout', 'pointerover']);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].target, fakeDoc.documentElement);
  assert.deepEqual(observed[0].opts.attributeFilter, ['title']);
});

test('a hovered node with data-tooltip-secondary renders dimmer primary + secondary spans', async () => {
  class FakeElement {}
  function makeEl() {
    return {
      className: '', textContent: '', style: {}, children: [],
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      append(...kids) { this.children.push(...kids); },
      getBoundingClientRect: () => ({ width: 100, height: 30 }),
    };
  }
  const listeners = {};
  const bodyChildren = [];
  const fakeDoc = {
    documentElement: {}, body: { appendChild: (el) => bodyChildren.push(el) },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    createElement: () => makeEl(), querySelectorAll: () => [],
  };
  const fakeWin = { Element: FakeElement, innerWidth: 1000, innerHeight: 800, MutationObserver: class { observe() {} } };
  const sys = createTooltipSystem({ document: fakeDoc, window: fakeWin, delayMs: 0 });
  sys.install();
  // A selection-status node carries both the duration (primary) and size (secondary).
  const node = Object.assign(new FakeElement(), {
    dataset: { tooltipSecondary: '41.1mb' },
    getAttribute: (k) => (k === 'data-tooltip' ? '44m 45s' : null),
    setAttribute() {}, removeAttribute() {},
    closest(sel) { return sel === '[data-tooltip]' ? node : null; },
    contains: () => false,
  });
  listeners.pointerover({ target: node, clientX: 20, clientY: 20 });
  await new Promise((r) => setTimeout(r, 5)); // let the 0ms dwell timer fire
  const tip = bodyChildren[0];
  assert.ok(tip, 'a tooltip element was created and appended to the body');
  assert.ok(tip.classList.contains('visible'));
  assert.equal(tip.children.length, 2, 'duration + size rendered as two separate spans');
  assert.deepEqual(tip.children.map((c) => c.className), ['tooltip-primary', 'tooltip-secondary']);
  assert.deepEqual(tip.children.map((c) => c.textContent), ['44m 45s', '41.1mb']);
});

test('prepareTooltipNode promotes title to data-tooltip + aria-label, then strips title', () => {
  class FakeElement {}
  const sys = createTooltipSystem({
    document: { documentElement: {}, body: {}, addEventListener() {}, createElement: () => ({}), querySelectorAll: () => [] },
    window: { Element: FakeElement, innerWidth: 1, innerHeight: 1, MutationObserver: class { observe() {} } },
  });
  const attrs = { title: 'Shuffle on' };
  const node = Object.assign(new FakeElement(), {
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
  });
  sys.prepareTooltipNode(node);
  assert.equal(attrs['data-tooltip'], 'Shuffle on');
  assert.equal(attrs['aria-label'], 'Shuffle on', 'accessible name preserved');
  assert.equal(attrs.title, undefined, 'native title stripped so Chromium popup never fires');
});
