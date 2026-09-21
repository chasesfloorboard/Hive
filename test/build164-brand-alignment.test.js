const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('themed window chrome keeps the Hive brand on the same centerline as the tabs', () => {
  const brandRule = css.match(/html\.theme-window-bar-enabled \.topbar-left\s*\{([^}]*)\}/);
  assert.ok(brandRule, 'themed brand alignment rule should exist');
  assert.doesNotMatch(brandRule[1], /transform\s*:/);
  const appRowRule = css.match(/html\.theme-window-bar-enabled \.topbar-app-row\s*\{([^}]*)\}/);
  assert.ok(appRowRule, 'themed app row should exist');
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-app-row\s*\{[\s\S]*?-webkit-app-region\s*:\s*no-drag/);
  const titlebarRule = css.match(/html\.theme-window-bar-enabled \.window-titlebar-row\s*\{([^}]*)\}/);
  assert.ok(titlebarRule, 'themed titlebar row should exist');
  assert.match(titlebarRule[1], /-webkit-app-region\s*:\s*drag/);
});

test('themed Hive brand remains non-draggable and interactive', () => {
  assert.match(
    css,
    /html\.theme-window-bar-enabled \.topbar-left[\s\S]*?-webkit-app-region:\s*no-drag/
  );
});
