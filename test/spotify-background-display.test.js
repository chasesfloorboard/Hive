const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts', 'spotify-background.sh');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');

test('Spotify background helper isolates the client display', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /Xvfb/);
  assert.match(text, /DISPLAY=/);
  assert.match(text, /GDK_BACKEND=x11/);
  assert.match(text, /LIBGL_ALWAYS_SOFTWARE=1/);
  assert.match(text, /spotify_install_path/);
  assert.match(text, /Hive\/config\.json/);
  assert.match(text, /spotify_exec/);
  assert.match(text, /pgrep -x spotify/);
  assert.match(text, /-displayfd/);
  assert.match(text, /DISPLAY_FILE/);
  assert.match(text, /stale|lock/i);
  assert.match(text, /Do not invoke/);
  assert.match(text, /already-patched Spotify executable/);
  assert.match(text, /xorg-server-xvfb/);
});

test('Spotify background helper allocates a fresh X display without relying on stale X lock slots', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /Xvfb -displayfd/);
  assert.match(text, /seq 1 50/);
  assert.match(text, /rm -f .*DISPLAY_FILE/);
});

test('Hive launches Spotify only through the isolated helper', () => {
  assert.match(main, /spotify-background\.sh/);
  assert.doesNotMatch(main, /spawn\(command, \['auto'\]/);
  assert.match(renderer, /spotifyLaunch\?\./);
  assert.match(fs.readFileSync(helper, 'utf8'), /isolated display/);
});

test('Installer provisions the Xvfb system dependency', () => {
  assert.match(installer, /xorg-server-xvfb/);
  assert.match(installer, /apt-get install -y xvfb/);
  assert.match(installer, /dnf install -y xorg-x11-server-Xvfb/);
  assert.match(installer, /command -v Xvfb/);
});

test('Spotify startup waits for the actual provider connection', () => {
  assert.match(renderer, /let spotifyBridgeStartupPromise = null/);
  assert.match(renderer, /if \(spotifyBridgeStartupPromise\) return spotifyBridgeStartupPromise/);
  assert.match(renderer, /const deadline = Date\.now\(\) \+ 30000/);
  assert.match(renderer, /status\?\.connected/);
});

test('Spotify background helper forces the known-good X11 path on Wayland', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET/);
  assert.match(text, /--ozone-platform=x11/);
  assert.match(text, /--disable-features=UseOzonePlatform/);
});

test('Spotify background helper records startup phases for provider diagnosis', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /spotify-background-status\.json/);
  assert.match(text, /phase/);
  assert.match(text, /xvfb-ready/);
  assert.match(text, /spotify-started/);
  assert.match(text, /spotify-exited/);
});

test('Hive exposes background provider diagnostics through spotify status', () => {
  assert.match(main, /spotify-background-status\.json/);
  assert.match(main, /background/);
  assert.match(main, /phase/);
});

test('Spotify background ownership survives Spotify PID handoff by using an inherited instance marker', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /HIVE_SPOTIFY_INSTANCE_ID/);
  assert.match(text, /HIVE_SPOTIFY_OWNER/);
  assert.match(text, /pgrep -x spotify/);
  assert.match(text, /\/proc\/\$[^ ]+\/environ/);
  assert.match(text, /instance marker|ownership marker|owner marker/i);
});

test('Spotify background ownership handles multiple inherited Spotify processes from one provider instance', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /hive_owned_spotify_pids/);
  assert.match(text, /matched processes/);
  assert.match(text, /for owned_pid in \$hive_owned_spotify_pids/);
});

test('Spotify background ownership uses a durable owner record separate from transient lifecycle status', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /spotify-background-owner\.json/);
  assert.match(text, /owner_file/);
  assert.match(text, /owner record|durable owner|persistent owner/i);
});

test('Spotify background helper recognizes and reuses a Hive-owned provider instead of treating it as visible desktop Spotify', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /spotify-background-status\.json/);
  assert.match(text, /spotifyPid/);
  assert.match(text, /display/);
  assert.match(text, /\/proc\/\$candidate_pid\/environ/);
  assert.match(text, /HIVE.*owned|owned.*HIVE|hive-owned/i);
  assert.match(text, /already running on the desktop|already running visibly/);
});

test('Spotify background helper verifies ownership before rejecting an existing Spotify process', () => {
  const text = fs.readFileSync(helper, 'utf8');
  const guardIndex = text.indexOf("pgrep -x spotify");
  assert.notEqual(guardIndex, -1, 'existing Spotify guard should remain');
  const ownershipIndex = text.search(/hive_owned_spotify/);
  assert.notEqual(ownershipIndex, -1, 'helper should contain explicit ownership handling');
  assert.ok(ownershipIndex < guardIndex, 'ownership must be evaluated before the existing-process guard');
});

test('Spotify background helper does not kill a reused Hive-owned Spotify instance on helper exit', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /SPOTIFY_OWNED/);
  assert.match(text, /SPOTIFY_OWNED.*-eq 1/);
  assert.match(text, /hive_owned_spotify.*-eq 1/);
  assert.match(text, /Reusing Hive-owned Spotify/);
});

test('Spotify background ownership recovers an orphaned provider from the durable PID and display record even when the child lost Hive marker variables', () => {
  const text = fs.readFileSync(helper, 'utf8');
  assert.match(text, /hive_owned_spotify_pid/);
  assert.match(text, /hive_owned_spotify_display/);
  assert.match(text, /spotifyPid/);
  assert.match(text, /kill.*hive_owned_spotify_pid|hive_owned_spotify_pid.*kill/i);
  assert.match(text, /orphaned|orphan/i);
  assert.match(text, /DISPLAY.*hive_owned_spotify_display|hive_owned_spotify_display.*DISPLAY/);
  assert.match(text, /Recorded Hive-owned Spotify PID|recover.*recorded.*Spotify PID/i);
});
