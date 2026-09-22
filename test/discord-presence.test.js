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

test('DiscordPresence stores/reads its own activity type from a Hive-owned file, not Music Presence\'s', () => {
  assert.match(discordPresence, /_readActivityTypeName\(\) \{/);
  const readStart = discordPresence.indexOf('_readActivityTypeName() {');
  const readEnd = discordPresence.indexOf('\n  }', readStart);
  const readBlock = discordPresence.slice(readStart, readEnd);
  assert.match(readBlock, /settings\?\.activityType/);
  assert.doesNotMatch(readBlock, /presence\?\.activity_type/);

  assert.match(discordPresence, /setActivityType\(name\) \{/);
  const setStart = discordPresence.indexOf('setActivityType(name) {');
  const setEnd = discordPresence.indexOf('\n  }', setStart);
  const setBlock = discordPresence.slice(setStart, setEnd);
  assert.match(setBlock, /JSON\.stringify\(\{ activityType: normalized \}, null, 2\)/);
  // Changing the activity type re-publishes the current activity immediately
  // instead of waiting for the next track change to pick it up.
  assert.match(setBlock, /if \(this\.lastPayload\) this\._apply\(this\.lastPayload, true\);/);
});

// Real bug/UX gap the user reported: Rich Presence was working, but showed
// up under Discord's "Activity" section with a Spotify-style "Listening to"
// pill (activity type 2) instead of the "Playing <name>" treatment (type 0)
// the user wants Hive to show up as, by default.
test('the default activity type is "playing" (type 0), not "listening"', () => {
  assert.match(discordPresence, /const ACTIVITY_TYPE_BY_NAME = \{ playing: 0, streaming: 1, listening: 2, watching: 3, competing: 5 \};/);
  const readStart = discordPresence.indexOf('_readActivityTypeName() {');
  const readEnd = discordPresence.indexOf('\n  }', readStart);
  const readBlock = discordPresence.slice(readStart, readEnd);
  assert.match(readBlock, /if \(!this\.activityTypeSettingsPath\) return 'playing';/);
  assert.match(readBlock, /return Object\.prototype\.hasOwnProperty\.call\(ACTIVITY_TYPE_BY_NAME, name\) \? name : 'playing';/);
  assert.doesNotMatch(readBlock, /'listening'/);

  const typeStart = discordPresence.indexOf('_readActivityType() {');
  const typeEnd = discordPresence.indexOf('\n  }', typeStart);
  assert.match(discordPresence.slice(typeStart, typeEnd), /\?\? 0;/);
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

test('DiscordPresence exposes a live status for Settings (configured/connected), not just activity type', () => {
  const start = discordPresence.indexOf('status() {');
  const end = discordPresence.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start, 'expected a status() method');
  const block = discordPresence.slice(start, end);
  assert.match(block, /configured: !!this\.loon\?\.url/);
  assert.match(block, /discordConnected: !!this\.rpc\?\.ready/);
  assert.match(block, /loonConnected: !!this\.loon\?\.connected/);
});
