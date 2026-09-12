'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
let dbus = null;
try { dbus = require('dbus-next'); } catch (e) { console.warn('[MPRIS] dbus-next unavailable:', e?.message || e); }

const SERVICE = 'org.mpris.MediaPlayer2.Beehive';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const ROOT = 'org.mpris.MediaPlayer2';

function us(seconds) { return BigInt(Math.max(0, Math.round(Number(seconds || 0) * 1000000))); }

class RootInterface extends (dbus?.interface?.Interface || class {}) {
  constructor() { super(ROOT); }
  Raise() {}
  Quit() {}
  get CanQuit() { return false; }
  get Fullscreen() { return false; } set Fullscreen(_v) {}
  get CanSetFullscreen() { return false; }
  get CanRaise() { return false; }
  get HasTrackList() { return false; }
  get Identity() { return 'Beehive'; }
  get DesktopEntry() { return 'beehive'; }
  get SupportedUriSchemes() { return ['file']; }
  get SupportedMimeTypes() { return []; }
}
class PlayerInterface extends (dbus?.interface?.Interface || class {}) {
  constructor(owner) { super(PLAYER); this.owner = owner; }
  Next() { this.owner.command('NEXT'); }
  Previous() { this.owner.command('PREVIOUS'); }
  Pause() { this.owner.command('PAUSE'); }
  PlayPause() { this.owner.command('PLAYPAUSE'); }
  Stop() { this.owner.command('STOP'); }
  Play() { this.owner.command('PLAY'); }
  Seek(offset) { this.owner.command('SEEKREL\t' + (Number(offset) / 1000000)); }
  SetPosition(_trackId, position) { this.owner.command('SEEK\t' + (Number(position) / 1000000)); }
  OpenUri(uri) { const u = String(uri || ''); if (u.startsWith('file://')) this.owner.command('OPENURI\t' + decodeURIComponent(u.slice(7))); }
  Seeked(position) { return position; }
  get PlaybackStatus() { return this.owner.state.paused ? (this.owner.state.track ? 'Paused' : 'Stopped') : 'Playing'; }
  get LoopStatus() { return ['None', 'Track', 'Playlist'][Math.max(0, Math.min(2, Number(this.owner.state.repeat) || 0))]; }
  set LoopStatus(v) { this.owner.command('REPEAT\t' + (v === 'Track' ? 1 : v === 'Playlist' ? 2 : 0)); }
  get Rate() { return 1; }
  set Rate(_v) {}
  get Shuffle() { return !!this.owner.state.shuffle; }
  set Shuffle(v) { this.owner.command('SHUFFLE\t' + (!!v)); }
  get Metadata() { return this.owner.metadata(); }
  get Volume() { return Number(this.owner.state.volume); }
  set Volume(v) { this.owner.command('VOLUME\t' + Math.max(0, Math.min(1, Number(v)))); }
  get Position() { return us(this.owner.state.position); }
  get MinimumRate() { return 1; }
  get MaximumRate() { return 1; }
  get CanGoNext() { return true; }
  get CanGoPrevious() { return true; }
  get CanPlay() { return !!this.owner.state.track; }
  get CanPause() { return !!this.owner.state.track; }
  get CanSeek() { return !!this.owner.state.track; }
  get CanControl() { return true; }
}
if (dbus) {
  const { configureMembers, ACCESS_READ, ACCESS_READWRITE } = dbus.interface;
  PlayerInterface.configureMembers({
    methods: {
      Next: { inSignature: '', outSignature: '' }, Previous: { inSignature: '', outSignature: '' }, Pause: { inSignature: '', outSignature: '' },
      PlayPause: { inSignature: '', outSignature: '' }, Stop: { inSignature: '', outSignature: '' }, Play: { inSignature: '', outSignature: '' },
      Seek: { inSignature: 'x', outSignature: '' }, SetPosition: { inSignature: 'ox', outSignature: '' }, OpenUri: { inSignature: 's', outSignature: '' }
    },
    properties: {
      PlaybackStatus: { signature: 's', access: ACCESS_READ }, LoopStatus: { signature: 's', access: ACCESS_READWRITE }, Rate: { signature: 'd', access: ACCESS_READWRITE },
      Shuffle: { signature: 'b', access: ACCESS_READWRITE }, Metadata: { signature: 'a{sv}', access: ACCESS_READ }, Volume: { signature: 'd', access: ACCESS_READWRITE },
      Position: { signature: 'x', access: ACCESS_READ }, MinimumRate: { signature: 'd', access: ACCESS_READ }, MaximumRate: { signature: 'd', access: ACCESS_READ },
      CanGoNext: { signature: 'b', access: ACCESS_READ }, CanGoPrevious: { signature: 'b', access: ACCESS_READ }, CanPlay: { signature: 'b', access: ACCESS_READ },
      CanPause: { signature: 'b', access: ACCESS_READ }, CanSeek: { signature: 'b', access: ACCESS_READ }, CanControl: { signature: 'b', access: ACCESS_READ }
    },
    signals: { Seeked: { signature: 'x' } }
  });
  RootInterface.configureMembers({
    methods: { Raise: { inSignature: '', outSignature: '' }, Quit: { inSignature: '', outSignature: '' } },
    properties: {
      CanQuit: { signature: 'b', access: ACCESS_READ }, Fullscreen: { signature: 'b', access: ACCESS_READWRITE }, CanSetFullscreen: { signature: 'b', access: ACCESS_READ },
      CanRaise: { signature: 'b', access: ACCESS_READ }, HasTrackList: { signature: 'b', access: ACCESS_READ }, Identity: { signature: 's', access: ACCESS_READ },
      DesktopEntry: { signature: 's', access: ACCESS_READ }, SupportedUriSchemes: { signature: 'as', access: ACCESS_READ }, SupportedMimeTypes: { signature: 'as', access: ACCESS_READ }
    }
  });
}

class BeehiveMPRIS {
  constructor({ userData, sendCommand }) {
    this.userData = userData; this.sendCommand = sendCommand; this.bus = null; this.root = null; this.player = null; this.running = false;
    this.state = { track: null, position: 0, duration: 0, paused: true, volume: 1, shuffle: false, repeat: 0, artworkPath: '' };
    this.trackKey = ''; this.coverPath = ''; this.lastMetadataKey = ''; this.lastPosition = 0; this.lastPlaybackStatus = ''; this.lastArtworkUrl = '';
  }
  command(command) { try { this.sendCommand(command); } catch {} }
  async start() {
    if (!dbus || this.running || process.platform !== 'linux') return false;
    try {
      this.bus = dbus.sessionBus(); await this.bus.requestName(SERVICE);
      this.root = new RootInterface(); this.player = new PlayerInterface(this);
      this.bus.export(OBJECT_PATH, this.root); this.bus.export(OBJECT_PATH, this.player); this.running = true;
      console.info('[MPRIS] Registered', SERVICE); await this.update(this.state); return true;
    } catch (e) { console.warn('[MPRIS] Registration failed:', e?.message || e); try { this.bus?.disconnect(); } catch {} this.bus=null; return false; }
  }
  stop() { try { this.bus?.disconnect(); } catch {} this.bus=null; this.running=false; }
  metadata() {
    const t=this.state.track; if(!t?.path) return {};
    const id='/org/mpris/MediaPlayer2/Track/'+crypto.createHash('sha1').update(String(t.path)).digest('hex').slice(0,32);
    const v=dbus.Variant;
    const m={'mpris:trackid':new v('o',id),'mpris:length':new v('x',us(this.state.duration||t.duration)),'xesam:title':new v('s',String(t.title||'')),'xesam:artist':new v('as',[String(t.artist||'')]),'xesam:album':new v('s',String(t.album||'')),'xesam:albumArtist':new v('as',[String(t.albumArtist||t.artist||'')])};
    if(t.path)m['xesam:url']=new v('s',pathToFileURL(String(t.path)).href);
    if(t.genre)m['xesam:genre']=new v('as',[String(t.genre)]); if(t.track)m['xesam:trackNumber']=new v('i',Number(t.track)||0);
    // MPRIS requires artwork to be part of the Metadata a{sv} dictionary.
    // Local Beehive artwork always wins: if a valid cached cover exists, never
    // replace it with a remote URL.
    const localArt = this.coverPath && fs.existsSync(this.coverPath)
      ? pathToFileURL(this.coverPath).href
      : '';
    if (localArt) {
      m['mpris:artUrl'] = new v('s', localArt);
    } else if (t.artworkUrl) {
      m['mpris:artUrl'] = new v('s', String(t.artworkUrl));
    }
    return m;
  }
  async writeCover() {
    const t = this.state.track;
    const requested = String(this.state.artworkPath || '').trim();
    if (!t?.path || !requested) { this.coverPath = ''; return; }
    try {
      const resolved = path.resolve(requested);
      const userDataPath = typeof this.userData === 'function' ? this.userData() : this.userData;
      const coversRoot = path.resolve(userDataPath, 'covers') + path.sep;
      if (!resolved.startsWith(coversRoot) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        this.coverPath = '';
        return;
      }
      this.coverPath = resolved;
    } catch { this.coverPath = ''; }
  }
  async update(p={}) {
    const hadTrack = this.state.track?.path || '';
    const nextTrack = p.track?.path || '';
    // Preserve a known-good local artwork path during metadata refreshes. The
    // renderer updates position/playing state frequently, and those updates must
    // never accidentally erase the cover for the current track.
    const sameTrack = !!nextTrack && nextTrack === hadTrack;
    const incomingArtwork = Object.prototype.hasOwnProperty.call(p, 'artworkPath')
      ? String(p.artworkPath || '').trim()
      : '';
    if (sameTrack && !incomingArtwork && this.state.artworkPath) {
      p = { ...p, artworkPath: this.state.artworkPath };
    }
    this.state={...this.state,...p};
    if(!this.running)return;
    await this.writeCover();
    const artworkUrl = this.coverPath || String(this.state.artworkUrl || '');
    const metadataKey = JSON.stringify({ path:this.state.track?.path||'', title:this.state.track?.title||'', artist:this.state.track?.artist||'', album:this.state.track?.album||'', albumArtist:this.state.track?.albumArtist||'', genre:this.state.track?.genre||'', track:this.state.track?.track||0, duration:Number(this.state.duration||0), artworkUrl });
    const playbackStatus = this.player.PlaybackStatus;
    const changed={};
    if (metadataKey !== this.lastMetadataKey || artworkUrl !== this.lastArtworkUrl || playbackStatus !== this.lastPlaybackStatus) {
      changed.Metadata=this.metadata();
      this.lastMetadataKey=metadataKey; this.lastArtworkUrl=artworkUrl; this.lastPlaybackStatus=playbackStatus;
    }
    if (Math.abs(Number(this.state.position||0)-Number(this.lastPosition||0)) >= 1 || Object.keys(changed).length) {
      changed.PlaybackStatus=playbackStatus; changed.Position=us(this.state.position); changed.Volume=Number(this.state.volume); changed.Shuffle=!!this.state.shuffle; changed.LoopStatus=this.player.LoopStatus; this.lastPosition=Number(this.state.position||0);
      try { dbus.interface.Interface.emitPropertiesChanged(this.player, changed, []); } catch(e) { console.warn('[MPRIS] PropertiesChanged failed:',e?.message||e); }
    }
  }
}
module.exports={BeehiveMPRIS};
