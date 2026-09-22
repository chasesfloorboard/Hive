const { app, BrowserWindow, protocol, net, ipcMain, dialog, clipboard, nativeImage, shell, nativeTheme, Tray, Menu, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const zlib = require('zlib');
const http = require('http');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const util = require('util');
const { fork, spawn, execFileSync } = require('child_process');
const { readWavMusicBeeLove: readSharedWavMusicBeeLove, readWavMusicBeePopmRaw: readSharedWavMusicBeePopmRaw } = require('./wav-id3');
const { readMp3MusicBeeLove: readSharedMp3MusicBeeLove } = require('./musicbee-love');
const { analyzeLoveValues, isLoveFieldName, normalizeLoveValue, CANONICAL_LOVE_TAG } = require('./love-integrity');
const { createClient: createMusicBrainzClient } = require('./musicbrainz');
const { canonicalize } = require('./canonical-metadata');
const { rendererTrackPayload } = require('./scan-payload');
const { normalizeText: normalizeArtworkText, scoreResult: scoreArtworkResult, createArtworkCache, providers: artworkProviders } = require('./artwork-providers');
const { TaskManager } = require('./task-manager');
const { BeehiveMPRIS } = require('./mpris');
const { ArtworkProxy } = require('./artwork-proxy');
const { runSecurityAudit, runLibraryHealth, runEnvironmentAudit } = require('./beta-diagnostics');
const { createDiagnosticsController } = require('./diagnostics');
const { PlaybackProtection } = require('./playback-protection');
const { ScrobblingService } = require('./scrobbling');
const { refreshDevices, sendTracksToDevice } = require('./device-manager');
const { listAudioOutputs } = require('./audio-output-manager');
const { readMusicBeeWrappedArchive, musicBeeImportPlayId } = require('./musicbee-wrapped-import');
const { selectPreferredLyrics } = require('./lyrics-provider');
const { autoUpdater } = require('electron-updater');
const { createUpdateChecker } = require('./update-checker');
const updateChecker = createUpdateChecker({ autoUpdater });
const { storeRoot: musicBeeStoreRoot, yearDir: musicBeeYearDir, writeYearStore: writeMusicBeeYearStore, metadataFor: musicBeeMetadataFor, readStoredYear: readMusicBeeStoredYear, mergeImportedYear: mergeMusicBeeImportedYear, exportArchive: exportMusicBeeArchive, appendHiveEvent: appendMusicBeeHiveEvent, trackKey: musicBeeTrackKey } = require('./musicbee-wrapped-store');

// Optional startup profiler. It is completely inert unless Beehive is launched
// with --startup-debug (or BEEHIVE_STARTUP_DEBUG=1). The profiler records the
// main-process timeline, renderer milestones, event-loop stalls, Electron
// process metrics, and every child process Beehive launches during startup.
// This is intentionally separate from normal crash logging so production
// launches do not pay the diagnostic I/O cost.

const STARTUP_DEBUG_ENABLED = process.argv.includes('--startup-debug') || process.env.BEEHIVE_STARTUP_DEBUG === '1';
const PERFORMANCE_DEBUG_ENABLED = STARTUP_DEBUG_ENABLED || process.argv.includes('--scroll-debug') || process.env.BEEHIVE_SCROLL_DEBUG === '1';
const GSTREAMER_TRACE_ENABLED = process.env.HIVE_GST_TRACE === '1';
// POST-SPOTIFY 1.0: Spotify development is intentionally paused. Keep the
// bridge implementation intact so it can be resumed later by changing this
// single flag back to false. Do not remove the Spotify code while paused.
const SPOTIFY_DEVELOPMENT_PAUSED = true;
const STARTUP_DEBUG_STARTED_AT = process.hrtime.bigint();
const HIVE_PROJECT_ROOT = path.resolve(__dirname, '..', '..');
function findHiveContainerRoot(startPath) {
  let current = path.resolve(startPath || HIVE_PROJECT_ROOT);
  for (let i = 0; i < 8; i += 1) {
    if (path.basename(current).toLowerCase() === 'hive') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}
function getPortableApplicationRoot() {
  // The Linux launcher intentionally uses one stable Electron executable for
  // Discord identity. The launcher supplies the actual extracted build root.
  const hintedRoot = String(process.env.HIVE_PORTABLE_ROOT || '').trim();
  if (hintedRoot) return path.resolve(hintedRoot);
  try {
    if (app.isPackaged) return path.dirname(app.getPath('exe'));
  } catch {}
  return HIVE_PROJECT_ROOT;
}
const PORTABLE_ROOT = () => path.resolve(getPortableApplicationRoot());
// Pre-portable-mode location (still used as a migration source and as the
// fallback when Hive isn't running from a folder literally named "hive" --
// see stableHiveDataRoot below).
function legacyStableConfigRoot() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming'), 'Hive');
  if (process.platform === 'darwin') return path.join(process.env.HOME || process.cwd(), 'Library', 'Application Support', 'Hive');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || process.cwd(), '.config'), 'Hive');
}
function stableHiveDataRoot() {
  // Fully portable: the database, settings, artwork cache, playlists,
  // provider state, plugins and themes (all subfolders of this root, via
  // USER_DATA()) live INSIDE the Hive folder itself, not in a per-machine
  // home-directory location -- so moving/copying the whole folder to another
  // drive or machine (a removable SSD, say) brings everything with it.
  // configureStableDataPaths() below handles a one-time migration from the
  // older ~/.config-based location for anyone upgrading from before this.
  const hiveRoot = findHiveContainerRoot(PORTABLE_ROOT());
  if (hiveRoot) return path.join(hiveRoot, 'Hive Data');
  // Only reachable if Hive is running from a folder not literally named
  // "hive" (e.g. a renamed checkout) -- keep the old per-OS location as a
  // reasonable fallback rather than writing data next to arbitrary code.
  return legacyStableConfigRoot();
}
const STABLE_DATA_ROOT = () => stableHiveDataRoot();
const LEGACY_BUILD_DATA_ROOT = () => path.join(PORTABLE_ROOT(), 'data');
function hiveUserBackupRoot() {
  const hiveRoot = findHiveContainerRoot(PORTABLE_ROOT());
  return hiveRoot ? path.join(hiveRoot, 'User Data Backup') : '';
}
const HIVE_USER_BACKUP_ROOT = () => hiveUserBackupRoot();
// Same format Hive uses for a MusicBee import (per-year play_history.xml +
// year_metadata.xml), kept in plain sight next to "User Data Backup" instead
// of buried in the Electron userData profile, since this is the one piece of
// Hive's own state a user might reasonably want to browse, back up, or hand
// to another install themselves.
function hiveWrappedDataRoot() {
  const hiveRoot = findHiveContainerRoot(PORTABLE_ROOT());
  return hiveRoot ? path.join(hiveRoot, 'Hive Wrapped Data') : path.join(app.getPath('userData'), 'yearly-wrap', 'musicbee');
}
const HIVE_WRAPPED_DATA_ROOT = () => hiveWrappedDataRoot();
function migrateLegacyWrappedDataSync() {
  try {
    const target = HIVE_WRAPPED_DATA_ROOT();
    const legacy = path.join(app.getPath('userData'), 'yearly-wrap', 'musicbee');
    if (!target || path.resolve(target) === path.resolve(legacy)) return;
    if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(legacy, target, { recursive: true });
    fs.rmSync(legacy, { recursive: true, force: true });
  } catch (err) { console.warn('[Hive] Wrapped data folder migration skipped:', err?.message || String(err)); }
}
const BACKUP_EXCLUDED_DIRS = new Set(['session', 'logs', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache']);
function copyDirectoryContentsSync(source, destination, { skipDirs = BACKUP_EXCLUDED_DIRS } = {}) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(destination, { recursive:true, mode:0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes:true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      fs.cpSync(from, to, { recursive:true, force:false, errorOnExist:false });
    } else if (!fs.existsSync(to)) fs.copyFileSync(from, to);
  }
  return true;
}
function findLegacyBuildDataRoot() {
  const current = LEGACY_BUILD_DATA_ROOT();
  if (fs.existsSync(current)) return current;
  const parent = path.dirname(PORTABLE_ROOT());
  try {
    const candidates = fs.readdirSync(parent, { withFileTypes:true })
      .filter(e => e.isDirectory() && /^Hive-/i.test(e.name) && fs.existsSync(path.join(parent, e.name, 'data')))
      .map(e => path.join(parent, e.name, 'data'));
    candidates.sort((a,b) => {
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });
    return candidates[0] || '';
  } catch { return ''; }
}
function restoreHiveUserBackupSync(dataRoot) {
  const backupRoot = HIVE_USER_BACKUP_ROOT();
  if (!backupRoot || !fs.existsSync(backupRoot)) return false;
  let restored = false;
  try {
    fs.mkdirSync(dataRoot, { recursive:true, mode:0o700 });
    const restoreNewer = (source, destination) => {
      for (const entry of fs.readdirSync(source, { withFileTypes:true })) {
        if (BACKUP_EXCLUDED_DIRS.has(entry.name)) continue;
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isDirectory()) { fs.mkdirSync(to, { recursive:true, mode:0o700 }); restoreNewer(from, to); continue; }
        // The stable profile is authoritative once it exists. The in-project
        // backup is a recovery copy, not a second competing source of truth.
        // Older builds compared mtimes here; because the backup is itself copied
        // after writes, that could make a stale backup look newer and resurrect
        // old Favorites/UI state on the next build. Restore only missing files.
        const shouldCopy = !fs.existsSync(to);
        if (shouldCopy) { fs.copyFileSync(from, to); try { fs.chmodSync(to, 0o600); } catch {} restored = true; }
      }
    };
    restoreNewer(backupRoot, dataRoot);
  } catch (err) { console.warn('[Hive] User-data backup restore skipped:', err?.message || String(err)); }
  return restored;
}
function backupHiveUserDataSync() {
  const source = STABLE_DATA_ROOT();
  const backupRoot = HIVE_USER_BACKUP_ROOT();
  if (!backupRoot || !fs.existsSync(source)) return false;
  try {
    fs.mkdirSync(backupRoot, { recursive:true, mode:0o700 });
    for (const entry of fs.readdirSync(source, { withFileTypes:true })) {
      if (BACKUP_EXCLUDED_DIRS.has(entry.name)) continue;
      const from = path.join(source, entry.name);
      const to = path.join(backupRoot, entry.name);
      fs.cpSync(from, to, { recursive:true, force:true });
    }
    fs.writeFileSync(path.join(backupRoot, '.hive-backup-meta.json'), JSON.stringify({ version:1, backedUpAt:new Date().toISOString() }, null, 2) + '\n', { mode:0o600 });
    return true;
  } catch (err) { console.warn('[Hive] User-data backup failed:', err?.message || String(err)); return false; }
}
function configureStableDataPaths() {
  const dataRoot = STABLE_DATA_ROOT();
  fs.mkdirSync(dataRoot, { recursive:true, mode:0o700 });
  // First launch after the transition: preserve the most recent build-local
  // profile, but never overwrite an already-established user profile.
  const marker = path.join(dataRoot, '.hive-stable-profile-v1');
  if (!fs.existsSync(marker)) {
    const legacy = findLegacyBuildDataRoot();
    if (legacy && path.resolve(legacy) !== path.resolve(dataRoot)) {
      try { copyDirectoryContentsSync(legacy, dataRoot); } catch (err) { console.warn('[Hive] Stable profile migration skipped:', err?.message || String(err)); }
    }
    // Portable-mode migration: anyone with an existing install has their real
    // database/settings/playlists/plugins sitting in the older ~/.config-style
    // location (legacyStableConfigRoot), not inside the Hive folder. Copy it
    // in once -- never delete the original, so nothing is lost even if this
    // runs twice or something goes wrong partway through.
    // "Tag Backups" is deliberately excluded: it's pre-write safety copies of
    // whole audio files, not app state, and on a real library can reach many
    // tens of GB with no relationship to the size of Hive's actual settings/
    // database -- copying it here would make first launch after this change
    // hang for a very long time and could easily not fit on a smaller
    // destination drive. It stays in the original ~/.config location.
    const legacyConfig = legacyStableConfigRoot();
    if (path.resolve(legacyConfig) !== path.resolve(dataRoot)) {
      try {
        if (copyDirectoryContentsSync(legacyConfig, dataRoot, { skipDirs: new Set([...BACKUP_EXCLUDED_DIRS, 'Tag Backups']) })) {
          console.log(`[Hive] Migrated user data into the portable Hive folder from ${legacyConfig} (Tag Backups intentionally left behind, see comment). The original is untouched; it can be removed manually once you've confirmed everything moved over.`);
        }
      } catch (err) { console.warn('[Hive] Portable-mode data migration skipped:', err?.message || String(err)); }
    }
    try { fs.writeFileSync(marker, JSON.stringify({ migratedAt:new Date().toISOString() }) + '\n', { mode:0o600 }); } catch {}
  }
  // The stable profile is the primary store. The in-project backup is a local
  // safety copy and a recovery source when a new build starts with missing or
  // stale app-owned state. It deliberately excludes Chromium session/cache/log
  // data and never copies the user's music files.
  restoreHiveUserBackupSync(dataRoot);
  app.setPath('userData', dataRoot);
  app.setPath('sessionData', path.join(dataRoot, 'session'));
}
try {
  configureStableDataPaths();
} catch (err) {
  try { console.error('[Hive] Unable to initialize stable Hive data root:', err?.message || String(err)); } catch {}
}
try {
  migrateLegacyWrappedDataSync();
} catch (err) {
  try { console.error('[Hive] Unable to migrate Wrapped data folder:', err?.message || String(err)); } catch {}
}
// Electron's own crash reporter, for the one class of failure the existing
// crashDebug()/session-log system (see session-log.js: uncaughtException,
// unhandledRejection, render-process-gone, gpu-process-crashed,
// child-process-gone) cannot see at all: a hard native crash (a segfault in
// the C GStreamer helper, a native Node addon, or Electron/Chromium itself)
// kills the process before any JS handler ever runs. Started here, right
// after configureStableDataPaths() above establishes the portable userData
// root, so crash dumps land inside Hive's own portable data area rather than
// the OS default location -- this build is meant to be fully self-contained.
// Hive is offline-first and does not phone home; uploadToServer is
// deliberately false so dumps are written locally only, for the user to find
// and attach to a bug report themselves (see the "Open crash reports folder"
// action in Settings > Diagnostics) -- never sent anywhere automatically.
try {
  crashReporter.start({ productName: 'Hive', companyName: 'Hive', uploadToServer: false, compress: true });
} catch (err) {
  try { console.error('[Hive] Unable to start crash reporter:', err?.message || String(err)); } catch {}
}
function serializePortableFolder(folder) {
  const absolute = path.resolve(String(folder || ''));
  if (!absolute) return '';
  const rel = path.relative(PORTABLE_ROOT(), absolute);
  if (rel && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return { type:'portable', path:rel };
  if (rel === '') return { type:'portable', path:'.' };
  return absolute;
}
function resolveConfiguredFolder(folder) {
  if (folder && typeof folder === 'object' && folder.type === 'portable') return path.resolve(PORTABLE_ROOT(), String(folder.path || '.'));
  const value = String(folder || '');
  if (!value) return '';
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return absolute;
  const sibling = path.join(PORTABLE_ROOT(), path.basename(value));
  if (fs.existsSync(sibling)) return sibling;
  return absolute;
}
function resolveConfigFolders(config) {
  const source = Array.isArray(config?.folders) ? config.folders : [];
  return source.map(resolveConfiguredFolder).filter(Boolean);
}
function portableConfigFolders(config) {
  const next = { ...(config || {}) };
  next.folders = (Array.isArray(next.folders) ? next.folders : []).map(folder => serializePortableFolder(resolveConfiguredFolder(folder))).filter(Boolean);
  return next;
}
async function normalizePortableLibraryConfig() {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  const normalized = portableConfigFolders(config);
  if (JSON.stringify(normalized.folders) !== JSON.stringify(config.folders || [])) await writeJsonSafe(CONFIG_PATH(), normalized);
  return normalized;
}
// Metadata writers replace complete media files. Never replace the inode that
// the active audio transport is reading: an in-place Love/tag rewrite can race
// the decoder and turn a metadata click into an unsafe audio event. Waiters are
// released explicitly when the transport hands ownership of the path away; a
// wall-clock timeout must never turn an active playback path into a writable one.
const playbackProtection = new PlaybackProtection();
function setPlaybackProtectedPath(trackPath) {
  const nextPath = trackPath ? path.resolve(String(trackPath)) : '';
  if (nextPath) {
    playbackProtection.protect(nextPath);
  } else {
    playbackProtection.release();
  }
}
function isPlaybackProtectedPath(trackPath) {
  return playbackProtection.isProtected(trackPath);
}
async function waitForPlaybackProtectionRelease(trackPath) {
  await playbackProtection.waitForRelease(trackPath);
  return true;
}
// Session logging, console capture, startup diagnostics, and tracked
// child-process spawning. See session-log.js.
const { createSessionLog } = require('./session-log');
const {
  RAW_CONSOLE,
  CONSOLE_NOISE,
  beehiveLogDir,
  ensureBeehiveLogDir,
  sessionLogPath,
  writeSession,
  flushSessionLogSync,
  pruneSessionLogs,
  startupDebug,
  startupDebugAppMetrics,
  startStartupProfiler,
  stopStartupProfiler,
  spawnTracked,
  forkTracked,
  runtimeResourcePath,
  workerForkOptions,
  crashDebug,
} = createSessionLog({
  hiveProjectRoot: HIVE_PROJECT_ROOT,
  startupDebugEnabled: STARTUP_DEBUG_ENABLED,
  startupDebugStartedAt: STARTUP_DEBUG_STARTED_AT,
});

// Optional native GStreamer playback backend. GStreamer owns the actual audio
// sink, clock, buffering, seeking and gapless transition; Electron only sends
// transport commands and receives lightweight events. See gstreamer-bridge.js.
const { createGstreamerBridge } = require('./gstreamer-bridge');
const gstreamerBridge = createGstreamerBridge({
  runtimeResourcePath,
  userDataDir: () => USER_DATA(),
  spawnTracked,
  crashDebug,
  writeSession,
  getMainWindow: () => mainWindow,
  startupDebugEnabled: STARTUP_DEBUG_ENABLED,
  gstreamerTraceEnabled: GSTREAMER_TRACE_ENABLED,
  getAudioOutputDevice: () => {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
      return String(config.audioOutputDevice || '').trim();
    } catch { return ''; }
  },
});
const {
  ensureGstreamerHelper,
  startGstreamerProcess,
  gstreamerStatus,
  restartGstreamerProcess,
  sendGstreamerCommand,
} = gstreamerBridge;

// Give large 20k+ library scans more V8 heap headroom and expose GC for
// periodic cleanup of temporary metadata/artwork parser objects.
// Chromium VSync/presentation timing is currently producing repeated
// GLSurfacePresentationHelper GetVSyncParametersIfAvailable() failures on the
// target Linux desktop. Disable GPU VSync so Chromium does not wait for the
// problematic display-vblank synchronization path. This is independent of
// GStreamer and does not change native audio transport.
// Linux desktop integration: use Electron 44's explicit X11/Ozone path so the
// Preserve the proven 0.9 Linux/X11 window path. On a GNOME Wayland desktop this
// intentionally runs through XWayland, because 0.9 used the legacy X11 path and its
// window-manager decorations matched the user's desktop theme. Hive can optionally
// replace those decorations with its own renderer title bar when the user enables
// the themed Electron window-bar setting. This is a window/compositor choice only;
// GStreamer and native audio transport are untouched.
if (process.platform === 'linux') {
  nativeTheme.themeSource = 'system';
  // Electron 33 is the known-good Linux desktop foundation for Hive. Keep the
  // exact 0.9-era X11 path so GNOME/Wayland sessions use XWayland's native
  // window-manager decorations when the optional Hive title-bar mode is off.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('disable-features', 'UseOzonePlatform');
}
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192 --expose-gc');
const USER_DATA = () => app.getPath('userData');
const MUSICBRAINZ_CACHE_PATH = () => path.join(USER_DATA(), 'musicbrainz-cache.json');
let musicBrainzClient;
const CONFIG_PATH = () => path.join(USER_DATA(), 'config.json');
const THEME_WINDOW_BAR_KEY = 'themeWindowBarEnabled';
const DEFAULT_THEME_WINDOW_BAR = true;
let themeWindowBarEnabled = DEFAULT_THEME_WINDOW_BAR;
let windowRecreateInProgress = false;
function readThemeWindowBarPreferenceSync() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    // A pre-window-bar config file is not an explicit opt-out. Treat a missing
    // key as the product default, while preserving an explicitly saved false.
    if (config && Object.prototype.hasOwnProperty.call(config, THEME_WINDOW_BAR_KEY)) {
      return config[THEME_WINDOW_BAR_KEY] === true;
    }
    return DEFAULT_THEME_WINDOW_BAR;
  } catch { return DEFAULT_THEME_WINDOW_BAR; }
}
function windowBoundsSnapshot(window) {
  try { return window.getBounds(); } catch { return { x:undefined, y:undefined, width:1440, height:860 }; }
}
const CUSTOM_CSS_PATH = () => path.join(USER_DATA(), 'custom-theme.css');
const THEME_META_PATH = () => path.join(USER_DATA(), 'custom-theme.json');
const PLUGINS_DIR = () => path.join(USER_DATA(), 'plugins');
const artworkProxy = new ArtworkProxy(() => COVERS_DIR());
const mpris = new BeehiveMPRIS({
  userData: USER_DATA,
  artworkProxy,
  sendCommand: command => {
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mpris:command', String(command || '')); } catch {}
  }
});

try {
  const desktopEntry = path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local', 'share'), 'applications', 'hive.desktop');
  startupDebug('MPRIS DESKTOP INTEGRATION', { desktopEntry, exists: fs.existsSync(desktopEntry), mprisDesktopEntry: 'hive' });
} catch {}

// Linux desktop tray integration. Electron uses StatusNotifierItem on Linux when
// available, which is the native path used by GNOME-compatible tray hosts.
const { createTrayController } = require('./tray');
const { createHiveTray, updateHiveTrayState, hiveLogoPath } = createTrayController({
  Tray,
  Menu,
  nativeImage,
  runtimeResourcePath,
  mpris,
  getMainWindow: () => mainWindow,
  openMainWindow: () => createWindow(),
  quitApp: () => app.quit(),
});
let mprisTrackPath = '';
let lastMprisArtworkLogAt = 0;
const MPRIS_ARTWORK_LOG_INTERVAL_MS = 5000;

// Hive owns Discord Rich Presence directly again (see IMPORTANT INFO.txt and
// the session notes on the Music Presence proxy failing on this machine):
// loon (self-hosted, see setup-music-presence.sh) turns local cover art into
// a temporary public URL, and a direct Discord IPC connection publishes the
// activity. music-presence.service must stay stopped while this is active,
// or the two will fight over the same Discord activity.
const { DiscordPresence } = require('./discord-presence');
// Hive's own dedicated Discord Application (registered at
// discord.com/developers/applications, not any individual user's personal
// app), the shared default every install's Rich Presence publishes under --
// matches how every other app with Discord Rich Presence does this (one
// project-owned application ID, not a per-user one).
const DISCORD_PRESENCE_CLIENT_ID = '1548882733063733300';
// The loon WebSocket URL (including its Basic Auth credentials, from the
// self-hosted deployment's caddy.env) is deliberately NOT hardcoded here --
// it lives only in userData/discord-presence.json, outside the git-tracked
// project tree, so a secret never lands in source control. See
// setup-music-presence.sh for how that self-hosted loon+bore deployment is
// provisioned.
function readDiscordPresenceConfigSync() {
  let loonUrl = '';
  let loonCa = null;
  try {
    const raw = fs.readFileSync(path.join(USER_DATA(), 'discord-presence.json'), 'utf8');
    loonUrl = String(JSON.parse(raw)?.loonWsUrl || '');
  } catch {}
  // The self-hosted loon deployment's Caddy front-end uses `tls internal`
  // (its own local certificate authority), not a publicly trusted CA. Pin
  // trust to that specific CA's root certificate (stable across Caddy's
  // periodic short-lived-intermediate rotation) rather than disabling
  // certificate verification outright.
  try {
    loonCa = fs.readFileSync(path.join(USER_DATA(), 'discord-presence-loon-ca.pem'), 'utf8');
  } catch {}
  return { loonUrl, loonCa };
}
const discordPresenceConfig = readDiscordPresenceConfigSync();
// Hive's own activity-type preference -- no longer Music Presence's
// settings.json (Hive publishes Rich Presence directly and does not use or
// share state with Music Presence anymore).
const DISCORD_ACTIVITY_TYPE_PATH = () => path.join(USER_DATA(), 'discord-activity-type.json');
const discordPresence = new DiscordPresence({
  clientId: DISCORD_PRESENCE_CLIENT_ID,
  loonUrl: discordPresenceConfig.loonUrl,
  loonCa: discordPresenceConfig.loonCa,
  activityTypeSettingsPath: DISCORD_ACTIVITY_TYPE_PATH()
});
discordPresence.on('error', (err) => startupDebug('DISCORD PRESENCE ERROR', { message: err?.message || String(err) }));
let gpuCrashFallbackRecorded = false;
const scrobbling = new ScrobblingService(
  async () => readJsonSafe(CONFIG_PATH(), { folders: [] }),
  async (next) => writeJsonSafe(CONFIG_PATH(), next),
  { userData: USER_DATA }
);

const inAppDiagnostics = createDiagnosticsController({
  userDataDir: USER_DATA(),
  version: (() => { try { return app.getVersion(); } catch { return 'unknown'; } })(),
  build: (() => { try { return fs.readFileSync(path.join(HIVE_PROJECT_ROOT, 'BUILD'), 'utf8').trim() || 'unknown'; } catch { return 'unknown'; } })(),
  getRuntime: async () => {
    const cfg = await readJsonSafe(CONFIG_PATH(), { folders: [] });
    const cached = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
    let dbHealth = null;
    try { dbHealth = await databaseRequest('health_check'); } catch (err) { dbHealth = { ok:false, error:err?.message || String(err) }; }
    return {
      libraryRoots: Array.isArray(cfg?.folders) ? cfg.folders.map(resolveConfiguredFolder).filter(Boolean) : [],
      libraryTrackCount: Array.isArray(cached?.tracks) ? cached.tracks.length : 0,
      databaseHealth: dbHealth,
      gpuAccelerationDisabled: gpuAccelerationDisabledAtStartup(),
      startupDebugEnabled: STARTUP_DEBUG_ENABLED,
      performanceDebugEnabled: PERFORMANCE_DEBUG_ENABLED,
      spotifyDevelopmentPaused: SPOTIFY_DEVELOPMENT_PAUSED
    };
  },
  getLogs: async () => {
    ensureBeehiveLogDir();
    const readTail = async (filePath, maxBytes = 200 * 1024) => {
      try {
        const st = await fsp.stat(filePath);
        const start = Math.max(0, st.size - maxBytes);
        const handle = await fsp.open(filePath, 'r');
        try { const buf = Buffer.alloc(Math.max(0, st.size - start)); await handle.read(buf, 0, buf.length, start); return buf.toString('utf8'); }
        finally { await handle.close(); }
      } catch { return ''; }
    };
    return { crash: await readTail(sessionLogPath()), scan: await readTail(SCAN_LOG_PATH()) };
  },
  getAudits: async () => {
    const cfg = await readJsonSafe(CONFIG_PATH(), { folders: [] });
    const environment = await runEnvironmentAudit(HIVE_PROJECT_ROOT, {
      logDir: beehiveLogDir(),
      tempDir: path.join(app.getPath('temp'), 'BeehiveMusicBrainz'),
      libraryRoots: Array.isArray(cfg?.folders) ? cfg.folders.map(resolveConfiguredFolder).filter(Boolean) : []
    });
    const security = await runSecurityAudit(HIVE_PROJECT_ROOT);
    return [
      { name:'Environment audit', ...environment },
      { name:'Security audit', ...security }
    ];
  },
  writeReport: async (filePath, text) => {
    await fsp.writeFile(filePath, text, { encoding:'utf8', mode:0o600 });
    return filePath;
  },
  openPath: async (dir) => shell.openPath(dir),
  onStart: () => { try { sendGstreamerCommand('TRACE\t1'); } catch {} },
  onFinish: () => { try { sendGstreamerCommand('TRACE\t0'); } catch {} }

});

// GPU acceleration is a process-start setting in Electron. Read the persisted
// preference before app.whenReady() so it can be applied early enough for the
// next launch. This does not touch the native GStreamer playback process.
function gpuAccelerationDisabledAtStartup() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8');
    const config = JSON.parse(raw);
    /* Builds before 261 could persist an automatic software-rendering fallback
     * after a GPU-process crash. That made a temporary recovery decision look
     * like the product default on the next launch. Automatic fallback is no
     * longer persisted; only an explicit user disable remains authoritative. */
    if (config?.gpuAccelerationAutoDisabled === true) return false;
    return config && config.disableGpuAcceleration === true;
  } catch {
    return false;
  }
}
if (gpuAccelerationDisabledAtStartup()) {
  try { app.disableHardwareAcceleration(); } catch (err) { console.warn('[Beehive] Could not disable hardware acceleration:', err.message); }
}

const COVERS_DIR = () => path.join(USER_DATA(), 'covers');
const LIBRARY_CACHE_PATH = () => path.join(USER_DATA(), 'library.json');
const LIBRARY_CACHE_GZIP_PATH = () => path.join(USER_DATA(), 'library.json.gz');
const HISTORY_PATH = () => path.join(USER_DATA(), 'history.json');
const LISTENING_EVENTS_PATH = () => path.join(USER_DATA(), 'listening-events.json');
const MUSICBEE_WRAPPED_IMPORTS_PATH = () => path.join(USER_DATA(), 'yearly-wrap-imports.json');
const STATS_PATH = () => path.join(USER_DATA(), 'play-stats.json');
const PLAYLISTS_PATH = () => path.join(USER_DATA(), 'playlists.json');
const SCAN_LOG_PATH = () => path.join(beehiveLogDir(), 'scan-live.log');
// Small renderer-owned session snapshot. This is intentionally separate from
// library metadata/play statistics so playback recovery can be updated often.
const PLAYBACK_STATE_PATH = () => path.join(USER_DATA(), 'playback-state.json');
// One-time migration: discard only Hive's derived library cache/database records
// so beta.6 can perform a genuinely cold first library scan. User configuration,
// playlists, playback state, and the music files themselves are never removed.
const DATABASE_PATH = () => path.join(USER_DATA(), 'beehive.db');
let databaseProcess = null;
let databaseReady = false;
let databaseSeq = 0;
const databasePending = new Map();
let recoveredMetadataJobs = [];
const taskManager = new TaskManager();
let artworkCacheManager = null;

function startDatabaseWorker() {
  if (databaseProcess && !databaseProcess.killed) return;
  const worker = runtimeResourcePath(path.join('app','workers','database-worker.py'));
  databaseProcess = spawnTracked(process.env.BEEHIVE_PYTHON || 'python3', [worker, DATABASE_PATH()], { stdio: ['pipe','pipe','pipe'] });
  try { if (databaseProcess.pid) process.setPriority(databaseProcess.pid, 15); } catch {}
  let buffer = '';
  databaseProcess.stdout.on('data', chunk => {
    buffer += String(chunk || '');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const pending = databasePending.get(String(msg.id));
        if (!pending) continue;
        databasePending.delete(String(msg.id));
        if (msg.ok) pending.resolve(msg.result); else pending.reject(new Error(msg.error || 'Database worker error'));
      } catch (err) { crashDebug('DATABASE invalid response', { message: err.message }); }
    }
  });
  databaseProcess.stderr.on('data', chunk => { const text=String(chunk||'').trim(); if(text) crashDebug('DATABASE worker stderr', text); });
  databaseProcess.on('exit', () => {
    for (const pending of databasePending.values()) pending.reject(new Error('Database worker exited.'));
    databasePending.clear(); databaseProcess = null; databaseReady = false;
  });
  databaseReady = true;
}
function databaseRequest(cmd, payload = {}) {
  startDatabaseWorker();
  const id = String(++databaseSeq);
  return new Promise((resolve,reject) => {
    databasePending.set(id,{resolve,reject});
    try { databaseProcess.stdin.write(JSON.stringify({ id, cmd, ...payload })+'\n'); }
    catch (err) { databasePending.delete(id); reject(err); }
  });
}
async function clearLibraryCacheData({ clearCovers = true } = {}) {
  const removed = [];
  for (const target of [LIBRARY_CACHE_PATH(), LIBRARY_CACHE_GZIP_PATH()]) {
    try { await fsp.rm(target, { force: true }); removed.push(target); } catch (err) {
      throw new Error(`Could not clear library cache ${target}: ${err.message}`);
    }
  }
  if (!databaseReady) throw new Error('Library database is not ready; cache reset was not completed.');
  {
    try { await databaseRequest('clear_library'); }
    catch (err) { throw new Error(`Could not clear cached library database: ${err.message}`); }
  }
  if (clearCovers) {
    try {
      const entries = await fsp.readdir(COVERS_DIR(), { withFileTypes: true });
      await Promise.all(entries.map(entry => fsp.rm(path.join(COVERS_DIR(), entry.name), { recursive: true, force: true })));
      removed.push(COVERS_DIR());
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new Error(`Could not clear cached artwork: ${err.message}`);
    }
  }
  scanLog('LIBRARY CACHE CLEARED', { clearCovers, removed: removed.length });
  return { ok: true, removed };
}

async function initializeDatabase() {
  startDatabaseWorker();
  artworkCacheManager = createArtworkCache(COVERS_DIR());
  try {
    recoveredMetadataJobs = await databaseRequest('recover_jobs');
    databaseReady = true;
  } catch (err) { databaseReady = false; crashDebug('DATABASE initialization failed', { message: err.message }); }
}
async function persistLibraryDatabase(tracks) {
  try { await databaseRequest('replace_library', { tracks: Array.isArray(tracks) ? tracks.map(canonicalize) : [] }); }
  catch (err) { crashDebug('DATABASE library persist failed', { message: err.message }); }
}
async function persistMetadataJob(job, status='queued', attempts=0, lastError='') {
  const payload = { id:String(job.id), status, job, attempts, createdAt:Number(job.createdAt || Date.now()), lastError };
  // A metadata write must never begin unless its recovery journal entry has
  // actually reached SQLite. Swallowing this error would turn the journal into
  // best-effort logging and could leave a partially completed physical write
  // with no durable recovery record after a crash.
  try {
    await databaseRequest('upsert_job', { job:payload });
  } catch (err) {
    crashDebug('DATABASE metadata job persist failed', { message:err.message });
    throw new Error(`Could not make the metadata operation durable: ${err.message}`);
  }
}
async function updateMetadataJob(id,status,attempts,error='') { try { await databaseRequest('update_job',{job_id:String(id),status,attempts,error}); } catch (err) { crashDebug('DATABASE metadata job update failed',{message:err.message}); } }
async function deleteMetadataJob(id) { try { await databaseRequest('delete_job',{job_id:String(id)}); } catch (err) { crashDebug('DATABASE metadata job delete failed',{message:err.message}); } }

function scanLog(message, data = null) {
  const stamp = new Date().toISOString();
  const suffix = data === null || data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  const line = `[${stamp}] ${message}${suffix}`;
  try { console.log(`[Beehive Scan] ${line}`); } catch {}
  try { ensureBeehiveLogDir(); fs.appendFileSync(SCAN_LOG_PATH(), line + '\n', 'utf8'); } catch {}
}

function scanMemoryDebug(label, data = {}) {
  if (process.env.BEEHIVE_SCAN_MEMORY_DEBUG !== '1') return;
  try {
    const memory = process.memoryUsage();
    scanLog(`SCAN MEMORY ${label}`, {
      ...data,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      databasePending: databasePending.size
    });
  } catch {}
}


const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.mp4', '.aac', '.wav', '.aiff', '.aif',
  '.ogg', '.oga', '.opus', '.wma', '.asf', '.ape', '.wv', '.mp2', '.mpc',
  '.dsf', '.dff', '.mka', '.mkv', '.webm', '.spx'
]);

let mainWindow;
let mm; // music-metadata, loaded lazily (ESM)

// ---------- protocol registration (must happen before app.ready) ----------
protocol.registerSchemesAsPrivileged([
  { scheme: 'mbfile', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'mbcover', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true } }
]);

function decodePath(url, prefix) {
  return decodeURIComponent(url.slice(prefix.length).replace(/^\/+/, ''));
}

async function readJsonSafe(p, fallback) {
  try {
    const txt = await fsp.readFile(p, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const isLibraryCache = p === LIBRARY_CACHE_PATH();
  const cacheWriteStartedAt = isLibraryCache ? Date.now() : 0;
  // The library cache is machine-only (immediately gzipped for transport,
  // never hand-edited) and can be tens of thousands of tracks -- pretty
  // printing it inflates the string V8 has to allocate and hash for no
  // benefit, on every single scan that finds even one changed file. Every
  // other JSON file stays indented for human readability/debugging.
  const payload = isLibraryCache ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  if (isLibraryCache) scanLog('LIBRARY CACHE JSON SERIALIZED', { ms: Date.now() - cacheWriteStartedAt, bytes: Buffer.byteLength(payload, 'utf8') });
  // Never write JSON directly over a live cache file. A concurrent reader can
  // otherwise observe a partially-written JSON document, fall back to `{}`, and
  // a later incremental scan can accidentally replace a full library cache with
  // only the handful of tracks it was refreshing. Write a complete temporary
  // file first and replace the destination only after the new JSON is complete.
  const temp = `${p}.beehive-write-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(temp, payload, 'utf8');
  try {
    await fsp.rename(temp, p);
    try { await fsp.chmod(p, 0o600); } catch {}
  } catch (err) {
    // Windows does not allow rename-over-existing-file. Remove the old file only
    // as the platform-specific fallback; the new file itself is already complete.
    if (process.platform === 'win32' && (err?.code === 'EEXIST' || err?.code === 'EPERM')) {
      await fsp.rm(p, { force: true });
      await fsp.rename(temp, p);
    } else {
      throw err;
    }
  } finally {
    try { await fsp.unlink(temp); } catch {}
  }

  // Mirror user-owned JSON state into the in-project Hive backup. Library cache
  // writes are intentionally excluded here because they are large; the complete
  // profile is snapshotted on application shutdown.
  if (p !== LIBRARY_CACHE_PATH() && !p.includes(`${path.sep}session${path.sep}`) && !p.includes(`${path.sep}logs${path.sep}`)) {
    try {
      const backupRoot = HIVE_USER_BACKUP_ROOT();
      if (backupRoot) {
        const relative = path.relative(STABLE_DATA_ROOT(), p);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
          const backupPath = path.join(backupRoot, relative);
          await fsp.mkdir(path.dirname(backupPath), { recursive:true });
          await fsp.copyFile(p, backupPath);
          try { await fsp.chmod(backupPath, 0o600); } catch {}
        }
      }
    } catch (err) { console.warn('[Hive] User-data JSON backup skipped:', err?.message || String(err)); }
  }

  // Keep a compact startup transport copy of the library cache. Electron's IPC
  // structured-clone cost grows substantially with a 30k-track object graph;
  // shipping the compressed bytes avoids cloning hundreds of megabytes of
  // duplicated JS objects before the renderer can use them. The plain JSON file
  // remains the canonical human-readable cache and fallback.
  if (p === LIBRARY_CACHE_PATH()) {
    try {
      // Compression is deliberately asynchronous. A synchronous gzip here can
      // stall the main process for hundreds of milliseconds on a large library,
      // including while playback/MPRIS IPC is being serviced.
      const compressed = await new Promise((resolve, reject) => {
        zlib.gzip(Buffer.from(payload, 'utf8'), { level: 1 }, (err, data) => err ? reject(err) : resolve(data));
      });
      const gzipPath = LIBRARY_CACHE_GZIP_PATH();
      const gzipTemp = `${gzipPath}.beehive-write-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fsp.writeFile(gzipTemp, compressed);
      try { await fsp.rename(gzipTemp, gzipPath); }
      catch (err) {
        if (process.platform === 'win32' && (err?.code === 'EEXIST' || err?.code === 'EPERM')) {
          await fsp.rm(gzipPath, { force: true });
          await fsp.rename(gzipTemp, gzipPath);
        } else throw err;
      }
      try { await fsp.unlink(gzipTemp); } catch {}
      if (isLibraryCache) scanLog('LIBRARY CACHE GZIP WRITTEN', { ms: Date.now() - cacheWriteStartedAt, compressedBytes: compressed.length });
    } catch (err) {
      crashDebug('COMPRESSED LIBRARY CACHE WRITE FAILED', { message: err?.message || String(err) });
    }
  }
}

// Serialize read-modify-write cycles against a shared JSON file. readJsonSafe/
// writeJsonSafe individually are safe (atomic temp-file + rename), but neither
// is aware of a concurrent caller doing its own read-modify-write against the
// same path -- two near-simultaneous mutations (even unrelated ones, e.g.
// renaming playlist A while a Favorites-timestamp autosave for playlist B
// lands) can each read the same "before" snapshot and whichever writes last
// silently discards the other's change. withJsonFileLock forces every
// registered mutation against one path through a single queue.
const jsonFileWriteQueues = new Map();
function withJsonFileLock(filePath, fn) {
  const previous = jsonFileWriteQueues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  jsonFileWriteQueues.set(filePath, next.catch(() => {}));
  return next;
}

// Serialize mutations to Beehive's play-stats.json so a clear operation cannot
// race a play/rating write and accidentally restore an old play count.
let statsMutationChain = Promise.resolve();
function withStatsMutation(task) {
  const run = statsMutationChain.then(task, task);
  statsMutationChain = run.catch(() => {});
  return run;
}

async function getMusicBrainzClient() {
  if (!musicBrainzClient) {
    musicBrainzClient = createMusicBrainzClient({ cacheFile: MUSICBRAINZ_CACHE_PATH() });
  }
  return musicBrainzClient;
}

ipcMain.handle('musicbrainz:searchReleaseGroups', async (_evt, query = {}) => {
  const client = await getMusicBrainzClient();
  return client.searchReleaseGroups(query);
});

ipcMain.handle('musicbrainz:searchReleases', async (_evt, query = {}) => {
  const client = await getMusicBrainzClient();
  return client.searchReleases(query);
});

ipcMain.handle('musicbrainz:identify', async (_evt, query = {}) => {
  const client = await getMusicBrainzClient();
  return client.identify(query);
});

ipcMain.handle('musicbrainz:getReleaseDetails', async (_evt, releaseId) => {
  const client = await getMusicBrainzClient();
  return client.getReleaseDetails(releaseId);
});

let yearlyWrapWindow = null;
// The currently-playing track's accent, so a Yearly Wrap window opened later
// (or a track change while it's already open) can theme itself to match the
// rest of the app's frosted-glass UI instead of a fixed purple/teal look.
let yearlyWrapTheme = null;
function sanitizeYearlyWrapTheme(theme) {
  const rgbTriple = value => {
    const m = String(value || '').match(/^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/);
    if (!m) return null;
    return [m[1], m[2], m[3]].map(n => Math.max(0, Math.min(255, Number(n)))).join(',');
  };
  const accent = rgbTriple(theme?.accent);
  if (!accent) return null;
  return { accent, accent2: rgbTriple(theme?.accent2) || accent };
}
function openYearlyWrapWindow(year = new Date().getFullYear(), theme = null) {
  const sanitized = sanitizeYearlyWrapTheme(theme);
  if (sanitized) yearlyWrapTheme = sanitized;
  if (yearlyWrapWindow && !yearlyWrapWindow.isDestroyed()) {
    yearlyWrapWindow.focus();
    return yearlyWrapWindow;
  }
  yearlyWrapWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 640,
    backgroundColor: '#08090d', autoHideMenuBar: true, frame: true,
    title: `Hive Yearly Wrap · ${year}`,
    parent: mainWindow || undefined,
    webPreferences: { preload: runtimeResourcePath(path.join('app','main','preload.js')), contextIsolation:true, nodeIntegration:false, sandbox:true }
  });
  yearlyWrapWindow.setMenuBarVisibility(false);
  yearlyWrapWindow.webContents.setWindowOpenHandler(({url}) => { try { const u=new URL(url); if(u.protocol==='https:'||u.protocol==='http:') shell.openExternal(url).catch(()=>{}); } catch {} return {action:'deny'}; });
  yearlyWrapWindow.on('closed', () => { yearlyWrapWindow = null; });
  const query = { year: String(year) };
  if (yearlyWrapTheme) { query.accent = yearlyWrapTheme.accent; query.accent2 = yearlyWrapTheme.accent2; }
  yearlyWrapWindow.loadFile(runtimeResourcePath(path.join('app','renderer','yearly-wrap.html')), { query });
  return yearlyWrapWindow;
}

ipcMain.handle('yearly-wrap:open', async (_evt, year, theme) => { openYearlyWrapWindow(Number(year) || new Date().getFullYear(), theme); return true; });

// Pushed whenever the main window's now-playing accent changes, so an
// already-open Yearly Wrap window follows the currently playing song instead
// of staying frozen at whatever was playing when it was opened.
ipcMain.handle('yearly-wrap:pushTheme', async (_evt, theme) => {
  const sanitized = sanitizeYearlyWrapTheme(theme);
  if (!sanitized) return false;
  yearlyWrapTheme = sanitized;
  if (yearlyWrapWindow && !yearlyWrapWindow.isDestroyed()) yearlyWrapWindow.webContents.send('yearly-wrap:theme', sanitized);
  return true;
});

ipcMain.handle('yearly-wrap:saveImage', async (_evt, payload = {}) => {
  const dataUrl = String(payload?.dataUrl || '');
  if (!/^data:image\/png;base64,/i.test(dataUrl)) throw new Error('Invalid Yearly Wrap image data.');
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('Yearly Wrap image is empty.');
  const requested = String(payload?.name || 'Hive-Yearly-Wrap.png').replace(/[^a-z0-9._ -]+/gi, '').trim();
  const name = requested.toLowerCase().endsWith('.png') ? requested : `${requested || 'Hive-Yearly-Wrap'}.png`;
  const pictures = app.getPath('pictures');
  const result = await dialog.showSaveDialog(yearlyWrapWindow || mainWindow, {
    defaultPath: path.join(pictures, name),
    filters: [{ name: 'PNG image', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePath) return { ok:false, canceled:true };
  await fsp.writeFile(result.filePath, buffer, { mode:0o600 });
  return { ok:true, filePath:result.filePath };
});

ipcMain.handle('yearly-wrap:copyImage', async (_evt, dataUrl = '') => {
  const value = String(dataUrl || '');
  if (!/^data:image\/png;base64,/i.test(value)) throw new Error('Invalid Yearly Wrap image data.');
  clipboard.writeImage(nativeImage.createFromDataURL(value));
  return { ok:true };
});

// Despite the "yearly-wrap" name (this channel predates its current use),
// this is now the shared source for Hive's own logo image data too -- the
// main renderer's top-left brand button and About dialog fetch it via the
// same window.beehive.getYearlyWrapBrandIcon() call (see renderer.js, "The
// Hive logo is a shared brand asset" comment). The Yearly Wrap window
// itself no longer shows a logo/watermark toggle, but this handler must
// stay for that other, still-live caller.
ipcMain.handle('yearly-wrap:getBrandIcon', async () => {
  try {
    const icon = nativeImage.createFromPath(hiveLogoPath());
    return icon.isEmpty() ? null : icon.toDataURL();
  } catch { return null; }
});

ipcMain.handle('window:minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); return true; });
ipcMain.handle('window:maximize', () => { if (!mainWindow || mainWindow.isDestroyed()) return false; mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); return mainWindow.isMaximized(); });
ipcMain.handle('window:close', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); return true; });
ipcMain.handle('window:is-maximized', () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()));
ipcMain.handle('window:theme-bar:get', () => themeWindowBarEnabled);
ipcMain.handle('window:theme-bar:set', async (_evt, enabled) => {
  const next = !!enabled;
  if (next === themeWindowBarEnabled) return { changed:false, enabled:next };
  themeWindowBarEnabled = next;
  const config = await readJsonSafe(CONFIG_PATH(), {});
  await writeJsonSafe(CONFIG_PATH(), { ...config, [THEME_WINDOW_BAR_KEY]: next });
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return { changed:true, enabled:next };
  }
  if (windowRecreateInProgress) return { changed:true, enabled:next, recreating:true };
  const oldWindow = mainWindow;
  const bounds = windowBoundsSnapshot(oldWindow);
  const maximized = oldWindow.isMaximized();
  windowRecreateInProgress = true;
  oldWindow.once('closed', () => {
    windowRecreateInProgress = false;
    createWindow({ bounds, maximized, preservePlayback: true });
  });
  oldWindow.close();
  return { changed:true, enabled:next, recreating:true };
});

function createWindow({ bounds = null, maximized = false, preservePlayback = false } = {}) {
  themeWindowBarEnabled = readThemeWindowBarPreferenceSync();
  startupDebug('WINDOW CREATE START');
  mainWindow = new BrowserWindow({
    ...(bounds && Number.isFinite(bounds.width) ? { x:bounds.x, y:bounds.y, width:bounds.width, height:bounds.height } : { width:1440, height:860 }),
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0c0f',
    autoHideMenuBar: true,
    frame: themeWindowBarEnabled ? false : true,
    title: 'Hive',
    icon: hiveLogoPath(),
    webPreferences: {
      preload: runtimeResourcePath(path.join('app','main','preload.js')),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  if (maximized) {
    mainWindow.once('ready-to-show', () => { try { mainWindow.maximize(); } catch {} });
  }
  const emitWindowMaximized = () => { try { mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized()); } catch {} };
  mainWindow.on('maximize', emitWindowMaximized);
  mainWindow.on('unmaximize', emitWindowMaximized);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') { shell.openExternal(url).catch(() => {}); }
    } catch {}
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const current = new URL(mainWindow.webContents.getURL() || 'file:///');
      const next = new URL(url);
      if (next.protocol !== current.protocol || next.href !== current.href) event.preventDefault();
    } catch { event.preventDefault(); }
  });

  let rendererRecoveryTimes = [];
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    let metrics = null;
    try { metrics = app.getAppMetrics().map(m => ({ type: m.type, pid: m.pid, memory: m.memory?.workingSetSize, cpu: m.cpu?.percent })); } catch {}
    crashDebug('RENDERER render-process-gone', { details, processMemory: process.memoryUsage(), appMetrics: metrics });
    const reason = String(details?.reason || '').toLowerCase();
    if (!['crashed','oom','killed','abnormal-exit'].includes(reason)) return;
    const now = Date.now();
    rendererRecoveryTimes = rendererRecoveryTimes.filter(t => now - t < 60000);
    if (rendererRecoveryTimes.length >= 2 || mainWindow.isDestroyed()) return;
    rendererRecoveryTimes.push(now);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      crashDebug('RENDERER RECOVERY RELOAD', { reason, attempt: rendererRecoveryTimes.length });
      try { mainWindow.loadFile(runtimeResourcePath(path.join('app','renderer','index.html'))); } catch (err) { crashDebug('RENDERER RECOVERY FAILED', { message:err?.message }); }
    }, 500).unref?.();
  });
  mainWindow.webContents.on('unresponsive', () => { crashDebug('RENDERER unresponsive'); startupDebug('RENDERER UNRESPONSIVE'); });
  mainWindow.webContents.on('responsive', () => { crashDebug('RENDERER responsive'); startupDebug('RENDERER RESPONSIVE'); });

  // When Beehive is open but not the foreground app, don't let an otherwise
  // idle Electron renderer consume the same compositor/GPU budget that apps
  // such as Steam need for smooth scrolling. Audio playback is independent of
  // the renderer frame rate, so this does not affect music playback. Restore
  // the normal frame rate as soon as Beehive regains focus.
  try {
    mainWindow.webContents.setFrameRate(30);
    mainWindow.on('focus', () => {
      try { mainWindow.webContents.setFrameRate(60); } catch {}
    });
    mainWindow.on('blur', () => {
      try { mainWindow.webContents.setFrameRate(30); } catch {}
    });
  } catch {}

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelName = Number(level) >= 3 ? 'ERROR' : Number(level) === 2 ? 'WARN' : Number(level) === 1 ? 'INFO' : 'DEBUG';
    writeSession(levelName, 'RENDERER', String(message), { line, sourceId });
    if (Number(level) >= 2 && !CONSOLE_NOISE.some(re => re.test(String(message)))) {
      try { RAW_CONSOLE[levelName === 'ERROR' ? 'error' : 'warn'](`[Renderer] ${String(message)}`); } catch {}
    }
    // Renderer INFO/DEBUG console traffic is fully preserved in the session log,
    // but does not belong in the live terminal. WARN/ERROR entries remain visible
    // there and are also recorded in the same session file.
    if (STARTUP_DEBUG_ENABLED && Number(level) >= 2) {
      startupDebug('RENDERER CONSOLE ERROR', { level, message, line, sourceId });
    }
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    writeSession('ERROR', 'PRELOAD', 'Renderer preload error', { preloadPath, error: String(error?.stack || error?.message || error) });
    if (STARTUP_DEBUG_ENABLED) startupDebug('RENDERER PRELOAD ERROR', { preloadPath, error: String(error?.stack || error?.message || error) });
  });
  mainWindow.webContents.on('did-start-loading', () => startupDebug('RENDERER did-start-loading'));
  mainWindow.webContents.on('dom-ready', () => startupDebug('RENDERER dom-ready'));
  mainWindow.webContents.on('did-finish-load', () => startupDebug('RENDERER did-finish-load'));
  mainWindow.webContents.on('did-stop-loading', () => startupDebug('RENDERER did-stop-loading'));
  mainWindow.loadFile(runtimeResourcePath(path.join('app','renderer','index.html')), {
    query: preservePlayback ? { preservePlayback: '1' } : undefined
  });
  startupDebug('WINDOW CREATE COMPLETE', { webContentsId:mainWindow.webContents.id });
}

app.on('child-process-gone', (_event, details) => {
  crashDebug('CHILD PROCESS gone', details);
  const type = String(details?.type || '').toLowerCase();
  const reason = String(details?.reason || '').toLowerCase();
  const exitCode = Number(details?.exitCode);
  const isGpuCrash = type === 'gpu' || type === 'gpu-process' || type.includes('gpu');
  const crashed = reason === 'crashed' || reason === 'abnormal-exit' || exitCode === 139 || exitCode >= 128;
  if (process.platform === 'linux' && isGpuCrash && crashed && !gpuCrashFallbackRecorded) {
    gpuCrashFallbackRecorded = true;
    /* Do not silently persist a software-rendering choice. Hardware
     * acceleration is the normal Electron path and the settings UI already
     * gives the user an explicit opt-out. Record the crash for diagnostics,
     * but let the next launch use the same user-selected graphics setting. */
    crashDebug('GPU PROCESS CRASHED', 'Hardware acceleration remains unchanged; the next launch will honor the user graphics setting.');
  }
});

app.on('before-quit', () => {
  // User-owned JSON is mirrored into the in-project backup as it is written.
  // Do not recursively copy the entire profile on the close path: a large
  // library/profile made the X button block the BrowserWindow while fs.cpSync
  // walked and copied every file. The stable profile itself remains the source
  // of truth, and playback-state writes are persisted before shutdown.
  writeSession('INFO', 'SESSION', 'Session ending', { uptimeMs: Math.round(process.uptime()*1000) });
  flushSessionLogSync();
});

app.on('before-quit', () => {
  startupDebug('APP BEFORE QUIT');
  stopStartupProfiler('before-quit');
  try { mpris.stop(); } catch {}
  try { discordPresence.stop(); } catch {}
  try { artworkProxy.stop(); } catch {}
  try { gstreamerBridge.requestQuit(); } catch {}
  try {
    for (const worker of tagReaderWorkers) {
      if (!worker) continue;
      for (const p of worker.pending.values()) p.reject(new Error('Beehive is shutting down.'));
      worker.proc?.kill();
    }
  } catch {}
  try { databaseProcess?.kill(); } catch {}
});

app.whenReady().then(async () => {
  // Backfill play 'source' provenance ('import' vs. 'hive') onto Wrapped
  // Data written before that field existed, using the same signal a MusicBee
  // archive vs. a native Hive play always differs on: fileUrl is a foreign
  // path (the machine MusicBee ran on) for an import, or this machine's own
  // real local file path for a native play. yearly-wrap:replacePlayCounts
  // needs this to tell "only ever played natively" apart from "actually in
  // the imported archive" -- see getMusicBeeImportedPlayCounts.
  try {
    const root = HIVE_WRAPPED_DATA_ROOT();
    if (root && fs.existsSync(root)) {
      const years = fs.readdirSync(root).filter(n => /^\d+$/.test(n)).map(Number);
      for (const year of years) {
        const stored = await readMusicBeeStoredYear(root, year);
        if (!stored?.plays?.length) continue;
        if (stored.plays.every(p => p.source === 'import' || p.source === 'hive')) continue;
        const backfilled = stored.plays.map(p => p.source === 'import' || p.source === 'hive'
          ? p
          : { ...p, source: path.isAbsolute(String(p.fileUrl || '')) ? 'hive' : 'import' });
        await writeMusicBeeYearStore(root, year, backfilled);
      }
    }
  } catch (err) {
    startupDebug('WRAPPED DATA PROVENANCE BACKFILL FAILED', { message: err?.message || String(err) });
  }

  // A previous build could have left an automatic GPU fallback marker in the
  // profile. It is no longer a persistent setting, so clear that recovery
  // marker while preserving an explicit user disable if one exists.
  try {
    const config = await readJsonSafe(CONFIG_PATH(), {});
    if (config?.gpuAccelerationAutoDisabled === true) {
      delete config.gpuAccelerationAutoDisabled;
      delete config.gpuAccelerationAutoDisabledAt;
      delete config.disableGpuAcceleration;
      await writeJsonSafe(CONFIG_PATH(), config);
      startupDebug('GPU AUTOMATIC FALLBACK CLEARED', 'Hardware acceleration restored as the default graphics path.');
    }
  } catch (err) {
    startupDebug('GPU FALLBACK CLEANUP FAILED', { message: err?.message || String(err) });
  }

  // POST-SPOTIFY 1.0: leave the Spotify bridge completely dormant on the
  // stable line. The implementation remains intact for a later resume.
  if (!SPOTIFY_DEVELOPMENT_PAUSED) {
    // Spotify is an optional integration. A bridge startup problem must never
    // reject the app.whenReady() handler or prevent the core Hive window from booting.
    try { startSpotifyBridge(); } catch (err) {
      console.warn('[Hive] Spotify bridge startup skipped:', err?.message || String(err));
      startupDebug('SPOTIFY BRIDGE STARTUP SKIPPED', { message: err?.message || String(err) });
    }
  } else {
    startupDebug('SPOTIFY DEVELOPMENT PAUSED');
  }
  startupDebug('APP READY');
  // Absolute local file streaming (audio). Handle HTTP byte ranges explicitly so
  // Chromium's media element can seek reliably instead of falling back to 0.
  protocol.handle('mbfile', async (request) => {
    try {
      const filePath = path.resolve(decodePath(request.url, 'mbfile://'));
      const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
      const folders = resolveConfigFolders(config);
      if (!folders.some(folder => isPathInsideFolder(filePath, folder))) {
        return new Response('Forbidden', { status: 403 });
      }
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });

      const size = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const mime = ({
        '.mp3':'audio/mpeg', '.flac':'audio/flac', '.m4a':'audio/mp4',
        '.mp4':'audio/mp4', '.ogg':'audio/ogg', '.opus':'audio/ogg',
        '.wav':'audio/wav', '.aac':'audio/aac', '.wma':'audio/x-ms-wma'
      })[ext] || 'application/octet-stream';
      const baseHeaders = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      };

      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } });
      }

      const range = request.headers.get('range');
      if (!range) {
        return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
          status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) }
        });
      }

      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) return new Response('Invalid Range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });

      let start;
      let end;
      if (match[1] === '') {
        const suffix = Number(match[2]);
        if (!Number.isFinite(suffix) || suffix <= 0) return new Response('Invalid Range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Number(match[2]);
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
        return new Response('Invalid Range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      const length = end - start + 1;
      return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(length),
          'Content-Range': `bytes ${start}-${end}/${size}`
        }
      });
    } catch (err) {
      return new Response(`Not found: ${err.message}`, { status: 404 });
    }
  });

  // Cached cover art, stored under userData/covers/<hash>.<ext>
  ipcMain.handle('gstreamer:status', () => gstreamerStatus());
ipcMain.handle('audio:validate', async (_evt, trackPath) => validateAudioForPlayback(trackPath));
ipcMain.handle('audio:integrity-scan', async (evt, paths = []) => scanAudioIntegrityLibrary(paths, evt.sender));
ipcMain.handle('audio:integrity-scan-cancel', async () => cancelAudioIntegrityScan());
ipcMain.handle('audio:integrity-scan-checkpoint', async () => getAudioIntegrityScanCheckpoint());
ipcMain.handle('audio:integrity-scan-resume', async (evt) => resumeAudioIntegrityScan(evt.sender));
ipcMain.handle('audio:integrity-scan-start-over', async () => { await clearAudioIntegrityScanCheckpoint(); return { status:'cleared' }; });
ipcMain.handle('audio:integrity-repair-love', async (evt, items = []) => repairLoveMetadataFiles(items, evt.sender));
ipcMain.handle('audio:integrity-repair-corrupt', async (evt, item = {}) => repairCorruptAudioFile(item, evt.sender));
ipcMain.handle('audio:integrity-report', async (_evt, result = null) => generateAudioIntegrityReport(result));
ipcMain.handle('audio:integrity-open-reports', async () => { await fsp.mkdir(AUDIO_INTEGRITY_REPORTS_DIR(), { recursive:true, mode:0o700 }); await shell.openPath(AUDIO_INTEGRITY_REPORTS_DIR()); return { dir:AUDIO_INTEGRITY_REPORTS_DIR() }; });
ipcMain.handle('audio:first-scan-integrity-state', async () => readFirstLibraryIntegrityAuditState());
ipcMain.handle('diagnostics:openCrashReports', async () => {
  const dir = app.getPath('crashDumps');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await shell.openPath(dir);
  return { dir };
});
ipcMain.handle('diagnostics:crashReportCount', async () => {
  const dir = app.getPath('crashDumps');
  try {
    const entries = await fsp.readdir(dir);
    return { dir, count: entries.length };
  } catch {
    return { dir, count: 0 };
  }
});
// Check-then-ask only: these never download or install without the explicit
// user action each handler name describes (see update-checker.js).
ipcMain.handle('updates:check', async () => updateChecker.check());
ipcMain.handle('updates:download', async () => updateChecker.download());
ipcMain.handle('updates:install', async () => { updateChecker.quitAndInstall(); return true; });
ipcMain.handle('updates:status', async () => updateChecker.getStatus());
updateChecker.onStatus(status => {
  try { mainWindow?.webContents?.send('updates:statusChanged', status); } catch {}
});
  ipcMain.handle('gstreamer:restart', () => restartGstreamerProcess());
  ipcMain.on('gstreamer:command', (_evt, command) => {
    if (GSTREAMER_TRACE_ENABLED) writeSession('DEBUG', 'GSTREAMER', `RENDERER_COMMAND ${String(command || '').replace(/\n/g, '')}`);
    sendGstreamerCommand(command);
  });

  // Spotify provider artwork is derived cache data. It is never embedded into
  // local music files and does not retain decoded DOM Image objects.
  ipcMain.handle('spotify:cacheArtwork', async (_evt, urls) => {
    const list = [...new Set((Array.isArray(urls) ? urls : []).map(v => String(v || '').trim()).filter(Boolean))].slice(0, 1000);
    const results = {};
    const root = COVERS_DIR();
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    const safeHost = host => host === 'i.scdn.co' || host.endsWith('.scdn.co');
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) {
        const url = list[cursor++];
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' || !safeHost(parsed.hostname.toLowerCase())) continue;
          const key = crypto.createHash('sha1').update(parsed.toString()).digest('hex');
          const existing = await fsp.readdir(root);
          const candidates = existing.filter(name => name.startsWith(`${key}.`));
          if (candidates.length) { results[url] = candidates[0]; continue; }
          const response = await net.fetch(parsed.toString(), { headers: { 'User-Agent': 'Hive/1.0 (Spotify artwork cache)' } });
          if (!response.ok) continue;
          const contentLength = Number(response.headers.get('content-length') || 0);
          if (contentLength > 8 * 1024 * 1024) continue;
          const buffer = Buffer.from(await response.arrayBuffer());
          if (!buffer.length || buffer.length > 8 * 1024 * 1024) continue;
          const contentType = String(response.headers.get('content-type') || '').toLowerCase();
          const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
          const fileName = `${key}${ext}`;
          const target = path.join(root, fileName);
          try { await fsp.writeFile(target, buffer, { flag: 'wx' }); } catch (err) { if (err?.code !== 'EEXIST') throw err; }
          results[url] = fileName;
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
    return results;
  });

  protocol.handle('mbcover', async (request) => {
    try {
      const name = decodePath(request.url, 'mbcover://');
      const filePath = path.join(COVERS_DIR(), name);
      const fileUrl = pathToFileURL(filePath).toString();
      return net.fetch(fileUrl);
    } catch (err) {
      return new Response(`Not found: ${err.message}`, { status: 404 });
    }
  });

  scanLog('Beehive started', { version: app.getVersion(), userData: USER_DATA() });
  // Show the application shell before waiting on the database worker during
  // ordinary launches. The database is important for durability/recovery, but
  // it should never sit in front of the first paint on normal cached startups.
  createHiveTray();
  createWindow();
  startupDebug('WINDOW REQUESTED');
  // The artwork proxy improves Music Presence compatibility but must never make
  // MPRIS unavailable if its optional localhost listener cannot bind. MPRIS can
  // still publish file:// artwork as a bounded fallback.
  Promise.resolve()
    .then(() => artworkProxy.start())
    .catch(err => { startupDebug('MPRIS ARTWORK PROXY START FAILED', { message:err?.message || String(err) }); return 0; })
    .then(() => mpris.start())
    .then(() => startupDebug('MPRIS START COMPLETE'))
    .catch(err => startupDebug('MPRIS START FAILED', {message:err?.message}));
  if (discordPresenceConfig.loonUrl) {
    try { discordPresence.start(); } catch (err) { startupDebug('DISCORD PRESENCE START FAILED', { message: err?.message || String(err) }); }
  } else {
    startupDebug('DISCORD PRESENCE DISABLED', { reason: 'No userData/discord-presence.json loon WebSocket URL configured.' });
  }
  if (!databaseReady) {
    startupDebug('DATABASE INITIALIZATION START');
    await initializeDatabase();
    startupDebug('DATABASE INITIALIZATION COMPLETE', { ready:databaseReady });
  }
  startupDebug('LIBRARY WATCHERS START');
  // Do not await this. fs.watch(folder, {recursive:true}) is emulated on
  // Linux by walking and stat-ing the whole watched tree to register a
  // per-directory inotify watch -- on a ~30k-file library this has been
  // measured taking 40+ seconds, and since it ran inside this awaited
  // startup chain, it blocked the ENTIRE main process for that whole window
  // (freezing IPC, which is why the renderer itself reported unresponsive).
  // File-change watching can start a few seconds late without harm; the
  // window becoming interactive must not wait on it, the same way
  // artworkProxy/mpris/discordPresence above already don't.
  startLibraryWatchers()
    .then(() => startupDebug('LIBRARY WATCHERS COMPLETE', { count:libraryWatchers.size }))
    .catch(err => startupDebug('LIBRARY WATCHERS FAILED', { message:err?.message || String(err) }));
  // A silent, passive check -- this only ever updates the status IPC
  // consumers can read (see Settings > About), never shows a popup or
  // downloads anything on its own. Gated on the same reliable "actually
  // packaged" signal runtimeResourcePath() uses (see session-log.js) rather
  // than bare app.isPackaged, which a renamed portable-runtime binary (see
  // hive-launcher.sh) makes unreliable; electron-updater expects a real
  // packaged build's app-update.yml, and running this against an unpacked
  // dev checkout would just log noisy, meaningless errors every launch.
  if (!process.env.HIVE_PORTABLE_ROOT && app.isPackaged) {
    setTimeout(() => { void updateChecker.check(); }, 5000);
  }
  if (Array.isArray(recoveredMetadataJobs) && recoveredMetadataJobs.length) {
    setTimeout(() => {
      startupDebug('RECOVERED METADATA JOBS DISPATCH', { count:recoveredMetadataJobs.length });
      // A recovered job starts a fresh recovery session. The stored attempt count
      // belongs to the interrupted pre-shutdown session; carrying an exhausted count
      // (for example attempts=3 with status=retry after a crash between journal updates)
      // would skip the retry loop entirely and surface a misleading generic failure.
      const jobs = recoveredMetadataJobs.map(item => ({ ...(item.job || {}), id:item.id, attempts:0, createdAt:Number(item.createdAt||Date.now()), lastError:'' }));
      recoveredMetadataJobs = [];
      if (jobs.length) {
        scanLog('Recovering interrupted metadata jobs', { count: jobs.length });
        enqueueMetadataSave({ sender: mainWindow?.webContents }, jobs, { recovered:true });
      }
    }, 1200);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { stopSpotifyBridge(); });

app.on('window-all-closed', () => {
  stopLibraryWatchers();
  if (windowRecreateInProgress) return;
  if (process.platform !== 'darwin') app.quit();
});

// ---------- library auto-scan / filesystem watching ----------
let libraryWatchers = new Map();
let libraryWatchDebounce = null;
let libraryWatchChangedPaths = new Set();
let libraryBulkWriteIgnoreUntil = 0;
// Paths written by Beehive itself are ignored by the filesystem watcher.
// A tag edit should update the UI directly, not trigger a full library scan.
// Bulk Love writes can legitimately take longer than the normal per-file
// suppression window, so the whole bulk operation has its own watcher guard.
let libraryBulkWriteActive = false;
let libraryBulkWriteDepth = 0;
function beginLibraryBulkWrite(label = 'metadata') {
  libraryBulkWriteDepth++; libraryBulkWriteActive = true;
  libraryBulkWriteIgnoreUntil = Math.max(libraryBulkWriteIgnoreUntil, Date.now() + 10 * 60 * 1000);
  if (libraryWatchDebounce) { clearTimeout(libraryWatchDebounce); libraryWatchDebounce = null; }
  scanLog('BULK WRITE BEGIN', { label, depth: libraryBulkWriteDepth });
}
function endLibraryBulkWrite(label = 'metadata') {
  libraryBulkWriteDepth = Math.max(0, libraryBulkWriteDepth - 1);
  if (libraryBulkWriteDepth === 0) { libraryBulkWriteActive = false; libraryBulkWriteIgnoreUntil = Date.now() + 5000; }
  scanLog('BULK WRITE END', { label, depth: libraryBulkWriteDepth });
}

// Desired Love state for files currently being processed by the background metadata worker.
const libraryPendingLoveWrites = new Map();
const libraryInternalWrites = new Map();
const libraryInternalWriteDirs = new Map();
function markLibraryInternalWrite(trackPath) {
  const p = path.resolve(String(trackPath || ''));
  if (!p) return;
  const until = Date.now() + 10000;
  libraryInternalWrites.set(p, until);
  // MP3/WAV/FFmpeg writers use a temporary file and then rename it over the
  // original. The watcher can therefore report the temporary filename or a
  // directory-level rename rather than the final track path. Suppress the
  // containing directory for this short self-write window so Beehive never
  // rescans its own tag edits.
  libraryInternalWriteDirs.set(path.dirname(p), until);
}
function isLibraryInternalWrite(trackPath) {
  const p = path.resolve(String(trackPath || ''));
  const now = Date.now();
  const until = libraryInternalWrites.get(p) || 0;
  if (until && until >= now) return true;
  if (until) libraryInternalWrites.delete(p);
  const dir = path.dirname(p);
  const dirUntil = libraryInternalWriteDirs.get(dir) || 0;
  if (dirUntil && dirUntil >= now) return true;
  if (dirUntil) libraryInternalWriteDirs.delete(dir);
  return false;
}


function notifyLibraryFilesystemChange(reason = 'filesystem', changedPath = '') {
  if (changedPath) libraryWatchChangedPaths.add(path.resolve(String(changedPath)));
  if (libraryWatchDebounce) clearTimeout(libraryWatchDebounce);
  libraryWatchDebounce = setTimeout(() => {
    libraryWatchDebounce = null;
    if (!mainWindow || mainWindow.isDestroyed()) { libraryWatchChangedPaths.clear(); return; }
    const paths = [...libraryWatchChangedPaths];
    libraryWatchChangedPaths.clear();
    try { mainWindow.webContents.send('library:filesChanged', { reason, paths }); } catch {}
  }, 900);
}
function stopLibraryWatchers() {
  for (const watcher of libraryWatchers.values()) { try { watcher.close(); } catch {} }
  libraryWatchers.clear();
}
async function startLibraryWatchers() {
  stopLibraryWatchers();
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  for (const folder of resolveConfigFolders(config)) {
    if (!folder) continue;
    try { await fsp.access(folder, fs.constants.R_OK); } catch { continue; }
    try {
      const watcher = fs.watch(folder, { recursive: true }, (_eventType, filename) => {
        // A bulk Love operation may touch thousands of files and can outlive
        // the normal 10-second per-file self-write suppression. Never turn
        // those intentional writes into automatic rescans.
        if (libraryBulkWriteActive || Date.now() < libraryBulkWriteIgnoreUntil) return;
        const name = filename ? String(filename) : '';
        // Never index Beehive's private transactional media copies. Older
        // versions created these next to the music file; even if a filesystem
        // watcher reports one, it is not a library track.
        if (/\.beehive-(?:native-|love-|rating-|tags-|musicbee-)/i.test(name) || /(^|[\\/])\.beehive-tmp(?:[\\/]|$)/i.test(name)) return;
        // Node's recursive watcher reports relative paths for file changes.
        // Keep changedPath in the watcher callback's scope because it is also
        // needed after the directory-event check below.
        const changedPath = name ? path.resolve(folder, name) : '';
        // Ignore changes caused by Beehive's own tag writes; the renderer has
        // already updated that track's Love/rating state directly.
        if (changedPath && isLibraryInternalWrite(changedPath)) return;
        // Tag writers can also produce a directory-level event. During the
        // short self-write window, suppress that event as well so it cannot
        // cause a redundant full scan.
        if (!name) {
          const now = Date.now();
          const root = path.resolve(folder);
          for (const [dir, until] of libraryInternalWriteDirs) {
            if (until >= now && (dir === root || dir.startsWith(root + path.sep))) return;
            if (until < now) libraryInternalWriteDirs.delete(dir);
          }
          // Directory-only notifications are not useful for library indexing.
          // We only need to react when an actual audio file is created, removed,
          // or changed while Beehive is open.
          return;
        }
        if (!AUDIO_EXTS.has(path.extname(name).toLowerCase())) return;
        notifyLibraryFilesystemChange('audio-file', changedPath);
      });
      watcher.on('error', () => {});
      libraryWatchers.set(folder, watcher);
    } catch {}
  }
}

// ---------- IPC ----------

// Playback recovery is written synchronously on renderer shutdown so the last
// position/queue snapshot is on disk before the BrowserWindow disappears.
// The renderer also updates this file periodically while playing.
ipcMain.on('playback-state:saveSync', (_evt, state = {}) => {
  try {
    const payload = {
      version: 3,
      paths: Array.isArray(state.paths) ? state.paths.map(p => String(p || '')).filter(Boolean) : [],
      currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : -1,
      currentPath: String(state.currentPath || ''),
      position: Number.isFinite(Number(state.position)) ? Math.max(0, Number(state.position)) : 0,
      shuffle: !!state.shuffle,
      repeat: Number.isInteger(Number(state.repeat)) && Number(state.repeat) >= 0 && Number(state.repeat) <= 2 ? Number(state.repeat) : 0,
      volume: Number.isFinite(Number(state.volume)) ? Math.max(0, Math.min(1, Number(state.volume))) : 1,
      selectedQueueIndex: Number.isInteger(state.selectedQueueIndex) ? state.selectedQueueIndex : -1,
      selectedIndices: Array.isArray(state.selectedIndices) ? state.selectedIndices.filter(Number.isInteger) : [],
      wasPlaying: !!state.wasPlaying,
      savedAt: Date.now()
    };
    const target = PLAYBACK_STATE_PATH();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    _evt.returnValue = true;
  } catch (err) {
    try { _evt.returnValue = false; } catch {}
    console.warn('Beehive playback-state save failed:', err);
  }
});
ipcMain.handle('playback-state:get', async () => readJsonSafe(PLAYBACK_STATE_PATH(), null));
ipcMain.on('playback:protectPath', (_evt, trackPath) => { setPlaybackProtectedPath(trackPath); });
ipcMain.on('playback-state:updateTransportSync', (_evt, state = {}) => {
  try {
    const target = PLAYBACK_STATE_PATH();
    const existing = readJsonSafe(target, {}) || {};
    const payload = {
      ...existing,
      position: Number.isFinite(Number(state.position)) ? Math.max(0, Number(state.position)) : Number(existing.position || 0),
      currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : (Number.isInteger(existing.currentIndex) ? existing.currentIndex : -1),
      currentPath: state.currentPath != null ? String(state.currentPath || '') : String(existing.currentPath || ''),
      shuffle: state.shuffle == null ? !!existing.shuffle : !!state.shuffle,
      repeat: Number.isInteger(Number(state.repeat)) && Number(state.repeat) >= 0 && Number(state.repeat) <= 2 ? Number(state.repeat) : (Number.isInteger(existing.repeat) ? existing.repeat : 0),
      volume: Number.isFinite(Number(state.volume)) ? Math.max(0, Math.min(1, Number(state.volume))) : (Number.isFinite(Number(existing.volume)) ? Number(existing.volume) : 1),
      wasPlaying: state.wasPlaying == null ? !!existing.wasPlaying : !!state.wasPlaying,
      savedAt: Date.now()
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    _evt.returnValue = true;
  } catch (err) {
    try { _evt.returnValue = false; } catch {}
    console.warn('Beehive playback transport save failed:', err);
  }
});

ipcMain.on('startup:preloadEntry', () => startupDebug('PRELOAD SCRIPT ENTRY'));
ipcMain.handle('startup:debugLog', async (_evt, payload = {}) => {
  if (!PERFORMANCE_DEBUG_ENABLED) return false;
  const label = String(payload.label || 'EVENT');
  startupDebug('RENDERER ' + label, payload.details ?? null);
  return true;
});
ipcMain.handle('startup:debugState', async () => ({ enabled:STARTUP_DEBUG_ENABLED, path:STARTUP_DEBUG_ENABLED ? sessionLogPath() : null }));
ipcMain.handle('app:getVersion', async () => {
  return { version: app.getVersion(), name: 'Beehive' };
});

ipcMain.handle('config:get', async () => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  return { ...config, folders: resolveConfigFolders(config) };
});

ipcMain.handle('devices:list', async () => {
  const result = await refreshDevices({ autoMount: true });
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  const destinations = config?.androidDeviceDestinations && typeof config.androidDeviceDestinations === 'object'
    ? config.androidDeviceDestinations : {};
  return {
    ...result,
    devices: (result.devices || []).map(device => ({
      ...device,
      destinationPath: String(destinations[device.id] || '').trim() || (() => {
        // Real devices name this folder inconsistently ("SD card", "SD_Card",
        // "sdcard", "SD-Card", ...). Match "sd" and "card" with any (or no)
        // separator between them instead of requiring whitespace specifically,
        // so a real phone's "SD_Card" folder is still recognized as the SD
        // card and gets the SD-preferred default destination.
        const sd = (device.storages || []).find(storage => /\bsd[\s_-]*card\b/i.test(String(storage.name || '')) || /\bsd[\s_-]*card\b/i.test(String(storage.path || '')));
        return sd?.path ? `${sd.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/Music` : 'Music';
      })()
    }))
  };
});
ipcMain.handle('devices:setDestination', async (_evt, payload = {}) => {
  const id = String(payload?.deviceId || '').trim();
  const destinationPath = String(payload?.destinationPath || '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!id) throw new Error('Android device ID is required.');
  const parts = destinationPath.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Invalid Android destination path.');
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  config.androidDeviceDestinations = config.androidDeviceDestinations && typeof config.androidDeviceDestinations === 'object' ? config.androidDeviceDestinations : {};
  if (destinationPath) config.androidDeviceDestinations[id] = destinationPath;
  else delete config.androidDeviceDestinations[id];
  await writeJsonSafe(CONFIG_PATH(), config);
  return { ok: true, deviceId: id, destinationPath };
});
ipcMain.handle('audio-output:list', async () => listAudioOutputs());
ipcMain.handle('audio-output:set', async (_evt, deviceId = '') => {
  const id = String(deviceId || '').trim();
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  if (id) config.audioOutputDevice = id; else delete config.audioOutputDevice;
  await writeJsonSafe(CONFIG_PATH(), config);
  return { ok: true, deviceId: id, restartRequired: true };
});
ipcMain.handle('devices:sendTracks', async (evt, payload = {}) => {
  const result = await sendTracksToDevice(payload?.device || {}, Array.isArray(payload?.tracks) ? payload.tracks : [], {
    onProgress: progress => {
      try { evt.sender.send('devices:transferProgress', progress); } catch {}
    }
  });
  return result;
});

ipcMain.handle('config:saveUiState', async (_evt, uiState = {}) => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  const incoming = uiState && typeof uiState === 'object' ? uiState : {};
  config.uiState = { ...(config.uiState && typeof config.uiState === 'object' ? config.uiState : {}), ...incoming };
  await writeJsonSafe(CONFIG_PATH(), config);
  return config.uiState;
});

// Hive's own Discord Rich Presence status/control -- replaces the old
// music-presence:* handlers now that Hive publishes directly instead of
// delegating to the external Music Presence app.
ipcMain.handle('discord-presence:getSettings', async () => {
  const status = discordPresence.status();
  return {
    configured: status.configured,
    discordConnected: status.discordConnected,
    loonConnected: status.loonConnected,
    activityType: status.activityType
  };
});

ipcMain.handle('discord-presence:setActivityType', async (_evt, patch = {}) => {
  const activityType = discordPresence.setActivityType(patch?.activityType);
  return { activityType };
});

ipcMain.handle('discord-presence:restart', async () => {
  if (!discordPresenceConfig.loonUrl) return { ok: false, reason: 'Discord Rich Presence is not configured (no loon connection set up). See setup-music-presence.sh.' };
  try {
    discordPresence.stop();
    discordPresence.start();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message || 'Could not restart the Discord Rich Presence connection.' };
  }
});

ipcMain.handle('library:clearCacheNow', async () => clearLibraryCacheData({ clearCovers: true }));

ipcMain.handle('mpris:update', async (_evt, payload = {}) => {
  const p = payload || {};
  const track = p.track || null;
  const coverCandidates = [
    track?.cover,
    track?.coverFile,
    ...(Array.isArray(track?.covers) ? track.covers.map(c => c?.file) : [])
  ].map(v => String(v || '').trim()).filter(Boolean);
  let artworkPath = '';
  if (track?.path && !/^(?:https?:|spotify:)/i.test(String(track.path))) {
    mprisTrackPath = String(track.path);
    for (const coverFile of coverCandidates) {
      // Only Beehive's own cached cover filename is accepted here. Remote/data/blob
      // URLs are handled separately through artworkUrl when there is no local art.
      if (/^(?:https?:|data:|blob:|mbcover:)/i.test(coverFile)) continue;
      const candidate = path.join(COVERS_DIR(), path.basename(coverFile));
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          artworkPath = candidate;
          break;
        }
      } catch {}
    }
    // Artwork resolution is called from the MPRIS projection boundary. Do not
    // print the full candidate list on every heartbeat; it can otherwise flood
    // the terminal/session log while the player is running. Keep this diagnostic
    // globally rate-limited to at most one entry every five seconds.
    const now = Date.now();
    if (now - lastMprisArtworkLogAt >= MPRIS_ARTWORK_LOG_INTERVAL_MS) {
      lastMprisArtworkLogAt = now;
      console.info('[MPRIS] artwork resolution', {
        track: String(track.path),
        candidates: coverCandidates,
        coversDir: COVERS_DIR(),
        artworkPath
      });
    }
  } else {
    mprisTrackPath = '';
  }
  const updatePayload = {
    track,
    position:Number(p.position)||0,
    duration:Number(p.duration)||Number(track?.duration)||0,
    paused:!!p.paused,
    volume:Number(p.volume),
    shuffle:!!p.shuffle,
    repeat:Number(p.repeat)||0,
    artworkUrl:String(p.artworkUrl||''),
    artworkPath
  };
  updateHiveTrayState(updatePayload);
  try { void discordPresence.update(updatePayload); } catch (err) { startupDebug('DISCORD PRESENCE UPDATE FAILED', { message: err?.message || String(err) }); }
  return mpris.update(updatePayload);
});

ipcMain.handle('stats:getEmbedPlayCounts', async () => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  // Embedding is on by default; only an explicit false (the user turned it
  // off) should disable it. A profile that has never touched this setting
  // has config.embedPlayCounts === undefined, which must read as enabled.
  return config.embedPlayCounts !== false;
});

ipcMain.handle('stats:setEmbedPlayCounts', async (_evt, enabled) => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  config.embedPlayCounts = !!enabled;
  await writeJsonSafe(CONFIG_PATH(), config);
  return config.embedPlayCounts;
});

ipcMain.handle('graphics:getGpuAcceleration', async () => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  return config.disableGpuAcceleration !== true;
});

ipcMain.handle('custom-css:get', async () => {
  try {
    const css = await fsp.readFile(CUSTOM_CSS_PATH(), 'utf8');
    return { enabled: true, css, path: CUSTOM_CSS_PATH() };
  } catch (err) {
    if (err?.code === 'ENOENT') return { enabled: false, css: '', path: CUSTOM_CSS_PATH() };
    throw err;
  }
});

ipcMain.handle('custom-css:set', async (_evt, payload = {}) => {
  const css = String(payload?.css || '');
  if (Buffer.byteLength(css, 'utf8') > 1024 * 1024) throw new Error('Custom CSS must be 1 MB or smaller.');
  if (!css.trim()) {
    try { await fsp.unlink(CUSTOM_CSS_PATH()); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    return { enabled: false, css: '', path: CUSTOM_CSS_PATH() };
  }
  await fsp.mkdir(USER_DATA(), { recursive: true });
  await fsp.writeFile(CUSTOM_CSS_PATH(), css, 'utf8');
  return { enabled: true, css, path: CUSTOM_CSS_PATH() };
});

ipcMain.handle('custom-css:choose', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CSS stylesheets', extensions: ['css'] }]
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true, enabled: false, css: '' };
  const source = res.filePaths[0];
  const stat = await fsp.stat(source);
  if (!stat.isFile()) throw new Error('The selected CSS path is not a file.');
  if (stat.size > 1024 * 1024) throw new Error('Custom CSS must be 1 MB or smaller.');
  const css = await fsp.readFile(source, 'utf8');
  await fsp.mkdir(USER_DATA(), { recursive: true });
  await fsp.writeFile(CUSTOM_CSS_PATH(), css, 'utf8');
  return { canceled: false, enabled: true, css, path: CUSTOM_CSS_PATH(), sourcePath: source };
});

ipcMain.handle('custom-css:clear', async () => {
  try { await fsp.unlink(CUSTOM_CSS_PATH()); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  try { await fsp.unlink(THEME_META_PATH()); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  return { enabled: false, css: '', path: CUSTOM_CSS_PATH() };
});

ipcMain.handle('theme:import', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties:['openFile'], filters:[{ name:'Hive theme', extensions:['hive-theme','json','css'] }] });
  if (res.canceled || !res.filePaths[0]) return { canceled:true };
  const source=res.filePaths[0];
  const text=await fsp.readFile(source,'utf8');
  let name=path.basename(source,path.extname(source)); let css=text;
  if (path.extname(source).toLowerCase() !== '.css') {
    const pack=JSON.parse(text); css=String(pack?.css||''); name=String(pack?.name||name);
    if (!css.trim()) throw new Error('Theme pack does not contain CSS.');
  }
  if (Buffer.byteLength(css,'utf8') > 1024*1024) throw new Error('Theme CSS must be 1 MB or smaller.');
  await fsp.writeFile(CUSTOM_CSS_PATH(), css, 'utf8');
  await fsp.writeFile(THEME_META_PATH(), JSON.stringify({name, importedAt:Date.now(), source:path.basename(source)}, null, 2), 'utf8');
  return { canceled:false, enabled:true, css, name, source };
});

ipcMain.handle('theme:export', async (_evt, payload={}) => {
  const css=String(payload?.css||''); if (!css.trim()) throw new Error('There is no custom theme CSS to export.');
  const res=await dialog.showSaveDialog(mainWindow,{ defaultPath:String(payload?.name||'Hive Theme') .replace(/[^a-z0-9 _-]+/gi,'').trim()||'Hive Theme', filters:[{name:'Hive theme',extensions:['hive-theme']}] });
  if (res.canceled || !res.filePath) return { canceled:true };
  const name=String(payload?.name||'Hive Theme').trim()||'Hive Theme';
  await fsp.writeFile(res.filePath, JSON.stringify({format:'hive-theme',version:1,name,css},null,2),'utf8');
  return { canceled:false, path:res.filePath };
});

// A themes folder the user can just drop .hive-theme packs into, rather than
// requiring the file-picker Import flow every time. Same on-disk format
// theme:export already writes, so a pack exported from Hive (or shared by
// someone else) drops straight in and shows up.
const THEMES_DIR = () => path.join(USER_DATA(), 'themes');
ipcMain.handle('themes:list', async () => {
  const dir = THEMES_DIR();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return { dir, themes: [] }; }
  const themes = [];
  for (const file of entries) {
    if (!file.toLowerCase().endsWith('.hive-theme')) continue;
    try {
      const text = await fsp.readFile(path.join(dir, file), 'utf8');
      const pack = JSON.parse(text);
      const css = String(pack?.css || '');
      if (!css.trim()) continue;
      themes.push({ file, name: String(pack?.name || path.basename(file, '.hive-theme')), css, stock: !!pack?.stock });
    } catch { /* skip an unreadable/invalid pack rather than fail the whole list */ }
  }
  themes.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, themes };
});
ipcMain.handle('themes:openFolder', async () => {
  const dir = THEMES_DIR();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await shell.openPath(dir);
  return { dir };
});
// Writes Hive's built-in themes into the themes folder as ordinary
// .hive-theme packs, so a user who opens the folder can see/copy/edit them
// like any other theme instead of finding it empty. Never overwrites a file
// that already exists there -- a stock theme the user has started editing
// (or simply not touched) keeps whatever is on disk.
ipcMain.handle('themes:seedStock', async (_evt, themes = []) => {
  const dir = THEMES_DIR();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  let seeded = 0;
  for (const theme of Array.isArray(themes) ? themes : []) {
    const file = String(theme?.file || '').trim();
    const name = String(theme?.name || '').trim();
    const css = String(theme?.css || '');
    if (!file || !/^[a-z0-9-]+\.hive-theme$/i.test(file) || !name || !css.trim()) continue;
    const target = path.join(dir, file);
    try { await fsp.access(target); continue; } catch {}
    try {
      // stock:true marks this as a seeded copy of a built-in theme rather
      // than a user-authored one, so the dropdown (which already lists the
      // built-in by name) can skip it unless its css no longer matches the
      // canonical built-in -- i.e. the user has actually edited it.
      await fsp.writeFile(target, JSON.stringify({ format: 'hive-theme', version: 1, name, css, stock: true }, null, 2), 'utf8');
      seeded++;
    } catch {}
  }
  return { dir, seeded };
});

ipcMain.handle('theme:meta', async () => readJsonSafe(THEME_META_PATH(), {name:'Custom CSS'}));

const PLUGIN_STATE_DIR = () => path.join(USER_DATA(), 'plugin-state');
async function pluginStatePath(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  await fsp.mkdir(PLUGIN_STATE_DIR(), { recursive:true, mode:0o700 });
  return path.join(PLUGIN_STATE_DIR(), `${safe}.json`);
}

ipcMain.handle('plugins:list', async () => {
  const dir=PLUGINS_DIR(); await fsp.mkdir(dir,{recursive:true,mode:0o700});
  // The first-party Monstercat Visualizer plugin (previously auto-seeded here
  // from resources/hive-plugins/monstercat-visualizer) was removed -- it never
  // worked under this app's CSP (see plugins:run below: it executes plugin
  // code via `new Function(...)`, which requires 'unsafe-eval', and the CSP
  // does not grant that). It will be rebuilt; when it returns, seed it the
  // same way: copy the bundled folder into the user plugin directory here if
  // not already present, so "Open plugins folder" remains a genuine sharing
  // surface a user can copy to another install.
  const entries=await fsp.readdir(dir,{withFileTypes:true}); const out=[]; const seen=new Set();
  const readPlugin = async (root, bundled=false) => {
    try {
      const manifest=JSON.parse(await fsp.readFile(path.join(root,'manifest.json'),'utf8'));
      if (!manifest?.id || !manifest?.name) return;
      const id=String(manifest.id); if(seen.has(id)) return;
      const cssPath=path.join(root,'style.css'); const jsPath=path.join(root,'plugin.js');
      const css=fs.existsSync(cssPath)?await fsp.readFile(cssPath,'utf8'):'';
      const js=fs.existsSync(jsPath)?await fsp.readFile(jsPath,'utf8'):'';
      const state=await readJsonSafe(await pluginStatePath(id), {});
      const enabled=typeof state.enabled==='boolean' ? state.enabled : manifest.enabledByDefault !== false;
      out.push({id,name:String(manifest.name),version:String(manifest.version||'1.0.0'),description:String(manifest.description||''),author:String(manifest.author||''),css:css.slice(0,1024*1024),js:js.slice(0,512*1024),permissions:Array.isArray(manifest.permissions)?manifest.permissions:[],settings:Array.isArray(manifest.settings)?manifest.settings:[],icon:String(manifest.icon||''),apiVersion:Number(manifest.apiVersion||1),dir:root,bundled:!!bundled,enabled});
      seen.add(id);
    } catch (err) { console.warn('[Plugins] Could not load',path.basename(root),err?.message||err); }
  };
  for (const entry of entries) { if (entry.isDirectory()) await readPlugin(path.join(dir,entry.name), false); }
  // First-party Monstercat is seeded into the same user plugin directory as community plugins.
  return {dir,plugins:out};
});

const PLUGIN_SETTINGS_DIR = () => path.join(USER_DATA(), 'plugin-settings');

async function pluginSettingsPath(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  await fsp.mkdir(PLUGIN_SETTINGS_DIR(), { recursive:true, mode:0o700 });
  return path.join(PLUGIN_SETTINGS_DIR(), `${safe}.json`);
}

ipcMain.handle('plugins:setEnabled', async (_evt, payload={}) => {
  const id=String(payload?.id||''); if(!id) throw new Error('Plugin id is required.');
  const file=await pluginStatePath(id);
  await fsp.writeFile(file, JSON.stringify({enabled:!!payload?.enabled}, null, 2), 'utf8');
  return {id, enabled:!!payload?.enabled};
});

ipcMain.handle('plugins:getSettings', async (_evt, payload={}) => {
  const file = await pluginSettingsPath(payload?.id);
  return await readJsonSafe(file, {});
});

ipcMain.handle('plugins:setSettings', async (_evt, payload={}) => {
  const id = String(payload?.id || '');
  if (!id) throw new Error('Plugin id is required.');
  const file = await pluginSettingsPath(id);
  const settings = payload?.settings && typeof payload.settings === 'object' ? payload.settings : {};
  await fsp.writeFile(file, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
});

ipcMain.handle('plugins:openFolder', async () => { const dir=PLUGINS_DIR(); await fsp.mkdir(dir,{recursive:true,mode:0o700}); await shell.openPath(dir); return {dir}; });


ipcMain.handle('plugins:run', async (_evt, payload={}) => {
  const source=String(payload?.source||''); const id=String(payload?.id||'plugin');
  if(source.length>512*1024) throw new Error('Plugin script exceeds the 512 KB limit.');
  if(!mainWindow || mainWindow.isDestroyed()) return false;
  const encoded=JSON.stringify(source);
  const encodedId=JSON.stringify(id.replace(/[^a-zA-Z0-9._-]/g,'_'));
  await mainWindow.webContents.executeJavaScript(`(function(){try{const fn=new Function('Hive', ${encoded}); return Promise.resolve(fn(window.HivePlugin)).catch(()=>false);}catch(e){console.warn('[Hive Plugin]', ${encodedId}, e); return false;}})()`, true);
  return true;
});

ipcMain.handle('plugins:installFolder', async () => {
  const res=await dialog.showOpenDialog(mainWindow,{properties:['openDirectory']}); if(res.canceled||!res.filePaths[0]) return {canceled:true};
  const source=path.resolve(res.filePaths[0]); const manifestPath=path.join(source,'manifest.json');
  const manifest=JSON.parse(await fsp.readFile(manifestPath,'utf8'));
  if(!/^[a-zA-Z0-9._-]{1,80}$/.test(String(manifest?.id||''))) throw new Error('Plugin manifest id must contain only letters, numbers, dots, underscores, and dashes.');
  // Plugins are a trusted-local extension model, not a sandbox (see
  // docs/PLUGIN_API.md): installed code runs with the same permissions as
  // Hive itself. That must be disclosed at the moment of installing, not
  // only in documentation the user may never read -- a native dialog here,
  // naming the actual plugin and its declared permissions, so the user makes
  // an informed decision before anything is copied into the plugins folder.
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.filter(Boolean) : [];
  const confirmChoice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Install plugin'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Install plugin?',
    message: `Install "${String(manifest.name || manifest.id)}"?`,
    detail: `Plugins are trusted local code, not sandboxed: this plugin can run with the same permissions as Hive itself, including anything exposed by Hive's own plugin API. Only install plugins from sources you trust.\n\nAuthor: ${String(manifest.author || 'Unknown')}\nDeclared permissions: ${permissions.length ? permissions.join(', ') : 'none declared'}`,
  });
  if (confirmChoice.response !== 1) return { canceled: true };
  const target=path.join(PLUGINS_DIR(),String(manifest.id)); await fsp.mkdir(PLUGINS_DIR(),{recursive:true,mode:0o700});
  await fsp.rm(target,{recursive:true,force:true}); await fsp.cp(source,target,{recursive:true,filter:(src)=>!src.includes(path.sep+'.git'+path.sep)&&!src.endsWith(path.sep+'.git')});
  return {canceled:false,id:String(manifest.id),dir:target};
});

ipcMain.handle('scrobble:status', async () => scrobbling.status());
// status() deliberately strips credentials down to booleans (safe to poll
// often). Settings needs the actual saved values so reopening it doesn't
// look like nothing was ever configured -- see scrobble:config's renderer
// caller for the bug this fixes.
ipcMain.handle('scrobble:config', async () => scrobbling.config());
ipcMain.handle('scrobble:save', async (_evt, patch={}) => scrobbling.save(patch));
ipcMain.handle('scrobble:lastfmBegin', async () => scrobbling.beginLastFmAuth());
ipcMain.handle('scrobble:lastfmFinish', async () => scrobbling.finishLastFmAuth());
ipcMain.handle('scrobble:started', async (_evt, track={}) => { scrobbling.trackStarted(track); await scrobbling.sendNowPlaying(track); return true; });
ipcMain.handle('scrobble:nowPlaying', async (_evt, track={}) => scrobbling.sendNowPlaying(track));
ipcMain.handle('scrobble:submit', async (_evt, track={}) => scrobbling.submit(track));
ipcMain.handle('music:similarArtists', async (_evt, artistName) => scrobbling.getSimilarArtists(artistName));

ipcMain.handle('graphics:setGpuAcceleration', async (_evt, enabled) => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  config.disableGpuAcceleration = !enabled;
  await writeJsonSafe(CONFIG_PATH(), config);
  return config.disableGpuAcceleration !== true;
});

ipcMain.handle('config:addFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  const folder = res.filePaths[0];
  if (!config.folders.some(existing => resolveConfiguredFolder(existing) === path.resolve(folder))) config.folders.push(serializePortableFolder(folder));
  await writeJsonSafe(CONFIG_PATH(), config);
  await startLibraryWatchers();
  return config;
});

ipcMain.handle('config:removeFolder', async (_evt, folder) => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  config.folders = config.folders.filter((f) => resolveConfiguredFolder(f) !== path.resolve(String(folder || '')));
  await writeJsonSafe(CONFIG_PATH(), config);
  await startLibraryWatchers();
  return config;
});

function isPathInsideFolder(filePath, folderPath) {
  const file = path.resolve(String(filePath || ''));
  const folder = path.resolve(String(folderPath || ''));
  if (!file || !folder) return false;
  const rel = path.relative(folder, file);
  return rel === '' || (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Security-audit finding, fixed before 1.0: tracks:deleteFromDisk and the
// mbfile:// protocol handler already reject a path outside every configured
// library folder, but the metadata/artwork write handlers below (writeTags,
// writeArtwork, modifyArtwork, removeArtwork, removeFrontArtwork, and the
// metadata:saveBatch queue) only checked that the file existed -- so any
// track record pointing outside config.folders (e.g. via an imported
// playlist referencing an external file) could have its file silently
// rewritten by an ordinary Love/Rating/Tag-Editor/Auto-Tag write. Same
// isPathInsideFolder() check, same config.folders source of truth.
async function isTrackPathAllowedInLibrary(trackPath) {
  const resolved = path.resolve(String(trackPath || ''));
  if (!resolved) return false;
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  const folders = Array.isArray(config.folders) ? config.folders.map(f => path.resolve(String(f || ''))).filter(Boolean) : [];
  return folders.some(folder => isPathInsideFolder(resolved, folder));
}
const LIBRARY_BOUNDARY_ERROR = 'File is outside a configured Beehive library folder.';

ipcMain.on('files:startDrag', (evt, filePaths = []) => {
  const paths = Array.from(new Set((Array.isArray(filePaths) ? filePaths : [filePaths]).map(p => String(p || '')).filter(Boolean)))
    .filter(p => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } });
  if (!paths.length) return;
  try {
    // Electron's native file drag exposes the real filesystem paths to the OS,
    // which lets targets such as Discord, a DAW, Nautilus, etc. receive the
    // actual music files instead of a web URL.
    evt.sender.startDrag({
      files: paths,
      icon: nativeImage.createEmpty()
    });
  } catch (err) {
    crashDebug('Native file drag failed', { message: err?.message || String(err) });
  }
});

ipcMain.handle('file:showInBrowser', async (_evt, filePath) => {
  const target = path.resolve(String(filePath || ''));
  if (!target) return { ok: false, error: 'No file was specified.' };
  try {
    const st = await fsp.stat(target);
    if (!st.isFile()) return { ok: false, error: 'The selected path is not a file.' };
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('tracks:deleteFromDisk', async (_evt, filePaths = []) => {
  const requested = [...new Set((Array.isArray(filePaths) ? filePaths : [])
    .filter(Boolean).map(p => path.resolve(String(p))))];
  if (!requested.length) return { ok: false, deleted: [], errors: [] };

  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  const folders = Array.isArray(config.folders) ? config.folders.map(f => path.resolve(String(f || ''))).filter(Boolean) : [];
  const invalid = requested.filter(p => !folders.some(folder => isPathInsideFolder(p, folder)));
  if (invalid.length) {
    return { ok: false, deleted: [], errors: invalid.map(p => ({ path: p, error: 'File is outside a configured Beehive library folder.' })) };
  }

  const existing = [];
  const missing = [];
  for (const p of requested) {
    try {
      const st = await fsp.stat(p);
      if (!st.isFile() || !AUDIO_EXTS.has(path.extname(p).toLowerCase())) {
        missing.push({ path: p, error: 'The selected path is not a supported audio file.' });
      } else {
        existing.push(p);
      }
    } catch (err) {
      missing.push({ path: p, error: err?.message || 'File could not be accessed.' });
    }
  }
  if (!existing.length) return { ok: false, deleted: [], errors: missing };


  const deleted = [];
  const errors = missing.slice();
  for (const p of existing) {
    try {
      await fsp.unlink(p);
      deleted.push(p);
    } catch (err) {
      errors.push({ path: p, error: err?.message || String(err) });
    }
  }
  return { ok: errors.length === 0, deleted, errors };
});

async function reconcileCachedLovedWithDatabase(cached) {
  if (!cached || !Array.isArray(cached.tracks) || !cached.tracks.length) return cached;
  try {
    const lovedPaths = await databaseRequest('get_loved_paths');
    const lovedSet = new Set((Array.isArray(lovedPaths) ? lovedPaths : []).map(p => path.resolve(String(p || ''))));
    for (const track of cached.tracks) {
      const key = path.resolve(String(track?.path || ''));
      if (!key) continue;
      track.loved = lovedSet.has(key);
      track.loveHydrated = true;
    }
    return cached;
  } catch (err) {
    crashDebug('DATABASE Love reconciliation skipped', { message: err?.message || String(err) });
    return cached;
  }
}

ipcMain.handle('library:getCached', async () => {
  // Fast-start transport: prefer the compressed sidecar so Electron clones a
  // small Uint8Array instead of a huge nested track object graph. The renderer
  // decompresses/parses this off the synchronous startup path.
  const fastStartAt = process.hrtime.bigint();
  try {
    const compressed = await fsp.readFile(LIBRARY_CACHE_GZIP_PATH());
    if (compressed.length) {
      startupDebug('FAST LIBRARY CACHE GZIP READY', {
        bytes: compressed.length,
        elapsedMs: Number(process.hrtime.bigint() - fastStartAt) / 1e6
      });
      // The compressed cache is a transport optimization, not the Love source
      // of truth. The renderer will receive the durable Love projection below
      // through the ordinary scan/reconciliation path.
      let lovedPaths = [];
      try { lovedPaths = await databaseRequest('get_loved_paths'); } catch (err) { crashDebug('DATABASE Love snapshot unavailable', { message: err?.message || String(err) }); }
      return { compressed: 'gzip', data: new Uint8Array(compressed), lovedPaths };
    }
  } catch {}

  const cached = await readJsonSafe(LIBRARY_CACHE_PATH(), null);
  if (cached && Array.isArray(cached.tracks) && cached.tracks.length) {
    startupDebug('FAST LIBRARY CACHE READY', {
      tracks: cached.tracks.length,
      elapsedMs: Number(process.hrtime.bigint() - fastStartAt) / 1e6
    });
    return await reconcileCachedLovedWithDatabase(cached);
  }

  try {
    const db = await databaseRequest('get_library');
    if (db && Array.isArray(db.tracks) && db.tracks.length) return db;
  } catch (err) { crashDebug('DATABASE cache read failed', { message: err.message }); }
  return cached;
});

async function walk(dir, out, onDirectory = null, state = { directories: 0 }) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    scanLog('WALK ERROR', { dir, error: err?.message || String(err) });
    return;
  }
  state.directories++;
  try { onDirectory?.(state.directories, dir); } catch {}
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^\.beehive-tmp$/i.test(entry.name)) continue;
      await walk(full, out, onDirectory, state);
    } else {
      if (/\.beehive-(?:native-|love-|rating-|tags-|musicbee-)/i.test(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTS.has(ext)) out.push(full);
    }
  }
}

async function ensureMM() {
  if (!mm) mm = await import('music-metadata');
  return mm;
}

async function extractAndCacheCovers(pictures) {
  if (!pictures || !pictures.length) return [];
  const seen = new Set();
  const out = [];
  for (const picture of pictures) {
    if (!picture || !picture.data) continue;
    const ext = (picture.format || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const hash = crypto.createHash('sha1').update(picture.data).digest('hex');
    if (seen.has(hash)) continue; // some files repeat the same image under multiple tag frames
    seen.add(hash);
    const fileName = `${hash}.${ext}`;
    const filePath = path.join(COVERS_DIR(), fileName);
    try {
      await fsp.access(filePath);
    } catch {
      await fsp.mkdir(COVERS_DIR(), { recursive: true });
      await fsp.writeFile(filePath, picture.data);
    }
    // music-metadata gives a human-readable type like "Cover (front)" / "Cover (back)"
    out.push({ file: fileName, type: picture.type || null, hash });
  }
  // front cover first, back cover next, everything else after, in original order otherwise
  const rank = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('front')) return 0;
    if (t.includes('back')) return 1;
    return 2;
  };
  out.sort((a, b) => rank(a.type) - rank(b.type));
  return out;
}



function tagHelperPath() { return runtimeResourcePath(path.join('resources','python','tag_helper.py')); }

// Metadata writes are deliberately lower-priority than playback. Artwork edits
// can rewrite a large FLAC/MP3, so a normal-priority helper plus normal-priority
// file copy can compete with GStreamer's audio buffers and cause audible/stuttery
// playback. Background metadata jobs opt into Linux's idle I/O class and a modest
// CPU nice value. Interactive/direct tag operations retain their normal priority.
function backgroundProcessCommand(executable, args) {
  if (process.platform === 'linux') {
    return { command: 'ionice', args: ['-c', '3', 'nice', '-n', '12', executable, ...args] };
  }
  if (process.platform === 'darwin') {
    return { command: 'nice', args: ['-n', '12', executable, ...args] };
  }
  return { command: executable, args };
}

async function copyMetadataFile(source, destination, background = false) {
  if (!background || (process.platform !== 'linux' && process.platform !== 'darwin')) {
    await fsp.copyFile(source, destination);
    return;
  }
  const { command, args } = backgroundProcessCommand('cp', ['--reflink=auto', source, destination]);
  await new Promise((resolve, reject) => {
    const child = spawnTracked(command, args, { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `Background file copy exited with code ${code}`)));
  }).catch(async err => {
    // Some non-GNU cp implementations do not support --reflink. Preserve the
    // low-priority behavior where possible, but fall back safely to Node copy.
    await fsp.copyFile(source, destination);
  });
}

// A pool rather than a single process: tag_helper.py's stdin loop handles
// one request at a time, so every runTagHelper() call used to serialize
// behind one shared process no matter how many concurrent callers were
// waiting (e.g. the force-embed worker pool below looked 8-way parallel at
// the Node layer but was fully single-threaded underneath). Spreading
// requests across a small pool of these processes gives that concurrency
// somewhere real to go.
const TAG_HELPER_POOL_SIZE = 4;
let tagReaderSeq = 0;
const tagReaderWorkers = [];
function startTagReaderWorker(slot) {
  const existing = tagReaderWorkers[slot];
  if (existing?.proc && !existing.proc.killed) return existing;
  const script = tagHelperPath();
  if (!fs.existsSync(script)) throw new Error('Native tag helper is missing from this Beehive build.');
  const python = process.env.BEEHIVE_PYTHON || 'python3';
  const launch = backgroundProcessCommand(python, [script]);
  const proc = spawnTracked(launch.command, launch.args, { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  try { if (proc.pid) process.setPriority(proc.pid, 15); } catch {}
  const worker = { proc, pending: new Map() };
  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += String(chunk || '');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const pending = worker.pending.get(String(msg.id));
        if (!pending) continue;
        worker.pending.delete(String(msg.id));
        if (msg.ok) pending.resolve(msg.result); else pending.reject(new Error(msg.error || 'Native tag helper error'));
      } catch (err) { crashDebug('TAGREADER invalid response', { message: err.message }); }
    }
  });
  proc.stderr.on('data', chunk => { const text = String(chunk || '').trim(); if (text) crashDebug('TAGREADER stderr', text); });
  proc.on('error', err => crashDebug('TAGREADER process error', { message: err.message }));
  proc.on('exit', () => {
    for (const pending of worker.pending.values()) pending.reject(new Error('Native tag reader exited.'));
    worker.pending.clear();
    if (tagReaderWorkers[slot] === worker) tagReaderWorkers[slot] = null;
  });
  tagReaderWorkers[slot] = worker;
  return worker;
}
function pickTagReaderWorker() {
  let best = null;
  for (let slot = 0; slot < TAG_HELPER_POOL_SIZE; slot++) {
    const worker = tagReaderWorkers[slot]?.proc && !tagReaderWorkers[slot].proc.killed
      ? tagReaderWorkers[slot]
      : startTagReaderWorker(slot);
    if (!best || worker.pending.size < best.pending.size) best = worker;
  }
  return best;
}
function runTagHelper(request) {
  const worker = pickTagReaderWorker();
  const id = String(++tagReaderSeq);
  const payload = { ...request, id };
  return new Promise((resolve, reject) => {
    worker.pending.set(id, { resolve, reject });
    try { worker.proc.stdin.write(JSON.stringify(payload) + '\n'); }
    catch (err) { worker.pending.delete(id); reject(err); }
  });
}

const audioIntegrityCache = new Map();
const audioIntegrityLibraryCache = new Map();
let audioIntegrityScanState = null;
const audioIntegrityLoveCache = new Map();
const AUDIO_PREFLIGHT_SECONDS = 2;
const AUDIO_PREFLIGHT_TIMEOUT_MS = 7000;
const AUDIO_LIBRARY_SCAN_TIMEOUT_MS = 120000;
const AUDIO_LIBRARY_SCAN_CONCURRENCY = 2;

async function validateAudioForLibraryScan(trackPath, scanState = null) {
  const absolutePath = path.resolve(String(trackPath || ''));
  if (!absolutePath) return { status:'unavailable', error:'No audio file path.' };
  let stat;
  try { stat = await fsp.stat(absolutePath); }
  catch (err) { return { status:'unavailable', error:err?.message || 'File could not be accessed.' }; }
  if (!stat.isFile()) return { status:'unavailable', error:'The selected path is not a file.' };
  const key = `${absolutePath}\t${stat.size}\t${stat.mtimeMs}`;
  const cached = audioIntegrityLibraryCache.get(key);
  if (cached) return cached;
  const result = await new Promise(resolve => {
    let settled = false;
    let stderr = '';
    let child = null;
    let timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch {}
      finish({ status:'corrupt', error:`Full audio integrity scan timed out after ${AUDIO_LIBRARY_SCAN_TIMEOUT_MS / 1000} seconds.` });
    }, AUDIO_LIBRARY_SCAN_TIMEOUT_MS);
    try {
      child = spawnTracked('ffmpeg', [
        '-hide_banner', '-nostdin', '-v', 'error', '-xerror',
        '-i', absolutePath, '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-f', 'null', '-'
      ], { windowsHide:true });
      scanState?.children?.add(child);
      child.once('close', () => scanState?.children?.delete(child));
      child.once('error', () => scanState?.children?.delete(child));
      child.stderr.on('data', data => {
        stderr += data.toString();
        if (stderr.length > 16000) stderr = stderr.slice(-16000);
      });
      child.on('error', err => finish({ status:'unavailable', error:err?.message || 'ffmpeg could not be started.' }));
      child.on('close', code => {
        const detail = stderr.trim();
        if (code === 0 && !detail) finish({ status:'ok' });
        else finish({ status:'corrupt', error:detail || `Audio decoder rejected the file (ffmpeg exit ${code ?? 'unknown'}).` });
      });
    } catch (err) {
      finish({ status:'unavailable', error:err?.message || String(err) });
    }
  });
  if (result.status === 'ok' || result.status === 'corrupt') audioIntegrityLibraryCache.set(key, result);
  return result;
}


function loveValuesFromNativeTag(tag) {
  const value = tag?.value;
  const field = String(value?.description ?? value?.name ?? tag?.description ?? tag?.name ?? tag?.id ?? '').trim();
  if (!isLoveFieldName(field)) return [];
  const raw = value?.text ?? value?.value ?? value;
  const values = [];
  const collect = item => {
    if (item === null || item === undefined) return;
    if (Array.isArray(item)) { for (const child of item) collect(child); return; }
    if (Buffer.isBuffer(item) || item instanceof Uint8Array) { collect(Buffer.from(item).toString('utf8')); return; }
    if (typeof item === 'object') {
      if (item.text !== undefined) { collect(item.text); return; }
      if (item.value !== undefined) { collect(item.value); return; }
      if (item.data !== undefined && (typeof item.data === 'string' || Buffer.isBuffer(item.data) || item.data instanceof Uint8Array)) { collect(item.data); return; }
      return;
    }
    for (const piece of String(item).split('\0')) {
      const clean = piece.trim();
      if (clean) values.push(clean);
    }
  };
  collect(raw);
  return values.map(normalizeLoveValue).filter(Boolean).map((normalized, index) => ({ field, value: normalized, raw: values[index] || normalized }));
}

async function inspectLoveMetadata(trackPath) {
  try {
    const absolutePath = path.resolve(String(trackPath || ''));
    const stat = await fsp.stat(absolutePath);
    const cacheKey = `${absolutePath}\t${stat.size}\t${stat.mtimeMs}`;
    const cached = audioIntegrityLoveCache.get(cacheKey);
    if (cached) return cached;
    const meta = await (await ensureMM()).parseFile(absolutePath, { duration: false, skipCovers: true });
    const observations = [];
    for (const tagList of Object.values(meta.native || {})) {
      for (const tag of (Array.isArray(tagList) ? tagList : [])) observations.push(...loveValuesFromNativeTag(tag));
    }
    const decision = analyzeLoveValues(observations.map(item => item.value));
    const result = {
      flagged: decision.flagged,
      loved: decision.loved,
      canonicalValue: decision.canonicalValue,
      canonicalTag: CANONICAL_LOVE_TAG,
      tags: observations.map(item => ({ field: item.field, value: item.value }))
    };
    audioIntegrityLoveCache.set(cacheKey, result);
    return result;
  } catch (err) {
    return { flagged: false, loved: false, canonicalValue: '0', canonicalTag: CANONICAL_LOVE_TAG, tags: [], unavailable: err?.message || 'Metadata could not be inspected.' };
  }
}

async function repairLoveMetadataFiles(items, sender) {
  const candidates = Array.isArray(items) ? items : [];
  const results = { status: 'complete', total: candidates.length, repaired: [], failed: [] };
  for (const item of candidates) {
    const trackPath = path.resolve(String(item?.path || ''));
    if (!trackPath) continue;
    try {
      await waitForPlaybackProtectionRelease(trackPath);
      const audit = await inspectLoveMetadata(trackPath);
      if (!audit.flagged) continue;
      // The existing format-specific Love writer deliberately removes every
      // historical Beehive/MusicBee Love alias and writes exactly one canonical
      // LOVE RATING value. L always wins because inspectLoveMetadata already
      // resolves any L/U (or equivalent) conflict to Loved.
      await embedLoveInFile(trackPath, audit.loved);
      audioIntegrityLoveCache.clear();
      await updateCachedLoved([trackPath], audit.loved).catch(() => {});
      results.repaired.push({ path: trackPath, loved: audit.loved, tags: audit.tags });
      try { sender?.send('audio:integrity-repair-progress', { total: candidates.length, completed: results.repaired.length + results.failed.length, currentPath: trackPath, status: 'repaired' }); } catch {}
    } catch (err) {
      results.failed.push({ path: trackPath, error: err?.message || String(err) });
      try { sender?.send('audio:integrity-repair-progress', { total: candidates.length, completed: results.repaired.length + results.failed.length, currentPath: trackPath, status: 'failed' }); } catch {}
    }
  }
  writeSession(results.failed.length ? 'WARN' : 'INFO', 'LOVE INTEGRITY REPAIR', 'Love metadata repair complete', { total: results.total, repaired: results.repaired.length, failed: results.failed.length });
  return results;
}


const AUDIO_INTEGRITY_REPORTS_DIR = () => path.join(USER_DATA(), 'reports', 'audio-integrity');
const AUDIO_INTEGRITY_BACKUPS_DIR = () => path.join(USER_DATA(), 'reports', 'audio-integrity', 'Corrupt Audio Backups');
const AUDIO_INTEGRITY_FIRST_SCAN_STATE_PATH = () => path.join(USER_DATA(), 'audio-integrity-first-scan.json');
let lastAudioIntegrityResult = null;

async function repairCorruptAudioFile(item, sender) {
  const absolutePath = path.resolve(String(item?.path || ''));
  if (!absolutePath) throw new Error('No audio file path was supplied.');
  await waitForPlaybackProtectionRelease(absolutePath);
  const stat = await fsp.stat(absolutePath);
  if (!stat.isFile()) throw new Error('The selected path is not a file.');
  const ext = path.extname(absolutePath).toLowerCase() || '.audio';
  const token = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.hive-repair-${token}${ext}`);
  const backupPath = path.join(AUDIO_INTEGRITY_BACKUPS_DIR(), `${new Date().toISOString().replace(/[:.]/g,'-')}-${token}-${path.basename(absolutePath)}`);
  let child = null;
  try {
    await fsp.mkdir(AUDIO_INTEGRITY_BACKUPS_DIR(), { recursive:true, mode:0o700 });
    child = spawnTracked('ffmpeg', [
      '-hide_banner', '-nostdin', '-v', 'warning', '-err_detect', 'ignore_err',
      '-i', absolutePath, '-map', '0', '-c', 'copy', '-map_metadata', '0', '-y', tempPath
    ], { windowsHide:true });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); if (stderr.length > 16000) stderr = stderr.slice(-16000); });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0) throw new Error(stderr.trim() || `FFmpeg repair exited with code ${code}.`);
    const validation = await validateAudioForLibraryScan(tempPath);
    if (validation.status !== 'ok') throw new Error(`Recovered file did not pass a full integrity check. ${validation.error || ''}`.trim());
    await fsp.copyFile(absolutePath, backupPath);
    const backupHash = crypto.createHash('sha256').update(await fsp.readFile(backupPath)).digest('hex');
    await fsp.rename(tempPath, absolutePath);
    audioIntegrityLibraryCache.clear();
    audioIntegrityCache.clear();
    const result = { status:'repaired', path:absolutePath, backupPath, backupSha256:backupHash, message:'Recovered audio passed a full integrity check and replaced the original.' };
    writeSession('INFO', 'AUDIO INTEGRITY REPAIR', 'Corrupt audio repaired safely', result);
    try { sender?.send('audio:integrity-repair-progress', { ...result, status:'repaired' }); } catch {}
    return result;
  } catch (err) {
    try { await fsp.rm(tempPath, { force:true }); } catch {}
    const result = { status:'failed', path:absolutePath, error:err?.message || String(err) };
    writeSession('WARN', 'AUDIO INTEGRITY REPAIR', 'Corrupt audio repair failed', result);
    try { sender?.send('audio:integrity-repair-progress', result); } catch {}
    return result;
  }
}

function formatAudioIntegrityReport(result) {
  const scan = result && typeof result === 'object' ? result : {};
  const corrupt = Array.isArray(scan.corrupt) ? scan.corrupt : [];
  const unavailable = Array.isArray(scan.unavailable) ? scan.unavailable : [];
  const love = Array.isArray(scan.loveConflicts) ? scan.loveConflicts : [];
  const metadataIssues = Array.isArray(scan.metadataIssues) ? scan.metadataIssues : [];
  const repaired = Array.isArray(scan.repaired) ? scan.repaired : [];
  const failed = Array.isArray(scan.repairFailed) ? scan.repairFailed : [];
  const lines = [
    'Hive Audio Integrity Report',
    `Generated: ${new Date().toISOString()}`,
    `Scan started: ${scan.startedAt ? new Date(Number(scan.startedAt)).toISOString() : 'unknown'}`,
    `Scan duration: ${Number(scan.durationMs || 0)} ms`,
    '',
    'SUMMARY',
    `Total files: ${Number(scan.total || 0)}`,
    `Completed: ${Number(scan.completed || 0)}`,
    `Corrupted: ${corrupt.length}`,
    `Could not be scanned: ${unavailable.length}`,
    `Metadata inspection issues: ${metadataIssues.length}`,
    `Love metadata conflicts: ${love.length}`,
    `Repaired during this report session: ${repaired.length}`,
    `Repair failures: ${failed.length}`,
    '',
    'CORRUPTED FILES'
  ];
  if (!corrupt.length) lines.push('None.');
  corrupt.forEach((item, index) => {
    lines.push('', `--- Corrupt file ${index + 1} ---`, `File: ${item?.path || ''}`, `Format: ${path.extname(String(item?.path || '')).replace(/^\./,'').toUpperCase() || 'Unknown'}`, `Problem: ${item?.error || 'Decoder rejected the file.'}`);
  });
  lines.push('', 'FILES THAT COULD NOT BE SCANNED');
  if (!unavailable.length) lines.push('None.');
  unavailable.forEach((item, index) => lines.push('', `--- Unscannable file ${index + 1} ---`, `File: ${item?.path || ''}`, `Problem: ${item?.error || 'File could not be scanned.'}`));
  lines.push('', 'METADATA INSPECTION ISSUES');
  if (!metadataIssues.length) lines.push('None.');
  metadataIssues.forEach((item, index) => lines.push('', `--- Metadata issue ${index + 1} ---`, `File: ${item?.path || ''}`, `Problem: ${item?.error || 'Metadata could not be inspected.'}`));
  lines.push('', 'LOVE METADATA CONFLICTS');
  if (!love.length) lines.push('None.');
  love.forEach((item, index) => lines.push('', `--- Love conflict ${index + 1} ---`, `File: ${item?.path || ''}`, `Tags: ${JSON.stringify(item?.tags || [])}`, `Canonical value: ${item?.canonicalValue || ''}`));
  if (repaired.length || failed.length) {
    lines.push('', 'REPAIR RESULTS');
    repaired.forEach((item, index) => lines.push('', `--- Repaired file ${index + 1} ---`, `File: ${item?.path || ''}`, `Backup: ${item?.backupPath || ''}`, `Result: ${item?.message || 'Repaired'}`));
    failed.forEach((item, index) => lines.push('', `--- Repair failure ${index + 1} ---`, `File: ${item?.path || ''}`, `Problem: ${item?.error || ''}`));
  }
  lines.push('', 'END OF REPORT', '');
  return lines.join('\n');
}

async function generateAudioIntegrityReport(result = null) {
  const report = result && typeof result === 'object' ? result : lastAudioIntegrityResult;
  if (!report) throw new Error('There is no completed Audio Integrity scan to report yet.');
  await fsp.mkdir(AUDIO_INTEGRITY_REPORTS_DIR(), { recursive:true, mode:0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(AUDIO_INTEGRITY_REPORTS_DIR(), `audio-integrity-report-${stamp}.txt`);
  await fsp.writeFile(reportPath, formatAudioIntegrityReport(report), { encoding:'utf8', mode:0o600 });
  writeSession('INFO', 'AUDIO INTEGRITY REPORT', 'Audio integrity report generated', { reportPath });
  return { path:reportPath, dir:AUDIO_INTEGRITY_REPORTS_DIR() };
}

async function readFirstLibraryIntegrityAuditState() {
  const state = await readJsonSafe(AUDIO_INTEGRITY_FIRST_SCAN_STATE_PATH(), null);
  if (!state || state.version !== 1) return null;
  return state;
}

async function writeFirstLibraryIntegrityAuditState(state) {
  const payload = { version:1, ...(state || {}), updatedAt:Date.now() };
  await writeJsonSafe(AUDIO_INTEGRITY_FIRST_SCAN_STATE_PATH(), payload);
  return payload;
}

async function maybeRunFirstLibraryIntegrityAudit(audioPaths, firstScan, sender) {
  const paths = [...new Set((Array.isArray(audioPaths) ? audioPaths : []).map(p => path.resolve(String(p || ''))).filter(Boolean))];
  if (!paths.length) return { status:'none' };
  const state = await readFirstLibraryIntegrityAuditState();
  if (state?.status === 'complete') return { status:'already-complete', reportPath:state.reportPath || '' };
  if (!firstScan && state?.status !== 'running') return { status:'not-first-scan' };
  if (audioIntegrityScanState?.running) return { status:'busy' };

  await writeFirstLibraryIntegrityAuditState({ status:'running', total:paths.length, startedAt:state?.startedAt || Date.now() });
  scanLog('FIRST LIBRARY INTEGRITY AUDIT STARTING', { total:paths.length, resumed:state?.status === 'running' });
  const result = state?.status === 'running' && await readAudioIntegrityScanCheckpoint()
    ? await resumeAudioIntegrityScan(sender)
    : await scanAudioIntegrityLibrary(paths, sender);
  if (result?.status === 'complete' && Number(result.completed || 0) >= Number(result.total || paths.length)) {
    const report = await generateAudioIntegrityReport(result);
    await writeFirstLibraryIntegrityAuditState({
      status:'complete',
      total:result.total,
      completed:result.completed,
      corrupt:result.corrupt?.length || 0,
      unavailable:result.unavailable?.length || 0,
      metadataIssues:result.metadataIssues?.length || 0,
      loveConflicts:result.loveConflicts?.length || 0,
      reportPath:report.path,
      completedAt:Date.now()
    });
    const summary = { total:result.total, corrupt:result.corrupt?.length || 0, unavailable:result.unavailable?.length || 0, metadataIssues:result.metadataIssues?.length || 0, loveConflicts:result.loveConflicts?.length || 0, reportPath:report.path };
    scanLog('FIRST LIBRARY INTEGRITY AUDIT COMPLETE', summary);
    try { sender?.send('audio:first-scan-integrity-complete', summary); } catch {}
    return { status:'complete', result, report };
  }
  await writeFirstLibraryIntegrityAuditState({ status:'running', total:result?.total || paths.length, completed:result?.completed || 0, startedAt:state?.startedAt || Date.now() });
  return result || { status:'cancelled' };
}

const AUDIO_INTEGRITY_SCAN_CHECKPOINT_PATH = () => path.join(USER_DATA(), 'audio-integrity-scan-checkpoint.json');
let audioIntegrityCheckpointWriteChain = Promise.resolve();

function writeAudioIntegrityScanCheckpoint(state) {
  // Multiple scan workers can finish close together. Serialize checkpoint writes
  // so an older snapshot can never finish its rename after a newer snapshot and
  // roll durable progress backward.
  audioIntegrityCheckpointWriteChain = audioIntegrityCheckpointWriteChain
    .catch(() => {})
    .then(() => {
      const payload = {
        version: 1,
        savedAt: Date.now(),
        total: state.total,
        completed: state.completed,
        paths: state.paths,
        completedPaths: [...state.completedPaths],
        corrupt: state.corrupt,
        unavailable: state.unavailable,
        metadataIssues: state.metadataIssues,
        loveConflicts: state.loveConflicts
      };
      return writeJsonSafe(AUDIO_INTEGRITY_SCAN_CHECKPOINT_PATH(), payload);
    });
  return audioIntegrityCheckpointWriteChain;
}

async function readAudioIntegrityScanCheckpoint() {
  const checkpoint = await readJsonSafe(AUDIO_INTEGRITY_SCAN_CHECKPOINT_PATH(), null);
  if (!checkpoint || checkpoint.version !== 1 || !Array.isArray(checkpoint.paths)) return null;
  const paths = [...new Set(checkpoint.paths.map(p => path.resolve(String(p || ''))).filter(Boolean))];
  const completedPaths = new Set((Array.isArray(checkpoint.completedPaths) ? checkpoint.completedPaths : []).map(p => path.resolve(String(p || ''))));
  if (!paths.length) return null;
  return {
    ...checkpoint,
    paths,
    completedPaths: [...completedPaths],
    completed: Math.min(paths.length, completedPaths.size),
    total: paths.length
  };
}

async function clearAudioIntegrityScanCheckpoint() {
  try { await fsp.unlink(AUDIO_INTEGRITY_SCAN_CHECKPOINT_PATH()); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
}

async function getAudioIntegrityScanCheckpoint() {
  return readAudioIntegrityScanCheckpoint();
}

async function resumeAudioIntegrityScan(sender) {
  const checkpoint = await readAudioIntegrityScanCheckpoint();
  if (!checkpoint) return { status:'none' };
  return scanAudioIntegrityLibrary(checkpoint.paths, sender, checkpoint);
}

async function scanAudioIntegrityLibrary(paths, sender, checkpoint = null) {
  if (audioIntegrityScanState?.running) return { status:'busy' };
  const uniquePaths = [...new Set((Array.isArray(paths) ? paths : []).map(p => path.resolve(String(p || ''))).filter(Boolean))];
  const checkpointPaths = checkpoint?.paths || uniquePaths;
  const completedSet = new Set((checkpoint?.completedPaths || []).map(p => path.resolve(String(p || ''))));
  const state = {
    running:true,
    cancelled:false,
    total:checkpoint ? checkpointPaths.length : uniquePaths.length,
    completed:checkpoint ? completedSet.size : 0,
    paths:checkpointPaths,
    completedPaths:completedSet,
    corrupt:Array.isArray(checkpoint?.corrupt) ? checkpoint.corrupt : [],
    unavailable:Array.isArray(checkpoint?.unavailable) ? checkpoint.unavailable : [],
    metadataIssues:Array.isArray(checkpoint?.metadataIssues) ? checkpoint.metadataIssues : [],
    loveConflicts:Array.isArray(checkpoint?.loveConflicts) ? checkpoint.loveConflicts : [],
    startedAt:Date.now(),
    sender,
    children:new Set()
  };
  audioIntegrityScanState = state;
  // Write an initial checkpoint before the first FFmpeg child starts so even an
  // interruption before file #1 completes remains explicitly recoverable.
  await writeAudioIntegrityScanCheckpoint(state).catch(err => scanLog('AUDIO INTEGRITY INITIAL CHECKPOINT FAILED', { message:err?.message || String(err) }));
  const emit = payload => { try { sender?.send('audio:integrity-scan-progress', payload); } catch {} };
  emit({ phase:'started', total:state.total, completed:state.completed, corrupt:state.corrupt.length, unavailable:state.unavailable.length, resumed:!!checkpoint });
  let cursor = 0;
  const workPaths = state.paths.filter(p => !state.completedPaths.has(p));
  const worker = async () => {
    while (!state.cancelled) {
      const index = cursor++;
      if (index >= workPaths.length) return;
      const filePath = workPaths[index];
      const result = await validateAudioForLibraryScan(filePath, state);
      const loveAudit = await inspectLoveMetadata(filePath);
      state.completed++;
      state.completedPaths.add(filePath);
      if (result.status === 'corrupt') state.corrupt.push({ path:filePath, error:String(result.error || '') });
      else if (result.status === 'unavailable') state.unavailable.push({ path:filePath, error:String(result.error || '') });
      if (loveAudit.unavailable) state.metadataIssues.push({ path:filePath, error:String(loveAudit.unavailable) });
      if (loveAudit.flagged) state.loveConflicts.push({ path:filePath, loved:loveAudit.loved, canonicalValue:loveAudit.canonicalValue, canonicalTag:loveAudit.canonicalTag, tags:loveAudit.tags });
      // Persist after every completed file. Closing/crashing Hive therefore loses
      // at most the currently-running file and never discards completed work.
      try { await writeAudioIntegrityScanCheckpoint(state); }
      catch (err) { scanLog('AUDIO INTEGRITY CHECKPOINT WRITE FAILED', { message:err?.message || String(err) }); }
      emit({ phase:'progress', total:state.total, completed:state.completed, corrupt:state.corrupt.length, unavailable:state.unavailable.length, loveConflicts:state.loveConflicts.length, currentPath:filePath, currentStatus:result.status, loveStatus:loveAudit.flagged ? 'conflict' : 'ok' });
    }
  };
  await Promise.all(Array.from({length:Math.min(AUDIO_LIBRARY_SCAN_CONCURRENCY, Math.max(1, workPaths.length || 1))}, () => worker()));
  const cancelled = state.cancelled;
  state.running = false;
  const result = { status:cancelled ? 'cancelled' : 'complete', total:state.total, completed:state.completed, corrupt:state.corrupt, unavailable:state.unavailable, metadataIssues:state.metadataIssues, loveConflicts:state.loveConflicts, durationMs:Date.now()-state.startedAt, startedAt:state.startedAt, resumed:!!checkpoint };
  if (!cancelled && state.completed >= state.total) {
    await clearAudioIntegrityScanCheckpoint().catch(err => scanLog('AUDIO INTEGRITY CHECKPOINT CLEAR FAILED', { message:err?.message || String(err) }));
  } else {
    await writeAudioIntegrityScanCheckpoint(state).catch(() => {});
  }
  audioIntegrityScanState = null;
  emit({ phase:cancelled ? 'cancelled' : 'complete', ...result });
  lastAudioIntegrityResult = result;
  writeSession('INFO', 'AUDIO INTEGRITY SCAN', cancelled ? 'Library corruption scan cancelled' : 'Library corruption scan complete', { total:result.total, completed:result.completed, corrupt:result.corrupt.length, unavailable:result.unavailable.length, loveConflicts:result.loveConflicts.length, durationMs:result.durationMs, resumed:result.resumed });
  return result;
}

function cancelAudioIntegrityScan() {
  if (!audioIntegrityScanState?.running) return false;
  audioIntegrityScanState.cancelled = true;
  for (const child of audioIntegrityScanState.children || []) { try { child.kill('SIGTERM'); } catch {} }
  return true;
}

async function validateAudioForPlayback(trackPath) {
  const absolutePath = path.resolve(String(trackPath || ''));
  if (!absolutePath) return { status:'unavailable', error:'No audio file path.' };
  let stat;
  try { stat = await fsp.stat(absolutePath); }
  catch (err) { return { status:'unavailable', error:err?.message || 'File could not be accessed.' }; }
  if (!stat.isFile()) return { status:'unavailable', error:'The selected path is not a file.' };
  const key = `${absolutePath}\t${stat.size}\t${stat.mtimeMs}`;
  const cached = audioIntegrityCache.get(key);
  if (cached) return cached;
  // Decode a short prefix in a separate process before handing the file to the
  // persistent GStreamer transport. This is deliberately asynchronous: a bad
  // file must never make the Electron renderer/main event loop hitch while we
  // discover that its decoder stream is malformed. A full-library integrity
  // sweep would be far too expensive for ~30k-track libraries, so successful
  // files are cached by path/size/mtime and each track is preflighted only when
  // Hive is about to play it. Runtime GStreamer errors remain the final safety net
  // for corruption that occurs later in a file.
  const result = await new Promise(resolve => {
    let settled = false;
    let stderr = '';
    let child = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch {}
      finish({ status:'corrupt', error:`Audio decoder preflight timed out after ${AUDIO_PREFLIGHT_TIMEOUT_MS} ms.` });
    }, AUDIO_PREFLIGHT_TIMEOUT_MS);
    try {
      child = spawnTracked('ffmpeg', [
        '-hide_banner', '-nostdin', '-v', 'error', '-xerror',
        '-t', String(AUDIO_PREFLIGHT_SECONDS), '-i', absolutePath,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-f', 'null', '-'
      ], { windowsHide:true });
      child.stderr.on('data', data => {
        stderr += data.toString();
        if (stderr.length > 12000) stderr = stderr.slice(-12000);
      });
      child.on('error', err => finish({ status:'unavailable', error:err?.message || 'ffmpeg could not be started.' }));
      child.on('close', code => {
        const detail = stderr.trim();
        if (code === 0 && !detail) finish({ status:'ok' });
        else finish({
          status: 'corrupt',
          error: detail || `Audio decoder rejected the file (ffmpeg exit ${code ?? 'unknown'}).`
        });
      });
    } catch (err) {
      finish({ status:'unavailable', error:err?.message || String(err) });
    }
  });
  if (result.status === 'ok' || result.status === 'corrupt') audioIntegrityCache.set(key, result);
  writeSession(result.status === 'corrupt' ? 'WARN' : 'DEBUG', 'AUDIO PREFLIGHT', result.status === 'corrupt' ? 'Corrupt audio detected before playback' : 'Audio preflight passed', { path:absolutePath, ...result });
  return result;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawnTracked('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(err));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.split('\n').filter(Boolean).slice(-4).join(' ') || `ffmpeg exited ${code}`)));
  });
}


function runMetaflac(args) {
  return new Promise((resolve, reject) => {
    const child = spawnTracked('metaflac', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(err));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `metaflac exited ${code}`)));
  });
}

const {
  id3Synchsafe,
  readId3Size,
  musicBeePopmValue,
  musicBeePopmByte,
  musicBeePopmStars,
  id3FrameSize,
  parseId3Frames,
  txxxDescription,
  makeId3Frame,
  makeMusicBeeLoveFrame,
  makeMusicBeePopmFrame,
  makeFMPSRatingFrame,
} = require('./id3-frames');


async function writeAndSyncReplacement(temp, target, data) {
  await fsp.writeFile(temp, data);
  const fd = await fsp.open(temp, 'r+');
  try { await fd.sync(); } finally { await fd.close(); }
  await fsp.rename(temp, target);
}

// withMusicBeeWriteLock, createMetadataTempPath, commitMetadataTemp,
// embedRatingInFile, performWriteArtwork,
// performModifyArtwork, performRemoveFrontArtwork, performRemoveArtwork,
// performWriteMetadata, and performWriteTags all now come from
// ./metadata-writer (constructed further down, once all of this file's
// dependencies they need -- runTagHelper, copyMetadataFile,
// markLibraryInternalWrite, waitForPlaybackProtectionRelease,
// normalizePictureType, readEmbeddedRating -- are defined). They are declared
// with `const` at module scope, so every reference to these names anywhere in
// this file (including from functions defined earlier in the file, like the
// legacy MusicBee MP3/WAV writers below and the play-count writer) resolves
// to the same shared implementations/lock map at call time.

async function readWavId3Tag(filePath) {
  const input = await fsp.readFile(filePath);
  if (input.length < 12 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  while (pos + 8 <= input.length) {
    const id = input.toString('ascii', pos, pos + 4);
    const size = input.readUInt32LE(pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > input.length) break;
    if (id === 'id3 ' || id === 'ID3 ') {
      const tag = input.subarray(dataStart, dataEnd);
      if (tag.length >= 10 && tag.toString('ascii', 0, 3) === 'ID3') {
        return { input, chunkPos: pos, chunkSize: size, dataStart, dataEnd, tag };
      }
    }
    pos = dataEnd + (size & 1);
  }
  return null;
}

async function readWavId3TagLight(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const header = Buffer.alloc(12);
      const hr = await fd.read(header, 0, 12, 0);
      if (hr.bytesRead < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;
      const stat = await fd.stat();
      let pos = 12;
      while (pos + 8 <= stat.size) {
        const ch = Buffer.alloc(8);
        const r = await fd.read(ch, 0, 8, pos);
        if (r.bytesRead < 8) break;
        const id = ch.toString('ascii', 0, 4);
        const size = ch.readUInt32LE(4);
        const dataStart = pos + 8;
        const dataEnd = dataStart + size;
        if (dataEnd > stat.size || dataEnd < dataStart) break;
        if ((id === 'id3 ' || id === 'ID3 ') && size >= 10 && size <= 32 * 1024 * 1024) {
          const tag = Buffer.alloc(size);
          await fd.read(tag, 0, size, dataStart);
          if (tag.toString('ascii', 0, 3) === 'ID3') return tag;
        }
        pos = dataEnd + (size & 1);
      }
    } finally { await fd.close(); }
  } catch {}
  return null;
}

async function readWavMusicBeeLove(filePath) {
  return readSharedWavMusicBeeLove(filePath);
}

async function readWavMusicBeePopmRaw(filePath) {
  return readSharedWavMusicBeePopmRaw(filePath);
}

async function updateWavMusicBeeTags(trackPath, { stars = null, loved = null } = {}) {
  return withMusicBeeWriteLock(trackPath, async () => {
    const found = await readWavId3Tag(trackPath);
    if (!found) throw new Error('WAV file does not contain an ID3 tag.');
    const input = found.input;
    const tag = found.tag;
    const version = tag[3] >= 4 ? 4 : 3;
    const tagSize = readId3Size(tag);
    const payload = tag.subarray(10, Math.min(tag.length, 10 + tagSize));
    const parsed = parseId3Frames(payload, version);
    const frames = parsed.frames;
    const trailing = parsed.trailing;
    const isPadding = trailing.length === 0 || trailing.every(byte => byte === 0);
    const outputFrames = [];
    let counter = 0;

    for (const frame of frames) {
      let remove = false;
      if (stars !== null && frame.id === 'POPM') {
        const nul = frame.data.indexOf(0);
        if (nul >= 0) {
          const email = frame.data.subarray(0, nul).toString('latin1').trim().toLowerCase();
          if (email === 'musicbee') {
            if (nul + 6 <= frame.data.length) counter = frame.data.readUInt32BE(nul + 2);
            remove = true;
          }
        }
      }
      if (stars !== null && frame.id === 'TXXX' && txxxDescription(frame.data).trim().toUpperCase() === 'FMPS_RATING') remove = true;
      if (loved !== null && frame.id === 'TXXX') {
        const desc = txxxDescription(frame.data).trim().toUpperCase();
        if (isBeehiveLoveFieldName(desc)) remove = true;
      }
      if (!remove) outputFrames.push(frame.raw);
    }

    if (loved !== null) if (loved) outputFrames.push(makeMusicBeeLoveFrame(version, 'L'));
    if (stars !== null) {
      // Keep the MusicBee POPM source of truth for WAVs with ID3, matching MP3.
      // FMPS_Rating is also synchronized for portability, but Beehive's reader
      // intentionally ignores it on WAV so other applications cannot override
      // the MusicBee value.
      outputFrames.push(makeFMPSRatingFrame(stars, version));
      outputFrames.push(makeMusicBeePopmFrame(stars, version, counter));
    }

    const keptTrailing = isPadding ? trailing : Buffer.alloc(0);
    const newPayload = Buffer.concat([...outputFrames, keptTrailing]);
    const newTag = Buffer.concat([
      Buffer.from('ID3','ascii'),
      Buffer.from([version,0,tag[5] & 0xF0]),
      id3Synchsafe(newPayload.length),
      newPayload
    ]);

    const oldChunkTotal = 8 + found.chunkSize + (found.chunkSize & 1);
    const newChunkSize = newTag.length;
    const newChunkTotal = 8 + newChunkSize + (newChunkSize & 1);
    let output;
    if (newChunkTotal <= oldChunkTotal) {
      const chunk = Buffer.alloc(oldChunkTotal);
      Buffer.from('id3 ','ascii').copy(chunk, 0);
      chunk.writeUInt32LE(oldChunkTotal - 8 - ((oldChunkTotal - 8) & 1), 4);
      // Keep the existing RIFF chunk size exactly stable; pad the ID3 payload.
      newTag.copy(chunk, 8);
      output = Buffer.concat([input.subarray(0, found.chunkPos), chunk, input.subarray(found.chunkPos + oldChunkTotal)]);
    } else {
      const chunk = Buffer.alloc(newChunkTotal);
      Buffer.from('id3 ','ascii').copy(chunk, 0);
      chunk.writeUInt32LE(newChunkSize, 4);
      newTag.copy(chunk, 8);
      output = Buffer.concat([input.subarray(0, found.chunkPos), chunk, input.subarray(found.chunkPos + oldChunkTotal)]);
      const riffSize = output.length - 8;
      output.writeUInt32LE(riffSize >>> 0, 4);
    }

    const temp = `${trackPath}.beehive-musicbee-${crypto.randomBytes(6).toString('hex')}.tmp`;
    await writeAndSyncReplacement(temp, trackPath, output);
  });
}

async function updateMp3MusicBeeTagsUnlocked(trackPath, { stars = null, loved = null } = {}) {
  const input = await fsp.readFile(trackPath);
  let version = 3;
  let flags = 0;
  let audioOffset = 0;
  let payload = Buffer.alloc(0);

  if (input.length >= 10 && input.toString('ascii', 0, 3) === 'ID3') {
    version = input[3] >= 4 ? 4 : 3;
    flags = input[5];
    const size = readId3Size(input);
    const end = Math.min(input.length, 10 + size);
    payload = input.subarray(10, end);
    audioOffset = end;
  }

  const parsed = parseId3Frames(payload, version);
  const frames = parsed.frames;
  const trailing = parsed.trailing;
  const isPadding = trailing.length === 0 || trailing.every(byte => byte === 0);
  const outputFrames = [];
  let existingMusicBeeCounter = 0;

  for (const frame of frames) {
    let remove = false;
    if (frame.id === 'POPM' && stars !== null) {
      const nul = frame.data.indexOf(0);
      if (nul >= 0) {
        const email = frame.data.subarray(0, nul).toString('latin1').trim().toLowerCase();
        // Only replace MusicBee's own POPM. Preserve its play counter when
        // changing the rating, just as Strawberry changes only POPM.rating.
        if (email === 'musicbee') {
          if (nul + 6 <= frame.data.length) {
            existingMusicBeeCounter = frame.data.readUInt32BE(nul + 2);
          }
          remove = true;
        }
      }
    }
    if (frame.id === 'TXXX' && stars !== null) {
      // Strawberry stores its portable normalized rating as TXXX:FMPS_Rating.
      // Keep this synchronized with the MusicBee POPM value.
      const desc = txxxDescription(frame.data).trim().toUpperCase();
      if (desc === 'FMPS_RATING') remove = true;
    }
    if (frame.id === 'TXXX' && loved !== null) {
      const desc = txxxDescription(frame.data).toUpperCase();
      // Replace the exact MusicBee Love field. Also remove Beehive's old
      // incorrect TXXX:Love spelling if it exists from an earlier build.
      if (isBeehiveLoveFieldName(desc)) remove = true;
    }
    if (!remove) outputFrames.push(frame.raw);
  }

  // Write only MusicBee's definitive LOVE RATING field; do not create the
  // legacy TXXX:Love field.
  if (loved !== null) {
    // Keep one authoritative Love field. Unlove removes every Beehive Love field from the file.
    // The absence of the field is the authoritative Unloved state.
    if (loved) outputFrames.push(makeMusicBeeLoveFrame(version, 'L'));
  }
  if (stars !== null) {
    // This deliberately mirrors Strawberry's SetRating(): FMPS_Rating is
    // always replaced (including 0), and the MusicBee POPM frame remains in
    // the tag with its rating byte changed to 0 when the user clears it.
    // Keeping the frame is important: it gives us a deterministic, writable
    // source-of-truth instead of relying on deletion through a hand-written
    // ID3 parser.
    outputFrames.push(makeFMPSRatingFrame(stars, version));
    outputFrames.push(makeMusicBeePopmFrame(stars, version, existingMusicBeeCounter));
  }

  // Always keep ID3 padding at the very end. New/replaced frames must be
  // placed before it; putting them after padding makes otherwise valid tags
  // invisible to strict ID3 readers (and was the reason ratings appeared to
  // save in Beehive but disappeared after restart).
  const keptTrailing = isPadding ? trailing : Buffer.alloc(0);
  payload = Buffer.concat([...outputFrames, keptTrailing]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([version, 0, flags & 0xF0]),
    id3Synchsafe(payload.length)
  ]);
  const output = Buffer.concat([header, payload, input.subarray(audioOffset)]);
  const temp = `${trackPath}.beehive-musicbee-${crypto.randomBytes(6).toString('hex')}.tmp`;
  await writeAndSyncReplacement(temp, trackPath, output);
}

async function updateMp3MusicBeeTags(trackPath, options = {}) {
  return withMusicBeeWriteLock(trackPath, () => updateMp3MusicBeeTagsUnlocked(trackPath, options));
}

async function writeMp3MusicBeeRating(trackPath, stars) {
  await updateMp3MusicBeeTags(trackPath, { stars });
}

const LOVE_SCAN_VERSION = 4;
// Bumped when the library record gains a broader native-tag inventory. A stale
// record is reparsed once during the next normal scan so the migration is real,
// not merely a cache-field default.
const METADATA_SCAN_VERSION = 2;
// Records created by the Uint8Array artwork fix need one bounded artwork
// hydration pass when their cached cover reference is absent. Records with a
// valid hashed cover reference remain incremental and are not reparsed.
const ARTWORK_SCAN_VERSION = 1;

function isFavoriteLoveValue(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'L' || v === 'Y' || v === 'YES' || v === 'TRUE' ||
    v === '1' || v === 'LOVE' || v === 'LOVED' ||
    v === 'FAVORITE' || v === 'FAVOURITE';
}

// Every Love field Beehive has historically written/recognized. When Unlove is
// requested, ALL of these aliases are normalized to one LOVE RATING field. Unlove removes the Love fields; Love writes one canonical LOVE RATING=L field.
const BEEHIVE_LOVE_FIELD_NAMES = new Set([
  'LOVE RATING',
  'LOVE',
  'LOVERATING',
  'MUSICBEE/LOVE RATING',
  'MUSICBEE/LOVERATING',
  'MUSICBEE LOVE RATING'
]);
function isBeehiveLoveFieldName(value) {
  return BEEHIVE_LOVE_FIELD_NAMES.has(String(value ?? '').trim().toUpperCase());
}

function splitId3LoveValues(value, encoding) {
  const text = String(value ?? '').replace(/^\uFEFF/, '');
  // ID3 TXXX is a text-list field. Some files therefore contain both an old
  // `U` value and a later `L` value in one field. Love is true if ANY value is
  // recognized as Loved, never based on only the first/last value.
  return text.split('\0').map(v => v.trim()).filter(Boolean);
}

async function readMp3MusicBeeLove(filePath) { return readSharedMp3MusicBeeLove(filePath); }
async function readMp3PopmRaw(filePath) {
  // ID3 can legally contain more than one POPM frame (one per application/email).
  // MusicBee uses the "MusicBee" email. Never return the first POPM blindly:
  // another player's POPM with rating 0 can otherwise hide MusicBee's 255.
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const head = Buffer.alloc(10);
      const { bytesRead } = await fd.read(head, 0, 10, 0);
      if (bytesRead < 10 || head.toString('ascii', 0, 3) !== 'ID3') return 0;
      const major = head[3];
      const flags = head[5];
      const tagSize = readId3Size(head);
      const payload = Buffer.alloc(tagSize);
      await fd.read(payload, 0, tagSize, 10);

      let pos = 0;
      // ID3v2.3/v2.4 extended headers precede the frames when the flag is set.
      if (major >= 3 && (flags & 0x40)) {
        if (payload.length >= 4) {
          const extSize = major >= 4
            ? ((payload[0] & 0x7f) << 21) | ((payload[1] & 0x7f) << 14) | ((payload[2] & 0x7f) << 7) | (payload[3] & 0x7f)
            : payload.readUInt32BE(0);
          // v2.3's size excludes its four-byte size field; v2.4 includes the size field.
          pos = major >= 4 ? extSize : 4 + extSize;
          if (pos > payload.length) pos = 0;
        }
      }

      let musicBeeRating = 0;
      let anyPopmRating = 0;
      let fmpsRating = 0;
      while (pos < payload.length) {
        if (major === 2) {
          if (pos + 6 > payload.length) break;
          const id = payload.toString('ascii', pos, pos + 3);
          const size = (payload[pos + 3] << 16) | (payload[pos + 4] << 8) | payload[pos + 5];
          if (!/^[A-Z0-9]{3}$/.test(id) || size <= 0 || pos + 6 + size > payload.length) break;
          if (id === 'POP') {
            const frame = payload.subarray(pos + 6, pos + 6 + size);
            const nul = frame.indexOf(0);
            if (nul >= 0 && nul + 1 < frame.length) {
              const email = frame.subarray(0, nul).toString('latin1').trim().toLowerCase();
              const raw = musicBeePopmByte(frame[nul + 1]);
              anyPopmRating = Math.max(anyPopmRating, raw);
              if (email === 'musicbee') musicBeeRating = Math.max(musicBeeRating, raw);
            }
          }
          pos += 6 + size;
        } else {
          if (pos + 10 > payload.length) break;
          const id = payload.toString('ascii', pos, pos + 4);
          const b = payload.subarray(pos + 4, pos + 8);
          const size = major >= 4
            ? ((b[0] & 0x7f) << 21) | ((b[1] & 0x7f) << 14) | ((b[2] & 0x7f) << 7) | (b[3] & 0x7f)
            : b.readUInt32BE(0);
          if (/^\x00{4}$/.test(id)) {
            let next = pos;
            while (next < payload.length && payload[next] === 0) next++;
            if (next + 10 <= payload.length) {
              const nextId = payload.toString('ascii', next, next + 4);
              const nextSize = major >= 4
                ? ((payload[next + 4] & 0x7f) << 21) | ((payload[next + 5] & 0x7f) << 14) | ((payload[next + 6] & 0x7f) << 7) | (payload[next + 7] & 0x7f)
                : payload.readUInt32BE(next + 4);
              if (/^[A-Z0-9]{4}$/.test(nextId) && nextSize > 0 && next + 10 + nextSize <= payload.length) {
                pos = next;
                continue;
              }
            }
            break;
          }
          if (!/^[A-Z0-9]{4}$/.test(id) || size <= 0) break;
          if (pos + 10 + size > payload.length) break;
          const frame = payload.subarray(pos + 10, pos + 10 + size);
          if (id === 'POPM') {
            const nul = frame.indexOf(0);
            if (nul >= 0 && nul + 1 < frame.length) {
              const email = frame.subarray(0, nul).toString('latin1').trim().toLowerCase();
              const raw = musicBeePopmByte(frame[nul + 1]);
              anyPopmRating = Math.max(anyPopmRating, raw);
              if (email === 'musicbee') musicBeeRating = Math.max(musicBeeRating, raw);
            }
          } else if (id === 'TXXX') {
            // Strawberry's portable fallback is TXXX:FMPS_Rating with a
            // normalized 0.0-1.0 value. Read it if no POPM is available.
            const desc = txxxDescription(frame).trim().toUpperCase();
            if (desc === 'FMPS_RATING') {
              const encoding = frame[0];
              const body = frame.subarray(1);
              let sep = -1;
              if (encoding === 0 || encoding === 3) {
                sep = body.indexOf(0);
                if (sep >= 0) {
                  const valueText = body.subarray(sep + 1).toString(encoding === 3 ? 'utf8' : 'latin1').trim();
                  const normalized = Number.parseFloat(valueText);
                  if (Number.isFinite(normalized) && normalized > fmpsRating) fmpsRating = Math.max(0, Math.min(1, normalized));
                }
              } else {
                for (let i = 0; i + 1 < body.length; i += 2) {
                  if (body[i] === 0 && body[i + 1] === 0) { sep = i; break; }
                }
                if (sep >= 0) {
                  const valueText = body.subarray(sep + 2).toString('utf16le').trim();
                  const normalized = Number.parseFloat(valueText);
                  if (Number.isFinite(normalized) && normalized > fmpsRating) fmpsRating = Math.max(0, Math.min(1, normalized));
                }
              }
            }
          }
          pos += 10 + size;
        }
      }
      // Beehive's MP3 rating authority is ONLY the MusicBee POPM frame.
      // Other POPM applications and FMPS are deliberately ignored for display.
      return musicBeeRating || 0;
    } finally {
      await fd.close();
    }
  } catch {
    return 0;
  }
}

async function readMp3PopmRating(filePath) {
  const raw = await readMp3PopmRaw(filePath);
  return musicBeePopmStars(raw);
}

async function readNativeEmbeddedRating(filePath, metadataLib) {
  const meta = await metadataLib.parseFile(filePath, { duration: false, skipCovers: true });
  const normalize = (raw, scale255 = false, scaleNormalized = false) => {
    if (raw === null || raw === undefined || raw === '') return 0;
    if (typeof raw === 'object') return normalize(raw.rating ?? raw.text ?? raw.value, scale255, scaleNormalized);
    const n = Number(String(raw).replace(/[^0-9.+-]/g, ''));
    if (!Number.isFinite(n)) return 0;
    if (scale255) return musicBeePopmStars(n);
    if (scaleNormalized) return Math.max(0, Math.min(5, Math.round(n * 10) / 2));
    if (n <= 5) return Math.round(n * 2) / 2;
    if (n <= 100) return Math.max(0, Math.min(5, Math.round(n / 10) / 2));
    return musicBeePopmStars(n);
  };

  let rating = 0;
  for (const tagList of Object.values(meta.native || {})) {
    for (const tag of (Array.isArray(tagList) ? tagList : [])) {
      // MP4/M4A freeform atoms come back from music-metadata namespaced as
      // "----:com.apple.iTunes:FMPS_Rating", not the bare field name. Matching
      // only the bare id here silently discarded every rating Hive itself wrote
      // to an M4A file (write_rating -> tag_helper.py always succeeded; only the
      // read-back for display was broken). Compare the segment after the last
      // ':' so both bare (FLAC/Vorbis) and namespaced (MP4 freeform) ids work.
      const rawId = String(tag?.id || '');
      const id = (rawId.includes(':') ? rawId.slice(rawId.lastIndexOf(':') + 1) : rawId).toUpperCase();
      const desc = String(tag?.value?.description || '').toUpperCase();
      // Only read the exact portable field Beehive writes for non-MP3 files.
      // Generic/provider rating tags are intentionally ignored.
      if (id === 'FMPS_RATING' || desc === 'FMPS_RATING' || id === 'FMPS/RATING' || desc === 'FMPS/RATING') {
        rating = Math.max(rating, normalize(
          tag?.value?.rating ?? tag?.value?.text ?? tag?.value?.value ?? tag?.value,
          false,
          true
        ));
      }
    }
  }
  return Math.max(0, Math.min(5, rating));
}

async function readEmbeddedRating(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return readMp3PopmRating(filePath);
  if (ext === '.wav') return musicBeePopmStars(await readWavMusicBeePopmRaw(filePath));
  const metadataLib = await ensureMM();
  return readNativeEmbeddedRating(filePath, metadataLib);
}

function ffmpegMetadataArgs(tags) {
  const map = {
    title: 'title', artist: 'artist', album: 'album', albumArtist: 'album_artist',
    genre: 'genre', year: 'date', track: 'track', disk: 'disc', comment: 'comment',
    composer: 'composer', grouping: 'grouping', copyright: 'copyright', lyrics: 'lyrics',
    compilation: 'COMPILATION', bpm: 'bpm', publisher: 'publisher', conductor: 'conductor'
  };
  const args = [];
  const standard = new Set(Object.keys(map));
  for (const [key, value] of Object.entries(tags || {})) {
    if (value === undefined || value === null) continue;
    const target = map[key] || key;
    args.push('-metadata', `${target}=${String(value)}`);
  }
  return args;
}

// Library cache/scan operations are serialized. Tag edits can trigger both an
// explicit incremental refresh and a filesystem-watcher refresh; allowing those
// two scans to read/write library.json concurrently can let an older snapshot win
// and make the UI temporarily appear empty.
let libraryScanChain = Promise.resolve();
async function acquireLibraryScanLock() {
  let releaseNext;
  const wait = libraryScanChain;
  libraryScanChain = new Promise(resolve => { releaseNext = resolve; });
  await wait;
  return releaseNext;
}

// Favorites/Love state is read as part of the scanner's existing metadata pass.
// Do not perform a second full-library Love scan after the library scan completes.
ipcMain.handle('library:scanChanged', async (evt, changedPaths = []) => {
  const releaseLibraryScan = await acquireLibraryScanLock();
  try {
  const requested = [...new Set((Array.isArray(changedPaths) ? changedPaths : [])
    .filter(Boolean).map(p => path.resolve(String(p))))];
  if (!requested.length) return await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });

  const previous = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const oldTracks = Array.isArray(previous.tracks) ? previous.tracks : [];
  const oldByPath = new Map(oldTracks.map(t => [path.resolve(String(t?.path || '')), t]));
  const stats = await readJsonSafe(STATS_PATH(), {});
  const existing = [];
  const removed = [];

  for (const filePath of requested) {
    try {
      const st = await fsp.stat(filePath);
      if (st.isFile() && AUDIO_EXTS.has(path.extname(filePath).toLowerCase())) {
        existing.push({ path: filePath, mtimeMs: Number(st.mtimeMs || 0), ctimeMs: Number(st.ctimeMs || 0), size: Number(st.size || 0) });
      } else {
        removed.push(filePath);
      }
    } catch {
      removed.push(filePath);
    }
  }

  if (!existing.length && !removed.length) return previous;

  const tracksByPath = new Map(oldTracks.map(t => [path.resolve(String(t?.path || '')), t]));
  for (const filePath of removed) tracksByPath.delete(filePath);

  let cursor = 0;
  const workerCount = Math.min(2, Math.max(1, existing.length));
  const workerPath = runtimeResourcePath(path.join('app','workers','scanner-worker.js'));
  const pool = [];
  const changedResults = [];

  const spawnScanner = () => {
    const child = forkTracked(workerPath, [], workerForkOptions({ execArgv: ['--max-old-space-size=512'], stdio: ['ignore','pipe','pipe','ipc'] }));
    const slot = { child, busy:false, job:null, timer:null };
    child.stdout?.on('data', chunk => { const text=String(chunk||'').trim(); if(text) scanLog(`incremental worker stdout: ${text}`); });
    child.stderr?.on('data', chunk => { const text=String(chunk||'').trim(); if(text) scanLog(`incremental worker stderr: ${text}`); });
    pool.push(slot); return slot;
  };
  const cleanup = slot => { if(slot.timer) clearTimeout(slot.timer); try{slot.child.removeAllListeners();}catch{} try{slot.child.disconnect();}catch{} try{slot.child.kill();}catch{} };

  await new Promise((resolve) => {
    if (!existing.length) return resolve();
    let finished = 0;
    const dispatch = slot => {
      const i = cursor++;
      if (i >= existing.length) { if (pool.every(s => !s.busy)) resolve(); return; }
      const info = existing[i]; slot.busy=true; slot.job=info;
      slot.timer=setTimeout(() => {
        if (!slot.busy) return;
        scanLog('INCREMENTAL SCAN TIMEOUT - preserving cached track', { file: info.path });
        changedResults.push({ info, track: oldByPath.get(path.resolve(info.path)) || null });
        slot.busy=false; slot.job=null; finished++;
        dispatch(slot); if (finished >= existing.length) resolve();
      }, 12000);
      slot.child.once('message', msg => {
        if (slot.timer) { clearTimeout(slot.timer); slot.timer=null; }
        const old = oldByPath.get(path.resolve(info.path));
        if (msg?.type === 'result' && msg.track) {
          changedResults.push({ info, track: msg.track });
        } else {
          // A failed incremental parse must never erase a previously known track
          // or its cached Love state. Preserve the old record until a successful
          // authoritative scan can replace it.
          changedResults.push({ info, track: old || null });
          scanLog('INCREMENTAL SCAN ERROR - preserving cached track', { file: info.path, error: msg?.error || 'unknown' });
        }
        slot.busy=false; slot.job=null; finished++;
        dispatch(slot); if (finished >= existing.length) resolve();
      });
      try { slot.child.send({ type:'scan', id:i, filePath:info.path, coversDir:COVERS_DIR() }); }
      catch { const old=oldByPath.get(path.resolve(info.path)); changedResults.push({info,track:old||null}); slot.busy=false; slot.job=null; finished++; dispatch(slot); if(finished>=existing.length) resolve(); }
    };
    for(let i=0;i<workerCount;i++) {
      const slot=spawnScanner();
      slot.child.on('error',()=>{}); slot.child.on('exit',()=>{});
    }
    for(const slot of pool) dispatch(slot);
  });
  for (const slot of pool) cleanup(slot);

  for (const { info, track } of changedResults) {
    const key = path.resolve(info.path);
    if (!track) continue;
    const old = oldByPath.get(key);
    const merged = {
      ...track,
      path: info.path,
      fileMtimeMs: info.mtimeMs,
      fileCtimeMs: Number(info?.ctimeMs || 0),
      fileSize: info.size,
      addedAt: old?.addedAt || track.addedAt || Date.now(),
      // stats.json is authoritative once a track has an entry there at all --
      // even a legitimate 0 (from Clear Play Counts or a MusicBee play-count
      // replacement) must win over a stale cached count. `||` treats that
      // real 0 as "missing" and silently resurrects the old cached value, so
      // this has to check presence with `??`, not truthiness.
      playCount: Number(stats[info.path]?.playCount ?? old?.playCount ?? track.playCount ?? 0),
      skipCount: Number(stats[info.path]?.skipCount ?? old?.skipCount ?? track.skipCount ?? 0),
      lastPlayedAt: Number(stats[info.path]?.lastPlayedAt ?? old?.lastPlayedAt ?? track.lastPlayedAt ?? 0),
      loved: !!track.loved,
      loveHydrated: true,
      loveCheckedMtimeMs: Number(info?.mtimeMs || 0),
      loveCheckedSize: Number(info?.size || 0),
      loveScanVersion: LOVE_SCAN_VERSION,
      metadataScanVersion: Number(track.metadataScanVersion || METADATA_SCAN_VERSION),
      artworkScanVersion: Number(track.artworkScanVersion || ARTWORK_SCAN_VERSION)
    };
    tracksByPath.set(key, merged);
    try { evt.sender.send('library:scanTrack', rendererTrackPayload(merged)); } catch {}
  }

  const ordered = [];
  const changedSet = new Set(requested);
  for (const t of oldTracks) {
    const key = path.resolve(String(t?.path || ''));
    if (!key || !tracksByPath.has(key)) continue;
    if (!changedSet.has(key)) ordered.push(t);
    else ordered.push(tracksByPath.get(key));
  }
  for (const [key, t] of tracksByPath) {
    if (!oldByPath.has(key)) ordered.push(t);
  }

  const scannedAt = Date.now();
  const result = { tracks: ordered, scannedAt };
  await writeJsonSafe(LIBRARY_CACHE_PATH(), result);
  // Keep SQLite authoritative for the next startup too. Incremental watcher
  // scans used to update only library.json, which meant the new SQLite backend
  // could immediately resurrect stale metadata after a restart.
  await persistLibraryDatabase(ordered);
  scanLog('Incremental library scan finished', { requested: requested.length, existing: existing.length, removed: removed.length, tracks: ordered.length });
  return { tracks: ordered.map(rendererTrackPayload), scannedAt };
  } finally {
    releaseLibraryScan();
  }
});

ipcMain.handle('library:scan', async (evt, options = {}) => {
  const releaseLibraryScan = await acquireLibraryScanLock();
  try {
  const forceFull = options?.forceFull === true;
  scanLog('SCAN IPC ENTER', { forceFull });
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  scanLog('SCAN CONFIG LOADED', { folders: Array.isArray(config.folders) ? config.folders.length : 0 });
  const files = [];
  const folders = resolveConfigFolders(config);
  for (const folder of folders) {
    const before = files.length;
    scanLog('WALK START', { folder });
    await walk(folder, files, (count, currentDir) => {
      if (count % 100 === 0 || files.length % 250 === 0) {
        scanLog('WALK PROGRESS', { folder, filesFound: files.length, directories: count, currentDir });
        try {
          evt.sender.send('library:scanProgress', {
            done: 0, total: files.length, tracksFound: 0, skipped: 0, current: path.basename(currentDir || folder),
            phase: `Finding music files · ${files.length.toLocaleString()} found`, changed: 0, unchanged: 0, enumerating: true
          });
        } catch {}
      }
    });
    scanLog('WALK DONE', { folder, addedFiles: files.length - before, totalFiles: files.length });
  }
  scanLog('FILE ENUMERATION DONE', { total: files.length });
  try {
    evt.sender.send('library:scanProgress', {
      done: 0, total: files.length, tracksFound: 0, skipped: 0, current: '',
      phase: `Preparing ${files.length.toLocaleString()} music files`, changed: 0, unchanged: 0, enumerating: false
    });
  } catch {}

  let previous = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const oldTracks = Array.isArray(previous.tracks) ? previous.tracks.map(rendererTrackPayload) : [];
  const oldByPath = new Map(oldTracks.map(t => [path.resolve(String(t?.path || '')), t]));
  const stats = await readJsonSafe(STATS_PATH(), {});
  // The scan working set never needs the lossless native-tag objects from the
  // previous JSON cache. Drop that parsed graph before metadata workers start.
  previous = null;

  // A rescan is incremental: recursively enumerate the configured folders, but
  // only send NEW or MODIFIED files through the expensive metadata/artwork parser.
  // Removed files disappear naturally because the final library is rebuilt from
  // the current filesystem set plus the cached records for unchanged files.
  const fileInfo = [];
  scanLog('STAT PHASE START', { totalFiles: files.length });
  let statCursor = 0;
  let statDone = 0;
  let statLastLog = Date.now();
  // Keep metadata probes deliberately modest. A large burst of concurrent stat()
  // calls can saturate a network-backed or spinning filesystem and make the scan
  // appear frozen. Eight workers give us steady progress without hammering storage.
  const statWorkerCount = Math.min(8, Math.max(1, files.length));
  const statWorkers = Array.from({ length: statWorkerCount }, async (_, workerIndex) => {
    scanLog('STAT WORKER START', { worker: workerIndex, total: statWorkerCount });
    while (true) {
      const i = statCursor++;
      if (i >= files.length) return;
      const filePath = files[i];
      const startedAt = Date.now();
      try {
        const st = await fsp.stat(filePath);
        fileInfo[i] = { path: filePath, mtimeMs: Number(st.mtimeMs || 0), ctimeMs: Number(st.ctimeMs || 0), size: Number(st.size || 0) };
      } catch {
        fileInfo[i] = null;
      } finally {
        statDone++;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= 1000) scanLog('Slow stat', { ms: elapsed, file: filePath, index: i });
        if (statDone === files.length || statDone % 250 === 0 || Date.now() - statLastLog >= 2000) {
          statLastLog = Date.now();
          scanLog('STAT PROGRESS', { done: statDone, total: files.length, file: filePath, index: i });
          try {
            evt.sender.send('library:scanProgress', {
              done: statDone, total: files.length, tracksFound: 0, skipped: files.length - statDone,
              current: path.basename(filePath || ''), phase: 'Checking files for changes', changed: 0, unchanged: 0, statPhase: true
            });
          } catch {}
        }
      }
    }
  });
  await Promise.all(statWorkers);
  scanLog('STAT PHASE DONE', { totalFiles: files.length, completed: statDone });

  const changed = [];
  const unchanged = [];
  for (const info of fileInfo) {
    if (!info) continue;
    const old = oldByPath.get(info.path);
    const hasArtworkReference = !!old?.cover || (Array.isArray(old?.covers) && old.covers.some(item => item?.file));
    const artworkNeedsRepair = !hasArtworkReference && Number(old?.artworkScanVersion || 0) < ARTWORK_SCAN_VERSION;
    const same = !forceFull && !artworkNeedsRepair && old && Number(old.fileMtimeMs || 0) === info.mtimeMs && Number(old.fileCtimeMs || 0) === info.ctimeMs && Number(old.fileSize || 0) === info.size && Number(old.metadataScanVersion || 0) >= METADATA_SCAN_VERSION;
    if (same) unchanged.push({ ...old, fileMtimeMs: info.mtimeMs, fileCtimeMs: info.ctimeMs, fileSize: info.size, artworkScanVersion: ARTWORK_SCAN_VERSION });
    else changed.push(info);
  }

  // Keep the scan working set bounded. The scanner result contains a lossless
  // nativeTags graph that is needed for SQLite persistence but not for the
  // renderer; retaining 30k of those graphs here caused the main V8 heap to
  // grow into the multi-gigabyte range. Full records are handed to SQLite in
  // small batches below, while this array contains renderer-safe records only.
  const tracks = unchanged.map(rendererTrackPayload);
  const inaccessible = files.length - fileInfo.filter(Boolean).length;
  let done = 0;
  let skipped = inaccessible;
  let cursor = 0;
  let lastProgressAt = 0;
  const total = files.length;
  scanLog('LIBRARY SCAN STARTED', { forceFull, total, previousTracks: oldTracks.length, changed: changed.length, unchanged: unchanged.length });
  const workerCount = Math.min(forceFull ? 4 : 2, Math.max(1, changed.length));
  const WORKER_RECYCLE_AFTER = 250;
  const JOB_TIMEOUT_MS = 12000;
  const workerPath = runtimeResourcePath(path.join('app','workers','scanner-worker.js'));
  const pool = [];

  // Full scans can discover tens of thousands of tracks. Sending one IPC message
  // per file overwhelms Chromium even though the scanner workers are async. Keep
  // progressive scan updates, but ship renderer track records in bounded batches.
  let rendererTrackBatch = [];
  const flushRendererTrackBatch = () => {
    if (!rendererTrackBatch.length) return;
    const batch = rendererTrackBatch;
    rendererTrackBatch = [];
    try { evt.sender.send('library:scanTrack', batch); } catch {}
  };
  const queueRendererTrack = track => {
    if (!track) return;
    rendererTrackBatch.push(track);
    if (rendererTrackBatch.length >= 100) flushRendererTrackBatch();
  };

  let databaseBatch = [];
  let databasePersistError = null;
  const DATABASE_BATCH_SIZE = 64;
  const flushDatabaseBatch = async () => {
    if (!databaseBatch.length) return;
    const batch = databaseBatch;
    databaseBatch = [];
    try {
      await databaseRequest('upsert_tracks', { tracks: batch.map(canonicalize) });
    } catch (err) {
      databasePersistError = err;
      crashDebug('DATABASE scan batch persist failed', { message: err?.message || String(err) });
    }
  };
  const queueDatabaseTrack = async (track) => {
    if (!track || typeof track !== 'object') return;
    databaseBatch.push(track);
    if (databaseBatch.length >= DATABASE_BATCH_SIZE) await flushDatabaseBatch();
  };

  const enrichTrack = (t, info) => {
    const old = oldByPath.get(t.path);
    return {
      ...t,
      fileMtimeMs: Number(info?.mtimeMs || 0),
      fileCtimeMs: Number(info?.ctimeMs || 0),
      fileSize: Number(info?.size || 0),
      addedAt: old?.addedAt || Date.now(),
      // See the matching comment in the incremental-scan merge above: `??`
      // is required here so a genuine 0 in stats.json isn't mistaken for
      // "no value" and overwritten by a stale cached count.
      playCount: Number(stats[t.path]?.playCount ?? old?.playCount ?? 0),
      skipCount: Number(stats[t.path]?.skipCount ?? old?.skipCount ?? 0),
      lastPlayedAt: Number(stats[t.path]?.lastPlayedAt ?? old?.lastPlayedAt ?? 0),
      loved: !!t.loved,
      loveHydrated: true,
      loveCheckedMtimeMs: Number(info?.mtimeMs || 0),
      loveCheckedSize: Number(info?.size || 0),
      loveScanVersion: LOVE_SCAN_VERSION,
      metadataScanVersion: Number(t.metadataScanVersion || METADATA_SCAN_VERSION),
      artworkScanVersion: Number(t.artworkScanVersion || ARTWORK_SCAN_VERSION)
    };
  };

  const sendProgress = (current = '', phase = 'Scanning changes') => {
    const now = Date.now();
    if (done === total || done % 5 === 0 || now - lastProgressAt >= 150) {
      lastProgressAt = now;
      evt.sender.send('library:scanProgress', {
        done, total, tracksFound: tracks.length, skipped, current, phase,
        changed: changed.length, unchanged: unchanged.length
      });
    }
  };

  // First phase is intentionally cheap: filesystem stat checks only. This is
  // what makes rescans practical for a 20k-30k library.
  evt.sender.send('library:scanProgress', {
    done: 0, total, tracksFound: tracks.length, skipped: 0, current: '',
    phase: forceFull ? `Reading tags from ${total.toLocaleString()} files` : `Checking ${total.toLocaleString()} files for changes`,
    changed: changed.length, unchanged: unchanged.length
  });

  const spawnScanner = () => {
    const child = forkTracked(workerPath, [], workerForkOptions({
      execArgv: ['--max-old-space-size=512'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    }));
    const slot = { child, busy:false, job:null, timer:null, heartbeat:null, startedAt:0, completed:0, stopping:false };
    child.stdout?.on('data', chunk => {
      const text = String(chunk || '').trim();
      if (text) scanLog(`worker stdout: ${text}`);
    });
    child.stderr?.on('data', chunk => {
      const text = String(chunk || '').trim();
      if (text) scanLog(`worker stderr: ${text}`);
    });
    pool.push(slot);
    scanLog('Scanner worker started', { pid: child.pid });
    return slot;
  };
  const cleanupSlot = (slot) => {
    if (slot.timer) { clearTimeout(slot.timer); slot.timer=null; }
    if (slot.heartbeat) { clearInterval(slot.heartbeat); slot.heartbeat=null; }
    try { slot.child.removeAllListeners(); } catch {}
    try { slot.child.disconnect(); } catch {}
    try { slot.child.kill(); } catch {}
    slot.busy=false; slot.job=null;
  };

  const runPool = () => new Promise((resolve, reject) => {
    if (!changed.length) return resolve();
    let finished=false;
    const failAll = err => { if(finished)return; finished=true; for(const slot of pool)cleanupSlot(slot); reject(err); };
    const completeIfDone = () => {
      if (done >= total && !finished) { finished=true; for(const slot of pool)cleanupSlot(slot); resolve(); }
      else if (cursor >= changed.length && pool.every(s => !s.busy) && done >= total && !finished) { finished=true; for(const slot of pool)cleanupSlot(slot); resolve(); }
    };
    const replaceWorker = slot => {
      if(finished || slot.stopping)return;
      const idx=pool.indexOf(slot); cleanupSlot(slot); if(idx<0||finished)return;
      const replacement=spawnScanner(); pool.splice(pool.indexOf(replacement),1); pool[idx]=replacement; attach(replacement); dispatch(replacement);
    };
    const fallbackTrackFor = (info) => {
      if (!info?.path) return null;
      const old = oldByPath.get(path.resolve(String(info.path || '')));
      if (old) {
        // Preserve the last known metadata when parsing fails. Do NOT mark the
        // file as freshly hydrated: its Love/metadata check markers remain stale
        // so a later scan will retry the authoritative read.
        return {
          ...old,
          fileMtimeMs: Number(info?.mtimeMs || old.fileMtimeMs || 0),
          fileCtimeMs: Number(info?.ctimeMs || old.fileCtimeMs || 0),
          fileSize: Number(info?.size || old.fileSize || 0)
        };
      }
      const ext = path.extname(info.path);
      return {
        id: crypto.createHash('md5').update(info.path).digest('hex'),
        path: info.path, title: path.basename(info.path, ext),
        artist: 'Unknown Artist', album: 'Unknown Album', albumArtist: 'Unknown Artist',
        year: null, genre: null, composer: null, publisher: null, conductor: null, comment: null,
        grouping: null, copyright: null, originalArtist: null, originalAlbum: null, originalYear: null,
        language: null, mood: null, occasion: null, keywords: null, quality: null, tempo: null, isrc: null, barcode: null,
        track: null, trackCount: null, disk: null, discCount: null, duration: 0, sampleRate: null, bitrate: null,
        channels: null, codec: ext.replace('.','').toUpperCase(), cover: null, covers: [], loved: false, lyrics: null,
        rating: 0, ratingRaw: 0, ratingHydrated: true, startTime: '', endTime: '', customTags: {}, nativeTags: {}, metadataScanVersion: 0,
        fileMtimeMs: info.mtimeMs, fileCtimeMs: Number(info?.ctimeMs || 0), fileSize: info.size, addedAt: Date.now(), playCount: 0, skipCount: 0, lastPlayedAt: 0, loveHydrated: false, loveCheckedMtimeMs: 0, loveCheckedCtimeMs: 0, loveCheckedSize: 0, loveScanVersion: 0
      };
    };
    const markSkippedAndContinue = (slot, info, dispatchNext=true) => {
      if(slot.timer){clearTimeout(slot.timer);slot.timer=null;}
      if(slot.heartbeat){clearInterval(slot.heartbeat);slot.heartbeat=null;}
      slot.busy=false;slot.job=null;
      const fallback = fallbackTrackFor(info);
      if (fallback && !tracks.some(t => t.path === fallback.path)) tracks.push(fallback);
      skipped++; done++;
      sendProgress(info?.path ? path.basename(info.path) : '', 'Scanning changed files');
      if(dispatchNext) dispatch(slot); completeIfDone();
    };
    const dispatch = slot => {
      if(finished || slot.busy || slot.stopping)return completeIfDone();
      const i=cursor++; if(i>=changed.length)return completeIfDone();
      const info=changed[i]; slot.busy=true; slot.job={index:i,info}; slot.startedAt=Date.now();
      scanLog('SCAN START', { index:i, done, total, file:info.path, worker:slot.child.pid });
      sendProgress(path.basename(info.path), 'Scanning changed files');
      slot.heartbeat=setInterval(()=>{
        if(!slot.busy||!slot.job)return;
        const elapsed=Date.now()-slot.startedAt;
        sendProgress(path.basename(slot.job.info.path), `Scanning changed files · ${Math.floor(elapsed/1000)}s on current file`);
        if(elapsed >= 2000) scanLog('SCAN WAIT', { ms:elapsed, file:slot.job.info.path, worker:slot.child.pid });
      }, 1000);
      slot.timer=setTimeout(()=>{
        if(!slot.busy||!slot.job)return;
        const stuck=slot.job.info; const elapsed=Date.now()-slot.startedAt;
        scanLog('SCAN TIMEOUT - killing worker and continuing', { ms:elapsed, file:stuck.path, worker:slot.child.pid });
        try{slot.child.kill('SIGKILL');}catch{}
        markSkippedAndContinue(slot,stuck,false); replaceWorker(slot);
      },JOB_TIMEOUT_MS);
      try { slot.child.send({type:'scan',id:i,filePath:info.path,coversDir:COVERS_DIR()}); }
      catch { scanLog('SCAN SEND ERROR', { file:info.path, worker:slot.child.pid }); markSkippedAndContinue(slot,info); }
    };
    const attach = slot => {
      slot.child.on('message', async msg => {
        if(finished||!slot.busy||!slot.job)return;
        if(!msg||msg.id!==slot.job.index)return;
        const info=slot.job.info;
        if(slot.timer){clearTimeout(slot.timer);slot.timer=null;}
        if(slot.heartbeat){clearInterval(slot.heartbeat);slot.heartbeat=null;}
        const elapsed = Date.now() - slot.startedAt;
        slot.busy=false;slot.job=null;
        scanLog(msg.type==='result' && msg.track ? 'SCAN DONE' : 'SCAN ERROR', { ms:elapsed, file:info.path, worker:slot.child.pid, error:msg.error || undefined });
        if(msg.type==='result'&&msg.track) {
          try {
            const enriched = enrichTrack(msg.track,info);
            await queueDatabaseTrack(enriched);
            const rendererTrack = rendererTrackPayload(enriched);
            tracks.push(rendererTrack);
            queueRendererTrack(rendererTrack);
            if (done % 250 === 0) scanMemoryDebug('PROGRESS', { done, tracks: tracks.length, databaseBatch: databaseBatch.length });
          } catch (err) {
            scanLog('SCAN RESULT HANDLER ERROR', { file:info.path, worker:slot.child.pid, error:String(err?.stack || err) });
            const fallback = fallbackTrackFor(info);
            if (fallback && !tracks.some(t => t.path === fallback.path)) tracks.push(fallback);
            skipped++;
          }
        } else {
          const fallback = fallbackTrackFor(info);
          if (fallback && !tracks.some(t => t.path === fallback.path)) tracks.push(fallback);
          skipped++;
        }
        done++;
        sendProgress(path.basename(info.path), 'Scanning changed files');
        slot.completed++;
        if(slot.completed>=WORKER_RECYCLE_AFTER && cursor<changed.length){
          slot.stopping=true; try{slot.child.disconnect();}catch{} try{slot.child.kill();}catch{};
          const idx=pool.indexOf(slot), replacement=spawnScanner(); pool.splice(pool.indexOf(replacement),1); pool[idx]=replacement;
          attach(replacement); dispatch(replacement); completeIfDone(); return;
        }
        dispatch(slot); completeIfDone();
      });
      const childFailure = () => {
        if(finished||slot.stopping)return;
        if(slot.busy&&slot.job){const info=slot.job.info;if(slot.timer){clearTimeout(slot.timer);slot.timer=null;}markSkippedAndContinue(slot,info,false);}
        replaceWorker(slot);
      };
      slot.child.on('error', childFailure);
      slot.child.on('exit', childFailure);
    };
    for(let i=0;i<workerCount;i++){const slot=spawnScanner();attach(slot);}
    for(const slot of pool)dispatch(slot);
  });

  flushRendererTrackBatch();
  const finalizationStartedAt = Date.now();
  scanLog('SCAN FINALIZATION START', { done, total, databaseBatch: databaseBatch.length });
  const finalBatchStartedAt = Date.now();
  await flushDatabaseBatch();
  scanLog('SCAN FINAL DATABASE FLUSH DONE', { ms: Date.now() - finalBatchStartedAt });
  if (databasePersistError) {
    scanLog('DATABASE scan persistence degraded', { message: databasePersistError.message });
  }
  const currentPaths = new Set(fileInfo.filter(Boolean).map(info => info.path));
  const removedPaths = oldTracks.map(track => track.path).filter(trackPath => !currentPaths.has(trackPath));
  if (removedPaths.length) {
    try { await databaseRequest('remove_tracks', { paths: removedPaths }); }
    catch (err) { crashDebug('DATABASE removed-track cleanup failed', { message: err?.message || String(err) }); }
  }
  let cacheNeedsRewrite = changed.length > 0 || removedPaths.length > 0;

  // In normal mode, unchanged files count as already processed. In a full
  // authoritative rescan every file is reparsed so embedded tags override any
  // stale Beehive cache and newly added files are guaranteed to enter the library.
  done = unchanged.length;
  sendProgress('', changed.length ? 'Scanning changed files' : 'No changes detected');
  await runPool();

  // Love is part of normal library reconciliation, not a separate Favorites
  // scanner. A one-time compatibility version lets us repair caches created by
  // older readers without forcing every future startup to reopen every file.
  // Changed/new files were already read by scanner-worker above; this pass is
  // only for unchanged records whose cached Love state predates the current
  // authoritative reader. Failed reads deliberately retain their old state and
  // remain candidates for a later scan.
  const staleLoveTracks = forceFull ? [] : tracks.filter(t => t && (
    t.loveHydrated !== true ||
    !Number.isFinite(Number(t.loveCheckedMtimeMs)) ||
    !Number.isFinite(Number(t.loveCheckedSize)) ||
    Number(t.loveScanVersion || 0) < LOVE_SCAN_VERSION
  ));
  if (staleLoveTracks.length) {
    cacheNeedsRewrite = true;
    scanLog('LOVE RECONCILIATION START', { total: staleLoveTracks.length, version: LOVE_SCAN_VERSION });
    let loveCursor = 0;
    let loveDone = 0;
    let loveUpdated = 0;
    let loveFailed = 0;
    const loveWorkers = Array.from({ length: Math.min(12, staleLoveTracks.length) }, async () => {
      while (true) {
        const i = loveCursor++;
        if (i >= staleLoveTracks.length) return;
        const track = staleLoveTracks[i];
        const filePath = String(track.path || '');
        try {
          const stat = await fsp.stat(filePath);
          const value = !!(await readLoveStateFromDisk(filePath));
          track.loved = value;
          track.loveHydrated = true;
          track.loveCheckedMtimeMs = Number(stat.mtimeMs || 0);
          track.loveCheckedCtimeMs = Number(stat.ctimeMs || 0);
          track.loveCheckedSize = Number(stat.size || 0);
          track.fileMtimeMs = Number(stat.mtimeMs || track.fileMtimeMs || 0);
          track.fileCtimeMs = Number(stat.ctimeMs || track.fileCtimeMs || 0);
          track.fileSize = Number(stat.size || track.fileSize || 0);
          track.loveScanVersion = LOVE_SCAN_VERSION;
          loveUpdated++;
          queueRendererTrack(rendererTrackPayload(track));
        } catch (err) {
          loveFailed++;
          scanLog('LOVE RECONCILIATION READ FAILED', { file: filePath, error: err?.message || String(err) });
        }
        loveDone++;
        if (loveDone === staleLoveTracks.length || loveDone % 250 === 0) {
          sendProgress(path.basename(filePath), 'Reconciling embedded Love tags');
        }
      }
    });
    await Promise.all(loveWorkers);
    scanLog('LOVE RECONCILIATION FINISHED', { total: staleLoveTracks.length, updated: loveUpdated, failed: loveFailed, version: LOVE_SCAN_VERSION });
  }

  flushRendererTrackBatch();

  if (total > 0 && tracks.length === 0 && oldTracks.length) {
    throw new Error('Library scan found no readable audio tracks; keeping the previous library.');
  }

  // Keep the cache ordered like the filesystem scan, while retaining the cached
  // metadata for unchanged files. This also drops files that were deleted.
  const byPath = new Map(tracks.map(t => [t.path, t]));
  const ordered = [];
  for (const info of fileInfo) if (info && byPath.has(info.path)) ordered.push(byPath.get(info.path));
  // Love/favorite state is part of the same reconciliation result. Changed
  // files are refreshed by scanner-worker, while unchanged records that need a
  // compatibility migration are refreshed by the bounded Love pass above.
  // There is no separate Favorites scan in the normal library path.
  scanLog('Library scan finished', { total, tracks: ordered.length, skipped, finalizationMs: Date.now() - finalizationStartedAt });
  const scannedAt = Date.now();
  const result = { tracks: ordered, scannedAt };
  if (cacheNeedsRewrite) {
    const cacheWriteStartedAt = Date.now();
    await writeJsonSafe(LIBRARY_CACHE_PATH(), result);
    scanLog('SCAN LIBRARY CACHE WRITE DONE', { ms: Date.now() - cacheWriteStartedAt, finalizationMs: Date.now() - finalizationStartedAt });
  } else {
    // A clean incremental startup scan is deliberately cache-read-only. Rewriting
    // the same ~93 MB JSON snapshot here caused a 300 ms serialization pause,
    // ~1.1 s gzip/write, and a large temporary heap spike despite zero metadata
    // changes. The renderer already has this exact cached library.
    scanLog('SCAN LIBRARY CACHE WRITE SKIPPED', { reason: 'no-library-changes', finalizationMs: Date.now() - finalizationStartedAt });
  }
  // Full records were already persisted to SQLite incrementally above. Do not
  // replace the database from this compact renderer/cache view: that would
  // recreate a whole-library serialization pass and discard nativeTags from
  // the lossless records stored by the scanner batches.
  if (!forceFull) {
    const orderedByPath = new Map(ordered.map(track => [track?.path, track]));
    const rendererChanged = changed.map(info => {
      const track = orderedByPath.get(info.path);
      return track ? rendererTrackPayload(track) : null;
    }).filter(Boolean);
    const rendererResult = {
      incremental: true,
      changed: rendererChanged,
      removedPaths,
      scannedAt
    };
    scanLog('SCAN IPC RESULT READY', {
      ms: Date.now() - scannedAt,
      totalMs: Date.now() - finalizationStartedAt,
      tracks: ordered.length,
      changed: rendererChanged.length,
      removed: removedPaths.length,
      payloadTracks: rendererChanged.length
    });
    return rendererResult;
  }
  const rendererPayloadStartedAt = Date.now();
  const rendererResult = { tracks: ordered.map(rendererTrackPayload), scannedAt };
  scanLog('SCAN IPC RESULT READY', { ms: Date.now() - rendererPayloadStartedAt, totalMs: Date.now() - finalizationStartedAt, tracks: ordered.length });
  return rendererResult;
  } finally {
    releaseLibraryScan();
  }
});

ipcMain.handle('yearly-wrap:chooseMusicBeeImport', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'MusicBee Wrapped archive', extensions: ['zip'] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('yearly-wrap:getMusicBeeState', async () => {
  const state = await readJsonSafe(MUSICBEE_WRAPPED_IMPORTS_PATH(), { version: 2, years: {}, syncEnabled: false });
  const years = Object.keys(state?.years || {}).map(Number).filter(y => Number.isInteger(y) && y >= 1900 && y <= 3000).sort((a,b) => b-a);
  let storedPlayCount = 0;
  for (const year of years) { const stored = await readMusicBeeStoredYear(HIVE_WRAPPED_DATA_ROOT(), year); storedPlayCount += stored?.plays?.length || 0; }
  return {
    imported: !!state?.syncEnabled && years.length > 0,
    syncEnabled: !!state?.syncEnabled,
    // Hive's own plays mirror into this same store unconditionally (see
    // listening:record), so there can be exportable Wrapped history even
    // when the user has never explicitly imported a MusicBee archive.
    hasWrappedData: years.length > 0 && fs.existsSync(musicBeeStoreRoot(HIVE_WRAPPED_DATA_ROOT())),
    years,
    storedPlayCount
  };
});

ipcMain.handle('yearly-wrap:chooseWrappedExport', async () => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), 'Hive-Yearly-Wrapped.zip'),
    filters: [{ name: 'Hive Wrapped archive', extensions: ['zip'] }]
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
});

ipcMain.handle('yearly-wrap:importMusicBee', async (_evt, archivePath) => {
  const imported = await readMusicBeeWrappedArchive(String(archivePath || ''));
  const groups = Array.isArray(imported?.years) ? imported.years : [];
  const existing = await readJsonSafe(LISTENING_EVENTS_PATH(), []);
  const events = Array.isArray(existing) ? existing : [];
  const ids = new Set(events.map(e => String(e?.id || '')));
  const importState = await readJsonSafe(MUSICBEE_WRAPPED_IMPORTS_PATH(), { version: 2, years: {}, syncEnabled: false });
  const state = importState && typeof importState === 'object' ? importState : { version: 2, years: {}, syncEnabled: false };
  state.version = 2; state.syncEnabled = true;
  if (!state.years || typeof state.years !== 'object') state.years = {};
  let added = 0, skipped = 0;
  const yearSummary = [];
  for (const group of groups) {
    const year = Number(group.year);
    const plays = Array.isArray(group.plays) ? group.plays : [];
    // The archive becomes the canonical record for this year up through the
    // moment of its first import: any native Hive play already recorded is
    // superseded, not merged with, since the archive now speaks for that
    // whole period. Only native plays recorded from the import onward keep
    // accumulating on top of the archive's own counts. This prune happens
    // once, on the first import of a given year -- a later re-import of the
    // same (or an updated) archive for that year must not re-discard plays
    // that arrived legitimately after that first import.
    const isFirstImportForYear = !state.years[String(year)]?.importedAt;
    if (isFirstImportForYear) {
      const priorStored = await readMusicBeeStoredYear(HIVE_WRAPPED_DATA_ROOT(), year);
      const priorPlays = priorStored?.plays || [];
      const survivors = priorPlays.filter(p => p.source !== 'hive');
      if (survivors.length !== priorPlays.length) {
        await writeMusicBeeYearStore(HIVE_WRAPPED_DATA_ROOT(), year, survivors);
      }
    }
    // Tag every play parsed straight from the archive as 'import' provenance,
    // as opposed to a native Hive play mirrored in via appendHiveEvent
    // ('hive' provenance, see musicbee-wrapped-store.js). yearly-wrap:replacePlayCounts
    // needs this distinction: a track only ever played natively (never in the
    // archive) must reset to zero on import-overwrite, not keep a count just
    // because Hive's own plays happen to live in the same merged store.
    const taggedGroup = { ...group, plays: plays.map(p => ({ ...p, source: 'import' })) };
    const mergedStore = await mergeMusicBeeImportedYear(HIVE_WRAPPED_DATA_ROOT(), taggedGroup);
    const mergedPlays = mergedStore.plays || plays;
    for (const play of plays) {
      const playedAtMs = Date.parse(String(play.playedAt || ''));
      if (!Number.isFinite(playedAtMs) || playedAtMs <= 0) { skipped++; continue; }
      const id = musicBeeImportPlayId(year, play);
      if (ids.has(id)) { skipped++; continue; }
      const trackDuration = Math.max(0, Number(play.durationMs) || 0) / 1000;
      const listened = Math.max(0, Number(play.playDuration) || 0);
      const event = {
        id, playedAt: playedAtMs, duration: listened, trackDuration,
        path: '', title: String(play.title || ''), artist: String(play.artist || ''), album: String(play.album || ''),
        albumArtist: String(play.albumArtist || ''), genre: String(play.genre || ''), cover: null, artworkUrl: null,
        source: 'musicbee-wrapped', spotifyUri: '', completed: trackDuration > 0 ? listened >= trackDuration * 0.8 : false,
        legacyFileUrl: String(play.fileUrl || ''), playlistName: String(play.playlistName || ''), listeningMode: String(play.listeningMode || '')
      };
      events.push(event); ids.add(id); added++;
    }
    const metadata = mergedStore.metadata || group.metadata || {};
    state.years[String(year)] = {
      year, importedAt: Number(state.years[String(year)]?.importedAt || Date.now()), updatedAt: Date.now(), source: 'MusicBeeWrapped',
      directory: String(group.directory || ''), storeDir: musicBeeYearDir(HIVE_WRAPPED_DATA_ROOT(), year), metadata,
      sourcePlayCount: plays.length, storedPlayCount: mergedPlays.length
    };
    yearSummary.push({ year, sourcePlayCount: plays.length, storedPlayCount: mergedPlays.length, added: Math.max(0, mergedStore.addedFromImport || 0), skipped: Math.max(0, plays.length - Math.max(0, mergedStore.addedFromImport || 0)), metadata });
  }
  events.sort((a,b) => Number(a?.playedAt || 0) - Number(b?.playedAt || 0));
  await writeJsonSafe(LISTENING_EVENTS_PATH(), events.slice(-20000));
  await writeJsonSafe(MUSICBEE_WRAPPED_IMPORTS_PATH(), state);
  return { ok: true, added, skipped, years: yearSummary, totalEvents: events.length, playCountsChanged: false, syncEnabled: true };
});

// Exports Hive's own Wrapped listening history, in the same per-year
// play_history.xml/year_metadata.xml zip format used for a MusicBee import.
// This works even when nothing has ever been imported -- native Hive plays
// mirror into this same store unconditionally (see listening:record) -- and
// if a MusicBee archive *was* imported, its plays are already merged into
// this same store, so one export naturally covers both.
ipcMain.handle('yearly-wrap:exportWrapped', async (_evt, destinationPath) => {
  const state = await readJsonSafe(MUSICBEE_WRAPPED_IMPORTS_PATH(), { version: 2, years: {}, syncEnabled: false });
  if (!fs.existsSync(musicBeeStoreRoot(HIVE_WRAPPED_DATA_ROOT()))) {
    throw new Error('No Wrapped listening history exists yet.');
  }
  const target = String(destinationPath || '').trim();
  if (!target) throw new Error('No export destination was selected.');
  await exportMusicBeeArchive(HIVE_WRAPPED_DATA_ROOT(), target);
  return { ok: true, path: target, years: Object.keys(state.years || {}).map(Number).filter(Number.isFinite).sort((a,b)=>b-a) };
});

function normalizePlayCountText(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

async function getMusicBeeImportedPlayCounts() {
  const state = await readJsonSafe(MUSICBEE_WRAPPED_IMPORTS_PATH(), { years: {} });
  const years = Object.keys(state?.years || {}).map(Number).filter(y => Number.isInteger(y) && y >= 1900 && y <= 3000);
  const counts = new Map();
  const archiveMatchedKeys = new Set();
  const rows = [];
  for (const year of years) {
    const stored = await readMusicBeeStoredYear(HIVE_WRAPPED_DATA_ROOT(), year);
    for (const play of stored?.plays || []) {
      const key = musicBeeTrackKey(play);
      if (!key || /^\u0000/.test(key)) continue;
      // Counting everything currently in the store is correct here because
      // yearly-wrap:importMusicBee already pruned any native ('hive') play
      // that predated a year's first import -- what's left is exactly the
      // archive's own history plus native plays from the point of import
      // onward, i.e. the canonical total. "Matched" (does this track get a
      // nonzero count at all on a Wrapped-import overwrite, or reset to
      // zero) must still key off actually having been in an imported
      // archive, not merely off Hive having ever played it -- a track never
      // imported at all would otherwise "match" purely because Hive's own
      // (never-pruned, since no import ever ran) plays live in this store.
      counts.set(key, (counts.get(key) || 0) + 1);
      if (play.source === 'import') archiveMatchedKeys.add(key);
      rows.push(play);
    }
  }
  return { state, counts, archiveMatchedKeys, rows };
}

ipcMain.handle('yearly-wrap:replacePlayCounts', async () => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  const { counts, archiveMatchedKeys } = await getMusicBeeImportedPlayCounts();
  const libraryCache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const tracks = Array.isArray(libraryCache.tracks) ? libraryCache.tracks : [];
  const exact = new Map(), pair = new Map();
  const add = (map, key, track) => { if (!key) return; const arr = map.get(key) || []; arr.push(track); map.set(key, arr); };
  for (const track of tracks) {
    add(exact, musicBeeTrackKey(track), track);
    add(pair, `${normalizePlayCountText(track?.title)}\u0000${normalizePlayCountText(track?.artist)}`, track);
  }
  // A Wrapped import is additive, not a pure overwrite: a track actually
  // present in the imported archive gets the full count (archive plays plus
  // whatever Hive has natively recorded for it, whenever those happened --
  // Hive just keeps adding to that baseline going forward). A track Hive has
  // only ever played natively, never present in any imported archive, resets
  // to zero -- the import has no record of it, so it isn't "whatever the
  // imported data is". archiveMatchedKeys (not just "appears in counts") is
  // what tells these two cases apart, since counts by itself is additive and
  // includes native-only tracks too.
  const nextStats = { ...stats };
  const matchedPaths = new Set(); let matchedTracks = 0, ambiguous = 0, importedPlays = 0;
  for (const [key, count] of counts) {
    if (!archiveMatchedKeys.has(key)) continue;
    importedPlays += count;
    let matches = exact.get(key) || [];
    if (matches.length !== 1) {
      const [title, artist] = key.split('\u0000');
      matches = pair.get(`${title}\u0000${artist}`) || [];
    }
    if (matches.length !== 1) { if (matches.length > 1) ambiguous++; continue; }
    const track = matches[0];
    if (!track?.path) continue;
    nextStats[track.path] = { ...(stats[track.path] || {}), playCount: Math.max(0, Math.floor(count)), lastPlayedAt: Number(stats[track.path]?.lastPlayedAt || 0) };
    matchedPaths.add(track.path); matchedTracks++;
  }
  for (const track of tracks) {
    if (!track?.path || matchedPaths.has(track.path)) continue;
    nextStats[track.path] = { ...(stats[track.path] || {}), playCount: 0, lastPlayedAt: Number(stats[track.path]?.lastPlayedAt || 0) };
  }
  await writeJsonSafe(STATS_PATH(), nextStats);
  const updatedPlayCounts = {};
  if (Array.isArray(libraryCache.tracks)) {
    libraryCache.tracks = libraryCache.tracks.map(track => {
      if (!track?.path) return track;
      const playCount = Number(nextStats[track.path]?.playCount ?? 0);
      updatedPlayCounts[track.path] = playCount;
      return { ...track, playCount };
    });
    await writeJsonSafe(LIBRARY_CACHE_PATH(), libraryCache);
  }
  // The renderer's in-memory library.tracks is a separate copy from this disk
  // cache and is never reloaded on its own after this call, so without handing
  // the new counts back here the UI keeps showing whatever it had before the
  // replacement until the next full restart/rescan.
  return { ok:true, importedPlays, importedTracks: counts.size, matchedTracks, ambiguous, unmatchedTracks: Math.max(0, counts.size - matchedTracks - ambiguous), updatedPlayCounts };
}));

ipcMain.handle('yearly-wrap:getYears', async () => {
  const events = await readJsonSafe(LISTENING_EVENTS_PATH(), []);
  const state = await readJsonSafe(MUSICBEE_WRAPPED_IMPORTS_PATH(), { years: {} });
  const years = new Set();
  for (const e of Array.isArray(events) ? events : []) { const y = new Date(Number(e?.playedAt || 0)).getFullYear(); if (y >= 1900 && y <= 3000) years.add(y); }
  for (const y of Object.keys(state?.years || {})) { const n = Number(y); if (n >= 1900 && n <= 3000) years.add(n); }
  years.add(new Date().getFullYear());
  return [...years].sort((a,b) => b-a);
});

ipcMain.handle('history:get', async () => {
  const history = await readJsonSafe(HISTORY_PATH(), []);
  return Array.isArray(history) ? history.sort((a,b) => Number(b.playedAt || 0) - Number(a.playedAt || 0)) : [];
});

// Exact Yearly Wrap listening events. These are separate from history.json, which
// intentionally keeps only the latest entry per track for the History view. Each
// event represents one actual playback session and stores the measured listening
// duration so the Wrap can report minutes without guessing.
ipcMain.handle('listening:record', async (_evt, payload = {}) => {
  const event = {
    id: crypto.randomUUID(),
    playedAt: Number(payload.playedAt) || Date.now(),
    duration: Math.max(0, Number(payload.duration) || 0),
    trackDuration: Math.max(0, Number(payload.trackDuration) || 0),
    path: String(payload.path || ''),
    title: String(payload.title || ''),
    artist: String(payload.artist || ''),
    album: String(payload.album || ''),
    albumArtist: String(payload.albumArtist || ''),
    genre: String(payload.genre || ''),
    cover: payload.cover || null,
    artworkUrl: payload.artworkUrl || null,
    source: String(payload.source || ''),
    spotifyUri: String(payload.spotifyUri || ''),
    completed: !!payload.completed
  };
  if (!event.playedAt || !event.title && !event.path && !event.spotifyUri) return { ok:false, error:'missing track identity' };
  const events = await readJsonSafe(LISTENING_EVENTS_PATH(), []);
  const next = Array.isArray(events) ? events : [];
  next.unshift(event);
  await writeJsonSafe(LISTENING_EVENTS_PATH(), next.slice(0, 10000));
  // Mirror every play into the same per-year Wrapped store used for a MusicBee
  // import/export, unconditionally -- not only once the user has explicitly
  // imported a MusicBee archive. This is what lets "Export Hive Wrapped" work
  // from a totally clean install with no import ever performed, and it means
  // an eventual MusicBee import merges into the very same store Hive has
  // already been building on its own.
  try {
    const importState = await readJsonSafe(MUSICBEE_WRAPPED_IMPORTS_PATH(), { version: 2, years: {}, syncEnabled: false });
    const year = new Date(event.playedAt).getFullYear();
    const stored = await readMusicBeeStoredYear(HIVE_WRAPPED_DATA_ROOT(), year);
    if (stored) await appendMusicBeeHiveEvent(HIVE_WRAPPED_DATA_ROOT(), event);
    else {
      // listening-events.json also carries a copy of every play a MusicBee
      // import already wrote (source:'musicbee-wrapped', pushed by
      // yearly-wrap:importMusicBee) -- excluding those here is what keeps
      // this from resurrecting them as reformatted 'hive'-sourced duplicates
      // of plays the Wrapped store already has natively.
      const rows = next.filter(e => e?.source !== 'musicbee-wrapped' && new Date(Number(e?.playedAt || 0)).getFullYear() === year).map(e => ({
        fileUrl: e.path || e.legacyFileUrl || '', title: e.title || '', artist: e.artist || '', album: e.album || '', albumArtist: e.albumArtist || '', genre: e.genre || '', year: '', durationMs: Math.round(Math.max(0, Number(e.trackDuration) || 0) * 1000), playedAt: new Date(Number(e.playedAt)).toISOString(), playDuration: Math.round(Math.max(0, Number(e.duration) || 0)), playlistName: e.playlistName || 'Library', listeningMode: e.listeningMode || '', source: 'hive'
      }));
      await writeMusicBeeYearStore(HIVE_WRAPPED_DATA_ROOT(), year, rows);
    }
    try {
      const refreshed = await readMusicBeeStoredYear(HIVE_WRAPPED_DATA_ROOT(), year);
      const meta = refreshed ? musicBeeMetadataFor(year, refreshed.plays) : null;
      importState.years[String(year)] = { ...(importState.years[String(year)] || {}), year, updatedAt: Date.now(), source: importState.years[String(year)]?.source || 'Hive', storeDir: musicBeeYearDir(HIVE_WRAPPED_DATA_ROOT(), year), metadata: meta, storedPlayCount: refreshed?.plays?.length || 0 };
      await writeJsonSafe(MUSICBEE_WRAPPED_IMPORTS_PATH(), importState);
    } catch {}
  } catch (err) { console.warn('Could not update local Wrapped data store:', err?.message || err); }
  return { ok:true, id:event.id };
});


async function readEmbeddedPlayCount(trackPath) {
  const metadataLib = await ensureMM();
  const meta = await metadataLib.parseFile(trackPath, { duration: false, skipCovers: true });
  // The embedded field is a custom/user tag (P_COUNT), which music-metadata does
  // not surface under `common` for any container format (it only maps well-known
  // fields there). Reading `common.p_count`/`common.pcount` here always silently
  // returned 0 regardless of what was actually embedded -- scan the raw native
  // tag list instead, the same way readNativeEmbeddedRating already does for
  // FMPS_Rating.
  const extractText = raw => {
    if (raw === null || raw === undefined) return '';
    if (Array.isArray(raw)) return raw.length ? extractText(raw[0]) : '';
    if (typeof raw === 'object') return extractText(raw.text ?? raw.value ?? raw.description ?? '');
    return String(raw);
  };
  let value = 0;
  for (const tagList of Object.values(meta.native || {})) {
    for (const tag of (Array.isArray(tagList) ? tagList : [])) {
      // ID3v2 TXXX and MP4 freeform atoms come back namespaced ("TXXX:P_COUNT",
      // "----:com.apple.iTunes:P_COUNT"); compare the segment after the last ':'
      // so bare (FLAC/Vorbis, ASF) and namespaced ids both match.
      const rawId = String(tag?.id || '');
      const id = (rawId.includes(':') ? rawId.slice(rawId.lastIndexOf(':') + 1) : rawId).toUpperCase();
      const desc = String(tag?.value?.description || '').toUpperCase();
      if (id !== 'P_COUNT' && desc !== 'P_COUNT') continue;
      const n = Number.parseInt(extractText(tag?.value).trim(), 10);
      if (Number.isFinite(n) && n >= 0) value = Math.max(value, n);
    }
  }
  return value;
}

async function writeEmbeddedPlayCount(trackPath, value) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  const nextValue = Math.max(0, Math.min(0xFFFFFFFF, Math.floor(Number(value) || 0)));
  // Every other metadata writer (Rating, Love, artwork, general tag-editor
  // save) marks its own write as internal before touching the file, so the
  // library filesystem watcher ignores it instead of treating Hive's own
  // write as an external change. This one didn't, so simply listening to a
  // song to completion -- which embeds its updated P_count here -- was
  // silently triggering a debounced library rescan and a visible refresh of
  // whatever view was open, ~900ms later, for no user-visible reason.
  markLibraryInternalWrite(trackPath);
  const temp = await createMetadataTempPath(trackPath, 'pcount');
  const artworkBefore = await runTagHelper({ op:'artwork_fingerprint', path:trackPath });
  try {
    await copyMetadataFile(trackPath, temp, false);
    // Metadata writes are deliberately delegated to the bundled Mutagen backend.
    // No FFmpeg/container reconstruction is allowed for a one-field tag edit --
    // it was rewriting the entire audio stream just to change one tag, and its
    // "success" was never actually verified correctly (see readEmbeddedPlayCount).
    await runTagHelper({ op:'write_pcount', path:temp, count:nextValue });
    const written = await readEmbeddedPlayCount(temp);
    if (written !== nextValue) {
      throw new Error(`P_count verification failed: expected ${nextValue}, read back ${written}`);
    }
    const artworkAfter = await runTagHelper({ op:'artwork_fingerprint', path:temp });
    if (artworkBefore?.fingerprint !== artworkAfter?.fingerprint) {
      throw new Error('P_count write changed embedded artwork unexpectedly; the original file was left untouched.');
    }
    await commitMetadataTemp(temp, trackPath, false);
    return nextValue;
  } catch (err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not embed P_count: ${err.message}`);
  }
}

async function embedPlayCountDelta(trackPath, delta) {
  const amount = Math.max(0, Math.floor(Number(delta) || 0));
  if (!amount) return { embedded: false, pCount: await readEmbeddedPlayCount(trackPath) };
  return withMusicBeeWriteLock(trackPath, async () => {
    const current = await readEmbeddedPlayCount(trackPath);
    const next = Math.min(0xFFFFFFFF, current + amount);
    await writeEmbeddedPlayCount(trackPath, next);
    return { embedded: true, pCount: next };
  });
}

ipcMain.handle('track:recordPlay', async (_evt, trackPath, meta = {}) => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  const entry = stats[trackPath] || { playCount: 0, lastPlayedAt: 0 };
  entry.playCount = Number(entry.playCount || 0) + 1;
  entry.lastPlayedAt = Date.now();
  stats[trackPath] = entry;

  // If enabled, embed only the new local plays since the last successful
  // embedding. This preserves the file's existing P_count and prevents a
  // second enable/restart from adding the same local plays twice.
  let pCountEmbedding = null;
  try {
    const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
    if (config.embedPlayCounts !== false) {
      const previousEmbeddedLocal = Number(entry.pCountEmbeddedLocal);
      const baseline = Number.isFinite(previousEmbeddedLocal) && previousEmbeddedLocal >= 0 ? previousEmbeddedLocal : 0;
      const delta = Math.max(0, entry.playCount - baseline);
      if (delta > 0) {
        pCountEmbedding = await embedPlayCountDelta(trackPath, delta);
        entry.pCountEmbeddedLocal = entry.playCount;
        stats[trackPath] = entry;
      } else if (entry.playCount >= baseline) {
        entry.pCountEmbeddedLocal = entry.playCount;
        stats[trackPath] = entry;
      }
    }
  } catch (err) {
    // Local play statistics must never be lost because embedding failed.
    // The baseline is intentionally left unchanged so the next play can retry
    // the outstanding local delta instead of silently losing it.
    console.warn('Could not embed local play count into file:', trackPath, err?.message || err);
    pCountEmbedding = { embedded: false, error: err?.message || String(err) };
  }
  await writeJsonSafe(STATS_PATH(), stats);

  // Do not rewrite the entire library cache for an individual play. The cache
  // can be tens of megabytes and is a startup/view cache, while STATS_PATH is
  // the durable source for play statistics. Rewriting it here caused a full
  // JSON stringify + gzip on every track transition.

  const history = await readJsonSafe(HISTORY_PATH(), []);
  const snapshot = { title: meta.title || '', artist: meta.artist || '', album: meta.album || '', cover: meta.cover || null, artworkUrl: meta.artworkUrl || null, source: meta.source || '', spotifyUri: meta.spotifyUri || '' };
  const next = [{ path: trackPath, playedAt: entry.lastPlayedAt, ...snapshot }, ...history.filter(h => h.path !== trackPath)];
  await writeJsonSafe(HISTORY_PATH(), next.slice(0, 500));
  return { ...entry, pCountEmbedding };
}));


ipcMain.handle('yearly-wrap:getData', async (_evt, requestedYear) => {
  const year = Number.isInteger(Number(requestedYear)) ? Number(requestedYear) : new Date().getFullYear();
  const events = await readJsonSafe(LISTENING_EVENTS_PATH(), []);
  const history = await readJsonSafe(HISTORY_PATH(), []);
  let library = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const tracks = Array.isArray(library?.tracks) ? library.tracks : [];
  const byPath = new Map(tracks.map(t => [String(t?.path || ''), t]));
  const normalizeLegacy = value => String(value || '').trim().toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ');
  const byLegacyFile = new Map();
  const byMetadata = new Map();
  for (const t of tracks) {
    const file = path.basename(String(t?.path || '')).toLowerCase();
    if (file && !byLegacyFile.has(file)) byLegacyFile.set(file, t);
    const key = [t?.title,t?.artist,t?.album].map(normalizeLegacy).join('\u0000');
    if (key.replace(/\u0000/g,'').trim() && !byMetadata.has(key)) byMetadata.set(key, t);
  }
  const resolveLegacyTrack = e => {
    if (e?.path && byPath.has(String(e.path))) return byPath.get(String(e.path));
    const legacyFile = String(e?.legacyFileUrl || '').replace(/\\/g, '/');
    const byFile = byLegacyFile.get(path.basename(legacyFile).toLowerCase());
    if (byFile) return byFile;
    const key = [e?.title,e?.artist,e?.album].map(normalizeLegacy).join('\u0000');
    return byMetadata.get(key) || null;
  };
  const exact = (Array.isArray(events) ? events : []).filter(e => new Date(Number(e?.playedAt || 0)).getFullYear() === year);
  let rows = exact.map(e => {
    const matched = resolveLegacyTrack(e);
    return {
      ...e,
      duration: Math.max(0, Number(e?.duration) || 0),
      trackDuration: Math.max(0, Number(e?.trackDuration) || Number(matched?.duration) || 0),
      title: e?.title || matched?.title || 'Unknown track', artist: e?.artist || matched?.artist || 'Unknown artist', album: e?.album || matched?.album || 'Unknown album',
      albumArtist: e?.albumArtist || matched?.albumArtist || '', genre: e?.genre || matched?.genre || '',
      cover: e?.cover || e?.artworkUrl || matched?.cover || matched?.artworkUrl || null,
      artworkUrl: e?.artworkUrl || matched?.artworkUrl || null
    };
  });
  let estimated = false;
  // Build 37/40 users have history.json but no per-play listening log yet. We can
  // still show useful retrospective information without pretending old play
  // counts were year-specific: use one saved last-played entry per track and the
  // library's real duration as an explicitly marked estimate.
  if (!rows.length) {
    rows = (Array.isArray(history) ? history : []).filter(e => new Date(Number(e?.playedAt || 0)).getFullYear() === year).map(e => {
      const t = byPath.get(String(e?.path || '')) || {};
      return {
        id: `legacy:${e.path || ''}:${e.playedAt || ''}`,
        playedAt: Number(e?.playedAt || 0),
        duration: Math.max(0, Number(e?.duration) || Number(t?.duration) || 0),
        trackDuration: Math.max(0, Number(t?.duration) || 0),
        path: e?.path || '', title: e?.title || t?.title || 'Unknown track',
        artist: e?.artist || t?.artist || 'Unknown artist', album: e?.album || t?.album || 'Unknown album',
        albumArtist: e?.albumArtist || t?.albumArtist || '', genre: e?.genre || t?.genre || '',
        cover: e?.cover || e?.artworkUrl || t?.cover || t?.artworkUrl || null,
        artworkUrl: e?.artworkUrl || t?.artworkUrl || null, source: e?.source || t?.source || '', spotifyUri: e?.spotifyUri || t?.spotifyUri || '', completed:false
      };
    });
    estimated = rows.length > 0;
  }
  const add=(map,key,amount=1)=>map.set(key,(map.get(key)||0)+amount);
  const byTrack=new Map(), byArtist=new Map(), byAlbum=new Map(), byGenre=new Map(), byDay=new Map(), byMonth=new Map();
  let totalSeconds=0;
  for(const e of rows){
    const duration=Math.max(0,Number(e.duration)||0); totalSeconds+=duration;
    add(byTrack,`${e.title}\u0000${e.artist}`,1); add(byArtist,e.artist,1); add(byAlbum,`${e.album}\u0000${e.artist}`,1);
    if(e.genre) add(byGenre,e.genre,duration);
    const d=new Date(Number(e.playedAt||0)); if(Number.isNaN(d.getTime())) continue;
    const day=d.toISOString().slice(0,10), month=day.slice(0,7); add(byDay,day,duration); add(byMonth,month,duration);
  }
  const top=(map,limit=5)=>[...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit);
  const topTrack=top(byTrack,1)[0];
  const topArtist=top(byArtist,1)[0];
  const topAlbum=top(byAlbum,1)[0];
  const topDay=top(byDay,1)[0];
  const topMonth=top(byMonth,1)[0];
  const firstCoverFor = predicate => {
    const row = rows.find(predicate);
    return row?.cover || row?.artworkUrl || null;
  };
  const topTrackCover=topTrack ? firstCoverFor(e=>`${e.title}\u0000${e.artist}`===topTrack[0]) : null;
  const topArtistRows = top(byArtist,5).map(([name,plays]) => ({ name, plays, cover:firstCoverFor(e=>e.artist===name) }));
  const topAlbumRows = top(byAlbum,5).map(([key,plays])=>{
    const [album,artist]=key.split('\u0000');
    return { album, artist, plays, cover:firstCoverFor(e=>e.album===album && e.artist===artist) };
  });
  const listeningDays=[...byDay.keys()].sort();
  let longestStreak=0,currentStreak=0,prev=null;
  for(const key of listeningDays){ const d=new Date(`${key}T12:00:00`); if(prev && Math.round((d-prev)/86400000)===1) currentStreak++; else currentStreak=1; longestStreak=Math.max(longestStreak,currentStreak); prev=d; }
  const monthRows=[...byMonth.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([month,seconds])=>({month,seconds}));
  const importedState = await readJsonSafe(MUSICBEE_WRAPPED_IMPORTS_PATH(), { years: {} });
  const importedMetadata = importedState?.years?.[String(year)]?.metadata || null;
  const imported = !!importedMetadata;
  return {
    year, estimated, imported, trackingSource: imported ? 'musicbee-wrapped + hive-events' : (estimated ? 'saved-history-estimate' : 'exact-listening-events'),
    importedMetadata,
    totalSeconds, totalPlays: rows.length, uniqueArtists: byArtist.size, uniqueAlbums: byAlbum.size,
    topTrack: topTrack ? (() => { const row=rows.find(e=>`${e.title}\u0000${e.artist}`===topTrack[0]) || {}; return { key:topTrack[0], plays:topTrack[1], album:row.album || '', cover:topTrackCover }; })() : null,
    topArtists: topArtistRows,
    topAlbums: topAlbumRows,
    topGenres: top(byGenre,5).map(([name,seconds])=>({name,seconds})),
    topDay: topDay ? {date:topDay[0],seconds:topDay[1]} : null,
    topMonth: topMonth ? {month:topMonth[0],seconds:topMonth[1]} : null,
    longestStreak, monthly:monthRows,
    rows: rows.slice(0,100).map(e=>({playedAt:e.playedAt,title:e.title,artist:e.artist,album:e.album,duration:e.duration,cover:e.cover || e.artworkUrl || null,source:e.source || ''}))
  };
});

async function readLibraryTracksForPlayCountSync() {
  const libraryCache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  return {
    libraryCache,
    tracks: Array.isArray(libraryCache?.tracks) ? libraryCache.tracks : []
  };
}

// Force-overwriting embedded play counts is for the clean-install / "I just
// imported and replaced my MusicBee Wrapped play counts" scenario: unlike
// the normal Embed action above (which only ever adds a delta on top of
// what's already in the file, so a lower Hive count never overwrites a
// higher existing embedded one), this writes Hive's current local count into
// the file exactly as-is -- even if that's lower than what's already
// embedded -- then resets the pCountEmbeddedLocal baseline so every later
// Embed goes back to being a normal incremental delta on top of this new
// starting point.
ipcMain.handle('stats:forceEmbedPlayCounts', async (_evt, paths) => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  const { libraryCache } = await readLibraryTracksForPlayCountSync();
  const results = { total: 0, embedded: 0, unchanged: 0, failed: 0, errors: [] };
  // Scoped to the given paths when provided -- e.g. the Import flow only
  // wants the songs it just imported/replaced stamped into their files, not
  // every track Hive has ever recorded a play for. Omitting `paths`
  // force-embeds the whole library, for callers that genuinely want that.
  const scopedPaths = Array.isArray(paths) && paths.length ? new Set(paths.map(p => String(p || ''))) : null;
  const entries = scopedPaths
    ? [...scopedPaths].filter(p => p).map(p => [p, stats[p]])
    : Object.entries(stats);
  // Each changed file involves a full-file backup+hash and an ffmpeg remux
  // (rewriting the entire audio stream just to change one tag), so running
  // these one at a time made importing/overwriting play counts for a large
  // Wrapped history visibly slow. Every other per-track I/O loop in this
  // file (readEmbeddedPlayCount scans, the earlier embed-conflict scan,
  // etc.) uses this same bounded worker-pool pattern; this one just hadn't
  // been converted.
  let cursor = 0;
  const workerCount = Math.min(8, Math.max(1, entries.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= entries.length) return;
      const [trackPath, rawEntry] = entries[i];
      if (!trackPath) continue;
      const entry = rawEntry && typeof rawEntry === 'object' ? { ...rawEntry } : {};
      const localCount = Math.max(0, Math.floor(Number(entry.playCount) || 0));
      results.total += 1;
      try {
        const existing = await readEmbeddedPlayCount(trackPath);
        if (existing === localCount) {
          entry.pCountEmbeddedLocal = localCount;
          stats[trackPath] = entry;
          results.unchanged += 1;
          continue;
        }
        await waitForPlaybackProtectionRelease(trackPath);
        await writeEmbeddedPlayCount(trackPath, localCount);
        entry.pCountEmbeddedLocal = localCount;
        stats[trackPath] = entry;
        results.embedded += 1;
      } catch (err) {
        results.failed += 1;
        if (results.errors.length < 100) results.errors.push({ path: trackPath, error: err?.message || String(err) });
      }
    }
  });
  await Promise.all(workers);
  await writeJsonSafe(STATS_PATH(), stats);
  if (Array.isArray(libraryCache?.tracks)) {
    libraryCache.tracks = libraryCache.tracks.map(track => {
      const entry = stats[track.path];
      return entry ? { ...track, playCount: Number(entry.playCount || 0) } : track;
    });
    await writeJsonSafe(LIBRARY_CACHE_PATH(), libraryCache);
  }
  return results;
}));

ipcMain.handle('stats:clearPlayCounts', async () => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  let cleared = 0;
  const nextStats = { ...stats };
  for (const [trackPath, rawEntry] of Object.entries(nextStats)) {
    const entry = rawEntry && typeof rawEntry === 'object' ? { ...rawEntry } : {};
    const previous = Number(entry.playCount || 0);
    if (previous > 0) cleared += previous;
    entry.playCount = 0;
    // Clearing Beehive's local counter must not erase the file's P_count.
    // Reset only the local embedding baseline so future plays are added again
    // starting from zero local plays.
    entry.pCountEmbeddedLocal = 0;
    nextStats[trackPath] = entry;
  }
  await writeJsonSafe(STATS_PATH(), nextStats);

  // Keep the cached library in sync so the UI and the next startup both show
  // zero Beehive play counts without rescanning or touching any music files.
  const libraryCache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  if (Array.isArray(libraryCache.tracks)) {
    libraryCache.tracks = libraryCache.tracks.map(track => ({ ...track, playCount: 0 }));
    await writeJsonSafe(LIBRARY_CACHE_PATH(), libraryCache);
  }

  // stats.json/library cache are just a display cache -- the actual source
  // of truth for play history is listening-events.json and the Hive Wrapped
  // Data store, which this used to leave completely untouched. That made
  // Clear Play Counts look like a full reset while native listening history
  // quietly survived underneath, so a later Wrapped import would still merge
  // in "cleared" native plays instead of starting from a clean slate.
  // Archive-imported history (source:'musicbee-wrapped' / 'import') is
  // deliberately preserved -- clearing is about forgetting Hive's own
  // tracked listens, not about forgetting an archive you already imported.
  const events = await readJsonSafe(LISTENING_EVENTS_PATH(), []);
  if (Array.isArray(events)) {
    const keptEvents = events.filter(e => e?.source === 'musicbee-wrapped');
    await writeJsonSafe(LISTENING_EVENTS_PATH(), keptEvents);
  }
  try {
    const root = HIVE_WRAPPED_DATA_ROOT();
    if (root && fs.existsSync(root)) {
      const years = fs.readdirSync(root).filter(n => /^\d+$/.test(n)).map(Number);
      for (const year of years) {
        const stored = await readMusicBeeStoredYear(root, year);
        const priorPlays = stored?.plays || [];
        const survivors = priorPlays.filter(p => p.source !== 'hive');
        if (survivors.length !== priorPlays.length) await writeMusicBeeYearStore(root, year, survivors);
      }
    }
  } catch (err) {
    console.warn('Could not clear native plays from the Wrapped data store:', err?.message || err);
  }

  return { cleared };
}));

ipcMain.handle('tracks:setRatings', async (evt, trackPaths = [], rating) => withStatsMutation(async () => {
  const paths = [...new Set((Array.isArray(trackPaths) ? trackPaths : [])
    .filter(Boolean)
    .map(p => String(p)))];
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  const stats = await readJsonSafe(STATS_PATH(), {});
  const results = { updated: 0, failed: 0, errors: [] };
  const total = paths.length;
  sendTagProgress(evt, { active: true, operation: 'rating', operationLabel: `Rating ${total.toLocaleString()} files`, phase: 'Writing ratings', done: 0, total, updated: 0, failed: 0, current: '' });
  let lastProgressAt = 0;
  try {
    // Serialize bulk writes. The underlying writers replace complete media
    // files (MP3/WAV ID3 rewrites and FFmpeg container rewrites), so parallel
    // metadata jobs can race with filesystem watchers/decoders and make a
    // bulk Clear appear to succeed while one or more files retain the old
    // rating. Individual rating writes were already serialized by their own
    // file locks; bulk now follows the same safe rule.
    for (let i = 0; i < paths.length; i++) {
      const trackPath = paths[i];
      const recoveryJob = { id:crypto.randomUUID(), kind:'rating', path:path.resolve(String(trackPath)), rating:value, createdAt:Date.now() };
      await persistMetadataJob(recoveryJob, 'running', 1, '');
      try {
        markLibraryInternalWrite(trackPath);
        await embedRatingInFile(trackPath, value);
        const entry = stats[trackPath] || { playCount: 0, lastPlayedAt: 0 };
        entry.rating = value;
        entry.ratingSource = 'beehive';
        stats[trackPath] = entry;
        results.updated += 1;
        await deleteMetadataJob(recoveryJob.id);
      } catch (err) {
        results.failed += 1;
        await updateMetadataJob(recoveryJob.id, 'retry', 1, err?.message || String(err));
        results.errors.push({ path: trackPath, error: err?.message || String(err) });
      }

      const done = i + 1;
      const now = Date.now();
      if (done === total || now - lastProgressAt >= 100) {
        lastProgressAt = now;
        sendTagProgress(evt, { active: true, operation: 'rating', operationLabel: `Rating ${total.toLocaleString()} files`, phase: 'Writing ratings', done, total, updated: results.updated, failed: results.failed, current: path.basename(trackPath) });
      }
    }
    await writeJsonSafe(STATS_PATH(), stats);
    return { ...results, rating: value };
  } finally {
    sendTagProgress(evt, { active: false, operation: 'rating', operationLabel: 'Rating complete', phase: results.failed ? 'Finished with errors' : 'Finished', done: total, total, updated: results.updated, failed: results.failed, current: '' });
  }
}));

ipcMain.handle('track:setRating', async (_evt, trackPath, rating) => withStatsMutation(async () => {
  const stats = await readJsonSafe(STATS_PATH(), {});
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  const entry = stats[trackPath] || { playCount: 0, lastPlayedAt: 0 };
  const recoveryJob = { id:crypto.randomUUID(), kind:'rating', path:path.resolve(String(trackPath)), rating:value, createdAt:Date.now() };
  await persistMetadataJob(recoveryJob, 'running', 1, '');
  try {
    await embedRatingInFile(trackPath, value);
    await deleteMetadataJob(recoveryJob.id);
  } catch (err) {
    await updateMetadataJob(recoveryJob.id, 'retry', 1, err?.message || String(err));
    throw err;
  }
  entry.rating = value;
  entry.ratingSource = 'beehive';
  stats[trackPath] = entry;
  await writeJsonSafe(STATS_PATH(), stats);
  return value;
}));

ipcMain.handle('track:readLove', async (_evt, trackPath) => {
  try { return await readLoveStateFromDisk(trackPath); }
  catch { return false; }
});

ipcMain.handle('tracks:readLove', async (_evt, paths = []) => {
  const out = {};
  const list = Array.isArray(paths) ? [...new Set(paths.filter(Boolean).map(String))] : [];
  let cursor = 0;
  const concurrency = 12;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      const filePath = list[i];
      try { out[filePath] = await readLoveStateFromDisk(filePath); }
      catch { out[filePath] = false; }
    }
  });
  await Promise.all(workers);
  return out;
});

ipcMain.handle('library:needsLovedRefresh', async () => {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const tracks = Array.isArray(cache.tracks) ? cache.tracks : [];
  // Only request the one-time migration refresh when we have tracks that have
  // never had their embedded Love state successfully checked. Normal scans
  // mark new/changed files with their exact mtime/size, so they do not need a
  // second full-library Love pass on the next startup.
  return tracks.some(t => t && (t.loveHydrated !== true || !Number.isFinite(Number(t.loveCheckedMtimeMs)) || !Number.isFinite(Number(t.loveCheckedSize)) || Number(t.loveScanVersion || 0) < LOVE_SCAN_VERSION));
});

ipcMain.handle('library:refreshLoved', async (evt) => {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const tracks = Array.isArray(cache.tracks) ? cache.tracks : [];
  const total = tracks.length;
  let done = 0, loved = 0, failed = 0;
  let cursor = 0, lastProgressAt = 0;
  sendTagProgress(evt, { active: true, operation: 'love-refresh', operationLabel: 'Refreshing Favorites', phase: 'Reading embedded Love state', done: 0, total, updated: 0, failed: 0, skipped: 0, current: '' });
  try {
    if (!total) return { tracks: [], total: 0, loved: 0, failed: 0 };
    const concurrency = Math.min(24, total);
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= total) return;
        const track = tracks[i];
        const filePath = String(track?.path || '');
        try {
          const exists = !!filePath && fs.existsSync(filePath);
          if (!exists) throw new Error('File not found');
          const stat = await fs.promises.stat(filePath);
          const value = !!(await readLoveStateFromDisk(filePath));
          track.loved = value;
          track.loveHydrated = true;
          track.loveCheckedMtimeMs = Number(stat.mtimeMs || 0);
          track.loveCheckedCtimeMs = Number(stat.ctimeMs || 0);
          track.loveCheckedSize = Number(stat.size || 0);
          track.loveScanVersion = LOVE_SCAN_VERSION;
          if (value) loved++;
        } catch (err) {
          failed++;
          // A failed read is not a successful check. Keep the previous cached
          // Love value and leave the check markers untouched so a later manual
          // refresh can retry it.
        }
        done++;
        const now = Date.now();
        if (done === total || now - lastProgressAt >= 150) {
          lastProgressAt = now;
          sendTagProgress(evt, { active: true, operation: 'love-refresh', operationLabel: 'Refreshing Favorites', phase: 'Reading embedded Love state', done, total, updated: loved, failed, skipped: 0, current: path.basename(filePath) });
        }
      }
    });
    await Promise.all(workers);
    cache.tracks = tracks;
    await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
    await persistLibraryDatabase(tracks);
    scanLog('Favorites Love reconciliation finished', { total, loved, failed });
    return { tracks, total, loved, failed };
  } finally {
    sendTagProgress(evt, { active: false, operation: 'love-refresh', operationLabel: failed ? 'Favorites refresh finished with errors' : 'Favorites refresh complete', phase: failed ? 'Some files could not be checked' : 'Finished', done, total, updated: loved, failed, skipped: 0, current: '' });
  }
});

ipcMain.handle('tracks:readRatings', async (_evt, paths = []) => {
  const out = {};
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  const readOne = async (filePath) => {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.mp3') {
        const raw = await readMp3PopmRaw(filePath);
        // MusicBee's 5-star POPM value is exactly 255. Treat that byte as
        // authoritative rather than relying on any normalized parser output.
        out[filePath] = { stars: raw === 255 ? 5 : musicBeePopmStars(raw), raw };
        return;
      }
      const stars = await readEmbeddedRating(filePath);
      out[filePath] = { stars, raw: 0 };
    } catch {
      // Leave an unreadable/unsupported file alone rather than falsely setting it to zero.
    }
  };
  const concurrency = 12;
  let cursor = 0;
  const workers = Array.from({length: Math.min(concurrency, list.length)}, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      await readOne(list[i]);
    }
  });
  await Promise.all(workers);
  return out;
});

ipcMain.handle('tracks:updateCachedLoves', async (_evt, loves = {}) => {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const values = loves && typeof loves === 'object' ? loves : {};
  let changed = false;
  for (const t of (cache.tracks || [])) {
    if (!t?.path || !Object.prototype.hasOwnProperty.call(values, t.path)) continue;
    const value = !!values[t.path];
    if (!!t.loved !== value || t.loveHydrated !== true) changed = true;
    t.loved = value;
    t.loveHydrated = true;
    t.loveScanVersion = LOVE_SCAN_VERSION;
  }
  if (changed) await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
  return true;
});

ipcMain.handle('tracks:updateCachedRatings', async (_evt, ratings = {}) => {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const values = ratings && typeof ratings === 'object' ? ratings : {};
  for (const t of (cache.tracks || [])) {
    if (!t?.path || !Object.prototype.hasOwnProperty.call(values, t.path)) continue;
    t.rating = Math.max(0, Math.min(5, Number(values[t.path]) || 0));
    t.ratingRaw = t.rating >= 5 ? 255 : 0;
    t.ratingHydrated = true;
  }
  await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
  return true;
});

ipcMain.handle('tracks:embedRatings', async (_evt, tracks = []) => {
  const results = { embedded: 0, failed: 0, errors: [] };
  for (const item of Array.isArray(tracks) ? tracks : []) {
    try {
      if (!item?.path) continue;
      await embedRatingInFile(item.path, Number(item.rating) || 0);
      results.embedded += 1;
    } catch (err) {
      results.failed += 1;
      results.errors.push({ path: item?.path, error: err.message });
    }
  }
  return results;
});

function decodeGeniusHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '\"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } });
}

// A plain non-greedy regex ([\s\S]*?...<\/div>) cannot correctly match a
// <div> against ITS OWN closing tag once there are other <div>s nested
// inside it -- it stops at the first </div> it finds, which is usually one
// of the nested ones, silently truncating or fragmenting the real content.
// Genius's lyrics containers are full of nested <div>s (line groups,
// annotation spans, etc.), so this walks the tag depth by hand from just
// after the opening tag's '>' to find the TRUE matching close tag.
function extractBalancedDiv(html, contentStart) {
  const tagRe = /<div\b[^>]*>|<\/div>/gi;
  tagRe.lastIndex = contentStart;
  let depth = 1;
  let match;
  while ((match = tagRe.exec(html))) {
    if (match[0].startsWith('</')) depth--;
    else depth++;
    if (depth === 0) return { content: html.slice(contentStart, match.index), end: tagRe.lastIndex };
  }
  return { content: html.slice(contentStart), end: html.length };
}

// Real bug, confirmed live: the old non-greedy data-lyrics-container regex
// fragmented every real Genius lyrics page into broken pieces (see
// extractBalancedDiv above), and one of those broken pieces was the page's
// own "3 Contributors / <Song> Lyrics" header bar, which then got
// concatenated straight into the embedded/displayed lyrics text. Genius
// marks that header (and similar non-lyrics UI, e.g. embed/share prompts)
// with data-exclude-from-selection="true" site-wide -- a stable semantic
// signal, unlike its auto-generated/versioned CSS class names -- so strip
// any such block, correctly balanced, before converting to plain text.
function stripGeniusExcludedBlocks(html) {
  let out = '';
  let cursor = 0;
  const openRe = /<div\b[^>]*\bdata-exclude-from-selection=["']true["'][^>]*>/gi;
  let match;
  while ((match = openRe.exec(html))) {
    out += html.slice(cursor, match.index);
    const { end } = extractBalancedDiv(html, match.index + match[0].length);
    cursor = end;
    openRe.lastIndex = end;
  }
  return out + html.slice(cursor);
}

function stripGeniusLyricsHtml(html) {
  return decodeGeniusHtmlEntities(stripGeniusExcludedBlocks(String(html || ''))
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(?:div|p|li|h[1-6])>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
  ).replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeLyricMatch(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function searchGeniusLyrics(artist, title) {
  const query = `${artist} ${title}`.trim();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
  };
  const wantedArtist = normalizeLyricMatch(artist);
  const wantedTitle = normalizeLyricMatch(title);
  const candidates = [];

  // Real bug, confirmed live: genius.com/search now renders its actual
  // results client-side (React/Next.js) -- the server-sent HTML is just an
  // app shell whose only *-lyrics links are a fixed "trending songs" widget,
  // completely unrelated to the query. This was previously tried FIRST and
  // gated the JSON API fallback behind `!candidates.length`, but the widget
  // is always present and non-empty, so the (working) API path below was
  // never actually reached except by the rare coincidence of a query
  // matching one of those trending songs (e.g. "Radiohead Creep").
  // genius.com/api/search/multi returns real, correctly-attributed
  // structured results (title/artist/url) and needs no token -- use it first.
  try {
    const apiResponse = await fetch(`https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(query)}`, { headers });
    if (apiResponse.ok) {
      const data = await apiResponse.json();
      for (const section of (data?.response?.sections || [])) {
        for (const hit of (section?.hits || [])) {
          const result = hit?.result;
          const url = String(result?.url || '');
          if (/^https?:\/\/genius\.com\/[^\s]+-lyrics$/i.test(url) && !candidates.some(c => c.url === url)) {
            candidates.push({ url, title: result?.title, artist: result?.primary_artist?.name });
          }
        }
      }
    } else {
      console.error(`[lyrics] Genius search API returned HTTP ${apiResponse.status} for "${query}"`);
    }
  } catch (err) {
    console.error(`[lyrics] Genius search API request failed for "${query}":`, err?.message || err);
  }

  // Last-resort fallback only: the search-page scrape below cannot return
  // real per-query results (see above), but is harmless to try if the API
  // itself was unreachable -- scoring below still requires both artist and
  // title to match, so it can only ever help, never replace a good result
  // with an unrelated trending song.
  if (!candidates.length) {
    try {
      const searchResponse = await fetch(`https://genius.com/search?q=${encodeURIComponent(query)}`, { headers });
      if (searchResponse.ok) {
        const html = await searchResponse.text();
        const hrefRe = /(?:href|data-href)=[\"'](?:https?:\/\/genius\.com)?(\/[^\"']+?-lyrics)(?:[\"'])/gi;
        let match;
        while ((match = hrefRe.exec(html))) {
          const href = `https://genius.com${match[1]}`;
          if (!candidates.some(c => c.url === href)) candidates.push({ url: href });
        }
      }
    } catch (_) {}
  }

  // Score candidate slugs/metadata so a broad Genius search does not accidentally
  // display a similarly named song by another artist.
  const scoreGeniusCandidate = item => {
    const hay = normalizeLyricMatch(`${item.title || ''} ${item.artist || ''} ${item.url || ''}`);
    let n = 0;
    if (wantedTitle && hay.includes(wantedTitle)) n += 4;
    if (wantedArtist && hay.includes(wantedArtist)) n += 4;
    return n;
  };
  candidates.sort((a, b) => scoreGeniusCandidate(b) - scoreGeniusCandidate(a));

  if (!candidates.length) {
    console.error(`[lyrics] Genius returned zero candidate URLs for "${query}" (both the search page and API discovery paths found nothing)`);
    return null;
  }

  // Require both artist and title to be represented in the Genius result before
  // displaying it. A broad search must never silently replace the requested song
  // with a similarly titled track.
  const passing = candidates.filter(item => scoreGeniusCandidate(item) >= 8).slice(0, 8);
  if (!passing.length) {
    console.error(`[lyrics] ${candidates.length} Genius candidate(s) found for "${query}" but none matched both artist and title closely enough (best score ${scoreGeniusCandidate(candidates[0])}/8, top result: ${candidates[0]?.url})`);
    return null;
  }
  for (const candidate of passing) {
    try {
      const response = await fetch(candidate.url, { headers });
      if (!response.ok) { console.error(`[lyrics] Genius lyrics page returned HTTP ${response.status} for ${candidate.url}`); continue; }
      const html = await response.text();
      const blocks = [];
      const containerOpenRe = /<div\b[^>]*\bdata-lyrics-container=["']true["'][^>]*>/gi;
      let openMatch;
      while ((openMatch = containerOpenRe.exec(html))) {
        const { content, end } = extractBalancedDiv(html, openMatch.index + openMatch[0].length);
        const text = stripGeniusLyricsHtml(content);
        if (text) blocks.push(text);
        containerOpenRe.lastIndex = end;
      }
      const lyrics = blocks.join('\n\n').trim();
      if (lyrics) return { plainLyrics: lyrics, syncedLyrics: '', source: 'genius' };
      console.error(`[lyrics] Genius lyrics page for ${candidate.url} had no data-lyrics-container blocks (page layout may have changed)`);
    } catch (err) {
      console.error(`[lyrics] fetching Genius lyrics page ${candidate.url} failed:`, err?.message || err);
    }
  }
  return null;
}

async function searchLrcLibLyrics(artist, title, album, duration) {
  const params = new URLSearchParams({ track_name: title, artist_name: artist });
  if (album) params.set('album_name', album);
  if (Number.isFinite(duration) && duration > 0) params.set('duration', String(Math.round(duration)));
  try {
    const response = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
      headers: { 'User-Agent': 'Hive/1.0 (BeehiveMusicBrainz)' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return selectPreferredLyrics({
      syncedLyrics: data?.syncedLyrics,
      plainLyrics: data?.plainLyrics,
      source: 'lrclib'
    });
  } catch (_) {
    return null;
  }
}

ipcMain.handle('lyrics:search', async (_evt, query = {}) => {
  const artist = String(query.artist || '').trim();
  const title = String(query.title || '').trim();
  const album = String(query.album || '').trim();
  const duration = Number(query.duration || 0);
  const highlightedLyrics = query.highlightedLyrics !== false;
  if (!artist || !title) return null;

  // Highlighted lyrics mode deliberately makes synchronized lyrics the first
  // choice: LRCLIB is queried first and its timestamped payload wins. If it has
  // no synchronized result, fall back to Genius plain lyrics. When the user turns
  // Highlighted lyrics off, skip LRCLIB entirely and use Genius only.
  if (highlightedLyrics) {
    const lrclib = await searchLrcLibLyrics(artist, title, album, duration);
    if (lrclib?.synced) return lrclib;
    const geniusLyrics = await searchGeniusLyrics(artist, title);
    if (geniusLyrics) return selectPreferredLyrics(geniusLyrics);
    return lrclib;
  }

  const geniusLyrics = await searchGeniusLyrics(artist, title);
  return geniusLyrics ? selectPreferredLyrics(geniusLyrics) : null;
});

ipcMain.handle('track:hasEmbeddedArtwork', async (_evt, trackPath) => {
  if (!trackPath || !fs.existsSync(trackPath)) return false;
  try {
    const native = await runTagHelper({ op: 'read_artwork_metadata', path: trackPath });
    return Array.isArray(native?.pictures) && native.pictures.length > 0;
  } catch {
    // Fall back to music-metadata only if the native helper cannot inspect the file.
    try {
      const metadataLib = await ensureMM();
      const meta = await metadataLib.parseFile(trackPath, { duration: false, skipCovers: false });
      return Array.isArray(meta?.common?.picture) && meta.common.picture.length > 0;
    } catch { return false; }
  }
});

ipcMain.handle('track:readTags', async (_evt, trackPath) => {
  const metadataLib = await ensureMM();
  const meta = await metadataLib.parseFile(trackPath, { duration: true, skipCovers: false });
  let stat = null;
  try { const st = await fsp.stat(trackPath); stat = { size: st.size, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs }; } catch {}
  // Keep a compact, content-based artwork signature for the multi-file tag editor.
  // Comparing image bytes rather than cached cover paths lets the editor reliably
  // detect when even one selected album track has different embedded artwork.
  const pictures = (Array.isArray(meta.common?.picture) ? meta.common.picture : []).map((picture, index) => {
    let data = picture?.data;
    try {
      if (Buffer.isBuffer(data)) data = data;
      else if (data instanceof Uint8Array) data = Buffer.from(data);
      else if (data?.type === 'Buffer' && Array.isArray(data.data)) data = Buffer.from(data.data);
      else if (Array.isArray(data)) data = Buffer.from(data);
      else if (typeof data === 'string') data = Buffer.from(data, 'base64');
      else data = Buffer.alloc(0);
    } catch { data = Buffer.alloc(0); }
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const mime = String(picture?.format || 'image/jpeg');
    return {
      // music-metadata can expose picture types as enum strings such as
      // `PictureType.COVER_BACK`. Normalize those before the native helper
      // fallback reaches the artwork editor so the dropdown can select the
      // actual Cover (Back) option rather than displaying the raw enum name.
      type: normalizePictureType(picture?.type || 'Other'),
      mime,
      description: String(picture?.description || ''),
      hash,
      index,
      dataUrl: data.length ? `data:${mime};base64,${data.toString('base64')}` : ''
    };
  });
  let nativePictures = pictures;
  let nativeCompilation = null;
  try {
    const native = await runTagHelper({ op: 'read_artwork', path: trackPath });
    nativePictures = (native.pictures || []).map(p => ({
      type: String(p.type || 'Other'), mime: String(p.mime || 'image/jpeg'), description: String(p.description || ''),
      hash: crypto.createHash('sha256').update(Buffer.from(p.dataBase64 || '', 'base64')).digest('hex'), index: Number(p.index || 0),
      dataUrl: p.dataBase64 ? `data:${String(p.mime || 'image/jpeg')};base64,${p.dataBase64}` : ''
    }));

    // readTags() is also used to refresh the currently playing queue entry.
    // The native artwork helper returns the actual embedded bytes, but historically
    // this response only exposed a data URL and dropped Beehive's persistent cover
    // cache filename. That meant the queue/now-playing UI could still display an
    // image while MPRIS (and Music Presence) had no local file to expose, resulting
    // in playing tracks with no artwork. Cache every embedded picture here and return
    // its stable cache filename so every consumer uses the same artwork source.
    try {
      const cachePictures = (native.pictures || []).map(p => ({
        data: Buffer.from(String(p.dataBase64 || ''), 'base64'),
        format: String(p.mime || 'image/jpeg'),
        type: String(p.type || 'Other')
      })).filter(p => p.data.length);
      const cached = await extractAndCacheCovers(cachePictures);
      const byHash = new Map(cached.map(item => [item.hash, item]));
      nativePictures = nativePictures.map(item => {
        const cachedItem = byHash.get(crypto.createHash('sha1').update(Buffer.from(String((native.pictures || [])[item.index]?.dataBase64 || ''), 'base64')).digest('hex'));
        return cachedItem ? { ...item, file: cachedItem.file } : item;
      });
    } catch (cacheErr) {
      console.warn('[Beehive] Embedded artwork cache refresh failed:', cacheErr?.message || cacheErr);
    }
    const compilation = await runTagHelper({ op: 'read_compilation', path: trackPath });
    nativeCompilation = String(compilation?.compilation || '0') === '1';
  } catch (err) { console.warn('[Beehive] Native metadata read fallback:', err.message); }
  const pictureSignatures = nativePictures.map(({ type, mime, hash, index }) => ({ type, mime, hash, index }));
  // Use the native helper as the source of truth for Compilation. This avoids
  // format-specific differences in music-metadata's normalized common tag.
  const normalizedCommon = { ...(meta.common || {}) };
  if (nativeCompilation !== null) normalizedCommon.compilation = nativeCompilation;
  return { common: normalizedCommon, native: meta.native || {}, format: meta.format || {}, stat, pictureSignatures, pictures: nativePictures };
});

ipcMain.handle('cover:choose', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg','jpeg','png','webp','gif','bmp'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const chosenPath = res.filePaths[0];
  const data = await fsp.readFile(chosenPath);
  const mime = ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp'})[path.extname(chosenPath).toLowerCase()] || 'application/octet-stream';
  return { path: chosenPath, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
});

function normalizePictureType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === '3' || raw.includes('front') || raw === 'album cover' || raw === 'cover') return 'Cover (Front)';
  if (raw === '4' || raw.includes('back') || raw === 'album cover (back)') return 'Cover (Back)';
  if (raw.includes('artist')) return 'Artist';
  return 'Other';
}

const { createMetadataWriter } = require('./metadata-writer');
const metadataWriter = createMetadataWriter({
  runTagHelper,
  copyMetadataFile,
  markLibraryInternalWrite,
  waitForPlaybackProtectionRelease,
  normalizePictureType,
  readEmbeddedRating,
  osTempDir: () => app.getPath('temp'),
});
const {
  withMusicBeeWriteLock,
  createMetadataTempPath,
  commitMetadataTemp,
  embedRatingInFile,
  performWriteArtwork,
  performModifyArtwork,
  performRemoveFrontArtwork,
  performRemoveArtwork,
  performWriteMetadata,
  performWriteTags,
} = metadataWriter;

// Direct single-file APIs remain available to the artwork editor, but all
// multi-file Save operations use the background batch queue below. This keeps
// file I/O out of the renderer/UI thread and gives every selected file its own
// completion result.
ipcMain.handle('metadata:bulkWriteStart', async (_evt, label = 'metadata') => { beginLibraryBulkWrite(String(label || 'metadata')); return true; });
ipcMain.handle('metadata:bulkWriteEnd', async (_evt, label = 'metadata') => { endLibraryBulkWrite(String(label || 'metadata')); return true; });
ipcMain.handle('track:writeArtwork', async (_evt, trackPath, imagePath, artworkMeta = {}) => {
  if (!(await isTrackPathAllowedInLibrary(trackPath))) throw new Error(LIBRARY_BOUNDARY_ERROR);
  return performWriteArtwork(trackPath, imagePath, artworkMeta);
});
ipcMain.handle('track:modifyArtwork', async (_evt, trackPath, operation = {}, options = {}) => {
  if (!(await isTrackPathAllowedInLibrary(trackPath))) throw new Error(LIBRARY_BOUNDARY_ERROR);
  return performModifyArtwork(trackPath, operation, { background: !!options?.background });
});
ipcMain.handle('track:removeFrontArtwork', async (_evt, trackPath) => {
  if (!(await isTrackPathAllowedInLibrary(trackPath))) throw new Error(LIBRARY_BOUNDARY_ERROR);
  return performRemoveFrontArtwork(trackPath);
});
ipcMain.handle('track:removeArtwork', async (_evt, trackPath) => {
  if (!(await isTrackPathAllowedInLibrary(trackPath))) throw new Error(LIBRARY_BOUNDARY_ERROR);
  return performRemoveArtwork(trackPath);
});
ipcMain.handle('track:writeTags', async (_evt, trackPath, tags) => {
  if (!(await isTrackPathAllowedInLibrary(trackPath))) throw new Error(LIBRARY_BOUNDARY_ERROR);
  return performWriteTags(trackPath, tags);
});

let metadataSaveQueue = Promise.resolve();

async function metadataJobAlreadySatisfied(job) {
  try {
    if (!job?.path || !fs.existsSync(job.path)) return false;
    if (job.kind === 'love') return (await readLoveStateFromDisk(job.path)) === !!job.loved;
    if (job.kind === 'rating') return Math.abs((Number(await readEmbeddedRating(job.path)) || 0) - (Number(job.rating) || 0)) < 0.01;
    if (job.kind === 'metadata') {
      const tags = job.tags || {};
      const fields = Object.keys(tags).filter(key => key !== 'compilation');
      if (fields.length) {
        const result = await runTagHelper({op:'read_metadata_fields',path:job.path,fields});
        const got = result?.fields || {};
        const norm = value => String(value ?? '').trim();
        for (const key of fields) {
          if (norm(tags[key]) !== norm(got[key])) return false;
        }
      }
      if (Object.prototype.hasOwnProperty.call(tags, 'compilation')) {
        const result = await runTagHelper({op:'read_compilation',path:job.path});
        const expected = String(tags.compilation) === '1' ? '1' : '0';
        const actual = String(result?.compilation || '0') === '1' ? '1' : '0';
        if (expected !== actual) return false;
      }
      const action = String(job.artwork?.action || '').toLowerCase();
      if (['add','write','replace','replace_slot'].includes(action)) {
        if (!job.artwork.imagePath || !fs.existsSync(job.artwork.imagePath)) return false;
        const wanted = crypto.createHash('sha256').update(await fsp.readFile(job.artwork.imagePath)).digest('hex');
        const result = await runTagHelper({op:'artwork_contains_hash',path:job.path,sha256:wanted});
        if (result?.match !== true) return false;
      } else if (action === 'remove_all' || action === 'remove_front') {
        const result = await runTagHelper({op:'read_artwork_metadata',path:job.path});
        const pictures = Array.isArray(result?.pictures) ? result.pictures : [];
        if (action === 'remove_all' && pictures.length) return false;
        if (action === 'remove_front' && pictures.some(p => normalizePictureType(p?.type || 'Other') === 'Cover (Front)')) return false;
      }
      return true;
    }
    if (job.kind === 'artwork:removeAll') { const r=await runTagHelper({op:'read_artwork_metadata',path:job.path}); return !(r?.pictures||[]).length; }
    if (job.kind === 'artwork:removeFront') { const r=await runTagHelper({op:'read_artwork_metadata',path:job.path}); return !(r?.pictures||[]).some(p=>normalizePictureType(p?.type||'Other')==='Cover (Front)'); }
    if (job.kind === 'artwork:add' || job.kind === 'artwork:replaceSlot') {
      if (!job.imagePath || !fs.existsSync(job.imagePath)) return false;
      const wanted=crypto.createHash('sha256').update(await fsp.readFile(job.imagePath)).digest('hex');
      const r=await runTagHelper({op:'artwork_contains_hash',path:job.path,sha256:wanted});
      return r?.match === true;
    }
  } catch (err) {
    scanLog('METADATA RECOVERY SATISFACTION CHECK FAILED', { path: job?.path, kind: job?.kind, error: err?.message || String(err) });
  }
  return false;
}

function enqueueMetadataSave(evt, jobs, options = {}) {
  const sender = evt?.sender || mainWindow?.webContents;
  const normalizedJobs = (Array.isArray(jobs) ? jobs : []).map(job => ({ ...job, id:String(job?.id || crypto.randomUUID()), createdAt:Number(job?.createdAt || Date.now()), path:String(job?.path || '') })).filter(job => job.path);
  metadataSaveQueue = metadataSaveQueue.then(() => new Promise((resolve) => {
    taskManager.enqueue('metadata', async () => {
      try { await runMetadataBatch(normalizedJobs, sender, options); } finally { resolve(); }
    }, { priority: 30 });
  }));
  return metadataSaveQueue;
}

async function runMetadataBatch(normalizedJobs, sender, options = {}) {
  const bulkLabel = 'Saving metadata changes';
  beginLibraryBulkWrite(bulkLabel);
  try {
    // Durability comes before the physical write. Previously these journal writes
    // were fire-and-forget, so a fast shutdown could leave a file half-processed
    // with no recovery record at all.
    await Promise.all(normalizedJobs.map(job => persistMetadataJob(job, 'queued', Number(job.attempts||0), job.lastError || '')));
    const total=normalizedJobs.length; let done=0,updated=0,failed=0; const errors=[],updatedPaths=[];
    const sendProgress=(active,phase,current='')=>{ try{ sender?.send('library:tagProgress',{active,operation:normalizedJobs.some(j=>j.operation==='artwork')?'artwork':'metadata',operationLabel:'Saving changes',phase,done,total,updated,failed,current,errors,paths:updatedPaths,recovered:!!options.recovered}); }catch{} };
    if(!total){sendProgress(false,'Finished');return;} sendProgress(true,'Writing');
    for(const job of normalizedJobs){
      if (!(await isTrackPathAllowedInLibrary(job.path))) {
        done++; failed++; errors.push({path:job.path,error:LIBRARY_BOUNDARY_ERROR});
        await deleteMetadataJob(job.id);
        sendProgress(true,'Writing',path.basename(job.path));
        continue;
      }
      let attempts=Number(job.attempts||0); let success=false; let lastError='';
      while(attempts<3 && !success){
        attempts++; await updateMetadataJob(job.id,'running',attempts,lastError);
        try {
          // Never replace the file currently owned by the audio transport. This
          // applies to Love, ratings, tag edits, and artwork because each may
          // replace the complete media inode underneath GStreamer.
          await waitForPlaybackProtectionRelease(job.path);
          if(await metadataJobAlreadySatisfied(job)){ success=true; }
          else {
            if(job.kind==='love') await embedLoveInFile(job.path,!!job.loved);
            else if(job.kind==='rating') await embedRatingInFile(job.path, Number(job.rating)||0);
            else if(job.kind==='tags') await performWriteTags(job.path,job.perTrack||{},{background:true});
            else if(job.kind==='metadata') await performWriteMetadata(job.path,job.tags||{},job.artwork||null,{background:true});
            else if(job.kind==='artwork:removeFront') await performRemoveFrontArtwork(job.path,{background:true});
            else if(job.kind==='artwork:removeAll') await performRemoveArtwork(job.path,{background:true});
            else if(job.kind==='artwork:replaceSlot'){ const data=await runTagHelper({op:'read_artwork_metadata',path:job.path}); const pictures=Array.isArray(data?.pictures)?data.pictures:[]; const targetType=normalizePictureType(job.slot?.type||'Other'); const occurrence=Math.max(1,Number(job.slot?.occurrence)||1); let seen=0,targetIndex=-1; for(let i=0;i<pictures.length;i++){if(normalizePictureType(pictures[i]?.type||'Other')!==targetType)continue; if(++seen===occurrence){targetIndex=i;break;}} if(targetIndex<0)throw new Error(`The ${job.slotLabel||'artwork'} is not present in this file.`); await performModifyArtwork(job.path,{action:'replace',index:targetIndex,imagePath:job.imagePath,pictureType:job.pictureType,comment:job.comment},{background:true}); }
            else if(job.kind==='artwork:add') await performWriteArtwork(job.path,job.imagePath,{pictureType:job.pictureType,comment:job.comment},{background:true});
            else throw new Error(`Unknown metadata job: ${job.kind}`);
            success=true;
          }
        } catch(err) {
          lastError=err?.message||String(err);
          await updateMetadataJob(job.id, attempts<3 ? 'retry' : 'failed', attempts, lastError);
          if(attempts<3) await new Promise(r=>setTimeout(r,500*attempts));
        }
      }
      done++;
      if(success){ updated++; updatedPaths.push(job.path); await deleteMetadataJob(job.id); }
      else { failed++; errors.push({path:job.path,error:lastError||job.lastError||'Metadata operation failed after 3 attempts.'}); }
      sendProgress(true,'Writing',path.basename(job.path));
    }
    sendProgress(false,failed?'Finished with errors':'Finished');
  } catch (err) {
    try { sender?.send('library:tagProgress',{active:false,operation:normalizedJobs.some(j=>j.operation==='artwork')?'artwork':'metadata',operationLabel:'Metadata save failed',phase:'Finished',done:0,total:normalizedJobs.length,updated:0,failed:normalizedJobs.length,errors:[{path:'',error:err?.message||String(err)}],paths:[],recovered:!!options.recovered}); } catch {}
  } finally {
    // Keep the filesystem watcher suppressed for the complete album batch. A
    // large album can take longer than the per-file internal-write window, and
    // triggering a scan halfway through would waste I/O and race the UI refresh.
    endLibraryBulkWrite(bulkLabel);
  }
}

ipcMain.on('metadata:saveBatch', (evt, jobs) => enqueueMetadataSave(evt, jobs));

ipcMain.handle('library:searchDatabase', async (_evt, query = {}) => {
  const text = String(query.text || '').trim();
  if (!text) return [];
  return databaseRequest('search_tracks', { text, limit: Math.min(5000, Math.max(1, Number(query.limit) || 1000)) });
});
ipcMain.handle('library:taskStatus', async () => taskManager.status());
ipcMain.handle('beta:securityAudit', async () => runSecurityAudit(HIVE_PROJECT_ROOT));
ipcMain.handle('beta:libraryHealth', async () => {
  const cached = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  return runLibraryHealth(Array.isArray(cached?.tracks) ? cached.tracks : []);
});
ipcMain.handle('beta:environmentAudit', async () => {
  const cfg = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  return runEnvironmentAudit(HIVE_PROJECT_ROOT, {
    logDir: beehiveLogDir(),
    tempDir: path.join(app.getPath('temp'), 'BeehiveMusicBrainz'),
    libraryRoots: Array.isArray(cfg?.folders) ? cfg.folders : []
  });
});
ipcMain.handle('diagnostics:start', async () => inAppDiagnostics.startSession());
ipcMain.handle('diagnostics:finish', async () => inAppDiagnostics.finishSession());
ipcMain.handle('diagnostics:status', async () => inAppDiagnostics.getStatus());
ipcMain.handle('diagnostics:mark', async (_evt, phase, detail = null) => inAppDiagnostics.mark(phase, detail));
ipcMain.handle('diagnostics:open-folder', async () => inAppDiagnostics.openReportFolder());
ipcMain.handle('diagnostics:writeFavoritesPipeline', async (_evt, report = {}) => {
  ensureBeehiveLogDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReport = report && typeof report === 'object' ? report : {};
  const reportPath = path.join(beehiveLogDir(), `favorites-pipeline-diagnostic-${stamp}-${process.pid}.json`);
  try {
    await fsp.writeFile(reportPath, JSON.stringify(safeReport, null, 2), { encoding:'utf8', mode:0o600 });
    writeSession('INFO', 'FAVORITES PIPELINE', 'FAVORITES PIPELINE DIAGNOSTIC REPORT', {
      reportPath,
      stage: safeReport.stage || 'unknown',
      libraryTrackCount: Number(safeReport.libraryTrackCount) || 0,
      libraryLovedCount: Number(safeReport.libraryLovedCount) || 0,
      favoriteRuleMatchCount: Number(safeReport.favoriteRuleMatchCount) || 0,
      favoriteEvaluatorCount: Number(safeReport.favoriteEvaluatorCount) || 0,
      libraryLovedNotMatchedCount: Array.isArray(safeReport.libraryLovedNotMatchedPaths) ? safeReport.libraryLovedNotMatchedPaths.length : 0
    });
    return { ok:true, reportPath };
  } catch (err) {
    writeSession('WARN', 'FAVORITES PIPELINE', 'FAVORITES PIPELINE DIAGNOSTIC REPORT WRITE FAILED', { message:err?.message || String(err) });
    return { ok:false, error:err?.message || String(err) };
  }
});
ipcMain.handle('diagnostics:getLogs', async () => {
  ensureBeehiveLogDir();
  const readTail = async (filePath, maxBytes = 750 * 1024) => {
    try {
      const st = await fsp.stat(filePath);
      const start = Math.max(0, st.size - maxBytes);
      const handle = await fsp.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(Math.max(0, st.size - start));
        await handle.read(buf, 0, buf.length, start);
        return buf.toString('utf8');
      } finally { await handle.close(); }
    } catch { return ''; }
  };
  const sessionFiles = fs.readdirSync(beehiveLogDir())
    .filter(name => /^session-\d{8}-\d{6}-\d+\.txt$/.test(name))
    .map(name => ({ name, path:path.join(beehiveLogDir(), name) }))
    .sort((a,b) => b.name.localeCompare(a.name));
  const sessions = [];
  for (const item of sessionFiles.slice(0,20)) {
    const stat = (() => { try { return fs.statSync(item.path); } catch { return null; } })();
    sessions.push({ name:item.name, path:item.path, size:stat?.size || 0, modifiedAt:stat?.mtime?.toISOString?.() || null, text:await readTail(item.path) });
  }
  const current = sessions.find(x => x.name === path.basename(sessionLogPath())) || sessions[0] || null;
  const crash = current?.text || '';
  const scan = await readTail(SCAN_LOG_PATH());
  return {
    dir: beehiveLogDir(),
    currentSession: current?.name || null,
    sessions,
    crash,
    scan,
    startup: current?.text || '',
    combined: crash || scan || 'No Hive diagnostic log entries were found yet.'
  };
});
ipcMain.handle('beta:databaseHealth', async () => databaseRequest('health_check'));
ipcMain.handle('artwork:providers', async () => artworkProviders);

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz) (cover search)', 'Accept': 'application/json', ...headers } });
  if (!response.ok) throw new Error(`Cover search failed (${response.status}).`);
  return response.json();
}

function normalizeCoverSearchText(value) {
  return normalizeArtworkText(value);
}
function scoreCoverResult(item, album, artist) { return scoreArtworkResult(item, album, artist); }

async function fetchTemporaryArtwork(url) {
  const imageHeaders = {
    'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz) (temporary artwork)',
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  };
  const jsonHeaders = {
    'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz) (temporary artwork)',
    'Accept': 'application/json'
  };

  // Cover Art Archive's /front-1200 convenience endpoint is not a reliable
  // existence test: it can 404 when the release has artwork but no image is
  // currently designated as the release's canonical "front" (and a 1200px
  // thumbnail can also be missing even when the original/500px image exists).
  // Resolve CAA metadata first and try the actual image/thumbnail URLs in
  // descending quality order. All returned bytes remain memory-only.
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isCaa = /(?:^|\.)coverartarchive\.org$/.test(host);
    const releaseMatch = isCaa && parsed.pathname.match(/^\/release\/([^/]+)\/(?:front(?:-(?:250|500|1200))?|back(?:-(?:250|500|1200))?)$/i);
    const releaseGroupMatch = isCaa && parsed.pathname.match(/^\/release-group\/([^/]+)\/front(?:-(?:250|500|1200))?$/i);

    if (releaseMatch || releaseGroupMatch) {
      const kind = releaseGroupMatch ? 'release-group' : 'release';
      const id = decodeURIComponent((releaseMatch || releaseGroupMatch)[1]);
      const apiUrl = `https://coverartarchive.org/${kind}/${encodeURIComponent(id)}`;
      const apiResponse = await fetch(apiUrl, { headers: jsonHeaders, cache: 'no-store' });
      if (apiResponse.ok) {
        const data = await apiResponse.json();
        const images = Array.isArray(data?.images) ? data.images : [];
        const preferred = [
          ...images.filter(item => item?.front && item?.approved !== false),
          ...images.filter(item => item?.front),
          ...images.filter(item => item?.approved !== false),
          ...images
        ];
        const seen = new Set();
        for (const image of preferred) {
          if (!image || seen.has(image.id)) continue;
          if (image.id != null) seen.add(image.id);
          const thumbs = image.thumbnails || {};
          const candidates = [
            thumbs['1200'], thumbs['500'], thumbs['250'],
            thumbs.large, thumbs.small, image.image
          ].filter(Boolean).map(String);
          for (const candidate of [...new Set(candidates)]) {
            try {
              const imageResponse = await fetch(candidate, {
                headers: imageHeaders,
                cache: 'no-store'
              });
              if (imageResponse.ok) return imageResponse;
            } catch {}
          }
        }
      }
    }
  } catch {}

  // If metadata resolution did not produce a usable image, retain the normal
  // direct fetch path. This keeps non-CAA sources (including iTunes) unchanged.
  try {
    const response = await fetch(url, {
      headers: imageHeaders,
      cache: 'no-store'
    });
    if (response.ok) return response;
    throw new Error(`Temporary artwork failed (${response.status}).`);
  } catch (err) {
    throw err instanceof Error ? err : new Error('Temporary artwork fetch failed.');
  }
}

ipcMain.handle('cover:loadTemporary', async (_evt, rawUrl = '') => {
  const url = String(rawUrl || '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('Temporary artwork URL must use HTTPS.');
  const response = await fetchTemporaryArtwork(url);
  const contentType = String(response.headers.get('content-type') || 'image/jpeg').split(';', 1)[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('Temporary artwork response was not an image.');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > 12 * 1024 * 1024) throw new Error('Temporary artwork image is empty or too large.');
  return { mimeType: contentType, base64: data.toString('base64') };
});

ipcMain.handle('cover:searchInternet', async (_evt, query = {}) => {
  const album = String(query.album || '').trim();
  const artist = String(query.artist || '').trim();
  const manualQuery = String(query.manualQuery || '').trim();
  if (!album && !manualQuery) return [];

  const targetAlbum = album || manualQuery;
  const targetArtist = artist;
  const results = [];
  const seen = new Set();
  const addResult = (item, scoreBoost = 0) => {
    const albumName = String(item.collectionName || item.releaseGroupTitle || item.title || '').trim();
    const artistName = String(item.artistName || item.artist || '').trim();
    if (!albumName || !item.artworkUrl) return;
    const key = String(item.artworkUrl || item.releaseId || item.collectionId || `${normalizeCoverSearchText(albumName)}|${normalizeCoverSearchText(artistName)}|${item.source}`);
    if (seen.has(key)) return;
    seen.add(key);
    item.score = scoreCoverResult(item, targetAlbum, targetArtist) + scoreBoost;
    results.push(item);
  };
  // Search actual releases first. Cover Art Archive artwork is attached to
  // releases (not merely release-groups), so this gives us a reliable artwork
  // URL and also lets us match the credited artist correctly.
  try {
    const mbClient = await getMusicBrainzClient();
    let mbResults = await mbClient.searchReleases({ album: targetAlbum, artist: targetArtist, limit: 20 });
    if (!mbResults.length) mbResults = await mbClient.searchReleases({ album: targetAlbum, artist: '', limit: 20 });
    for (const item of mbResults) addResult(item, 40);
  } catch (err) {
    console.warn('[BeehiveMusicBrainz] MusicBrainz release artwork search failed:', err.message);
  }

  const automatic = !manualQuery;
  const appleSearch = async (term, exactArtistOnly = false) => {
    const params = new URLSearchParams({ term, entity: 'album', media: 'music', country: 'US', limit: '25' });
    const data = await fetchJson(`https://itunes.apple.com/search?${params.toString()}`);
    const items = Array.isArray(data?.results) ? data.results : [];
    for (const item of items) {
      const itemAlbum = normalizeCoverSearchText(item.collectionName || '');
      const itemArtist = normalizeCoverSearchText(item.artistName || '');
      const wantedAlbum = normalizeCoverSearchText(targetAlbum);
      const wantedArtist = normalizeCoverSearchText(targetArtist);
      const albumExact = itemAlbum === wantedAlbum;
      const artistExact = !wantedArtist || itemArtist === wantedArtist;
      if (!albumExact) continue;
      if (exactArtistOnly && !artistExact) continue;
      if (!item.artworkUrl100) continue;
      const url = String(item.artworkUrl100)
        .replace(/100x100bb\.(jpg|jpeg|png)/i, '1000x1000bb.$1')
        .replace(/100x100[-.]?/i, '1000x1000');
      addResult({
        source: 'iTunes',
        collectionName: item.collectionName || '',
        artistName: item.artistName || '',
        releaseYear: item.releaseDate ? String(item.releaseDate).slice(0,4) : '',
        artworkUrl: url,
        width: 1000,
        height: 1000,
        collectionId: item.collectionId || null,
        collectionViewUrl: item.collectionViewUrl || ''
      }, exactArtistOnly ? 12 : 0);
    }
  };

  try {
    // Always consult Apple as a second artwork catalog. A successful MusicBrainz
    // search must not suppress alternate Apple covers, editions, or artwork.
    const beforeApple = results.length;
    if (targetArtist) await appleSearch(`${targetAlbum} ${targetArtist}`, true);
    const appleAdded = results.length - beforeApple;
    if (!appleAdded) await appleSearch(targetAlbum, false);
    if (!automatic && manualQuery && results.length === beforeApple) await appleSearch(manualQuery, false);
  } catch (err) {
    console.warn('[Beehive] iTunes cover search failed:', err.message);
  }

  // Keep exact album matches, but retain multiple releases/editions and both
  // artwork catalogs. The UI lets the user inspect the full-size image before applying it.
  return results
    .filter(item => normalizeCoverSearchText(item.collectionName) === normalizeCoverSearchText(targetAlbum))
    .sort((a,b) => Number(b.score||0) - Number(a.score||0))
    .slice(0, 12);
});

function assertSafeArtworkUrl(value) {
  const parsed = new URL(String(value || ''));
  if (parsed.protocol !== 'https:') throw new Error('Artwork URL must use HTTPS.');
  const host = parsed.hostname.toLowerCase();
  const approved = host === 'mzstatic.com' || host.endsWith('.mzstatic.com') || host === 'coverartarchive.org' || host.endsWith('.coverartarchive.org') || host === 'archive.org' || host.endsWith('.archive.org');
  if (!approved) throw new Error('Artwork source is not an approved music artwork host.');
  return parsed;
}

ipcMain.handle('cover:downloadSearchResult', async (_evt, artworkUrl) => {
  const parsed = assertSafeArtworkUrl(artworkUrl);
  const response = await fetch(parsed.toString(), { headers: { 'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz) (cover download)' } });
  if (!response.ok) throw new Error(`Could not download artwork (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('Downloaded artwork was empty.');
  const tempDir = path.join(app.getPath('temp'), 'beehive-artwork');
  await fsp.mkdir(tempDir, { recursive: true });
  const inputExt = path.extname(new URL(response.url || parsed.toString()).pathname).toLowerCase() === '.png' ? '.png' : '.jpg';
  const rawPath = path.join(tempDir, `cover-source-${crypto.randomBytes(10).toString('hex')}${inputExt}`);
  const normalizedPath = path.join(tempDir, `cover-1000-${crypto.randomBytes(10).toString('hex')}.jpg`);
  await fsp.writeFile(rawPath, buffer);
  try {
    // Normalize every selected online cover to exactly 1000x1000. The search
    // prefers true 1000px iTunes artwork and 1200px CAA artwork, but this keeps
    // the file embedded by Beehive consistent regardless of source.
    await runFfmpeg(['-hide_banner','-loglevel','error','-y','-i',rawPath,'-vf','scale=1000:1000:force_original_aspect_ratio=decrease,pad=1000:1000:(ow-iw)/2:(oh-ih)/2:color=black','-q:v','2',normalizedPath]);
    const normalized = await fsp.readFile(normalizedPath);
    try { await artworkCacheManager?.put(parsed.toString(), normalizedPath, { provider: parsed.hostname.includes('coverartarchive') ? 'musicbrainz-caa' : 'itunes', width: 1000, height: 1000 }); } catch {}
    return { path: normalizedPath, dataUrl: `data:image/jpeg;base64,${normalized.toString('base64')}`, width: 1000, height: 1000, sourceUrl: parsed.toString() };
  } finally {
    try { await fsp.unlink(rawPath); } catch {}
  }
});

ipcMain.handle('cover:downloadItunes', async (_evt, artworkUrl) => {
  return ipcMain.emit ? (await (async()=>{
    const parsed = assertSafeArtworkUrl(artworkUrl);
    if (!(parsed.hostname === 'mzstatic.com' || parsed.hostname.endsWith('.mzstatic.com'))) throw new Error('Not an iTunes artwork URL.');
    const response = await fetch(parsed.toString(), { headers: { 'User-Agent': 'Hive/0.9.0-beta.2 (BeehiveMusicBrainz)' } });
    if (!response.ok) throw new Error(`Could not download artwork (${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Downloaded artwork was empty.');
    const tempDir = path.join(app.getPath('temp'), 'beehive-artwork');
    await fsp.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `itunes-${crypto.randomBytes(10).toString('hex')}.jpg`);
    await fsp.writeFile(tempPath, buffer);
    return { path: tempPath, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };
  })()) : null;
});

ipcMain.handle('cover:paste', async () => {
  const image = clipboard.readImage();
  if (!image || image.isEmpty()) return null;
  const tempDir = path.join(app.getPath('temp'), 'beehive-artwork');
  await fsp.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `clipboard-${crypto.randomBytes(10).toString('hex')}.png`);
  await fsp.writeFile(tempPath, image.toPNG());
  return { path: tempPath, dataUrl: image.toDataURL() };
});

ipcMain.handle('cover:saveDataUrlImage', async (_evt, dataUrl, filename='artwork.jpg') => {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error('Invalid artwork image data.');
  const ext = path.extname(String(filename || '.jpg')) || '.jpg';
  const out = path.join(app.getPath('temp'), `beehive-export-${crypto.randomBytes(8).toString('hex')}${ext}`);
  await fsp.writeFile(out, Buffer.from(match[2], 'base64'));
  return out;
});

ipcMain.handle('cover:saveImage', async (_evt, imagePath) => {
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error('Artwork file not found.');
  const ext = path.extname(imagePath) || '.jpg';
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: `cover${ext}`, filters: [{ name: 'Image', extensions: ['png','jpg','jpeg','webp'] }] });
  if (res.canceled || !res.filePath) return false;
  await fsp.copyFile(imagePath, res.filePath);
  return true;
});

ipcMain.handle('cover:copy', async (_evt, coverFile) => {
  if (!coverFile) return false;
  const filePath = path.join(COVERS_DIR(), path.basename(coverFile));
  if (!fs.existsSync(filePath)) return false;
  clipboard.writeImage(nativeImage.createFromPath(filePath));
  return true;
});

ipcMain.handle('cover:save', async (_evt, coverFile) => {
  if (!coverFile) return false;
  const src = path.join(COVERS_DIR(), path.basename(coverFile));
  if (!fs.existsSync(src)) return false;
  const ext = path.extname(src) || '.jpg';
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: `cover${ext}`, filters: [{ name: 'Image', extensions: ['png','jpg','jpeg','webp'] }] });
  if (res.canceled || !res.filePath) return false;
  await fsp.copyFile(src, res.filePath);
  return true;
});


// ---------------------------------------------------------------------------
// Spotify / Spicetify bridge
// ---------------------------------------------------------------------------
// Spotify remains the audio engine. Hive only sends playback commands and
// receives normalized player state from the Spicetify extension. Keep this
// loopback-only so no LAN service is exposed.
const SPOTIFY_BRIDGE_HOST = '127.0.0.1';
const SPOTIFY_BRIDGE_PORT = 43872;
const SPOTIFY_BRIDGE_TOKEN_PATH = () => path.join(USER_DATA(), 'spotify-bridge-token');
let spotifyBridgeToken = '';
let spotifyBridgeServer = null;
let spotifyBridgeState = { connected: false, updatedAt: 0, player: null };
let spotifyBridgeCommands = [];
let spotifyBridgeSeq = 0;
const spotifyBridgeWaiters = new Set();
let spotifyBridgeSeenCommandsRequest = false;
let spotifyBridgeSeenStateRequest = false;

function ensureSpotifyBridgeToken() {
  try {
    fs.mkdirSync(USER_DATA(), { recursive: true, mode: 0o700 });
    let token = '';
    try { token = fs.readFileSync(SPOTIFY_BRIDGE_TOKEN_PATH(), 'utf8').trim(); } catch {}
    if (!/^[A-Fa-f0-9]{64}$/.test(token)) {
      token = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(SPOTIFY_BRIDGE_TOKEN_PATH(), token + '\n', { mode: 0o600 });
    }
    try { fs.chmodSync(SPOTIFY_BRIDGE_TOKEN_PATH(), 0o600); } catch {}
    spotifyBridgeToken = token;
    return token;
  } catch (err) {
    console.warn('[Hive] Could not initialize Spotify bridge token:', err?.message || String(err));
    spotifyBridgeToken = '';
    return '';
  }
}
function spotifyBridgeAuthorized(req) {
  if (!spotifyBridgeToken) return false;
  const header = String(req?.headers?.authorization || '');
  return header === `Bearer ${spotifyBridgeToken}`;
}

function spotifyBridgeOriginAllowed(origin) {
  const value = String(origin || '').trim();
  // Spotify's desktop XPUI currently runs under xpui.app.spotify.com, while
  // some versions/contexts use open.spotify.com. The old bridge allowed only
  // open.spotify.com, which made Chromium reject every loopback fetch from the
  // desktop client with a CORS/Failed-to-fetch error even though port 43872 was
  // healthy. Keep the allow-list narrow: this is not a general-purpose HTTP API.
  return value === 'https://open.spotify.com' || value === 'https://xpui.app.spotify.com';
}
function spotifyBridgeJson(res, status, body, requestOrigin = '') {
  const payload = JSON.stringify(body ?? {});
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Private-Network': 'true',
    'Vary': 'Origin'
  };
  if (spotifyBridgeOriginAllowed(requestOrigin)) headers['Access-Control-Allow-Origin'] = requestOrigin;
  res.writeHead(status, headers);
  res.end(payload);
}
function notifySpotifyBridgeWaiters() {
  for (const fn of [...spotifyBridgeWaiters]) { try { fn(); } catch {} }
}
function enqueueSpotifyBridgeCommand(command) {
  const item = { id: ++spotifyBridgeSeq, command, createdAt: Date.now() };
  spotifyBridgeCommands.push(item);
  if (spotifyBridgeCommands.length > 100) spotifyBridgeCommands.splice(0, spotifyBridgeCommands.length - 100);
  notifySpotifyBridgeWaiters();
  return item.id;
}
async function readHttpJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) throw new Error('Spotify bridge request too large.');
  }
  return body ? JSON.parse(body) : {};
}
function startSpotifyBridge() {
  if (spotifyBridgeServer) return;
  if (!ensureSpotifyBridgeToken()) return;
  spotifyBridgeServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return spotifyBridgeJson(res, 204, {}, req.headers.origin || '');
      if (!spotifyBridgeAuthorized(req)) return spotifyBridgeJson(res, 401, { error: 'Unauthorized' }, req.headers.origin || '');
      const url = new URL(req.url || '/', `http://${SPOTIFY_BRIDGE_HOST}:${SPOTIFY_BRIDGE_PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') return spotifyBridgeJson(res, 200, { ok: true, connected: spotifyBridgeState.connected }, req.headers.origin || '');
      if (req.method === 'GET' && url.pathname === '/commands') {
        if (!spotifyBridgeSeenCommandsRequest) {
          spotifyBridgeSeenCommandsRequest = true;
          startupDebug('SPOTIFY BRIDGE COMMAND POLL RECEIVED', { origin: req.headers.origin || null });
        }
        const after = Number(url.searchParams.get('after') || 0);
        const commands = spotifyBridgeCommands.filter(x => x.id > after);
        return spotifyBridgeJson(res, 200, { commands }, req.headers.origin || '');
      }
      if (req.method === 'POST' && url.pathname === '/state') {
        if (!spotifyBridgeSeenStateRequest) {
          spotifyBridgeSeenStateRequest = true;
          startupDebug('SPOTIFY BRIDGE STATE RECEIVED', { origin: req.headers.origin || null });
        }
        const data = await readHttpJson(req);
        spotifyBridgeState = { ...spotifyBridgeState, connected: true, updatedAt: Date.now(), player: data?.player || null };
        notifySpotifyBridgeWaiters();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('spotify:state', spotifyBridgeState.player);
        return spotifyBridgeJson(res, 200, { ok: true }, req.headers.origin || '');
      }
      if (req.method === 'POST' && url.pathname === '/ack') {
        const data = await readHttpJson(req);
        if (Number(data?.id) > 0) spotifyBridgeCommands = spotifyBridgeCommands.filter(x => x.id !== Number(data.id));
        return spotifyBridgeJson(res, 200, { ok: true }, req.headers.origin || '');
      }
      if (req.method === 'POST' && url.pathname === '/playlist') {
        const data = await readHttpJson(req);
        spotifyBridgeState = { ...spotifyBridgeState, connected: true, updatedAt: Date.now(), playlist: data };
        notifySpotifyBridgeWaiters();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('spotify:playlist', data);
        return spotifyBridgeJson(res, 200, { ok: true }, req.headers.origin || '');
      }
      return spotifyBridgeJson(res, 404, { error: 'Not found' }, req.headers.origin || '');
    } catch (err) {
      return spotifyBridgeJson(res, 400, { error: String(err?.message || err) }, req.headers.origin || '');
    }
  });
  spotifyBridgeServer.on('error', err => {
    console.warn('[Hive] Spotify bridge unavailable:', err?.message || err);
    startupDebug('SPOTIFY BRIDGE ERROR', { message: err?.message || String(err), code: err?.code || null });
    try { spotifyBridgeServer?.close(); } catch {}
    spotifyBridgeServer = null;
    spotifyBridgeState = { connected: false, updatedAt: Date.now(), player: null };
  });
  spotifyBridgeServer.listen(SPOTIFY_BRIDGE_PORT, SPOTIFY_BRIDGE_HOST, () => {
    console.info(`[Hive] Spotify bridge listening on http://${SPOTIFY_BRIDGE_HOST}:${SPOTIFY_BRIDGE_PORT}`);
    startupDebug('SPOTIFY BRIDGE READY', { host: SPOTIFY_BRIDGE_HOST, port: SPOTIFY_BRIDGE_PORT });
  });
}
function spotifyBackgroundStatus() {
  const statusPath = path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME || '/tmp', '.cache'), 'hive', 'spotify-background-status.json');
  try {
    const raw = fs.readFileSync(statusPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return {
      phase: String(data.phase || ''),
      detail: String(data.detail || ''),
      display: String(data.display || ''),
      spotifyPid: String(data.spotifyPid || ''),
      spotifyExec: String(data.spotifyExec || ''),
      updatedAt: Number(data.updatedAt || 0)
    };
  } catch { return null; }
}

function stopSpotifyBridge() {
  try { spotifyBridgeServer?.close(); } catch {}
  spotifyBridgeServer = null;
}
function spotifyCommand(command) {
  if (!command) return false;
  const payload = typeof command === 'object' ? command : { command:String(command) };
  console.info('[Spotify Playback] command queued', payload);
  enqueueSpotifyBridgeCommand(payload);
  // Deliberately do not launch the track URI here. That bypasses the Hive
  // provider bridge and hands the user over to the visible Spotify UI. Hive's
  // Spotify transport is Spicetify-controlled; if the bridge is unavailable,
  // the command simply remains queued until the client reconnects.
  return true;
}
function launchSpotifyOrLogin() {
  // Spotify is an external provider, but on Linux its desktop client can raise
  // a real Wayland/XWayland window as soon as playback is requested.  When
  // Xvfb is available, launch the entire Spotify client on an isolated display
  // instead of trying to fight the window manager with wmctrl/xdotool.
  const helper = path.join(HIVE_PROJECT_ROOT, 'scripts', 'spotify-background.sh');
  try {
    if (!fs.existsSync(helper)) throw new Error(`Missing Spotify background helper: ${helper}`);
    const child = require('child_process').spawn(helper, [], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HIVE_SPOTIFY_BACKGROUND: '1' }
    });
    child.unref();
    startupDebug('SPOTIFY BACKGROUND LAUNCH', { helper });
    return true;
  } catch (err) {
    startupDebug('SPOTIFY BACKGROUND LAUNCH FAILED', { helper, message: err?.message || String(err) });
    return false;
  }
}

ipcMain.handle('spotify:status', async () => ({
  connected: !!spotifyBridgeState.connected && (Date.now() - Number(spotifyBridgeState.updatedAt || 0) < 5000),
  player: spotifyBridgeState.player || null,
  bridgeAgeMs: spotifyBridgeState.updatedAt ? Math.max(0, Date.now() - Number(spotifyBridgeState.updatedAt)) : null,
  bridgeServer: !!spotifyBridgeServer,
  background: spotifyBackgroundStatus()
}));
ipcMain.handle('spotify:launch', async () => {
  if (SPOTIFY_DEVELOPMENT_PAUSED) return false;
  return launchSpotifyOrLogin();
});
ipcMain.handle('spotify:login', async () => {
  if (SPOTIFY_DEVELOPMENT_PAUSED) return false;
  for (const command of ['opera', 'opera-stable']) {
    try { require('child_process').spawn(command, ['--new-window', 'https://accounts.spotify.com/login'], { detached: true, stdio: 'ignore' }).unref(); return true; } catch {}
  }
  try { await shell.openExternal('https://accounts.spotify.com/login'); return true; } catch { return false; }
});
ipcMain.handle('spotify:command', async (_evt, command) => {
  if (SPOTIFY_DEVELOPMENT_PAUSED) return false;
  return spotifyCommand(command);
});

// ---------------------------------------------------------------------------
// Podcasts — public directory discovery + RSS episode metadata
// ---------------------------------------------------------------------------
const { podcastRequest, xmlDecode, xmlTag, xmlAttr, parsePodcastFeed } = require('./podcast-feed');
ipcMain.handle('podcast:search', async (_evt, query) => {
  const q=String(query||'').trim(); if (!q) return {results:[]};
  // Allow a pasted RSS feed URL to act as a direct search/open action. This is
  // particularly useful for shows that are poorly indexed by the public
  // directory. It still uses the same safe HTTP(S)-only feed parser below.
  if (/^https?:\/\//i.test(q)) {
    try {
      const feed=parsePodcastFeed(await podcastRequest(q), q);
      return {results:[{id:q, title:feed.title, author:feed.author||'', feedUrl:q, image:feed.image||'', genre:''}]};
    } catch { return {results:[]}; }
  }
  const endpoints=[
    `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&term=${encodeURIComponent(q)}`,
    `https://itunes.apple.com/search?media=podcast&entity=podcast&attribute=titleTerm&limit=25&term=${encodeURIComponent(q)}`
  ];
  const payloads=await Promise.all(endpoints.map(url=>podcastRequest(url).then(body=>JSON.parse(body)).catch(()=>({results:[]}))));
  const merged=new Map();
  for (const data of payloads) for (const x of (Array.isArray(data?.results)?data.results:[])) {
    const item={id:String(x.collectionId||x.trackId||''), title:String(x.collectionName||x.trackName||'Podcast'), author:String(x.artistName||''), feedUrl:String(x.feedUrl||''), image:String(x.artworkUrl600||x.artworkUrl100||''), genre:String(x.primaryGenreName||'')};
    if (!item.feedUrl) continue;
    const key=item.feedUrl;
    if (!merged.has(key)) merged.set(key,item);
    else { const prior=merged.get(key); if (!prior.image && item.image) prior.image=item.image; if (!prior.author && item.author) prior.author=item.author; }
  }
  const needle=q.toLowerCase();
  const results=[...merged.values()].sort((a,b)=>{
    const score=item=>{ const title=item.title.toLowerCase(), author=item.author.toLowerCase(); return (title===needle?100:0)+(title.startsWith(needle)?35:0)+(title.includes(needle)?20:0)+(author.includes(needle)?10:0); };
    return score(b)-score(a) || a.title.localeCompare(b.title);
  }).slice(0,30);
  return {results};
});
ipcMain.handle('podcast:feed', async (_evt, url) => parsePodcastFeed(await podcastRequest(url), String(url)));

ipcMain.handle('podcasts:favorites:get', async () => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  return Array.isArray(config.podcastFavorites) ? config.podcastFavorites : [];
});
ipcMain.handle('podcasts:favorites:toggle', async (_evt, favorite = {}) => {
  const config = await readJsonSafe(CONFIG_PATH(), { folders: [] });
  const current = Array.isArray(config.podcastFavorites) ? config.podcastFavorites : [];
  const feedUrl = String(favorite.feedUrl || '').trim();
  if (!feedUrl) throw new Error('Podcast feed URL is required.');
  const index = current.findIndex(x => String(x?.feedUrl || '') === feedUrl);
  let next;
  let favorited;
  if (index >= 0) { next = current.filter((_, i) => i !== index); favorited = false; }
  else {
    const entry = {
      feedUrl,
      title:String(favorite.title || 'Podcast'),
      author:String(favorite.author || ''),
      image:String(favorite.image || ''),
      genre:String(favorite.genre || '')
    };
    next = [entry, ...current.filter(x => String(x?.feedUrl || '') !== feedUrl)].slice(0, 50);
    favorited = true;
  }
  config.podcastFavorites = next;
  await writeJsonSafe(CONFIG_PATH(), config);
  return { favorited, favorites: next };
});

const STAR_FAVORITES_PLAYLIST_ID = 'hive-star-favorites';
const STAR_FAVORITES_PLAYLIST = {
  id: STAR_FAVORITES_PLAYLIST_ID,
  systemKey: 'star-favorites',
  name: 'Favorites',
  label: 'Favorites',
  icon: '★',
  tracks: [],
  smart: true,
  match: 'all',
  rules: [{ field: 'love', op: 'is', value: 'Loved' }],
  // Star Favorites is the user's complete Love collection; it is intentionally
  // not subject to the normal 5,000-track smart-playlist display cap.
  sort: 'addedDesc',
  sourceType: 'library',
  sourceValue: 'library',
  description: 'Example Auto Playlist: Love is Loved. Edit the rules to make this your own.',
  displayView: 'albums',
  filterDuplicates: false,
  selectBy: 'track',
  smartShuffle: 'none',
  autoRefresh: true,
  exportStatic: false
};

async function ensureStarFavoritesPlaylist() {
  return withJsonFileLock(PLAYLISTS_PATH(), () => ensureStarFavoritesPlaylistUnlocked());
}
async function ensureStarFavoritesPlaylistUnlocked() {
  const lists = await readJsonSafe(PLAYLISTS_PATH(), []);
  const matches = lists
    .map((playlist, index) => ({ playlist, index }))
    .filter(({ playlist }) => playlist?.systemKey === 'star-favorites' || playlist?.id === STAR_FAVORITES_PLAYLIST_ID);

  if (matches.length) {
    // There must be one canonical Favorites autoplaylist. Older builds could
    // leave both the canonical record and a duplicate behind, so merge the
    // durable favorite timestamps before removing duplicates.
    const canonicalMatch = matches.find(x => x.playlist?.id === STAR_FAVORITES_PLAYLIST_ID) || matches[0];
    const canonical = canonicalMatch.playlist;
    const favoriteAddedAt = {};
    for (const match of matches) {
      const source = match.playlist?.favoriteAddedAt;
      if (!source || typeof source !== 'object') continue;
      for (const [trackPath, timestamp] of Object.entries(source)) {
        const key = String(trackPath || '');
        const value = Number(timestamp);
        if (!key || !Number.isFinite(value) || value <= 0) continue;
        favoriteAddedAt[key] = Math.max(Number(favoriteAddedAt[key]) || 0, value);
      }
    }
    const normalized = {
      ...canonical,
      id: STAR_FAVORITES_PLAYLIST_ID,
      systemKey: 'star-favorites',
      name: 'Favorites',
      // Favorites remains a system autoplaylist, but its presentation is user-editable.
      // Preserve a saved rich label/icon and only fall back to the canonical defaults
      // when older data does not have one.
      label: (typeof canonical.label === 'string' && canonical.label.trim()) ? canonical.label : 'Favorites',
      icon: (typeof canonical.icon === 'string' && canonical.icon) ? canonical.icon : '★',
      smart: true,
      // Favorites is a normal user-editable autoplaylist. Preserve its current
      // rules when they exist; only the missing/legacy default gets Love= Loved.
      rules: Array.isArray(canonical.rules) && canonical.rules.length
        ? canonical.rules
        : [{ field: 'love', op: 'is', value: 'Loved' }],
      sourceType: canonical.sourceType || 'library',
      sourceValue: canonical.sourceValue || 'library',
      favoriteAddedAt,
      updatedAt: Date.now()
    };
    const deduped = lists.filter((_, index) => !matches.some(match => match.index === index));
    const insertIndex = Math.min(canonicalMatch.index, deduped.length);
    deduped.splice(insertIndex, 0, normalized);
    await writeJsonSafe(PLAYLISTS_PATH(), deduped);
    return deduped;
  }

  const now = Date.now();
  lists.push({ ...STAR_FAVORITES_PLAYLIST, createdAt: now, updatedAt: now, trackAddedAt: {} });
  await writeJsonSafe(PLAYLISTS_PATH(), lists);
  return lists;
}

ipcMain.handle('playlists:get' , async () => ensureStarFavoritesPlaylist());
ipcMain.handle('playlists:save', async (_evt, playlist) => withJsonFileLock(PLAYLISTS_PATH(), async () => {
  const lists = await readJsonSafe(PLAYLISTS_PATH(), []);
  const existing = lists.find(p => p.id === playlist.id);
  const now = Date.now();
  const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  const previousAdded = (existing && existing.trackAddedAt && typeof existing.trackAddedAt === 'object') ? existing.trackAddedAt : {};
  const trackAddedAt = {};
  for (const trackPath of tracks) {
    const key = String(trackPath || '');
    if (!key) continue;
    trackAddedAt[key] = Number(previousAdded[key]) || now;
  }
  const favoriteAddedAtSource = playlist.favoriteAddedAt && typeof playlist.favoriteAddedAt === 'object'
    ? playlist.favoriteAddedAt
    : (existing?.favoriteAddedAt && typeof existing.favoriteAddedAt === 'object' ? existing.favoriteAddedAt : {});
  const favoriteAddedAt = {};
  for (const [trackPath, timestamp] of Object.entries(favoriteAddedAtSource)) {
    const key = String(trackPath || '');
    const value = Number(timestamp);
    if (key && Number.isFinite(value) && value > 0) favoriteAddedAt[key] = value;
  }
  const isCanonicalFavorites = playlist?.id === STAR_FAVORITES_PLAYLIST_ID || playlist?.systemKey === 'star-favorites';
  const item = {
    ...playlist,
    id: isCanonicalFavorites ? STAR_FAVORITES_PLAYLIST_ID : (playlist.id || crypto.randomUUID()),
    name: isCanonicalFavorites ? 'Favorites' : String(playlist.name || 'Untitled Playlist'),
    label: isCanonicalFavorites
      ? (typeof playlist.label === 'string' && playlist.label.trim() ? playlist.label : (typeof existing?.label === 'string' && existing.label.trim() ? existing.label : 'Favorites'))
      : (typeof playlist.label === 'string' ? playlist.label : (typeof existing?.label === 'string' ? existing.label : String(playlist.name || 'Untitled Playlist'))),
    tracks,
    trackAddedAt,
    favoriteAddedAt,
    spotifyTracks: Array.isArray(playlist.spotifyTracks) ? playlist.spotifyTracks : (Array.isArray(existing?.spotifyTracks) ? existing.spotifyTracks : []),
    // Snapshot of podcast episodes referenced by a path in `tracks`, keyed by
    // that same path. Podcast episodes aren't part of the scanned local
    // library (unlike ordinary tracks) or a dedicated Spotify-style source
    // playlist, so without a durable snapshot here, the renderer's
    // tracksForPlaylist() has nothing to resolve a "podcast:<id>" path back
    // into a playable track -- the episode would silently vanish.
    podcastEpisodes: (playlist.podcastEpisodes && typeof playlist.podcastEpisodes === 'object' && !Array.isArray(playlist.podcastEpisodes))
      ? playlist.podcastEpisodes
      : (existing?.podcastEpisodes && typeof existing.podcastEpisodes === 'object' ? existing.podcastEpisodes : {}),
    cover: typeof playlist.cover === 'string' ? playlist.cover : (typeof existing?.cover === 'string' ? existing.cover : ''),
    artworkUrl: typeof playlist.artworkUrl === 'string' ? playlist.artworkUrl : (typeof existing?.artworkUrl === 'string' ? existing.artworkUrl : ''),
    spotifyArtworkCacheFile: typeof playlist.spotifyArtworkCacheFile === 'string' ? playlist.spotifyArtworkCacheFile : (typeof existing?.spotifyArtworkCacheFile === 'string' ? existing.spotifyArtworkCacheFile : ''),
    smart: isCanonicalFavorites ? true : !!playlist.smart,
    match: playlist.match === 'any' ? 'any' : 'all',
    rules: isCanonicalFavorites
      ? (Array.isArray(playlist.rules) && playlist.rules.length ? playlist.rules : [{ field: 'love', op: 'is', value: 'Loved' }])
      : (Array.isArray(playlist.rules) ? playlist.rules : []),
    systemKey: isCanonicalFavorites ? 'star-favorites' : playlist.systemKey,
    icon: isCanonicalFavorites
      ? (typeof playlist.icon === 'string' && playlist.icon ? playlist.icon : (typeof existing?.icon === 'string' && existing.icon ? existing.icon : '★'))
      : playlist.icon,
    // 0 (or unset) means "no limit" -- a smart playlist matches every
    // qualifying track unless the user explicitly caps it. Previously this
    // coerced any falsy limit to 500 and hard-capped everything at 5000,
    // which is what made an intentionally uncapped playlist look like it
    // topped out at 5000 tracks.
    limit: Number(playlist.limit) > 0 ? Math.max(1, Math.floor(Number(playlist.limit))) : 0,
    updatedAt: now,
    createdAt: playlist.createdAt || now
  };

  const idx = lists.findIndex(p => p.id === item.id);
  if (idx >= 0) lists[idx] = item; else lists.push(item);
  await writeJsonSafe(PLAYLISTS_PATH(), lists);
  return item;
}));

function parseM3UEntries(text, playlistFile) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries = [];
  let pendingInfo = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toUpperCase().startsWith('#EXTINF:')) {
      const comma = line.indexOf(',');
      const info = comma >= 0 ? line.slice(comma + 1).trim() : '';
      const meta = line.slice(8, comma >= 0 ? comma : undefined);
      const dash = meta.indexOf(',');
      const duration = dash >= 0 ? meta.slice(0, dash) : meta;
      const parts = info.split(' - ');
      pendingInfo = { duration: Number(duration) || -1, artist: parts.length > 1 ? parts.shift().trim() : '', title: parts.join(' - ').trim() || info };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/^https?:\/\//i.test(line)) { pendingInfo = null; continue; }
    let filePath = line;
    if (/^file:\/\//i.test(filePath)) { try { filePath = decodeURIComponent(new URL(filePath).pathname); } catch { try { filePath = decodeURI(new URL(filePath).pathname); } catch {} } }
    else { try { filePath = decodeURIComponent(filePath); } catch {} }
    if (!path.isAbsolute(filePath)) filePath = path.resolve(path.dirname(playlistFile), filePath);
    entries.push({ path: path.normalize(filePath), info: pendingInfo || {} });
    pendingInfo = null;
  }
  return entries;
}

ipcMain.handle('playlists:chooseImportFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'M3U playlists', extensions: ['m3u', 'm3u8'] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  const text = await fsp.readFile(filePath, 'utf8');
  return { path: filePath, name: path.basename(filePath, path.extname(filePath)), entries: parseM3UEntries(text, filePath) };
});

ipcMain.handle('playlists:exportM3U', async (_evt, payload) => {
  const name = String(payload?.name || 'Playlist').trim() || 'Playlist';
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  const res = await dialog.showSaveDialog(mainWindow, { defaultPath: `${name}.m3u8`, filters: [{ name: 'M3U playlist', extensions: ['m3u8', 'm3u'] }] });
  if (res.canceled || !res.filePath) return { canceled: true };
  const lines = ['#EXTM3U'];
  for (const t of tracks) {
    const artist = String(t?.artist || '').trim();
    const title = String(t?.title || path.basename(t?.path || '', path.extname(t?.path || ''))).trim();
    const duration = Number(t?.duration) > 0 ? Math.round(Number(t.duration)) : -1;
    lines.push(`#EXTINF:${duration},${artist ? artist + ' - ' : ''}${title}`);
    lines.push(String(t?.path || ''));
  }
  await fsp.writeFile(res.filePath, lines.join('\n') + '\n', 'utf8');
  return { canceled: false, path: res.filePath, count: tracks.length };
});

function spotifyPlaylistId(input) {
  const value = String(input || '').trim();
  const m = value.match(/(?:open\.spotify\.com\/(?:embed\/)?)playlist\/([A-Za-z0-9]{22})/i) || value.match(/^spotify:playlist:([A-Za-z0-9]{22})$/i) || value.match(/^([A-Za-z0-9]{22})$/);
  return m ? m[1] : null;
}

function findSpotifyTrackList(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.trackList)) return value.trackList;
  for (const v of Object.values(value)) { const found = findSpotifyTrackList(v); if (found) return found; }
  return null;
}

ipcMain.handle('playlists:importSpotify', async (_evt, input) => {
  const id = spotifyPlaylistId(input);
  if (!id) throw new Error('Enter a valid Spotify playlist URL.');

  // Prefer the Spicetify session. This lets Hive import private playlists and
  // the user's complete playlist without asking Hive to own Spotify credentials.
  const commandId = enqueueSpotifyBridgeCommand({ type: 'getPlaylist', playlistId: id });
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const current = spotifyBridgeState;
    if (current?.playlist?.commandId === commandId) return current.playlist;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Public fallback keeps the button useful even before the Spicetify extension
  // has been applied. Private playlists intentionally require the Spotify client.
  const url = `https://open.spotify.com/embed/playlist/${id}`;
  const response = await net.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Spotify returned HTTP ${response.status}. Open Spotify and sign in, then try again.`);
  const html = await response.text();
  const match = html.match(/<script[^>]+id=[\"']__NEXT_DATA__[\"'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Spotify did not expose this playlist publicly. Open Spotify and sign in to import private playlists.');
  let data; try { data = JSON.parse(match[1]); } catch { throw new Error('Could not read Spotify playlist metadata.'); }
  const rows = findSpotifyTrackList(data) || [];
  const findSpotifyImage = value => {
    if (!value || typeof value !== 'object') return '';
    for (const key of ['image','image_url','imageUrl','cover','coverUrl','url']) {
      const v = String(value?.[key] || '').trim();
      if (/^https?:\/\//i.test(v) && /i\.scdn\.co|spotify/i.test(v)) return v;
    }
    for (const v of Object.values(value)) {
      if (Array.isArray(v)) for (const item of v) { const found=findSpotifyImage(item); if(found)return found; }
      else if (v && typeof v === 'object') { const found=findSpotifyImage(v); if(found)return found; }
    }
    return '';
  };
  const tracks = rows.map(row => {
    const title = row?.title || row?.name || '';
    const subtitle = row?.subtitle || row?.artist || '';
    const uri = row?.uri || '';
    const artists = String(subtitle).split(',').map(x => x.trim()).filter(Boolean);
    const rawDuration = Number(row?.duration || row?.duration_ms || 0) || 0;
    const duration = rawDuration > 10000 ? rawDuration / 1000 : rawDuration;
    const cover = String(row?.image || row?.cover || '').trim() || findSpotifyImage(row);
    return { title: String(title).trim(), artist: artists.join(', '), spotifyUri: uri, spotifyId: String(uri).split(':').pop(), album: String(row?.album || '').trim(), duration, cover, artworkUrl: cover };
  }).filter(t => t.title && t.spotifyId);
  const name = String(data?.props?.pageProps?.state?.data?.entity?.name || data?.props?.pageProps?.data?.entity?.name || 'Spotify Playlist').trim();
  const cover = tracks.find(t => /^https?:\/\//i.test(String(t.cover || t.artworkUrl || '')))?.cover || '';
  return { id, name, sourceUrl: `https://open.spotify.com/playlist/${id}`, cover, artworkUrl:cover, tracks, likelyTruncated: rows.length >= 100, source: 'spotify' };
});

ipcMain.handle('playlists:delete', async (_evt, id) => withJsonFileLock(PLAYLISTS_PATH(), async () => {
  const lists = await readJsonSafe(PLAYLISTS_PATH(), []);
  await writeJsonSafe(PLAYLISTS_PATH(), lists.filter(p => p.id !== id));
  return true;
}));

async function writeMp3MusicBeeLove(trackPath, loved) {
  await updateMp3MusicBeeTags(trackPath, { loved: !!loved });
}

const {
  mp4Atom,
  mp4Children,
  mp4FindPath,
  parseMp4FreeformName,
} = require('./mp4-atoms');
function mp4LoveValuesFromBuffer(input) {
  let p = 0;
  const top = [];
  while (p + 8 <= input.length) { const a = mp4Atom(input, p); if (!a) break; top.push(a); p = a.end; }
  const moov = top.find(a => a.type === 'moov');
  const ilst = moov && mp4FindPath(input, moov, ['udta', 'meta', 'ilst']);
  if (!ilst) return [];
  const values = [];
  for (const c of mp4Children(input, ilst)) {
    const ff = parseMp4FreeformName(input, c);
    if (!ff || ff.mean.toLowerCase() !== 'com.apple.itunes' || !isBeehiveLoveFieldName(ff.name)) continue;
    const d = mp4Children(input, c).find(x => x.type === 'data');
    if (!d || d.offset + d.header + 8 > d.end) continue;
    values.push(input.subarray(d.offset + d.header + 8, d.end).toString('utf8').trim().toUpperCase());
  }
  return values;
}

async function verifyLoveTag(trackPath, expected) {
  const ext = path.extname(trackPath).toLowerCase();

  // Each container has its own native MusicBee Love representation.
  // Verification deliberately checks the whole tag/container so an Unlove
  // operation cannot succeed while a duplicate/legacy Love field remains.
  if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') {
    const values = mp4LoveValuesFromBuffer(await fsp.readFile(trackPath));
    return expected ? (values.length === 1 && values[0] === 'L') : values.length === 0;
  }
  if (ext === '.flac') {
    try {
      const c = spawnTracked('metaflac', ['--export-tags-to=-', trackPath], { windowsHide: true });
      let output = '';
      c.stdout.on('data', d => { output += d.toString(); });
      const code = await new Promise((resolve, reject) => {
        c.on('error', reject);
        c.on('close', resolve);
      });
      if (code !== 0) return false;
      const lines = output.split(/\r?\n/).filter(Boolean);
      const loveLines = lines.filter(line => isBeehiveLoveFieldName(line.split('=')[0]));
      if (!expected) return loveLines.length === 0;
      return loveLines.length === 1 && /^LOVE RATING=L$/i.test(loveLines[0].trim());
    } catch {
      return false;
    }
  }

  let data = await fsp.readFile(trackPath);
  if (ext === '.wav') {
    let p = 12;
    let found = null;
    while (p + 8 <= data.length) {
      const id = data.toString('ascii', p, p + 4);
      const size = data.readUInt32LE(p + 4);
      const dataStart = p + 8;
      if (dataStart + size > data.length) break;
      if (id === 'id3 ' || id === 'ID3 ') {
        found = data.subarray(dataStart, dataStart + size);
        break;
      }
      p = dataStart + size + (size & 1);
    }
    if (!found) return !expected;
    data = found;
  }

  if (ext === '.mp3' || ext === '.wav') {
    if (data.length < 10 || data.toString('ascii', 0, 3) !== 'ID3') return !expected;
    const version = data[3] >= 4 ? 4 : 3;
    const size = readId3Size(data);
    const payload = data.subarray(10, Math.min(data.length, 10 + size));
    let loveCount = 0;
    let lovedValueCount = 0;
    let loveValueIsUnloved = false;
    for (const frame of parseId3Frames(payload, version).frames) {
      if (frame.id !== 'TXXX') continue;
      const desc = txxxDescription(frame.data).trim().toUpperCase();
      if (!isBeehiveLoveFieldName(desc)) continue;
      loveCount++;
      const body = frame.data.subarray(1);
      const nul = body.indexOf(0);
      const value = body.subarray(nul >= 0 ? nul + 1 : 0)
        .toString(frame.data[0] === 3 ? 'utf8' : 'latin1')
        .trim().toUpperCase();
      if (value === 'L') lovedValueCount++;
      if (value === '0') loveValueIsUnloved = true;
    }
    return expected ? (loveCount === 1 && lovedValueCount === 1) : (loveCount === 0);
  }

  return false;
}

async function embedLoveInFile(trackPath, loved) {
  if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
  const temp = await createMetadataTempPath(trackPath, 'love');
  const artworkBefore = await runTagHelper({ op:'artwork_fingerprint', path:trackPath });
  try {
    await copyMetadataFile(trackPath, temp, false);
    // LOVE is ordinary metadata. Keep one writer: the bundled Mutagen backend.
    await runTagHelper({ op:'write_love', path:temp, loved:!!loved });
    const readBack = await runTagHelper({ op:'read_love', path:temp });
    if (Boolean(readBack?.loved) !== Boolean(loved)) {
      throw new Error(`Love write verification failed: expected ${!!loved}, read back ${!!readBack?.loved}`);
    }
    const artworkAfter = await runTagHelper({ op:'artwork_fingerprint', path:temp });
    if (artworkBefore?.fingerprint !== artworkAfter?.fingerprint) {
      throw new Error('Love write changed embedded artwork unexpectedly; the original file was left untouched.');
    }
    await commitMetadataTemp(temp, trackPath, false);
    return true;
  } catch(err) {
    try { await fsp.unlink(temp); } catch {}
    throw new Error(`Could not embed Love tag: ${err.message}`);
  }
}

function sendTagProgress(evt, payload) {
  try { evt?.sender?.send('library:tagProgress', payload); } catch {}
}

async function updateCachedLoved(paths, loved) {
  const cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  const wanted = new Set((Array.isArray(paths) ? paths : [paths])
    .filter(Boolean)
    .map(p => path.resolve(String(p))));
  let changed = false;
  for (const track of (cache.tracks || [])) {
    const trackPath = String(track?.path || '');
    if (!trackPath || !wanted.has(path.resolve(trackPath))) continue;
    if (!!track.loved !== !!loved) {
      track.loved = !!loved;
      changed = true;
    }
  }
  if (changed) await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
  try {
    const values = {};
    for (const trackPath of wanted) values[trackPath] = !!loved;
    await databaseRequest('set_loved', { values });
  } catch (err) {
    crashDebug('DATABASE Love projection update failed', { message: err?.message || String(err), paths: [...wanted] });
  }
  return changed;
}

async function readFlacMusicBeeLove(filePath) {
  try {
    const c = spawnTracked('metaflac', ['--export-tags-to=-', filePath], { windowsHide: true });
    let output = '';
    c.stdout.on('data', d => { output += d.toString(); });
    const code = await new Promise((resolve, reject) => {
      c.on('error', reject);
      c.on('close', resolve);
    });
    if (code !== 0) return false;
    for (const line of output.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq < 0 || !isBeehiveLoveFieldName(line.slice(0, eq))) continue;
      if (isFavoriteLoveValue(line.slice(eq + 1))) return true;
    }
  } catch {}
  return false;
}

async function readMp4MusicBeeLove(filePath) {
  try { return mp4LoveValuesFromBuffer(await fsp.readFile(filePath)).some(isFavoriteLoveValue); } catch {}
  return false;
}

async function snapshotProtectedMetadata(trackPath) {
  // Artwork operations are strictly artwork-only. Capture the two user-facing
  // independent states before the native tag rewrite and verify them afterward.
  // This prevents a buggy metadata backend from silently changing Love or Rating
  // while removing/replacing pictures.
  return {
    loved: !!(await readLoveStateFromDisk(trackPath)),
    rating: Number(await readEmbeddedRating(trackPath)) || 0
  };
}

async function verifyProtectedMetadataUnchanged(trackPath, before) {
  const after = await snapshotProtectedMetadata(trackPath);
  if (!!after.loved !== !!before.loved) {
    throw new Error('Artwork operation changed the Love state; the file was not accepted.');
  }
  if (Math.abs(after.rating - before.rating) > 0.01) {
    throw new Error(`Artwork operation changed the Rating from ${before.rating} to ${after.rating}; the file was not accepted.`);
  }
  return after;
}

async function readLoveStateFromDisk(trackPath) {
  const filePath = path.resolve(String(trackPath || ''));
  if (!filePath || !fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return !!(await readMp3MusicBeeLove(filePath));
  if (ext === '.wav') return !!(await readWavMusicBeeLove(filePath));
  if (ext === '.flac') return !!(await readFlacMusicBeeLove(filePath));
  if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') return !!(await readMp4MusicBeeLove(filePath));
  try {
    const meta = await (await ensureMM()).parseFile(filePath, { duration: false, skipCovers: true });
    for (const tagList of Object.values(meta.native || {})) {
      for (const tag of (Array.isArray(tagList) ? tagList : [])) {
        const desc = String(tag?.value?.description || '').trim().toUpperCase();
        if (!isBeehiveLoveFieldName(desc)) continue;
        const value = String(tag?.value?.text ?? tag?.value ?? '').trim().toUpperCase();
        if (isFavoriteLoveValue(value)) return true;
      }
    }
  } catch {}
  return false;
}

async function setLoveForSingleTrack(evt, trackPath, loved) {
  if (!trackPath) throw new Error('Track path is required.');
  const value = !!loved;
  const absolutePath = path.resolve(String(trackPath));
  const recoveryJob = { id:crypto.randomUUID(), kind:'love', path:absolutePath, loved:value, createdAt:Date.now() };
  await persistMetadataJob(recoveryJob, 'running', 1, '');
  const workerPath = runtimeResourcePath(path.join('app','workers','metadata-worker.js'));
  const operationLabel = `${value ? 'Loving' : 'Unloving'} 1 file`;

  // A single-track Love/Unlove must use the same metadata-worker path as bulk
  // operations. This is important for FLAC: the worker selects the writer by
  // extension and uses metaflac to embed MusicBee's LOVE RATING field. MP3,
  // WAV, M4A/MP4 and other supported formats use their format-specific writers.
  await waitForPlaybackProtectionRelease(absolutePath);
  // Same per-path lock as embedRatingInFile/performWriteMetadata/artwork
  // writers: the worker below reads the whole file, writes its own copy, and
  // renames it back independently of those writers, so without a shared lock
  // a Love toggle and a Rating change made moments apart for the same file
  // could race and one edit would silently discard the other.
  return withMusicBeeWriteLock(absolutePath, () => setLoveForSingleTrackLocked(evt, absolutePath, value, recoveryJob, workerPath, operationLabel));
}

async function setLoveForSingleTrackLocked(evt, absolutePath, value, recoveryJob, workerPath, operationLabel) {
  markLibraryInternalWrite(absolutePath);
  libraryPendingLoveWrites.set(absolutePath, value);
  libraryBulkWriteActive = true;
  if (libraryWatchDebounce) {
    clearTimeout(libraryWatchDebounce);
    libraryWatchDebounce = null;
  }

  const sendProgress = (active, phase, done, current = '') => {
    sendTagProgress(evt, {
      active,
      operation: 'love',
      operationLabel,
      phase,
      done,
      total: 1,
      updated: done,
      failed: done ? 0 : 0,
      skipped: 0,
      current
    });
  };

  sendProgress(true, 'Starting background metadata worker', 0, '');

  let child = null;
  let timer = null;
  let writeSucceeded = false;
  try {
    child = forkTracked(workerPath, [], workerForkOptions({
      execArgv: ['--max-old-space-size=512'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    }));
    child.stdout?.on('data', chunk => { const text = String(chunk || '').trim(); if (text) scanLog(`metadata worker stdout: ${text}`); });
    child.stderr?.on('data', chunk => { const text = String(chunk || '').trim(); if (text) scanLog(`metadata worker stderr: ${text}`); });

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = fn => value => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      child.once('message', finish(resolve));
      child.once('error', finish(reject));
      child.once('exit', finish((code, signal) => reject(new Error(`Metadata worker exited (${code ?? 'null'}${signal ? `, ${signal}` : ''}).`))));
      timer = setTimeout(() => finish(reject)(new Error('Metadata worker timed out after 120 seconds.')), 120000);
      child.send({ cmd: 'love', path: absolutePath, loved: value }, err => {
        if (err) finish(reject)(err);
      });
    });

    if (!result?.ok) throw new Error(result?.error || 'Metadata worker failed.');

    // The worker verifies the format-specific embedded tag. Re-read it from
    // the physical file as an independent final check before touching cache.
    const diskLoved = await readLoveStateFromDisk(absolutePath);
    if (diskLoved !== value) {
      throw new Error(`File metadata did not change to ${value ? 'Loved' : 'Unloved'} on disk.`);
    }

    await updateCachedLoved(absolutePath, value);
    await deleteMetadataJob(recoveryJob.id);
    writeSucceeded = true;
    sendProgress(true, 'Embedded Love tag verified', 1, path.basename(absolutePath));
    return true;
  } finally {
    if (!writeSucceeded) await updateMetadataJob(recoveryJob.id, 'retry', 1, 'Love operation interrupted or failed.');
    if (timer) clearTimeout(timer);
    try { child?.disconnect(); } catch {}
    try { child?.kill(); } catch {}
    libraryPendingLoveWrites.delete(absolutePath);
    libraryBulkWriteActive = false;
    libraryBulkWriteIgnoreUntil = Date.now() + 5000;
    sendTagProgress(evt, {
      active: false,
      operation: 'love',
      operationLabel: 'Love operation complete',
      phase: 'Finished',
      done: 1,
      total: 1,
      updated: writeSucceeded ? 1 : 0,
      failed: writeSucceeded ? 0 : 1,
      skipped: 0,
      current: '',
      errors: writeSucceeded ? [] : [{ path: absolutePath, error: 'Love metadata write failed.' }]
    });
  }
}

ipcMain.handle('track:toggleLove', async (evt, trackPath, value) => {
  return setLoveForSingleTrack(evt, trackPath, !!value);
});

ipcMain.handle('tracks:setLove', async (evt, trackPaths = [], loved) => {
  const requestedPaths = [...new Set((Array.isArray(trackPaths) ? trackPaths : [])
    .filter(Boolean).map(p => String(p)))];
  const value = !!loved;
  const results = { updated: 0, failed: 0, skipped: 0, errors: [] };

  // If we are adding Love, never rewrite files that are already marked as
  // favorites. The cache mirrors Beehive's authoritative Love tag state, so
  // this removes thousands of needless metadata rewrites from a "Love all"
  // operation while keeping the main process out of the file loop.
  let cache = await readJsonSafe(LIBRARY_CACHE_PATH(), { tracks: [] });
  if (!cache || !Array.isArray(cache.tracks)) cache = { tracks: [] };
  const cacheByPath = new Map(cache.tracks.map(t => [String(t.path || ''), t]));
  let paths = requestedPaths;
  if (value) {
    const alreadyLoved = new Set(
      cache.tracks.filter(t => !!t?.loved).map(t => String(t.path || ''))
    );
    paths = requestedPaths.filter(p => !alreadyLoved.has(p));
    results.skipped = requestedPaths.length - paths.length;
  }
  const total = paths.length;
  if (!total) {
    sendTagProgress(evt, {
      active: false,
      operation: 'love',
      operationLabel: 'Love operation complete',
      phase: results.skipped ? `Skipped ${results.skipped.toLocaleString()} already Loved` : 'Finished',
      done: 0,
      total: 0,
      updated: 0,
      failed: 0,
      skipped: results.skipped,
      current: ''
    });
    return results;
  }

  // Strawberry-style architecture: enqueue metadata jobs onto dedicated
  // background worker processes. The Electron main process remains responsible
  // for playback/UI IPC while workers do the expensive file I/O and tag rewrites.
  // Keep metadata writes strictly serialized. A single worker avoids competing
  // whole-file rewrites and lets the audio decoder retain disk/CPU headroom.
  const WORKER_COUNT = 1;
  const workerPath = runtimeResourcePath(path.join('app','workers','metadata-worker.js'));
  const previousBulkState = libraryBulkWriteActive;
  const recoveryJobs = new Map();
  for (const p of paths) {
    const job = { id:crypto.randomUUID(), kind:'love', path:path.resolve(String(p)), loved:value, createdAt:Date.now() };
    recoveryJobs.set(path.resolve(String(p)), job);
    void persistMetadataJob(job, 'queued', 0, '');
    libraryPendingLoveWrites.set(p, value);
  }
  libraryBulkWriteActive = true;
  if (libraryWatchDebounce) {
    clearTimeout(libraryWatchDebounce);
    libraryWatchDebounce = null;
  }

  let cacheDirty = false;
  let lastCacheFlush = Date.now();
  let lastProgressAt = 0;
  let nextIndex = 0;
  let completed = 0;
  let stopped = false;
  const workers = [];

  const sendProgress = (active, current = '') => {
    const now = Date.now();
    if (active && completed !== total && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    sendTagProgress(evt, {
      active,
      operation: 'love',
      operationLabel: `${value ? 'Loving' : 'Unloving'} ${total.toLocaleString()} files${results.skipped ? ` (${results.skipped.toLocaleString()} already Loved skipped)` : ''}`,
      phase: active ? 'Embedding Love tags' : (results.failed ? 'Finished with errors' : 'Finished'),
      done: completed,
      total,
      updated: results.updated,
      failed: results.failed,
      skipped: results.skipped,
      current,
      lastError: results.errors.length ? results.errors[results.errors.length - 1] : null
    });
  };

  const flushCache = async (force = false) => {
    if (!cacheDirty) return;
    if (!force && completed % 250 !== 0 && Date.now() - lastCacheFlush < 5000) return;
    await writeJsonSafe(LIBRARY_CACHE_PATH(), cache);
    cacheDirty = false;
    lastCacheFlush = Date.now();
  };

  const createWorker = () => {
    const child = forkTracked(workerPath, [], workerForkOptions({
      execArgv: ['--max-old-space-size=512'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    }));
    const state = { child, busy: false, job: null, timer: null };
    child.stdout?.on('data', chunk => { const text = String(chunk || '').trim(); if (text) scanLog(`metadata worker stdout: ${text}`); });
    child.stderr?.on('data', chunk => { const text = String(chunk || '').trim(); if (text) scanLog(`metadata worker stderr: ${text}`); });
    workers.push(state);
    return state;
  };

  const shutdownWorker = state => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    try { state.child.removeAllListeners(); } catch {}
    try { state.child.disconnect(); } catch {}
    try { state.child.kill(); } catch {}
  };

  const finishJob = async (state, message) => {
    if (!state.job) return;
    const job = state.job;
    state.job = null;
    state.busy = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    completed++;
    if (message?.ok) {
      results.updated++;
      await deleteMetadataJob(recoveryJobs.get(path.resolve(String(job.path)))?.id);
      const track = cacheByPath.get(job.path);
      if (track) { track.loved = value; track.loveHydrated = true; cacheDirty = true; }
      try { await databaseRequest('set_loved', { values: { [path.resolve(String(job.path))]: value } }); }
      catch (err) { scanLog('DATABASE Love projection update failed', { path: job.path, error: err?.message || String(err) }); }
    } else {
      results.failed++;
      const recovery = recoveryJobs.get(path.resolve(String(job.path)));
      await updateMetadataJob(recovery?.id, 'retry', 1, message?.error || 'Metadata worker failed.');
      results.errors.push({ path: job.path, error: message?.error || 'Metadata worker failed.' });
    }
    await flushCache(false);
    sendProgress(true, path.basename(job.path));
    dispatch(state);
    if (completed >= total) stopped = true;
    // Release this job's per-path write lock only now that every side effect
    // of it (cache/database updates, progress, recovery-job bookkeeping) is
    // fully committed.
    job.releaseLock?.();
  };

  const dispatch = async state => {
    if (stopped || state.busy) return;
    if (nextIndex >= total) return;
    const job = { path: paths[nextIndex++], loved: value };
    try {
      await waitForPlaybackProtectionRelease(job.path);
    } catch (err) {
      completed++;
      results.failed++;
      results.errors.push({ path: job.path, error: err?.message || String(err) });
      sendProgress(true, path.basename(job.path));
      if (completed >= total) stopped = true;
      return;
    }
    if (stopped) return;
    // Hold the same per-path write lock every other metadata writer (Rating,
    // artwork, general tag-editor save, single-track Love) uses, for this
    // job's entire in-flight duration -- from the send below through however
    // it eventually settles (worker response, timeout, or worker error/exit).
    // Without this, an individual Rating/Artwork edit for a file this bulk
    // Love operation happens to be mid-write on could race it, exactly the
    // race this whole write-lock convention exists to prevent.
    withMusicBeeWriteLock(job.path, () => new Promise(resolve => {
      job.releaseLock = resolve;
      state.job = job;
      state.busy = true;
      state.timer = setTimeout(async () => {
        if (!state.busy || !state.job) return;
        const timedOutJob = state.job;
        state.busy = false;
        state.job = null;
        results.failed++;
        completed++;
        results.errors.push({ path: timedOutJob.path, error: 'Metadata worker timed out after 120 seconds.' });
        sendProgress(true, path.basename(timedOutJob.path));
        try { state.child.kill(); } catch {}
        const idx = workers.indexOf(state);
        if (idx >= 0) workers[idx] = createWorker();
        timedOutJob.releaseLock?.();
        dispatch(workers[idx]);
        if (completed >= total) stopped = true;
      }, 120000);
      try { state.child.send({ cmd: 'love', path: job.path, loved: value }); }
      catch (err) { finishJob(state, { ok: false, error: err?.message || String(err) }); }
    })).catch(() => {});
  };

  sendTagProgress(evt, { active: true, operation: 'love', operationLabel: `${value ? 'Loving' : 'Unloving'} ${total.toLocaleString()} files${results.skipped ? ` (${results.skipped.toLocaleString()} already Loved skipped)` : ''}`, phase: 'Starting background metadata workers', done: 0, total, updated: 0, failed: 0, skipped: results.skipped, current: '' });

  try {
    for (let i = 0; i < WORKER_COUNT; i++) createWorker();
    for (const state of workers) {
      state.child.on('message', msg => { finishJob(state, msg).catch(err => scanLog('Metadata job completion error', { error: String(err) })); });
      state.child.on('error', err => {
        if (state.busy) finishJob(state, { ok: false, error: err?.message || String(err) }).catch(() => {});
      });
      state.child.on('exit', (code, signal) => {
        if (state.busy) finishJob(state, { ok: false, error: `Metadata worker exited (${code ?? 'null'}${signal ? `, ${signal}` : ''}).` }).catch(() => {});
      });
    }
    for (const state of workers) dispatch(state);

    while (completed < total) await new Promise(resolve => setTimeout(resolve, 100));
    await flushCache(true);
    return results;
  } finally {
    stopped = true;
    await flushCache(true).catch(() => {});
    for (const state of workers) shutdownWorker(state);
    for (const p of paths) libraryPendingLoveWrites.delete(p);
    libraryBulkWriteActive = previousBulkState;
    libraryBulkWriteIgnoreUntil = Date.now() + 5000;
    sendTagProgress(evt, { active: false, operation: 'love', operationLabel: 'Love operation complete', phase: results.failed ? 'Finished with errors' : 'Finished', done: total, total, updated: results.updated, failed: results.failed, skipped: results.skipped, current: '', errors: results.errors });
  }
});
