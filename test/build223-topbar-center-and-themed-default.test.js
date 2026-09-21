const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

test('Build 223 centers themed navigation controls through the shared app-row alignment', () => {
  const appRow = css.match(/\.topbar-app-row\s*\{([^}]*)\}/);
  assert.ok(appRow, 'topbar app row rule should exist');
  assert.match(appRow[1], /align-items\s*:\s*center/);
  assert.match(appRow[1], /flex\s*:\s*1 1 auto/);

  const brand = css.match(/html\.theme-window-bar-enabled \.topbar-left\s*\{([^}]*)\}/);
  assert.ok(brand, 'themed brand rule should exist');
  assert.doesNotMatch(brand[1], /transform\s*:/);

  const tabs = css.match(/html\.theme-window-bar-enabled \.topbar-tabs\s*\{([^}]*)\}/);
  assert.ok(tabs, 'themed tab strip rule should exist');
  assert.match(tabs[1], /align-items\s*:\s*center/);
});

test('Build 223 uses the themed Electron window bar by default on first boot', () => {
  assert.match(main, /const DEFAULT_THEME_WINDOW_BAR\s*=\s*true/);
  assert.match(main, /frame:\s*themeWindowBarEnabled\s*\?\s*false\s*:\s*true/);
});
