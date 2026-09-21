'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const styles = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');

function rule(source, selector) {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `missing CSS rule: ${selector}`);
  const end = source.indexOf('}', start);
  assert.ok(end >= 0, `unterminated CSS rule: ${selector}`);
  return source.slice(start, end + 1);
}

test('Add Tab button is neutral, circular, and subtly darker while pressed', () => {
  const normal = rule(styles, '.tab-add {');
  const hover = rule(styles, '.tab-add:hover {');
  const active = rule(styles, '.tab-add:active {');

  assert.match(normal, /width:\s*22px/);
  assert.match(normal, /height:\s*22px/);
  assert.match(normal, /border-radius:\s*50%/);
  assert.doesNotMatch(normal, /background:.*var\(--accent/);
  assert.doesNotMatch(hover, /background:.*var\(--accent/);
  assert.doesNotMatch(active, /background:\s*#000(?:000)?\b/);
  assert.match(active, /box-shadow:/);
  assert.match(active, /var\(--control-bg-active\)/);
});

test('Add Tab remains a native button with the existing add-tab identity', () => {
  assert.match(html, /<button[^>]+id="tab-add-btn"[^>]+class="tab tab-add"/);
  assert.match(html, />\+</);
});
