'use strict';
// Canonical, stable home for Hive's direct Discord Rich Presence publisher
// (app/main/discord-presence.js, loon-client.js, discord-rpc.js, ws-client.js)
// and its self-hosted loon+bore setup automation (setup-music-presence.sh,
// app/main/bore-resume-watcher.js). Edit this file in place when this
// subsystem's architecture legitimately changes -- do not create a new
// buildNNN-*.test.js file for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const discordPresence = fs.readFileSync(path.join(root, 'app/main/discord-presence.js'), 'utf8');
const setupScript = fs.readFileSync(path.join(root, 'setup-music-presence.sh'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

test('Rich Presence falls back to the remote artworkUrl when there is no local artworkPath', () => {
  // Real bug: Spotify and podcast playback never have a local artworkPath
  // (main.js's mpris:update handler only resolves one for real local
  // files), but both already carry a public https:// artworkUrl of their
  // own (podcast feed artwork, Spotify CDN cover). discord-presence.js only
  // ever read artworkPath, so Rich Presence silently showed no artwork at
  // all for anything that wasn't a local file, even though a usable URL was
  // sitting right there in the same update payload -- and using it directly
  // needs no loon round-trip at all.
  assert.match(discordPresence, /const artworkUrl = !artworkPath &&/);
  assert.match(discordPresence, /String\(payload\.artworkUrl \|\| ''\)/);
  assert.match(discordPresence, /let largeImageUrl = artworkUrl \|\| null;/);
});

test('bore.pub tunnels automatically recover after the system sleeps and wakes', () => {
  // Real bug: bore.pub's free tunnel silently stops forwarding across a
  // suspend/resume cycle -- the local bore client process stays "active"
  // per systemd the whole time, but the actual public forwarding is dead
  // until the service is restarted (reproduced live: curl against the
  // tunnel timed out after a period of inactivity, and worked again
  // immediately after `systemctl --user restart`).
  const watcherPath = path.join(root, 'app/main/bore-resume-watcher.js');
  assert.ok(fs.existsSync(watcherPath), 'bore-resume-watcher.js must exist');
  const watcher = fs.readFileSync(watcherPath, 'utf8');
  assert.match(watcher, /org\.freedesktop\.login1/);
  assert.match(watcher, /PrepareForSleep/);
  assert.match(watcher, /if \(sleeping\) return;/);
  assert.match(watcher, /systemctl.*--user.*restart.*beehive-loon-https\.service.*beehive-loon-http\.service/);

  // The setup script must actually install this as its own persistent
  // systemd user service, independent of whether Hive itself is running.
  assert.match(setupScript, /beehive-bore-resume-watcher\.service/);
  assert.match(setupScript, /ExecStart=\$NODE_BIN \$HIVE_PROJECT_DIR\/app\/main\/bore-resume-watcher\.js/);
});

test('the setup script no longer installs or starts music-presence.service', () => {
  // Hive publishes Discord Rich Presence directly (discord-presence.js) and
  // must not compete with a separately-running Music Presence instance for
  // the same Discord activity.
  assert.doesNotMatch(setupScript, /music-presence-bin/);
  assert.doesNotMatch(setupScript, /systemctl --user enable --now music-presence\.service/);
  assert.match(setupScript, /systemctl --user disable --now music-presence\.service/);
});

test('a fresh install generates its own random loon basic-auth credential instead of the shared documented example password', () => {
  assert.match(setupScript, /GENERATED_PASS="\$\(openssl rand/);
  assert.match(setupScript, /caddy hash-password -p "\$GENERATED_PASS"/);
});

test('the setup script writes the credentials Hive itself needs to actually use the loon server it just provisioned', () => {
  // Without these, main.js's discordPresenceConfig.loonUrl stays empty and
  // Discord Rich Presence silently never starts -- no error, no prompt.
  assert.match(setupScript, /discord-presence\.json/);
  assert.match(setupScript, /loonWsUrl/);
  assert.match(setupScript, /discord-presence-loon-ca\.pem/);
  assert.match(setupScript, /root\.crt/);
});

test('main.js publishes under a dedicated Hive Discord application, not an individual user\'s personal one', () => {
  assert.match(mainJs, /const DISCORD_PRESENCE_CLIENT_ID = '1548882733063733300';/);
});

// Settings > Discord was rewritten: it used to read/write Music Presence's
// own settings.json (presence.activity_type, a custom Discord application
// id) and shell out to `systemctl restart music-presence.service`. Hive
// publishes Rich Presence directly now, so all of that must be gone in
// favor of Hive's own small activity-type file and direct start()/stop()
// control over its own DiscordPresence instance.
test('Settings > Discord no longer reads/writes Music Presence settings.json or restarts music-presence.service', () => {
  assert.doesNotMatch(mainJs, /music-presence:getSettings/);
  assert.doesNotMatch(mainJs, /music-presence:saveSettings/);
  assert.doesNotMatch(mainJs, /music-presence:restart/);
  assert.doesNotMatch(mainJs, /MUSIC_PRESENCE_SETTINGS_PATH/);
  assert.doesNotMatch(mainJs, /systemctl.*music-presence\.service.*restart|restart.*music-presence\.service/);

  assert.match(mainJs, /const DISCORD_ACTIVITY_TYPE_PATH = \(\) => path\.join\(USER_DATA\(\), 'discord-activity-type\.json'\);/);
  assert.match(mainJs, /ipcMain\.handle\('discord-presence:getSettings', async \(\) => \{/);
  assert.match(mainJs, /ipcMain\.handle\('discord-presence:setActivityType', async \(_evt, patch = \{\}\) => \{/);
  assert.match(mainJs, /ipcMain\.handle\('discord-presence:restart', async \(\) => \{/);
  const restartStart = mainJs.indexOf("ipcMain.handle('discord-presence:restart'");
  const restartEnd = mainJs.indexOf('});', restartStart);
  const restartBlock = mainJs.slice(restartStart, restartEnd);
  assert.match(restartBlock, /discordPresence\.stop\(\);/);
  assert.match(restartBlock, /discordPresence\.start\(\);/);
});

// Real bug the user reported and confirmed with screenshots: Rich Presence
// data was correct (track/artist/artwork/pause state all showed correctly
// under Discord's full profile Activity tab) but never appeared in the
// compact hover-card the way games/Spotify do -- it always landed on the
// deeper surface only. The activity object never set `instance`, which
// every reference Discord RPC implementation includes; every other field
// already matched a normal, complete Activity payload.
test('the published activity sets instance: true, matching a standard/complete Activity payload', () => {
  const start = discordPresence.indexOf('const activity = {');
  const end = discordPresence.indexOf('\n    };', start);
  assert.ok(start >= 0 && end > start, 'expected to find the activity object construction');
  const block = discordPresence.slice(start, end);
  assert.match(block, /instance:\s*true/);
});

// Behavior tests against the real module, with Discord and the loon relay
// stubbed. Settings live in Hive's own file (userData/discord-activity-type.json),
// never Music Presence's.
function makePresence({ loonUrl = '', settings = null } = {}) {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-presence-'));
  const settingsPath = path.join(dir, 'discord-activity-type.json');
  if (settings) fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const { DiscordPresence } = require('../app/main/discord-presence');
  const presence = new DiscordPresence({ clientId: '1', loonUrl, activityTypeSettingsPath: settingsPath });
  const calls = [];
  const sent = [];
  Object.assign(presence.rpc, {
    connect: () => calls.push('rpc.connect'), close: () => calls.push('rpc.close'),
    setActivity: activity => { if (presence.rpc.ready) sent.push(activity); return presence.rpc.ready; },
    clearActivity: () => calls.push('rpc.clear'),
  });
  Object.assign(presence.loon, { connect: () => calls.push('loon.connect'), close: () => calls.push('loon.close') });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { presence, calls, sent, settingsPath, cleanup };
}
const samplePayload = { track: { path: '/m/a.flac', title: 'Song', artist: 'Artist', album: 'Album' }, position: 10, duration: 200, paused: false };

// Real UX gap: Rich Presence used to require the self-hosted loon relay
// (only the developer's machine had it), so every other install -- and the
// Windows build -- never showed presence at all. Discord alone is enough;
// loon only adds local cover art.
test('presence starts without the loon relay and shows the track once Discord is ready, even if it started first', async () => {
  const { presence, calls, sent, cleanup } = makePresence();
  try {
    presence.start();
    assert.deepEqual(calls, ['rpc.connect'], 'no loon connection when none is configured');
    await presence.update(samplePayload); // Discord not ready yet: nothing can be sent
    assert.equal(sent.length, 0);
    presence.rpc.ready = true;
    presence.rpc.emit('ready');
    await new Promise(r => setImmediate(r));
    assert.equal(sent.length, 1, 'the track that started before Discord connected is sent on READY');
    assert.equal(sent[0].details, 'Song');
    assert.equal(sent[0].state, 'Artist');
    assert.equal(sent[0].type, 0, 'default activity type is "playing" (0), not "listening"');
    assert.equal(sent[0].assets.large_image, undefined, 'no local cover art without the relay');
  } finally { cleanup(); }
});

test('with a loon relay configured, start also connects it', () => {
  const { presence, calls, cleanup } = makePresence({ loonUrl: 'wss://example.invalid/loon' });
  try {
    presence.start();
    assert.deepEqual(calls, ['rpc.connect', 'loon.connect']);
    assert.equal(presence.status().artworkRelayConfigured, true);
  } finally { cleanup(); }
});

test('turning presence off persists, clears the activity, and stops publishing; activity type keeps the setting', async () => {
  const { presence, calls, sent, settingsPath, cleanup } = makePresence({ settings: { activityType: 'listening' } });
  try {
    presence.rpc.ready = true;
    assert.equal(presence.setEnabled(false), false);
    assert.ok(calls.includes('rpc.clear') && calls.includes('rpc.close'));
    await presence.update(samplePayload);
    assert.equal(sent.length, 0, 'nothing is published while off');
    presence.start();
    assert.ok(!calls.includes('rpc.connect'), 'start() is a no-op while off');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { activityType: 'listening', enabled: false });
    presence.setActivityType('watching');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { activityType: 'watching', enabled: false }, 'changing the type keeps the on/off setting');
    const status = presence.status();
    assert.equal(status.enabled, false);
    assert.equal(status.activityType, 'watching');
    assert.equal(status.artworkRelayConfigured, false);
    assert.equal(typeof status.discordConnected, 'boolean');
  } finally { cleanup(); }
});

test('an unreadable or unknown activity type falls back to "playing"', async () => {
  const { presence, sent, cleanup } = makePresence({ settings: { activityType: 'dancing' } });
  try {
    presence.rpc.ready = true;
    await presence.update(samplePayload);
    assert.equal(sent[0].type, 0);
  } finally { cleanup(); }
});

// Windows Discord listens on named pipes; looking only for socket files in
// temp directories meant the Windows build could never connect.
test('the Discord IPC client uses named pipes on Windows and socket files elsewhere', () => {
  const { socketCandidates } = require('../app/main/discord-rpc');
  const win = socketCandidates('win32');
  assert.equal(win[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(win.length, 10);
  assert.ok(socketCandidates('linux').every(p => /discord-ipc-\d$/.test(p) && !p.startsWith('\\\\')));
});


