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

// Finding #1: the global tooltip system converts every `title` attribute to
// a non-ARIA `data-tooltip` and deletes `title`, which silently removed the
// only accessible name icon-only controls had. Fixed by also mirroring the
// text into aria-label (when the element doesn't already have one) before
// title is removed, so this applies to every current and future
// title-only icon button, not just an enumerated list.
test('the tooltip system preserves an accessible name when it strips title', () => {
  const start = renderer.indexOf('function prepareTooltipNode(node) {');
  const end = renderer.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start, 'expected to find prepareTooltipNode()');
  const block = renderer.slice(start, end);
  assert.match(block, /if \(title && !node\.getAttribute\('aria-label'\)\) node\.setAttribute\('aria-label', title\);/);
  assert.match(block, /node\.removeAttribute\('title'\);/);
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
