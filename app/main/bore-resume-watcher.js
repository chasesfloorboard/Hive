#!/usr/bin/env node
'use strict';

// Restarts Hive's self-hosted loon bore tunnels after the system wakes from
// sleep. bore.pub's free tunnel silently stops forwarding across a
// suspend/resume cycle -- the local bore client process itself keeps
// running and systemd reports it "active" the whole time, but the actual
// public forwarding is dead until the process is restarted (this was
// reproduced live: curl against the tunnel timed out entirely after a period
// of inactivity, and worked again immediately after `systemctl --user
// restart`). Runs as its own persistent systemd user service, independent of
// whether Hive itself is running -- the bore tunnel services it restarts are
// already independent of Hive's process lifetime, so this should be too.

const { execFile } = require('child_process');

let dbus;
try {
  dbus = require('dbus-next');
} catch (err) {
  console.error('[bore-resume-watcher] dbus-next unavailable:', err?.message || err);
  process.exit(1);
}

function restartBoreTunnels() {
  execFile('systemctl', ['--user', 'restart', 'beehive-loon-https.service', 'beehive-loon-http.service'], (err, stdout, stderr) => {
    if (err) {
      console.error('[bore-resume-watcher] restart failed:', String(stderr || err.message || err).trim());
    } else {
      console.log('[bore-resume-watcher] bore tunnels restarted after resume');
    }
  });
}

async function main() {
  const bus = dbus.systemBus();
  const obj = await bus.getProxyObject('org.freedesktop.login1', '/org/freedesktop/login1');
  const manager = obj.getInterface('org.freedesktop.login1.Manager');
  manager.on('PrepareForSleep', (sleeping) => {
    // logind emits PrepareForSleep(true) just before suspend and
    // PrepareForSleep(false) just after resume. Only react to the resume
    // edge, and wait a few seconds before restarting: the network interface
    // has not necessarily reconnected yet at the instant of the signal, and
    // restarting bore against a still-down link would just leave it stale
    // again immediately.
    if (sleeping) return;
    console.log('[bore-resume-watcher] system resumed from sleep, restarting bore tunnels in 8s');
    setTimeout(restartBoreTunnels, 8000);
  });
  console.log('[bore-resume-watcher] listening for system sleep/resume via org.freedesktop.login1');
}

main().catch(err => {
  console.error('[bore-resume-watcher] failed to start:', err?.message || err);
  process.exit(1);
});
