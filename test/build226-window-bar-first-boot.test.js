const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

test('Build 226 treats a missing window-bar preference as the enabled default', () => {
  assert.match(main, /if \(config && Object\.prototype\.hasOwnProperty\.call\(config, THEME_WINDOW_BAR_KEY\)\)/);
  assert.match(main, /return config\[THEME_WINDOW_BAR_KEY\] === true;/);
  assert.match(main, /return DEFAULT_THEME_WINDOW_BAR;/);
});

test('Build 226 preserves an explicit saved false window-bar preference', () => {
  assert.match(main, /const DEFAULT_THEME_WINDOW_BAR\s*=\s*true/);
  assert.match(main, /frame:\s*themeWindowBarEnabled\s*\?\s*false\s*:\s*true/);
});
