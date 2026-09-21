'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const styles = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');

function rule(source, selector) {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `missing CSS rule: ${selector}`);
  const end = source.indexOf('}', start);
  assert.ok(end >= 0, `unterminated CSS rule: ${selector}`);
  return source.slice(start, end + 1);
}

test('Build 196 pins the add-tab control to a true 22px circle after generic tab sizing', () => {
  const normal = rule(styles, '.topbar-tabs > .tab.tab-add {');
  assert.match(normal, /box-sizing:\s*border-box/);
  assert.match(normal, /width:\s*22px\s*!important/);
  assert.match(normal, /min-width:\s*22px\s*!important/);
  assert.match(normal, /max-width:\s*22px\s*!important/);
  assert.match(normal, /height:\s*22px\s*!important/);
  assert.match(normal, /min-height:\s*22px\s*!important/);
  assert.match(normal, /max-height:\s*22px\s*!important/);
  assert.match(normal, /flex:\s*0 0 22px\s*!important/);
  assert.match(normal, /align-self:\s*center\s*!important/);
  assert.match(normal, /margin-top:\s*0\s*!important/);
  assert.match(normal, /border-radius:\s*50%\s*!important/);
});

// Moved here from build191-favorites-navigation-regressions.test.js
// (consolidated into test/playlist-sidebar-navigation.test.js) -- this is
// about the Add Tab control's own sizing, not Favorites/playlists.
test('Add Tab explicitly clears the inherited tab minimum width', () => {
  const normal = rule(styles, '.tab-add {');
  assert.match(normal, /width:\s*22px/);
  assert.match(normal, /min-width:\s*22px/);
  assert.match(normal, /height:\s*22px/);
  assert.match(normal, /flex:\s*0 0 22px/);
  assert.match(normal, /border-radius:\s*50%/);
});
