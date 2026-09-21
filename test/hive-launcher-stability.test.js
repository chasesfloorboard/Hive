'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'scripts', 'hive-launcher.sh'), 'utf8');
const run = fs.readFileSync(path.join(root, 'run.sh'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');

test('Hive launcher uses one stable executable identity for Discord detection', () => {
  assert.match(launcher, /STABLE_ROOT=.*hive\/runtime/);
  assert.match(launcher, /STABLE_ELECTRON=.*STABLE_ROOT/);
  assert.match(launcher, /ln \"\$item\" \"\$target\"/);
  assert.match(launcher, /cp -f -- \"\$item\" \"\$target\"/);
  assert.match(launcher, /exec \"\$STABLE_ELECTRON\"/);
});

test('Hive launcher cleans stale Hive build processes before starting', () => {
  assert.match(launcher, /cleanup_old_hive_processes\(\)/);
  assert.match(launcher, /node_modules\/electron\/dist\/electron/);
  assert.match(launcher, /scripts\/spotify-background\.sh/);
  assert.match(launcher, /app\/workers\/database-worker\.py/);
  assert.match(launcher, /kill -TERM/);
  assert.match(launcher, /kill -KILL/);
});

test('all normal Hive launch paths use the stable launcher', () => {
  assert.match(run, /scripts\/hive-launcher\.sh/);
  assert.match(installer, /\$PROJECT_DIR\/run\.sh/);
  assert.match(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.start, /hive-launcher\.sh/);
});

test('Discord display mode remains user-selectable through Music Presence', () => {
  assert.match(html, /setting-music-presence-activity-type/);
  assert.match(html, /value="playing"/);
  assert.match(html, /value="listening"/);
  assert.match(renderer, /activity_type \|\| 'playing'/);
  assert.match(html, /Registered Games detection remains controlled by Discord/);
});
