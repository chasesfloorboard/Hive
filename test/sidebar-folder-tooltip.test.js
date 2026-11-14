'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSidebarFolderTooltip, clampFolderTooltip } = require('../app/renderer/sidebar-folder-tooltip');

test('clampFolderTooltip offsets from the pointer and keeps 8px inside every edge', () => {
  const vp = { width: 1000, height: 800 };
  // Room on all sides: just the +14 / +16 offset.
  assert.deepEqual(clampFolderTooltip({ x: 100, y: 200 }, { width: 120, height: 40 }, vp), { left: 114, top: 216 });
  // Near the right/bottom edge: clamped so the box stays 8px inside.
  const r = clampFolderTooltip({ x: 995, y: 790 }, { width: 120, height: 40 }, vp);
  assert.equal(r.left, 1000 - 120 - 8);
  assert.equal(r.top, 800 - 40 - 8);
  // Near the top/left edge: never less than the 8px pad.
  const r2 = clampFolderTooltip({ x: -50, y: -50 }, { width: 120, height: 40 }, vp);
  assert.equal(r2.left, 8);
  assert.equal(r2.top, 8);
});

// A minimal fake document/window for the DOM paths.
function fakeEnv() {
  const classes = new Set();
  const tip = {
    className: '', textContent: '', style: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    _classes: classes,
  };
  const body = { appendChild() {} };
  const doc = { createElement: () => tip, body };
  const win = { innerWidth: 1000, innerHeight: 800 };
  return { doc, win, tip, raf: (cb) => cb() };
}

test('createSidebarFolderTooltip needs a document and window', () => {
  assert.throws(() => createSidebarFolderTooltip({ document: null, window: null }), /needs a document and window/);
});

test('show sets the folder path, makes it visible, and positions it; hide clears visible', () => {
  const { doc, win, tip, raf } = fakeEnv();
  const t = createSidebarFolderTooltip({ document: doc, window: win, requestAnimationFrame: raf });
  t.showSidebarFolderTooltip({}, '/music/Band/Album', { clientX: 100, clientY: 200 });
  assert.equal(tip.textContent, '/music/Band/Album', 'shows the full folder path');
  assert.equal(tip._classes.has('visible'), true);
  // rAF ran move() synchronously (fake raf), which positioned the (visible) tip.
  assert.equal(tip.style.left, '114px');
  assert.equal(tip.style.top, '216px');
  t.hideSidebarFolderTooltip();
  assert.equal(tip._classes.has('visible'), false);
});

test('move does nothing until the tooltip is visible, and only one element is ever created', () => {
  const { doc, win, tip, raf } = fakeEnv();
  let created = 0;
  doc.createElement = () => { created++; return tip; };
  const t = createSidebarFolderTooltip({ document: doc, window: win, requestAnimationFrame: raf });
  // move before show: not visible -> no positioning, and no element created yet.
  t.moveSidebarFolderTooltip({ clientX: 10, clientY: 10 });
  assert.equal(tip.style.left, undefined);
  t.showSidebarFolderTooltip({}, 'x', { clientX: 50, clientY: 50 });
  t.moveSidebarFolderTooltip({ clientX: 300, clientY: 400 });
  assert.equal(tip.style.left, '314px');
  // ensure()/show reused the same element across calls.
  t.showSidebarFolderTooltip({}, 'y', { clientX: 0, clientY: 0 });
  assert.equal(created, 1, 'the tooltip element is created once and reused');
});
