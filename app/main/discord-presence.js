'use strict';

// Direct Discord Rich Presence publisher: combines a loon client (turns local
// cover art into a temporary public URL) with a Discord IPC client (pushes
// the activity itself). This replaces relying on the external Music Presence
// app, whose own cover-art proxy was unreliable on this machine (see the
// build75/rc.1 changelog entries for why Hive previously delegated this to
// Music Presence, and the session notes for why that got reverted).
//
// Ground rule (matches the old IMPORTANT INFO.txt Discord Rich Presence
// section): do not resend unchanged activity metadata on playback-position
// ticks. Only track changes and pause/resume transitions trigger a resend;
// elapsed time is conveyed via Discord's own activity timestamps.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { LoonClient } = require('./loon-client');
const { DiscordRPC } = require('./discord-rpc');

// Discord Activity Type values (see Discord's Rich Presence documentation):
// 0 Playing, 1 Streaming, 2 Listening, 3 Watching, 5 Competing.
const ACTIVITY_TYPE_BY_NAME = { playing: 0, streaming: 1, listening: 2, watching: 3, competing: 5 };

class DiscordPresence extends EventEmitter {
  // `activityTypeSettingsPath` is Hive's own small settings file
  // (userData/discord-activity-type.json, shape {activityType: 'listening'}),
  // not Music Presence's -- Hive publishes Rich Presence directly and no
  // longer delegates to or shares state with the external Music Presence
  // app.
  constructor({ clientId, loonUrl, loonCa = null, activityTypeSettingsPath = '' }) {
    super();
    this.rpc = new DiscordRPC({ clientId });
    this.loon = new LoonClient({ url: loonUrl, ca: loonCa });
    this.activityTypeSettingsPath = activityTypeSettingsPath;
    this.lastKey = '';
    this.lastPayload = null;
    this.currentCoverResource = '';
    this.rpc.on('error', (err) => this.emit('error', err));
    this.loon.on('error', (err) => this.emit('error', err));
    this.loon.on('connected', () => { if (this.lastPayload) this._apply(this.lastPayload, true); });
    // setActivity is a no-op until Discord's READY, so a track that started
    // before the connection (Hive launched before Discord, or Discord
    // restarted) stayed blank until the next track change. Re-send it.
    this.rpc.on('ready', () => { if (this.lastPayload) this._apply(this.lastPayload, true); });
  }

  // Shape: {activityType: 'playing', enabled: true}. Both keys optional.
  // Cached after the first read: this is consulted on every playback update,
  // and only Hive writes the file.
  _readSettings() {
    if (this._settings) return this._settings;
    let settings = {};
    if (this.activityTypeSettingsPath) {
      try { settings = JSON.parse(fs.readFileSync(this.activityTypeSettingsPath, 'utf8')) || {}; } catch {}
    }
    this._settings = settings;
    return settings;
  }

  _writeSettings(patch) {
    this._settings = { ...this._readSettings(), ...patch };
    if (!this.activityTypeSettingsPath) return;
    fs.mkdirSync(path.dirname(this.activityTypeSettingsPath), { recursive: true });
    fs.writeFileSync(this.activityTypeSettingsPath, JSON.stringify(this._settings, null, 2), 'utf8');
  }

  // On unless the user turned it off in Settings.
  isEnabled() {
    return this._readSettings().enabled !== false;
  }

  setEnabled(enabled) {
    this._writeSettings({ enabled: !!enabled });
    if (enabled) this.start();
    else this.stop();
    return !!enabled;
  }

  // Default is 'playing' (Discord activity type 0), not 'listening' (type
  // 2): type 2 renders as a Spotify-style "Listening to" pill under
  // Activity, not the "Playing <name>" treatment the user actually wants
  // Hive to show up as.
  _readActivityTypeName() {
    const name = String(this._readSettings().activityType || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(ACTIVITY_TYPE_BY_NAME, name) ? name : 'playing';
  }

  _readActivityType() {
    return ACTIVITY_TYPE_BY_NAME[this._readActivityTypeName()] ?? 0;
  }

  // Persists the chosen activity type and immediately re-publishes the
  // current activity under it, rather than waiting for the next track change
  // to pick it up.
  setActivityType(name) {
    const normalized = String(name || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ACTIVITY_TYPE_BY_NAME, normalized)) throw new Error('Invalid Discord activity type.');
    this._writeSettings({ activityType: normalized });
    if (this.lastPayload) this._apply(this.lastPayload, true);
    return normalized;
  }

  // Live status for Settings: whether presence is on, whether Discord is
  // connected, and whether the optional loon artwork relay (which turns local
  // cover art into a public image URL; see readDiscordPresenceConfigSync in
  // main.js) is configured and connected.
  status() {
    return {
      enabled: this.isEnabled(),
      artworkRelayConfigured: !!this.loon?.url,
      discordConnected: !!this.rpc?.ready,
      loonConnected: !!this.loon?.connected,
      activityType: this._readActivityTypeName()
    };
  }

  // Presence needs only Discord itself: title, artist, album and progress
  // always show, as does artwork that already has a public URL (Spotify,
  // podcasts). The loon relay is optional and only adds local cover art.
  start() {
    if (!this.isEnabled()) return;
    this.lastKey = '';
    this.rpc.connect();
    if (this.loon.url) this.loon.connect();
  }

  stop() {
    try { this.rpc.clearActivity(); } catch {}
    this.rpc.close();
    this.loon.close();
    this.lastKey = '';
  }

  async update(payload) {
    this.lastPayload = payload;
    if (!this.isEnabled()) return;
    await this._apply(payload, false);
  }

  async _apply(payload, force) {
    const track = payload && payload.track;
    if (!track || !track.title) {
      if (this.lastKey) {
        this.rpc.clearActivity();
        this.lastKey = '';
      }
      return;
    }
    const artworkPath = String(payload.artworkPath || '');
    // Spotify and podcast playback never have a local artworkPath (main.js's
    // mpris:update handler only resolves one for real local files), but they
    // already carry a public https:// artworkUrl of their own (podcast feed
    // artwork, Spotify CDN cover) -- Discord can use that directly as
    // large_image with no loon round-trip needed at all. Without this
    // fallback, Rich Presence silently showed no artwork for anything that
    // wasn't a local file.
    const artworkUrl = !artworkPath && /^https?:\/\//i.test(String(payload.artworkUrl || '')) ? String(payload.artworkUrl) : '';
    const key = JSON.stringify({
      path: track.path || '',
      title: track.title || '',
      artist: track.artist || '',
      album: track.album || '',
      paused: !!payload.paused,
      artworkPath,
      artworkUrl
    });
    if (!force && key === this.lastKey) return;
    this.lastKey = key;

    let largeImageUrl = artworkUrl || null;
    if (artworkPath) {
      try {
        const resourcePath = `cover/${crypto.createHash('sha1').update(artworkPath).digest('hex')}${path.extname(artworkPath) || '.jpg'}`;
        if (resourcePath !== this.currentCoverResource) {
          if (this.currentCoverResource) this.loon.unregisterContent(this.currentCoverResource);
          const data = await fsp.readFile(artworkPath);
          const ext = path.extname(artworkPath).toLowerCase();
          const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          largeImageUrl = this.loon.registerContent(resourcePath, data, contentType);
          this.currentCoverResource = resourcePath;
        } else {
          largeImageUrl = this.loon.urlFor(resourcePath);
        }
      } catch (err) {
        this.emit('error', err);
      }
    } else if (this.currentCoverResource) {
      this.loon.unregisterContent(this.currentCoverResource);
      this.currentCoverResource = '';
    }

    const activity = {
      type: this._readActivityType(),
      details: String(track.title || '').slice(0, 128),
      assets: {},
      // Every reference Discord RPC implementation sets this on the activity
      // object; this one never did. Absent it, Discord appears to still
      // accept and store the activity (it shows correctly under the full
      // profile's Activity tab, per data alone) but does not treat it as a
      // "live session" worth surfacing in the compact hover-card the way it
      // does for games/Spotify -- it only shows the deeper, full-profile view.
      instance: true
    };
    if (largeImageUrl) {
      activity.assets.large_image = largeImageUrl;
      if (track.album) activity.assets.large_text = String(track.album).slice(0, 128);
    }
    const artistState = track.artist ? String(track.artist).slice(0, 128) : '';
    if (payload.paused) {
      activity.state = artistState ? `${artistState} — Paused` : 'Paused';
    } else {
      activity.state = artistState || undefined;
      const nowSec = Math.floor(Date.now() / 1000);
      const position = Math.max(0, Math.floor(Number(payload.position) || 0));
      const duration = Math.max(0, Math.floor(Number(payload.duration) || 0));
      activity.timestamps = { start: nowSec - position };
      if (duration > 0) activity.timestamps.end = nowSec + Math.max(0, duration - position);
    }
    this.rpc.setActivity(activity);
  }
}

module.exports = { DiscordPresence };
