'use strict';
// Canonical, stable home for accessibility fixes (see CLAUDE.md's #16 audit
// findings). Edit this file in place as each finding gets fixed or the
// approach changes -- do not create a new buildNNN-*.test.js file for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');

// Finding #1: the global tooltip system (app/renderer/tooltip-system.js) converts
// every `title` attribute to a non-ARIA `data-tooltip` and deletes `title`, which
// silently removed the only accessible name icon-only controls had. Fixed by also
// mirroring the text into aria-label (when the element doesn't already have one)
// before title is removed, so this applies to every current and future title-only
// icon button, not just an enumerated list. Verified behaviourally against the module.
test('the tooltip system preserves an accessible name when it strips title', () => {
  const { createTooltipSystem } = require('../app/renderer/tooltip-system');
  class FakeElement {}
  const sys = createTooltipSystem({
    document: { documentElement: {}, body: {}, addEventListener() {}, createElement: () => ({}), querySelectorAll: () => [] },
    window: { Element: FakeElement, innerWidth: 1, innerHeight: 1, MutationObserver: class { observe() {} } },
  });
  const fakeNode = (attrs) => Object.assign(new FakeElement(), {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
  });
  // A title-only icon button: after prepareTooltipNode it keeps an accessible name.
  const iconBtn = { title: 'Shuffle' };
  sys.prepareTooltipNode(fakeNode(iconBtn));
  assert.equal(iconBtn['aria-label'], 'Shuffle', 'accessible name mirrored to aria-label');
  assert.equal(iconBtn.title, undefined, 'native title stripped (no duplicate Chromium popup)');
  assert.equal(iconBtn['data-tooltip'], 'Shuffle', 'themed tooltip text retained');
  // An element that already has its own aria-label is not overwritten.
  const labelled = { title: 'Hover text', 'aria-label': 'Keep me' };
  sys.prepareTooltipNode(fakeNode(labelled));
  assert.equal(labelled['aria-label'], 'Keep me', 'existing accessible name preserved');
});

// Finding #2: 9 of 13 .modal-close buttons had no accessible name at all
// (no aria-label, and title would be stripped by finding #1 anyway).
test('every .modal-close button has an aria-label', () => {
  const buttonRe = /<button[^>]*class="modal-close[^"]*"[^>]*>/g;
  const matches = html.match(buttonRe) || [];
  assert.ok(matches.length >= 13, `expected at least 13 modal-close buttons, found ${matches.length}`);
  for (const tag of matches) assert.match(tag, /aria-label="Close"/, `missing aria-label: ${tag}`);
});

// Finding #3: modal overlays lacked role="dialog"/aria-modal, and
// openModal()/closeModal() never moved focus into the modal, trapped Tab
// inside it, or restored focus on close.
test('openModal marks the panel as a dialog, traps Tab, and moves/restores focus', () => {
  const start = renderer.indexOf('function openModal(modal) {');
  const end = renderer.indexOf('\n  function closeModal', start);
  assert.ok(start >= 0 && end > start, 'expected to find openModal()');
  const block = renderer.slice(start, end);
  assert.match(block, /panel\.setAttribute\('role', 'dialog'\)/);
  assert.match(block, /panel\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(block, /panel\.addEventListener\('keydown', modalTabTrap\)/);
  assert.match(block, /modalFocusReturn\.set\(modal, document\.activeElement\)/);
  assert.match(block, /\(focusable\[0\] \|\| panel\)\.focus\?\.\(/);

  const closeStart = renderer.indexOf('function closeModal(modal) {');
  const closeEnd = renderer.indexOf('\n  }', closeStart);
  const closeBlock = renderer.slice(closeStart, closeEnd);
  assert.match(closeBlock, /modalFocusReturn\.get\(modal\)/);
  assert.match(closeBlock, /returnFocus\.focus\(\{ preventScroll: true \}\)/);
});

test('modalTabTrap keeps Tab focus cycling inside the modal panel', () => {
  assert.match(renderer, /function modalTabTrap\(e\) \{/);
  const start = renderer.indexOf('function modalTabTrap(e) {');
  const end = renderer.indexOf('\n  }', start);
  const block = renderer.slice(start, end);
  assert.match(block, /if \(e\.key !== 'Tab'\) return;/);
  assert.match(block, /e\.shiftKey && document\.activeElement === first/);
  assert.match(block, /!e\.shiftKey && document\.activeElement === last/);
});

// Finding #4: no aria-live region for track changes or for showAppNotice()'s
// modal, unlike #about-update-status which already does this correctly.
test('the now-playing title/artist and the app notice body are live regions', () => {
  assert.match(html, /<div class="pb-meta" aria-live="polite">/);
  assert.match(html, /<div id="notice-body" class="notice-body" aria-live="assertive"><\/div>/);
});

// Findings #5/#6: album cards, song rows, queue rows and the right-click menu work from the
// keyboard (app/renderer/keyboard-access.js), and show where focus is.
const keys = require('../app/renderer/keyboard-access.js');

test('the arrow keys move through a list and stop at its ends', () => {
  assert.equal(keys.stepIndex(-1, 'ArrowDown', 5), 0);
  assert.equal(keys.stepIndex(2, 'ArrowDown', 5), 3);
  assert.equal(keys.stepIndex(4, 'ArrowDown', 5), 4);
  assert.equal(keys.stepIndex(0, 'ArrowUp', 5), 0);
  assert.equal(keys.stepIndex(3, 'Home', 5), 0);
  assert.equal(keys.stepIndex(1, 'End', 5), 4);
  assert.equal(keys.stepIndex(1, 'PageDown', 30, 10), 11);
  assert.equal(keys.stepIndex(4, 'PageUp', 30, 10), 0);
  assert.equal(keys.stepIndex(1, 'x', 5), -1);
  assert.equal(keys.stepIndex(0, 'ArrowDown', 0), -1);
});

test('menu items wrap around like a native menu', () => {
  assert.equal(keys.stepMenu(-1, 'ArrowDown', 4), 0);
  assert.equal(keys.stepMenu(3, 'ArrowDown', 4), 0);
  assert.equal(keys.stepMenu(0, 'ArrowUp', 4), 3);
  assert.equal(keys.stepMenu(-1, 'ArrowUp', 4), 3);
  assert.equal(keys.stepMenu(2, 'End', 4), 3);
  assert.equal(keys.stepMenu(2, 'Enter', 4), -1);
});

test('cards and stars have spoken names', () => {
  assert.equal(keys.albumLabel({ title: 'Illmatic', artist: 'Nas' }), 'Illmatic by Nas');
  assert.equal(keys.albumLabel({ title: '', artist: '' }), 'Unknown album');
  assert.equal(keys.starLabel(1), 'Rate 1 star');
  assert.equal(keys.starLabel(4), 'Rate 4 stars');
});

test('the library and the menu are wired to the keyboard module', () => {
  assert.ok(html.indexOf('keyboard-access.js') > 0 && html.indexOf('keyboard-access.js') < html.indexOf('src="renderer.js"'));
  assert.match(html, /id="songs-table"[^>]*tabindex="0"[^>]*data-row-list/);
  assert.match(html, /id="queue-list"[^>]*tabindex="0"[^>]*data-row-list/);
  assert.match(renderer, /class="song-row[^`]*tabindex="-1"/);
  assert.match(renderer, /HiveKeyboardAccess\?\.install\(document\)/);
  assert.match(renderer, /HiveKeyboardAccess\?\.prepareMenu\(m\)/);
  assert.match(renderer, /HiveKeyboardAccess\?\.menuClosed\(/);
  const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
  for (const sel of ['.album-card:focus-visible', '.song-row:focus-visible', '.queue-row:focus-visible', '.context-submenu-wrap.keyboard-open > .context-submenu']) assert.ok(css.includes(sel), sel);
});
