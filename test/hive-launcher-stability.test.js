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
const sessionLog = fs.readFileSync(path.join(root, 'app', 'main', 'session-log.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');

test('Hive launcher uses one stable executable identity for Discord detection', () => {
  assert.match(launcher, /STABLE_ROOT=.*hive\/runtime/);
  assert.match(launcher, /STABLE_ELECTRON=.*STABLE_ROOT/);
  assert.match(launcher, /ln \"\$item\" \"\$target\"/);
  assert.match(launcher, /cp -f -- \"\$item\" \"\$target\"/);
  assert.match(launcher, /exec \"\$STABLE_ELECTRON\"/);
});

// Real bug the user confirmed live (via Discord's own Registered Games UI,
// which never offered Hive as a detectable candidate at all -- not even a
// stale/wrong entry, nothing): the stable executable path was already
// consistent across builds, but the binary at the end of it was still
// literally named "electron" -- indistinguishable, to Discord's local game
// scanner, from every other unrelated Electron app (VS Code, Slack, Signal,
// Discord itself) that ships the same generic binary name. Renaming just the
// binary (not the other Electron resource files beside it, which it finds by
// directory, not filename) is what actually gives Discord something
// Hive-specific to recognize.
test('the stable executable is named Hive, not the generic "electron" every other Electron app also ships', () => {
  assert.match(launcher, /STABLE_ELECTRON="\$STABLE_ROOT\/Hive"/);
  assert.doesNotMatch(launcher, /STABLE_ELECTRON="\$STABLE_ROOT\/electron"/);
  const prepStart = launcher.indexOf('prepare_stable_runtime() {');
  const prepEnd = launcher.indexOf('\n}', prepStart);
  const prepBlock = launcher.slice(prepStart, prepEnd);
  // Old leftover "electron"-named binaries from before this fix must not
  // silently linger in the stable runtime directory forever.
  assert.match(prepBlock, /rm -f -- \"\$STABLE_ROOT\/electron\"/);
  assert.match(prepBlock, /target=\"\$STABLE_ELECTRON\"/);
});

// Real bug, confirmed live (a full black screen on launch): renaming the
// stable runtime binary to "Hive" for the fix above had a side effect
// nothing had caught yet -- Electron's own app.isPackaged treats ANY
// renamed executable (not literally "electron"/"electron.exe") as a signal
// that it must be a packaged, branded build, regardless of whether it
// actually was packaged. That made every app.isPackaged check in the app
// wrongly report true for this ordinary portable/dev checkout, sending
// runtimeResourcePath() (used for index.html, preload.js, the database
// worker, the scanner/metadata workers, everything) at a nonexistent
// resources/app.asar instead of the real project folder.
test('runtimeResourcePath/workerForkOptions trust HIVE_PORTABLE_ROOT over bare app.isPackaged', () => {
  const start = sessionLog.indexOf('function runningFromPortableCheckout()');
  assert.ok(start >= 0, 'expected a dedicated portable-checkout detector, not inline app.isPackaged checks');
  const lineEnd = sessionLog.indexOf('\n', start);
  assert.match(sessionLog.slice(start, lineEnd), /process\.env\.HIVE_PORTABLE_ROOT/);

  const resourcePathStart = sessionLog.indexOf('function runtimeResourcePath(relativePath) {');
  const resourcePathEnd = sessionLog.indexOf('\n  }', resourcePathStart);
  const resourcePathBlock = sessionLog.slice(resourcePathStart, resourcePathEnd);
  assert.match(resourcePathBlock, /if \(!runningFromPortableCheckout\(\)\) \{/);
  assert.doesNotMatch(resourcePathBlock, /if \(app\.isPackaged\)/);

  const workerOptsStart = sessionLog.indexOf('function workerForkOptions(options = {}) {');
  const workerOptsEnd = sessionLog.indexOf('\n  }', workerOptsStart);
  const workerOptsBlock = sessionLog.slice(workerOptsStart, workerOptsEnd);
  assert.match(workerOptsBlock, /if \(!runningFromPortableCheckout\(\)\) \{/);
  assert.match(workerOptsBlock, /cwd: runningFromPortableCheckout\(\) \? \(options\.cwd \|\| __dirname\) : unpackedRoot/);
});

test('the passive update-check startup gate also trusts HIVE_PORTABLE_ROOT over bare app.isPackaged', () => {
  assert.match(main, /if \(!process\.env\.HIVE_PORTABLE_ROOT && app\.isPackaged\) \{/);
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

// Hive publishes Discord Rich Presence directly (app/main/discord-presence.js)
// -- Music Presence is no longer used or configured from Settings.
test('Discord display mode remains user-selectable, via Hive\'s own Rich Presence connection', () => {
  assert.match(html, /setting-discord-presence-activity-type/);
  assert.match(html, /value="playing"/);
  assert.match(html, /value="listening"/);
  assert.doesNotMatch(html, /setting-music-presence-activity-type/);
  // Default is 'playing' (Discord activity type 0, "Playing Hive"), not
  // 'listening' -- the user explicitly wants Hive to show up like a game,
  // not under Discord's Spotify-style "Listening to" pill.
  assert.match(renderer, /const activity = String\(result\?\.activityType \|\| 'playing'\)/);
  assert.match(html, /Registered Games detection remains controlled by Discord/);
});
