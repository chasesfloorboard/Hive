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
