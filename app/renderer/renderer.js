(function () {
  // Earliest possible renderer marker: this intentionally runs before any Beehive
  // application initialization so a pre-init exception cannot leave us blind.
  try {
    if (window.beehive?.startupDebugEnabled) {
      window.beehive.startupDebugLog('RENDERER EARLIEST SCRIPT ENTRY', { readyState: document.readyState, href: location.href });
    }
  } catch (err) {
    try { console.error('[Beehive Debug] earliest startup marker failed', err); } catch {}
  }
  window.addEventListener('error', event => {

    try { console.error('[Beehive Debug] RENDERER error', { message: event.message, source: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack }); } catch {}
  });
  window.addEventListener('unhandledrejection', event => {
    try { console.error('[Beehive Debug] RENDERER unhandledrejection', event.reason?.stack || event.reason?.message || String(event.reason)); } catch {}
  });
  const audioElement = document.getElementById('audio');
  const rendererRecreationMode = new URLSearchParams(location.search).get('preservePlayback') === '1';

  const startupDebugEnabled = !!window.beehive.startupDebugEnabled;
  const performanceDebugEnabled = !!window.beehive.performanceDebugEnabled;
  const startupStatus = document.getElementById('startup-status');
  const startupStatusText = document.getElementById('startup-status-text');
  const startupPerfStart = performance.now();
  function startupMark(label, details = null) {
    if (!startupDebugEnabled) return;
    try { window.beehive.startupDebugLog(label, details); } catch {}
  }
  function diagnosticMark(phase, detail = null) {
    try { window.beehive.diagnosticMark?.(phase, detail); } catch {}
  }
  function startupStatusUpdate(text, hide = false) {
    if (startupStatusText) startupStatusText.textContent = String(text || 'Starting Hive…');
    if (startupStatus) startupStatus.classList.toggle('hidden', !!hide);
  }
  startupMark('RENDERER SCRIPT START', { href:location.href, readyState:document.readyState });
  if (startupDebugEnabled && 'PerformanceObserver' in window) {
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) startupMark('RENDERER LONG TASK', { durationMs:Number(entry.duration.toFixed(1)), startMs:Number(entry.startTime.toFixed(1)), name:entry.name });
        }
      });
      observer.observe({ type:'longtask', buffered:true });
    } catch {}
  }
  if (startupDebugEnabled) {
    let lastLoop = performance.now();
    const loopTimer = setInterval(() => {
      const now = performance.now();
      const drift = now - lastLoop - 250;
      lastLoop = now;
      if (drift > 75) startupMark('RENDERER EVENT LOOP STALL', { delayMs:Number(drift.toFixed(1)) });
    }, 250);
    loopTimer.unref?.();
    setTimeout(() => {
      clearInterval(loopTimer);
      // Continue a lightweight health stream after startup. This is debug-only
      // and is specifically intended to catch delayed renderer OOM/crash events.
      const runtimeHealthTimer = setInterval(() => {
        let imageCount = 0;
        try { imageCount = document.images?.length || 0; } catch {}
        startupMark('RENDERER RUNTIME HEALTH', {
          href: location.href,
          activeTab: activeTabId || null,
          view: viewMode || null,
          libraryTracks: Array.isArray(library?.tracks) ? library.tracks.length : 0,
          domNodes: document.getElementsByTagName('*').length,
          domImages: imageCount,
          coverCache: typeof coverMemoryCache !== 'undefined' ? coverMemoryCache.size : null,
          rssHint: performance.memory ? performance.memory.usedJSHeapSize : null,
          heapLimitHint: performance.memory ? performance.memory.jsHeapSizeLimit : null
        });
      }, 5000);
      runtimeHealthTimer.unref?.();
    }, 20000);
  }

  // Gapless playback engine: one persistent Web Audio clock, with decoded
  // AudioBuffers scheduled ahead of time. The HTMLMediaElement remains only as
  // a hidden compatibility shell; it is not the audio transport.
  const audioEngine = new EventTarget();
  let audioCtx = null;
  let masterGain = null;
  let activeSource = null;
  let activeBuffer = null;
  let activeStartedAt = 0;
  let activeOffset = 0;
  let activeDuration = 0;
  let enginePaused = true;
  let engineEnded = true;
  let engineMuted = false;
  // Default UI position is 80%; keep the engine default consistent with the
  // cubic slider representation instead of starting at linear 100%.
  let engineVolume = 0.8;
  let engineTrackGain = 1;
  const REPLAYGAIN_MODE_KEY = 'beehive:replaygain-mode';
  const REPLAYGAIN_CLIPPING_KEY = 'beehive:replaygain-clipping';
  let engineSrc = '';
  let engineGeneration = 0;
  // Startup restoration is permanently silent until the user explicitly presses
  // Play. This lock prevents any accidental programmatic play/resume path from
  // turning the restored position into immediate playback.
  let startupPlaybackLocked = true;
  // Startup restoration can retain the saved position without decoding the
  // entire track. This offset is consumed by the first explicit Play action.
  let pendingRestoredOffset = null;
  let scheduledNext = null;
  let scheduledNextIndex = -1;
  const bufferCache = new Map();
  const bufferLoads = new Map();

  // Native GStreamer transport. Unlike the previous experiment, this does not
  // copy decoded PCM through Electron IPC and does not create a second clock.
  // GStreamer owns one persistent pipeline and audio sink, closely matching
  // Strawberry's playbin/about-to-finish architecture.
  let gstAvailable = false;
  let gstAvailabilityKnown = false;
  let gstAvailabilityPromise = null;
  let gstActive = false;
  // A native audio-path fault is a safety latch, not a recoverable playback
  // miss. Never fall back to another decoder or automatically replay a track
  // after GStreamer reports a fatal audio error; restart Hive to clear it.
  let gstFatalError = false;
  let gstPosition = 0;
  let gstPositionUpdatedAt = 0;
  // Native POSITION events are ignored while a fresh URI is being loaded. The
  // persistent playbin can still report the previous URI's position during the
  // READY/PAUSED handoff; accepting that event after currentIndex changes would
  // paint the old scrubber position onto the new track. LOADED is the first
  // authoritative acknowledgement for the new URI.
  let gstPositionUpdatesEnabled = false;
  let gstDuration = 0;
  let gstTrackIndex = -1;
  let gstWaitingNextStream = false;
  let gstExpectInitialStream = false;
  let gstResumeAfterSeek = false;
  let spotifyState = null;
  let spotifyActive = false;
  let activePlaybackProvider = 'none';
  let spotifyPendingUri = '';
  let spotifyCommandBusy = false;
  let spotifyBridgeStartupPromise = null;
  let spotifyVolumeUserInteracting = false;
  let spotifySeekUserInteracting = false;
  let spotifyVolumeInteractionUntil = 0;
  let podcastActive = false;
  let scrobbleConfig = { enabled:false, thresholdPercent:50, thresholdSeconds:240, includePodcasts:false };
  let scrobbleCurrentKey = '';
  let scrobbleSubmitted = false;
  let scrobbleLastNowPlayingKey = '';
  function scrobbleKey(t) { return [t?.source,t?.path,t?.spotifyUri,t?.streamUrl,t?.title,t?.artist,t?.album].map(v=>String(v||'')).join('|'); }
  async function loadScrobbleConfig() { try { if (window.beehive.scrobbleStatus) scrobbleConfig = await window.beehive.scrobbleStatus(); } catch {} }
  function scrobbleEligible(t) { return !!t && (String(t.source||'').toLowerCase() !== 'podcast' || !!scrobbleConfig.includePodcasts); }
  async function scrobbleStart(t) {
    if (!scrobbleConfig.enabled || !scrobbleEligible(t)) return;
    const key=scrobbleKey(t); if (!key || key===scrobbleCurrentKey) return;
    scrobbleCurrentKey=key; scrobbleSubmitted=false; scrobbleLastNowPlayingKey='';
    try { await window.beehive.scrobbleStarted?.(t); scrobbleLastNowPlayingKey=key; } catch {}
  }
  async function scrobbleProgress(t, position, duration) {
    if (!scrobbleConfig.enabled || !scrobbleEligible(t) || !scrobbleCurrentKey || scrobbleSubmitted) return;
    const pos=Number(position)||0, dur=Number(duration)||0;
    if (dur<=0) return;
    const threshold=Math.min(dur * (Number(scrobbleConfig.thresholdPercent)||50)/100, Number(scrobbleConfig.thresholdSeconds)||240);
    if (pos >= threshold) { scrobbleSubmitted=true; try { await window.beehive.scrobbleSubmit?.(t); } catch {} }
  }

  function isSpotifyTrack(t) { return String(t?.source || '').toLowerCase() === 'spotify' && !!t?.spotifyUri; }
  function spotifyArtworkUrl(t) {
    if (!isSpotifyTrack(t)) return '';
    for (const value of [t?.artworkUrl, t?.cover]) {
      const url = normalizeSpotifyArtworkSource(value);
      if (/^https?:\/\//i.test(url)) return url;
    }
    return '';
  }
  function spotifyCachedArtworkSrc(t) {
    if (!isSpotifyTrack(t) || !t?.spotifyArtworkCacheFile) return '';
    return window.beehive.coverUrl?.(String(t.spotifyArtworkCacheFile)) || '';
  }
  function isPodcastTrack(t) { return String(t?.source || '').toLowerCase() === 'podcast' && !!t?.streamUrl; }
  function isLocalPlaybackTrack(t) { return !!t?.path && !isPodcastTrack(t) && !isSpotifyTrack(t); }
  function spotifyPositionNow() {
    if (!spotifyState) return 0;
    const base = Number(spotifyState.position) || 0;
    if (!spotifyState.isPlaying) return base;
    const stamp = Number(spotifyState.timestamp) || Date.now();
    return Math.max(0, Math.min(Number(spotifyState.duration) || Number.MAX_SAFE_INTEGER, base + Math.max(0, (Date.now() - stamp) / 1000)));
  }
  function setActivePlaybackProvider(provider) {
    activePlaybackProvider = ['local','spotify','podcast'].includes(provider) ? provider : 'none';
    spotifyActive = activePlaybackProvider === 'spotify';
    return activePlaybackProvider;
  }

  function stopLocalPlaybackForExternalProvider() {
    ++engineGeneration;
    cancelScheduledNext();
    stopActiveSource();
    if (gstActive) gstStop();
    gstActive = false;
    gstWaitingNextStream = false;
    gstExpectInitialStream = false;
    gstResumeAfterSeek = false;
    enginePaused = true;
    engineEnded = false;
    activeBuffer = null;
    activeOffset = 0;
    activeDuration = 0;
  }

  function stopSpotifyPlaybackForLocal() {
    if (spotifyActive) {
      void spotifySend({ type:'pause' });
      spotifyPendingUri = '';
      spotifyState = null;
    }
    if (activePlaybackProvider === 'spotify') setActivePlaybackProvider('none');
  }

  function activateSpotifyProvider() {
    stopLocalPlaybackForExternalProvider();
    podcastActive = false;
    try { audioElement.pause(); audioElement.removeAttribute('src'); } catch {}
    setActivePlaybackProvider('spotify');
  }

  function activateLocalProvider() {
    stopSpotifyPlaybackForLocal();
    podcastActive = false;
    try { audioElement.pause(); audioElement.removeAttribute('src'); } catch {}
    setActivePlaybackProvider('local');
  }

  async function spotifySend(command) {
    try {
      const result = await window.beehive.spotifyCommand(command);
      console.info('[Spotify Playback] bridge command', { command, result });
      return result;
    } catch (err) {
      console.error('[Spotify Playback] bridge command failed', { command, message:err?.message || String(err) });
      return false;
    }
  }
  async function ensureSpotifyBridge() {
    // The Hive loopback HTTP server existing is NOT the same thing as the
    // Spicetify extension being connected. spotifyStatus.connected is only
    // true after Spotify itself has POSTed state through the extension.
    // Keep one startup attempt shared by concurrent play requests so three
    // clicks cannot spawn three isolated Spotify instances.
    if (spotifyBridgeStartupPromise) return spotifyBridgeStartupPromise;
    spotifyBridgeStartupPromise = (async () => {
      try {
        const status = await window.beehive.spotifyStatus?.();
        if (status?.connected) {
          if (status.player) spotifyApplyState(status.player);
          return true;
        }
      } catch {}
      try {
        const launched = await window.beehive.spotifyLaunch?.();
        if (!launched) return false;
      } catch { return false; }
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 350));
        try {
          const status = await window.beehive.spotifyStatus?.();
          if (status?.connected) {
            if (status.player) spotifyApplyState(status.player);
            return true;
          }
        } catch {}
      }
      return false;
    })();
    try { return await spotifyBridgeStartupPromise; }
    finally { spotifyBridgeStartupPromise = null; }
  }
  function bindSpotifyProviderEvents() {
    if (!window.beehive?.onSpotifyState) return;
    try {
      window.beehive.onSpotifyState(state => {
        console.info('[Spotify Playback] provider state received', {
          uri: state?.uri, isPlaying: !!state?.isPlaying, position: state?.position, duration: state?.duration
        });
        spotifyApplyState(state);
      });
    } catch (err) {
      console.warn('[Spotify Playback] provider state listener unavailable:', err?.message || String(err));
    }
  }
  bindSpotifyProviderEvents();

  function spotifyApplyState(state) {
    const current = currentQueue[currentIndex];
    if (!current || !isSpotifyTrack(current) || !state) return;
    const stateUri = typeof state?.uri === 'string' ? state.uri.trim() : String(state?.uri?.uri || state?.uri?.value || '').trim();
    if (!stateUri || !current.spotifyUri) return;
    if (spotifyPendingUri && stateUri !== spotifyPendingUri) {
      console.info('[Spotify Playback] ignored stale provider state', { stateUri, pendingUri:spotifyPendingUri });
      return;
    }
    if (stateUri !== current.spotifyUri) {
      const found = currentQueue.findIndex(t => t?.spotifyUri === stateUri);
      if (found < 0) {
        console.warn('[Spotify Playback] ignored state for unknown queue URI', { stateUri, currentUri:current.spotifyUri, title:current.title });
        return;
      }
      if (activePlaybackProvider !== 'spotify') return;
      currentIndex = found;
      selectedQueueIndex = found;
      updateNowPlayingUI(currentQueue[found]);
      renderQueue();
    }
    const t = currentQueue[currentIndex];
    if (!t || t.spotifyUri !== stateUri) return;
    if (activePlaybackProvider !== 'spotify') setActivePlaybackProvider('spotify');
    spotifyActive = true;
    spotifyPendingUri = '';
    const duration = spotifyDurationSeconds(state?.duration || t.duration || 0);
    const position = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(state?.position) || 0));
    spotifyState = { ...state, uri:stateUri, duration, position, isPlaying:!!state?.isPlaying, timestamp:Number(state?.timestamp) || Date.now() };
    t.duration = duration || Number(t.duration) || 0;
    const stateContextUri = String(state?.contextUri || '').trim();
    if (stateContextUri) { t.spotifyContextUri = stateContextUri; t.contextUri = stateContextUri; }
    const spotifyArt = normalizeSpotifyArtworkSource(state?.artworkUrl || state?.cover || '');
    if (/^https?:\/\//i.test(spotifyArt)) { t.cover = spotifyArt; t.artworkUrl = spotifyArt; }
    if (state?.title) t.title = state.title;
    if (state?.artist) t.artist = state.artist;
    if (state?.album) t.album = state.album;
    if (state?.albumArtist) t.albumArtist = state.albumArtist;
    if (state?.year) t.year = state.year;
    if (Number.isFinite(Number(state?.volume)) && !(spotifyVolumeUserInteracting || Date.now() < spotifyVolumeInteractionUntil)) {
      engineVolume = Math.max(0, Math.min(1, Number(state.volume)));
      if (el.pbVolume) {
        renderVolumeSliderFromEngine(engineVolume);
      }
    }
    if (typeof state?.shuffle === 'boolean') shuffle = state.shuffle;
    if (Number.isInteger(Number(state?.repeat)) && Number(state.repeat) >= 0 && Number(state.repeat) <= 2) repeat = Number(state.repeat);
    enginePaused = !spotifyState.isPlaying;
    engineEnded = duration > 0 && position >= duration - 0.05;
    updateNowPlayingUI(t);
    renderQueue();
    dispatchAudio(spotifyState.isPlaying ? 'play' : 'pause');
    dispatchAudio('loadedmetadata');
    dispatchAudio('durationchange');
    dispatchAudio('timeupdate');
    if (!isScrubbing && !spotifySeekUserInteracting) updateSeekUI();
    syncMpris(t, !spotifyState.isPlaying);
    if (spotifyState.isPlaying) void scrobbleStart(t);
    return true;
  }

  async function spotifyPlayCurrent() {
    if (podcastActive) { try { audioElement.pause(); audioElement.removeAttribute('src'); } catch {} podcastActive = false; }
    const t = currentQueue[currentIndex];
    if (!isSpotifyTrack(t)) return false;
    activateSpotifyProvider();
    console.info('[Spotify Playback] play requested', { title:t.title, artist:t.artist, album:t.album, uri:t.spotifyUri, duration:spotifyDurationSeconds(t.duration), artwork:t.artworkUrl || t.cover || '' });
    spotifyState = { uri:t.spotifyUri, duration:spotifyDurationSeconds(t.duration), position:0, isPlaying:false, timestamp:Date.now() };
    spotifyPendingUri = t.spotifyUri;
    enginePaused = true; engineEnded = false; engineSrc = t.spotifyUri;
    const bridgeReady = await ensureSpotifyBridge();
    const contextUri = String(t.spotifyContextUri || t.contextUri || '').trim();
    const sent = await spotifySend({ type:'playUri', uri:t.spotifyUri, ...(contextUri ? { contextUri } : {}) });
    // Keep Spotify's own context shuffle/repeat aligned with Hive's transport
    // state. Spotify remains authoritative for the actual stream; Hive remains
    // authoritative for the unified queue/UI selection.
    await spotifySend({ type:'shuffle', enabled:!!shuffle });
    await spotifySend({ type:'repeat', mode:Number(repeat)||0 });
    updateNowPlayingUI(t); renderQueue(); dispatchAudio('loadedmetadata'); dispatchAudio('durationchange');
    if (!sent || !bridgeReady) {
      setActivePlaybackProvider('none');
      enginePaused = true;
      let diagnostic = null;
      try { diagnostic = await window.beehive.spotifyStatus?.(); } catch {}
      const backgroundPhase = String(diagnostic?.background?.phase || 'unknown');
      const backgroundDetail = String(diagnostic?.background?.detail || '');
      const bridgeAge = Number.isFinite(Number(diagnostic?.bridgeAgeMs)) ? Number(diagnostic.bridgeAgeMs) : null;
      let reason = 'Hive did not receive a connection from Spotify.';
      let action = 'Open the Spotify provider log for the exact startup failure.';
      if (backgroundPhase === 'failed') {
        reason = backgroundDetail || 'The isolated Spotify provider failed to start.';
        action = 'Open the Spotify provider log and fix the reported startup error.';
      } else if (backgroundPhase === 'spotify-exited') {
        reason = 'Spotify started but exited before the Hive bridge connected.';
        action = 'Open the Spotify provider log to see why Spotify exited.';
      } else if (backgroundPhase === 'spotify-running') {
        reason = bridgeAge == null ? 'Spotify is running, but the Spicetify bridge has not connected to Hive.' : `Spotify is running, but Hive has not received bridge state for ${Math.round(bridgeAge / 1000)}s.`;
        action = 'Open the Spotify provider log and check the Spicetify bridge connection.';
      } else if (backgroundPhase === 'launching-spotify' || backgroundPhase === 'spotify-started') {
        reason = `Spotify provider is ${backgroundPhase.replace('-', ' ')}, but the bridge has not connected yet.`;
        action = 'Open the Spotify provider log to inspect Spotify/Spicetify startup.';
      } else if (backgroundPhase === 'xvfb-ready' || backgroundPhase === 'starting-xvfb') {
        reason = `The isolated display is ${backgroundPhase === 'xvfb-ready' ? 'ready' : 'still starting'}, but Spotify has not connected.`;
        action = 'Open the Spotify provider log to inspect the background provider startup.';
      } else if (diagnostic?.bridgeServer === false) {
        reason = 'Hive could not keep its local Spotify bridge server running.';
        action = 'Restart Hive and check the session log for the Spotify bridge error.';
      }
      const phase = backgroundPhase !== 'unknown' ? ` Spotify provider phase: ${backgroundPhase}.` : '';
      showAppNotice(`Spotify provider diagnostics: ${reason}${phase} ${action} Provider log: ~/.cache/hive/spotify-background.log`, 'Hive', { copyable: true });
      return false;
    }
    // The bridge state event is authoritative for PLAYING; do not claim audio
    // is running merely because the command was queued.
    void scrobbleStart(t);
    return true;
  }

  async function spotifyLoadPaused(t, position=0) {
    if (podcastActive) { try { audioElement.pause(); audioElement.removeAttribute('src'); } catch {} podcastActive = false; }
    if (!isSpotifyTrack(t)) return false;
    activateSpotifyProvider(); enginePaused = true; engineEnded = false; engineSrc = t.spotifyUri;
    spotifyPendingUri = t.spotifyUri;
    spotifyState = { uri:t.spotifyUri, duration:spotifyDurationSeconds(t.duration), position:Number(position)||0, isPlaying:false, timestamp:Date.now() };
    await ensureSpotifyBridge();
    const contextUri = String(t.spotifyContextUri || t.contextUri || '').trim();
    await spotifySend({ type:'playUri', uri:t.spotifyUri, ...(contextUri ? { contextUri } : {}) });
    await spotifySend({ type:'pause' });
    updateNowPlayingUI(t); dispatchAudio('loadedmetadata'); dispatchAudio('durationchange'); dispatchAudio('timeupdate'); updateSeekUI();
    return true;
  }

  async function podcastLoad(t, position=0, autoplay=false) {
    if (!isPodcastTrack(t)) return false;
    // Cross-transport playback must have exactly one owner. Tear down any
    // active local Web Audio source, pending gapless source, GStreamer stream,
    // or Spotify playback before enabling the HTML media element. This is
    // especially important when a podcast was queued behind a local song.
    ++engineGeneration;
    cancelScheduledNext();
    stopActiveSource();
    if (gstActive) gstStop();
    if (spotifyActive) void spotifySend({ type:'pause' });
    spotifyActive = false;
    podcastActive = false;
    try { audioElement.pause(); audioElement.removeAttribute('src'); } catch {}
    podcastActive = true;
    setActivePlaybackProvider('podcast');
    engineSrc = t.streamUrl; engineEnded = false; enginePaused = !autoplay;
    audioElement.pause();
    audioElement.src = t.streamUrl;
    audioElement.preload = 'metadata';
    audioElement.volume = engineVolume; audioElement.muted = engineMuted;
    audioElement.load();
    try { await new Promise(resolve => { if (audioElement.readyState >= 1) return resolve(); const done=()=>{audioElement.removeEventListener('loadedmetadata',done);audioElement.removeEventListener('error',done);resolve();}; audioElement.addEventListener('loadedmetadata',done); audioElement.addEventListener('error',done); setTimeout(done,8000); }); } catch {}
    if (Number.isFinite(Number(position)) && Number(position) > 0) { try { audioElement.currentTime = Number(position); } catch {} }
    activeDuration = Number.isFinite(audioElement.duration) ? audioElement.duration : Number(t.duration)||0;
    activeOffset = Number(position)||0;
    updateNowPlayingUI(t); dispatchAudio('loadedmetadata'); dispatchAudio('durationchange'); dispatchAudio('timeupdate'); updateSeekUI();
    if (autoplay) { try { await audioElement.play(); void scrobbleStart(t); } catch (err) { enginePaused=true; engineEnded=false; dispatchAudio('pause'); console.warn('Podcast playback blocked:', err?.message || err); } }
    return true;
  }
  audioElement.addEventListener('loadedmetadata', () => { if (!podcastActive) return; activeDuration = Number.isFinite(audioElement.duration) ? audioElement.duration : activeDuration; dispatchAudio('loadedmetadata'); dispatchAudio('durationchange'); });
  audioElement.addEventListener('play', () => { if (!podcastActive) return; enginePaused=false; engineEnded=false; dispatchAudio('play'); });
  audioElement.addEventListener('pause', () => { if (!podcastActive) return; enginePaused=true; dispatchAudio('pause'); });
  audioElement.addEventListener('timeupdate', () => { if (!podcastActive) return; activeOffset=Number(audioElement.currentTime)||0; dispatchAudio('timeupdate'); });
  audioElement.addEventListener('ended', () => { if (!podcastActive) return; activeOffset=activeDuration; enginePaused=true; engineEnded=true; dispatchAudio('timeupdate'); dispatchAudio('ended'); });
  audioElement.addEventListener('error', () => { if (!podcastActive) return; enginePaused=true; engineEnded=true; dispatchAudio('pause'); console.warn('Podcast episode could not be played:', tSafe(audioElement.error)); });
  function tSafe(err) { return err ? `code ${err.code || 'unknown'}` : 'unknown media error'; }
  let gstLoadGeneration = 0;
  // Every user-initiated load gets a monotonically increasing request token.
  // Rapid album/track clicks can overlap async availability, decode, or GStreamer
  // work; only the newest request is allowed to reach an audio transport.
  let playbackLoadRequestGeneration = 0;
  function gstCompatibleTrack(t) {
    // GStreamer owns local files only. Virtual podcast/Spotify tracks must
    // never be handed to the native queue or pre-buffered as local audio.
    return isLocalPlaybackTrack(t);
  }
  function gstTrimmedTrack(t) {
    return Math.max(0, parseTimeValue(t?.startTime)) > 0 || Math.max(0, parseTimeValue(t?.endTime)) > 0;
  }
  function gstGaplessCompatibleQueue() {
    const current = currentQueue[currentIndex];
    if (!gstCompatibleTrack(current) || gstTrimmedTrack(current)) return false;
    const ni = getNextPlaybackIndex();
    return ni < 0 || (gstCompatibleTrack(currentQueue[ni]) && !gstTrimmedTrack(currentQueue[ni]));
  }
  function gstB64(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function replayGainMode() {
    try { const v = localStorage.getItem(REPLAYGAIN_MODE_KEY); return ['off','track','album'].includes(v) ? v : 'off'; } catch { return 'off'; }
  }
  function replayGainClippingGuard() {
    try { const v = localStorage.getItem(REPLAYGAIN_CLIPPING_KEY); return v === null ? true : v === 'true'; } catch { return true; }
  }
  function replayGainDbToLinear(db) {
    const n = Number.parseFloat(String(db ?? '').replace(/dB/i, '').trim());
    return Number.isFinite(n) ? Math.pow(10, n / 20) : 1;
  }
  function replayGainPeakValue(value) {
    const n = Number.parseFloat(String(value ?? '').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  async function resolveReplayGainForTrack(track) {
    engineTrackGain = 1;
    const mode = replayGainMode();
    if (mode === 'off' || !track?.path || isSpotifyTrack(track)) return;
    try {
      const data = await window.beehive.readTags(track.path);
      const native = data?.native || {};
      const value = wanted => nativeTagValue(native, wanted);
      let gainText = '';
      let peakText = '';
      if (mode === 'album') {
        gainText = value('REPLAYGAIN_ALBUM_GAIN');
        peakText = value('REPLAYGAIN_ALBUM_PEAK');
      }
      if (!gainText) {
        gainText = value('REPLAYGAIN_TRACK_GAIN');
        peakText = value('REPLAYGAIN_TRACK_PEAK') || peakText;
      }
      const gain = replayGainDbToLinear(gainText);
      if (!Number.isFinite(gain) || gain <= 0) return;
      let effective = Math.min(gain, 8);
      if (replayGainClippingGuard()) {
        const peak = replayGainPeakValue(peakText);
        if (peak > 0) effective = Math.min(effective, 1 / peak);
      }
      engineTrackGain = Math.max(0, Math.min(8, effective));
    } catch {}
  }
  // The visible Hive control is a conventional 0-100 percentage slider.
  // Keep the UI boundary linear and let each playback provider own its native
  // gain representation. Local GStreamer already consumes a linear 0-1 gain,
  // while Spotify/HTML media use the same canonical provider value.
  function clampUnitVolume(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }
  function renderVolumeSliderFromEngine(engineValue) {
    const slider = Math.max(0, Math.min(100, Math.round(clampUnitVolume(engineValue) * 100)));
    if (!el.pbVolume) return slider;
    el.pbVolume.value = String(slider);
    el.pbVolume.style.setProperty('--volume-progress', `${slider}%`);
    renderVolumeIcon();
    return slider;
  }

  let volumePersistTimer = 0;

  // Ordinary user volume is a real-time control. Match the proven Strawberry
  // behavior: each slider input updates the dedicated GStreamer volume element
  // immediately. Do not put a timer/debounce between the user's pointer and
  // the audio gain; that makes a drag feel visibly behind the thumb.
  function setNativeVolumeImmediate(value) {
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    if (!gstActive) return;
    gstSend('VOLUME\t' + String(next));
  }
  function scheduleVolumePersistence() {
    if (volumePersistTimer) clearTimeout(volumePersistTimer);
    volumePersistTimer = setTimeout(() => { volumePersistTimer = 0; saveLastPlayback(); }, 220);
  }
  function flushVolumePersistence() {
    if (volumePersistTimer) { clearTimeout(volumePersistTimer); volumePersistTimer = 0; }
    saveLastPlayback();
  }
  function applyOutputGain() {
    const effective = Math.max(0, Math.min(8, Number(engineTrackGain) || 1));
    if (gstActive) {
      gstSend('GAIN\t' + String(effective));
      setNativeVolumeImmediate(engineVolume);
    }
    if (masterGain && !engineMuted) masterGain.gain.value = Math.min(8, engineVolume * effective);
  }
  function gstSend(command) { try { diagnosticMark('GSTREAMER COMMAND', String(command || '').split('\t')[0]); window.beehive.gstreamerCommand(command); return true; } catch { return false; } }
  function gstSendNext() {
    diagnosticMark('QUEUE NEXT REQUEST');
    const ni = getNextPlaybackIndex();
    if (ni < 0 || ni === currentIndex) return;
    const current = currentQueue[currentIndex];
    const next = currentQueue[ni];
    if (gstCompatibleTrack(next) && !gstTrimmedTrack(current) && !gstTrimmedTrack(next)) gstSend(`NEXT\t${gstB64(next.path)}`);
  }
  function gstStop() {
    if (!gstActive) return;
    gstLoadGeneration++;
    gstSend('STOP');
    window.beehive.setPlaybackProtectedPath?.('');
    gstActive = false;
    gstTrackIndex = -1;
    gstPositionUpdatesEnabled = false;
    gstWaitingNextStream = false;
    gstExpectInitialStream = false;
  }
  async function gstLoadCurrent(offset = 0, requestGeneration = playbackLoadRequestGeneration) {
    const t = currentQueue[currentIndex];
    if (!t?.path || !gstAvailable || !gstCompatibleTrack(t)) return false;
    if (requestGeneration !== playbackLoadRequestGeneration) return false;
    const generation = ++gstLoadGeneration;
    gstActive = true;
    window.beehive.setPlaybackProtectedPath?.(t.path);
    // Do not accept native POSITION events until this LOAD has been acknowledged.
    // gstTrackIndex is deliberately invalid during the handoff as an additional
    // guard against a late position sample from the previous URI.
    gstPositionUpdatesEnabled = false;
    gstTrackIndex = -1;
    const trimStart = Math.max(0, parseTimeValue(t.startTime));
    const trimEnd = Math.max(0, parseTimeValue(t.endTime));
    const fullDuration = Math.max(0, Number(t.duration) || 0);
    gstDuration = trimEnd > trimStart ? Math.min(trimEnd, fullDuration || trimEnd) - trimStart : Math.max(0, fullDuration - trimStart);
    gstDuration = Math.max(0, gstDuration);
    gstPosition = Math.max(0, Math.min(gstDuration || Number.MAX_SAFE_INTEGER, Number(offset) || 0));
    gstPositionUpdatedAt = performance.now();
    gstWaitingNextStream = false;
    gstExpectInitialStream = true;
    enginePaused = false;
    engineEnded = false;
    engineSrc = window.beehive.fileUrl(t.path);
    // Build 250: transport remains direct in this isolated volume-fix branch.
    // Ordinary user volume is coalesced here and slewed natively by GStreamer.
    gstSend('GAIN\t' + String(Math.max(0, Math.min(8, Number(engineTrackGain) || 1))));
    setNativeVolumeImmediate(engineVolume);
    gstSend(`LOAD\t${gstB64(t.path)}\t${gstPosition}\t${trimStart}\t${trimEnd}`);
    gstSendNext();
    // A newer user command may have arrived while LOAD/NEXT were being queued.
    // Do not issue PLAY for this stale request; the newer request will own the
    // single GStreamer pipeline instead.
    if (requestGeneration !== playbackLoadRequestGeneration) return false;
    // handle_load() synchronously waits for the persistent GStreamer playbin to
    // finish its PAUSED/preroll transition before returning. PLAY can therefore
    // follow LOAD in the same helper command cycle without the old arbitrary
    // 25 ms renderer delay.
    if (generation !== gstLoadGeneration || !gstActive || requestGeneration !== playbackLoadRequestGeneration) return false;
    // Transport remains a direct GStreamer state change in this volume-focused branch.
    gstSend('PLAY');
    dispatchAudio('loadedmetadata');
    dispatchAudio('durationchange');
    // For GStreamer, the transport's PLAYING state is authoritative for the
    // play/pause button. Do not announce play here before the pipeline reaches
    // PLAYING, because the helper can emit a transitional PAUSED event after
    // LOAD/PLAY and would otherwise leave the button showing Play while audio
    // is already running. The PLAYING event below dispatches the final play
    // notification and starts the UI seek clock.
    updateNowPlayingUI(t);
    renderQueue();
    return true;
  }

  Object.defineProperties(audioEngine, {
    currentTime: {
      get() {
        // Startup restoration intentionally keeps activeBuffer null. The logical
        // offset is still the real transport position and must be exposed to the
        // UI while paused; otherwise the restored scrubber falls back to 0:00.
        if (podcastActive) return Number(audioElement.currentTime) || 0;
        if (spotifyActive) return spotifyPositionNow();
        if (gstActive) {
          const base = Math.max(0, Math.min(gstDuration || Number.MAX_SAFE_INTEGER, Number(gstPosition) || 0));
          if (enginePaused || !gstPositionUpdatedAt) return base;
          const elapsed = Math.max(0, (performance.now() - gstPositionUpdatedAt) / 1000);
          return Math.max(0, Math.min(gstDuration || Number.MAX_SAFE_INTEGER, base + elapsed));
        }
        if (!activeBuffer || !audioCtx) {
          return Math.max(0, Math.min(activeDuration, Number(activeOffset) || 0));
        }
        if (enginePaused) return Math.max(0, Math.min(activeDuration, activeOffset));
        return Math.max(0, Math.min(activeDuration, activeOffset + (audioCtx.currentTime - activeStartedAt)));
      },
      set(v) { seekEngine(Number(v) || 0); }
    },
    duration: { get() { return podcastActive ? (Number(audioElement.duration) || Number(activeDuration) || Number(currentQueue[currentIndex]?.duration) || 0) : spotifyActive ? (Number(spotifyState?.duration) || Number(currentQueue[currentIndex]?.duration) || 0) : (gstActive ? (gstDuration || 0) : (activeDuration || 0)); }},
    paused: { get() { return podcastActive ? !!audioElement.paused : (spotifyActive ? !spotifyState?.isPlaying : enginePaused); }},
    ended: { get() { return podcastActive ? !!engineEnded : (spotifyActive ? !!engineEnded : engineEnded); }},
    muted: { get() { return engineMuted; }, set(v) {
      engineMuted = !!v;
      audioElement.muted = engineMuted;
      if (activePlaybackProvider === 'local' && gstActive) gstSend('MUTE\t' + (engineMuted ? '1' : '0'));
      if (activePlaybackProvider === 'spotify') void spotifySend({ type:'mute', value:engineMuted });
      if (masterGain) masterGain.gain.value = engineMuted ? 0 : Math.min(8, engineVolume * engineTrackGain);
    }},
    volume: { get() { return engineVolume; }, set(v) {
      engineVolume = Math.max(0, Math.min(1, Number(v) || 0));
      if (activePlaybackProvider === 'podcast') audioElement.volume = engineVolume;
      if (activePlaybackProvider === 'local' && gstActive) setNativeVolumeImmediate(engineVolume);
      if (activePlaybackProvider === 'spotify') void spotifySend({ type:'volume', value:engineVolume });
      if (masterGain && !engineMuted && activePlaybackProvider !== 'spotify') masterGain.gain.value = Math.min(8, engineVolume * engineTrackGain);
    }},
    src: { get() { return engineSrc; }, set(v) { engineSrc = String(v || ''); }},
    readyState: { get() { return podcastActive ? Number(audioElement.readyState || 0) : (gstActive || activeBuffer ? 4 : 0); }}
  });
  audioEngine.load = () => {};
  audioEngine.removeAttribute = (name) => { if (name === 'src') engineSrc = ''; };
  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = engineMuted ? 0 : Math.min(8, engineVolume * engineTrackGain);
      masterGain.connect(audioCtx.destination);
    }
    return audioCtx;
  }
  async function decodeTrack(t) {
    if (!t?.path) throw new Error('Track has no path');
    const key = String(t.streamUrl || t.path);
    if (bufferCache.has(key)) return bufferCache.get(key);
    if (bufferLoads.has(key)) return bufferLoads.get(key);
    const promise = (async () => {
      const url = t.streamUrl ? t.streamUrl : window.beehive.fileUrl(t.path);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Audio fetch failed (${response.status})`);
      const bytes = await response.arrayBuffer();
      const ctx = ensureAudioContext();
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      bufferCache.set(key, decoded);
      return decoded;
    })();
    bufferLoads.set(key, promise);
    try { return await promise; } finally { bufferLoads.delete(key); }
  }
  function stopActiveSource() {
    if (!activeSource) return;
    try { activeSource.onended = null; activeSource.stop(); } catch {}
    try { activeSource.disconnect(); } catch {}
    activeSource = null;
  }
  function cancelScheduledNext() {
    if (!scheduledNext) return;
    try { scheduledNext.onended = null; scheduledNext.stop(); } catch {}
    try { scheduledNext.disconnect(); } catch {}
    scheduledNext = null;
    scheduledNextIndex = -1;
  }
  // MPRIS is a projection of the authoritative Hive transport state, not a
  // collection of backend-specific side effects. Some Linux systems fall back
  // Provider playback remains behind one synchronization boundary. Local audio
  // is GStreamer-authoritative; Spotify and podcasts retain their explicit
  // provider paths. MPRIS is only a projection and command surface, never a
  // playback engine.
  let mprisHeartbeatTimer = null;
  let mprisSyncTimer = null;

  function runMprisSync() {
    mprisSyncTimer = null;
    try { void syncMpris(); } catch {}
  }

  function scheduleMprisSync(immediate = false) {
    if (immediate) {
      try { void syncMpris(); } catch {}
      return;
    }
    if (mprisSyncTimer) return;
    mprisSyncTimer = setTimeout(runMprisSync, 5000);
  }

  function startMprisHeartbeat() {
    if (mprisHeartbeatTimer) return;
    mprisHeartbeatTimer = setInterval(() => {
      try {
        if (!audioEngine.paused && currentQueue[currentIndex]) void syncMpris();
      } catch {}
    }, 5000);
    mprisHeartbeatTimer.unref?.();
  }

  function stopMprisHeartbeat() {
    if (!mprisHeartbeatTimer) return;
    clearInterval(mprisHeartbeatTimer);
    mprisHeartbeatTimer = null;
  }

  function dispatchAudio(name) {
    try { audioEngine.dispatchEvent(new Event(name)); } catch {}
    if (name === 'play' || name === 'pause' || name === 'ended' || name === 'timeupdate') pluginEmit('playback', {name, state:{track:currentQueue[currentIndex]||null, position:Number(audioEngine.currentTime)||0, duration:Number(audioEngine.duration)||0, paused:!!audioEngine.paused}});
    if (name === 'play') {
      startMprisHeartbeat();
      scheduleMprisSync(true);
    } else if (name === 'pause' || name === 'ended') {
      stopMprisHeartbeat();
      scheduleMprisSync(true);
    } else if (name === 'loadedmetadata' || name === 'durationchange' || name === 'timeupdate') {
      scheduleMprisSync(false);
    }
  }
  function setEnginePosition(seconds) {
    if (!activeBuffer || !audioCtx) return;
    activeOffset = Math.max(0, Math.min(activeDuration, Number(seconds) || 0));
  }
  function scheduleBufferSource(buffer, when, offset, duration, kind, index, logicalOffset = 0, logicalDuration = null) {
    const ctx = ensureAudioContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(masterGain);
    const safeOffset = Math.max(0, Math.min(buffer.duration, offset));
    const safeDuration = Math.max(0, Math.min(buffer.duration - safeOffset, duration));
    if (safeDuration > 0) src.start(when, safeOffset, safeDuration);
    else src.start(when, safeOffset);
    if (kind === 'current') {
      // Keep AudioBuffer source coordinates separate from the logical position
      // and duration exposed to the UI. This is essential after seeking and
      // for tracks with startTime/endTime trims.
      const exposedDuration = Number.isFinite(logicalDuration)
        ? Math.max(0, logicalDuration)
        : (safeDuration > 0 ? safeDuration : Math.max(0, buffer.duration - safeOffset));
      activeSource = src;
      activeStartedAt = when;
      activeOffset = Math.max(0, Math.min(exposedDuration, Number(logicalOffset) || 0));
      activeDuration = exposedDuration;
      activeBuffer = buffer;
      engineEnded = false;
      src.onended = () => {
        if (src !== activeSource) return;
        activeOffset = activeDuration;
        engineEnded = true;
        activeSource = null;
        dispatchAudio('timeupdate');
        dispatchAudio('ended');
      };
    } else {
      scheduledNext = src;
      scheduledNextIndex = index;
    }
    return src;
  }
  async function prepareNextBuffer() {
    const nextIndex = getNextPlaybackIndex();
    if (nextIndex < 0 || nextIndex >= currentQueue.length) return;
    if (nextIndex === currentIndex) return;
    const next = currentQueue[nextIndex];
    if (!isLocalPlaybackTrack(next)) return;
    try { await decodeTrack(next); } catch {}
  }
  function playbackSettingEnabled(track, key) {
    const direct = track?.[key] ?? track?.[key.replace(/^BEEHIVE_/, '').replace(/_([A-Z])/g, (_,c)=>c.toUpperCase())];
    const custom = track?.customTags?.[key] ?? track?.customTags?.[String(key).toUpperCase()];
    return /^(1|true|yes)$/i.test(String(direct ?? custom ?? ''));
  }
  function isTrackExcluded(track) { return playbackSettingEnabled(track, 'BEEHIVE_EXCLUDE_PLAYBACK'); }
  function getNextPlaybackIndex() {
    if (!currentQueue.length) return -1;
    if (repeat === 2) return currentIndex;
    const direction = 1;
    let candidate = currentIndex + direction;
    let wrapped = false;
    while (true) {
      if (candidate >= currentQueue.length) {
        if (repeat !== 1 || wrapped) return -1;
        candidate = 0; wrapped = true;
      }
      if (!isTrackExcluded(currentQueue[candidate])) return candidate;
      candidate += direction;
    }
  }
  async function armGaplessNext(generation) {
    if (generation !== engineGeneration || !activeBuffer || !audioCtx || enginePaused) return;
    const nextIndex = getNextPlaybackIndex();
    if (nextIndex < 0 || nextIndex === currentIndex) return;
    const next = currentQueue[nextIndex];
    // Gapless Web Audio pre-buffering is only valid for local tracks. Crossing
    // into Podcast/Spotify must be a transport handoff, otherwise a virtual
    // podcast can be decoded into a second audio source while GStreamer/HTML
    // media is still active.
    if (!isLocalPlaybackTrack(next)) return;
    try {
      const nextBuffer = await decodeTrack(next);
      if (generation !== engineGeneration || !activeBuffer || !audioCtx || enginePaused) return;
      if (scheduledNext && scheduledNextIndex === nextIndex) return;
      cancelScheduledNext();
      const when = activeStartedAt + Math.max(0, activeDuration - activeOffset);
      const start = Math.max(0, parseTimeValue(next.startTime));
      const end = Math.max(0, parseTimeValue(next.endTime));
      const available = Math.max(0, nextBuffer.duration - start);
      const duration = end > start ? Math.min(end - start, available) : available;
      if (duration <= 0) return;
      scheduleBufferSource(nextBuffer, when, start, duration, 'next', nextIndex);
      // Promote the queue/UI at the exact scheduled boundary, without waiting
      // for an HTMLMediaElement ended event.
      const delay = Math.max(0, (when - audioCtx.currentTime) * 1000);
      setTimeout(() => {
        if (generation !== engineGeneration || scheduledNextIndex !== nextIndex) return;
        if (currentIndex !== nextIndex) {
          const old = currentQueue[currentIndex];
          if (old) playbackHistory.push(old);
          currentIndex = nextIndex;
          selectedQueueIndex = nextIndex;
          selectedQueueIndices.clear(); selectedQueueIndices.add(nextIndex);
          activeSource = scheduledNext;
          activeBuffer = nextBuffer;
          activeStartedAt = when;
          activeOffset = 0;
          activeDuration = duration;
          engineSrc = next.streamUrl ? next.streamUrl : window.beehive.fileUrl(next.path);
          scheduledNext = null; scheduledNextIndex = -1;
          // Web Audio promotes the next track on its own timer rather than via
          // GStreamer's STREAM_START event, so explicitly close the old play-count
          // candidate and start a fresh five-second qualification window here.
          finishPlayCountSession({ countIfQualified: true });
          updateNowPlayingUI(next);
          // Gapless playback promotes the next track without going through the
          // manual play/selection path. Publish the new track to MPRIS immediately
          // so Music Presence sees the transition instead of retaining the previous
          // song until the user manually skips/selects something.
          syncMpris(next, false);
          renderQueue();
          saveQueueSession();
          beginPlayCountSession(next);
          // Immediately arm the successor.
          armGaplessNext(generation);
        }
      }, delay);
    } catch {}
  }
  // Track transitions should update the existing album cards in place. This
  // deliberately touches only the small set of already-rendered cards rather
  // than rebuilding the Albums DOM just to move the now-playing highlight.
  function syncAlbumCardNowPlaying(track) {
    const key = track ? String(albumKey(track) || '') : '';
    document.querySelectorAll('.album-card.now-playing').forEach(card => card.classList.remove('now-playing'));
    if (!key) return;
    document.querySelectorAll(`.album-card[data-key="${CSS.escape(key)}"]`).forEach(card => card.classList.add('now-playing'));
  }

  // Play-count qualification is deliberately separate from Yearly Wrap/scrobbling.
  // A track earns one Beehive play only after five seconds of actual playback
  // time. Pauses do not consume the five-second window, and changing/skipping
  // tracks abandons an unqualified candidate. This prevents accidental clicks,
  // quick previews, and immediate skips from inflating play counts.
  const PLAY_COUNT_QUALIFY_MS = 5000;
  let playCountSession = null;
  let playCountTimer = null;

  function playCountTrackKey(t) {
    return String(t?.path || t?.spotifyUri || t?.streamUrl || '');
  }

  function clearPlayCountTimer() {
    if (playCountTimer) {
      clearTimeout(playCountTimer);
      playCountTimer = null;
    }
  }

  function finishPlayCountSession({ countIfQualified = true } = {}) {
    clearPlayCountTimer();
    const session = playCountSession;
    playCountSession = null;
    if (!session) return;
    if (session.activeSince != null) {
      session.accumulatedMs += Math.max(0, performance.now() - session.activeSince);
      session.activeSince = null;
    }
    if (countIfQualified && !session.counted && session.accumulatedMs >= PLAY_COUNT_QUALIFY_MS) {
      session.counted = true;
      recordTrackPlayed(session.track);
    }
  }

  function schedulePlayCountQualification(session) {
    clearPlayCountTimer();
    const remaining = Math.max(0, PLAY_COUNT_QUALIFY_MS - session.accumulatedMs);
    if (remaining <= 0) {
      session.counted = true;
      recordTrackPlayed(session.track);
      return;
    }
    playCountTimer = setTimeout(() => {
      playCountTimer = null;
      if (playCountSession !== session || session.activeSince == null || session.counted) return;
      session.accumulatedMs += Math.max(0, performance.now() - session.activeSince);
      session.activeSince = null;
      if (session.accumulatedMs < PLAY_COUNT_QUALIFY_MS) {
        // A timer can fire slightly early because of scheduler jitter. Resume
        // from the exact remaining amount instead of assuming five seconds.
        session.activeSince = performance.now();
        schedulePlayCountQualification(session);
        return;
      }
      session.counted = true;
      recordTrackPlayed(session.track);
    }, remaining);
  }

  function beginPlayCountSession(t) {
    const key = playCountTrackKey(t);
    if (!key) return;
    if (playCountSession?.key === key && !playCountSession.counted) {
      if (playCountSession.activeSince == null) playCountSession.activeSince = performance.now();
      schedulePlayCountQualification(playCountSession);
      return;
    }
    finishPlayCountSession({ countIfQualified: true });
    playCountSession = {
      key,
      track: t,
      accumulatedMs: 0,
      activeSince: performance.now(),
      counted: false
    };
    schedulePlayCountQualification(playCountSession);
  }

  function pausePlayCountSession() {
    const session = playCountSession;
    if (!session || session.counted || session.activeSince == null) return;
    session.accumulatedMs += Math.max(0, performance.now() - session.activeSince);
    session.activeSince = null;
    clearPlayCountTimer();
  }

  function endPlayCountSession() {
    finishPlayCountSession({ countIfQualified: true });
  }

  function recordTrackPlayed(t) {
    if (!t?.path) return;
    const nextCount = Number(t.playCount || 0) + 1;
    t.playCount = nextCount;
    t.lastPlayedAt = Date.now();

    // Queue entries can be separate objects from the canonical library track.
    // Keep both representations synchronized immediately so the Plays column,
    // Top 25 Most Played, sorting, and album/artist-derived views update as soon
    // as a track is actually started instead of waiting for a rescan/restart.
    const canonical = libraryTrackByPath?.get(String(t.path));
    if (canonical && canonical !== t) {
      canonical.playCount = nextCount;
      canonical.lastPlayedAt = t.lastPlayedAt;
    }

    // Keep the already-rendered album browser visually synchronized with the
    // new current track without invoking renderCurrentView().
    syncAlbumCardNowPlaying(t);

    // Persist the durable stat in the main process. The returned value is
    // authoritative if another serialized stats mutation completed first.
    window.beehive.recordPlay(t.path, {title:t.title, artist:t.artist, album:t.album, cover:visualCoverForTrack(t), artworkUrl:spotifyArtworkUrl(t), source:t.source, spotifyUri:t.spotifyUri}).then(entry=>{
      const count = Number(entry.playCount || t.playCount || 0);
      const when = Number(entry.lastPlayedAt || t.lastPlayedAt || Date.now());
      t.playCount = count;
      t.lastPlayedAt = when;
      if (canonical && canonical !== t) {
        canonical.playCount = count;
        canonical.lastPlayedAt = when;
      }
      // Play-count persistence is not a reason to tear down the active view.
      // The current track/playback UI is already updated synchronously above;
      // a full render here would rebuild the entire Albums grid after every song.
    }).catch(()=>{});

    // Do not rebuild the active library view on every track start. The renderer
    // model is updated above; a later intentional view refresh can repaint the
    // Plays column without paying the cost of rebuilding thousands of album cards.
  }
  // A native decoder/sink fault (e.g. the file that was playing got deleted
  // from disk) leaves the persistent playbin muted, stopped, and latched via
  // gstFatalError until an explicit fresh user action -- this deliberately
  // never auto-retries on its own. Discard that native instance and
  // establish a fresh READY handshake before retrying. Shared by every entry
  // point that starts playback in response to a real user action (pressing
  // Play again, or picking a different track/album/queue entirely): both are
  // equally "an explicit fresh user action," so both must be able to recover,
  // not just the exact button that happened to trigger the original fault.
  async function recoverFromGstFatalError() {
    window.beehive.setPlaybackProtectedPath?.('');
    gstActive = false;
    gstWaitingNextStream = false;
    gstExpectInitialStream = false;
    gstResumeAfterSeek = false;
    enginePaused = true;
    engineEnded = false;
    const restarted = await window.beehive.gstreamerRestart().catch(() => false);
    if (!restarted) {
      console.error('Beehive audio safety shutdown: could not restart GStreamer after native fault.');
      return false;
    }
    gstFatalError = false;
    gstAvailabilityKnown = true;
    gstAvailable = true;
    return true;
  }
  audioEngine.play = async (userInitiated = false) => {
    if (startupPlaybackLocked && !userInitiated) return;
    if (userInitiated) startupPlaybackLocked = false;
    if (podcastActive) { try { await audioElement.play(); } catch {} return; }
    if (spotifyActive) { await spotifySend({ type:'play' }); return; }
    if (gstActive) {
      engineEnded = false;
      gstSend('PLAY');
      // GStreamer state notifications are authoritative for the transport UI.
      // Do not synthesize a PLAY event here; the native PAUSED/PLAYING messages
      // will update enginePaused and the button in the correct order.
      return;
    }
    const currentTrack = currentQueue[currentIndex];
    if (gstFatalError && currentTrack?.path && window.beehive.gstreamerRestart) {
      const recovered = await recoverFromGstFatalError();
      if (!recovered) return false;
      return await requestLoadAndPlayCurrent(true);
    }
    const ctx = ensureAudioContext();
    await ctx.resume();
    enginePaused = false;
    engineEnded = false;
    dispatchAudio('play');
    if (activeSource) return;

    // A paused Web Audio source is intentionally stopped rather than suspended.
    // Resume from the engine's preserved logical offset instead of rebuilding
    // the track from 0:00. This also makes startup-restored tracks continue
    // from their restored position when Play is pressed.
    const t = currentQueue[currentIndex];
    if (!t?.path) return;
    if (activeBuffer && activeDuration > 0) {
      const target = Math.max(0, Math.min(activeDuration, Number(activeOffset) || 0));
      const start = Math.max(0, parseTimeValue(t.startTime));
      const end = Math.max(0, parseTimeValue(t.endTime));
      const absolute = start + target;
      const remaining = end > start
        ? Math.min(end - absolute, Math.max(0, activeBuffer.duration - absolute))
        : Math.max(0, activeBuffer.duration - absolute);
      if (remaining > 0) {
        const generation = ++engineGeneration;
        scheduleBufferSource(activeBuffer, ctx.currentTime + 0.015, absolute, remaining, 'current', currentIndex, target, activeDuration);
        updateNowPlayingUI(t);
        await armGaplessNext(generation);
        prepareNextBuffer();
        return;
      }
    }
    await requestLoadAndPlayCurrent();
  };
  audioEngine.pause = () => {
    if (podcastActive) { audioElement.pause(); savePlaybackSession(); return; }
    if (spotifyActive) { void spotifySend({ type:'pause' }); savePlaybackSession(); return; }
    if (gstActive) {
      if (enginePaused) return;
      gstSend('PAUSE');
      // Wait for the native PAUSED event before changing the logical transport
      // state. This keeps renderer state synchronized with the persistent
      // GStreamer pipeline instead of racing an asynchronous state change.
      savePlaybackSession();
      return;
    }
    if (!activeBuffer || !audioCtx || enginePaused) return;
    activeOffset = Math.max(0, Math.min(activeDuration, activeOffset + (audioCtx.currentTime - activeStartedAt)));
    enginePaused = true;
    cancelScheduledNext();
    stopActiveSource();
    dispatchAudio('pause');
    savePlaybackSession();
  };
  async function seekEngine(seconds, resumeAfterSeek = false) {
    if (podcastActive) { const target=Math.max(0, Number(seconds)||0); try { audioElement.currentTime=target; } catch {}; if (resumeAfterSeek) { try { await audioElement.play(); } catch {} } dispatchAudio('timeupdate'); savePlaybackSession(); return; }
    if (activePlaybackProvider === 'spotify') {
      const target=Math.max(0, Number(seconds)||0);
      void spotifySend({type:'seek', positionMs:Math.round(target*1000)});
      if (spotifyState) spotifyState={...spotifyState,position:target,timestamp:Date.now()};
      dispatchAudio('timeupdate'); updateSeekUI(); scheduleMprisSync(true); savePlaybackSession(); return;
    }
    if (gstActive) {
      const target = Math.max(0, Math.min(gstDuration || Number.MAX_SAFE_INTEGER, Number(seconds) || 0));
      gstPosition = target;
      gstPositionUpdatedAt = performance.now();
      gstSend((resumeAfterSeek ? 'SEEKPLAY\t' : 'SEEK\t') + String(target));
      if (resumeAfterSeek) gstResumeAfterSeek = true;
      dispatchAudio('timeupdate');
      scheduleMprisSync(true);
      savePlaybackSession();
      return;
    }
    // The native pipeline is left alive (merely idle at EOS, never STOPped) when
    // a track reaches its natural end with no next queue track to gapless-advance
    // to -- see the 'EOS' handler above. gstTrackIndex still pointing at the
    // current track (untouched since only a fresh LOAD resets it to -1) is what
    // distinguishes this from every other non-GStreamer ended state. Dragging the
    // scrubber back here is a real resumable seek, not just a value to stage for
    // the next explicit Play click.
    if (!gstActive && engineEnded && gstAvailable && gstTrackIndex >= 0 && gstTrackIndex === currentIndex && gstCompatibleTrack(currentQueue[currentIndex])) {
      const target = Math.max(0, Math.min(gstDuration || Number.MAX_SAFE_INTEGER, Number(seconds) || 0));
      gstActive = true;
      engineEnded = false;
      enginePaused = false;
      gstPosition = target;
      gstPositionUpdatedAt = performance.now();
      window.beehive.setPlaybackProtectedPath?.(currentQueue[currentIndex].path);
      gstSend('SEEKPLAY\t' + String(target));
      gstResumeAfterSeek = true;
      dispatchAudio('timeupdate');
      scheduleMprisSync(true);
      savePlaybackSession();
      return;
    }
    if (!activeBuffer) {
      if (activeDuration > 0) {
        activeOffset = Math.max(0, Math.min(activeDuration, Number(seconds) || 0));
        pendingRestoredOffset = activeOffset;
        dispatchAudio('timeupdate');
        saveLastPlayback();
      }
      return;
    }
    const wasPlaying = !enginePaused;
    const target = Math.max(0, Math.min(activeDuration, Number(seconds) || 0));
    engineGeneration++;
    const gen = engineGeneration;
    cancelScheduledNext();
    stopActiveSource();
    activeOffset = target;
    engineEnded = false;
    if (!wasPlaying) { dispatchAudio('timeupdate'); return; }
    const t = currentQueue[currentIndex];
    const start = Math.max(0, parseTimeValue(t?.startTime));
    const absolute = start + target;
    const end = Math.max(0, parseTimeValue(t?.endTime));
    const duration = end > start ? Math.min(end - absolute, Math.max(0, activeBuffer.duration - absolute)) : Math.max(0, activeBuffer.duration - absolute);
    if (duration <= 0) { goNext(); return; }
    scheduleBufferSource(activeBuffer, ensureAudioContext().currentTime + 0.01, absolute, duration, 'current', currentIndex, target, activeDuration);
    armGaplessNext(gen);
    dispatchAudio('timeupdate');
  }
  window.beehive.onGstreamerEvent?.((ev) => {
    if (!ev) return;
    const name = ev.name;
    if (name === 'SPECTRUM') {
      const parts = String(ev.value || '').split(',');
      nowPlayingSpectrum = parts.map(Number).filter(Number.isFinite).slice(0, 64);
      pluginEmit('spectrum', nowPlayingSpectrum.slice());
      scheduleNowPlayingSpectrumDraw();
      return;
    }
    if (name === 'POSITION') {
      const p = Number(ev.value);
      if (gstActive && gstPositionUpdatesEnabled && gstTrackIndex >= 0 && Number.isFinite(p)) { gstPosition = Math.max(0, Math.min(gstDuration || p, p)); gstPositionUpdatedAt = performance.now(); dispatchAudio('timeupdate'); }
      return;
    }
    if (name === 'LOADED') {
      if (!gstActive) return;
      // LOAD/initial-seek has completed in the native helper. Only now may
      // POSITION samples become authoritative for the newly selected track.
      gstTrackIndex = currentIndex;
      gstPositionUpdatesEnabled = true;
      gstPosition = 0;
      gstPositionUpdatedAt = performance.now();
      updateSeekUI();
      return;
    }
    if (name === 'ABOUT_TO_FINISH') {
      const ni = getNextPlaybackIndex();
      const next = ni >= 0 ? currentQueue[ni] : null;
      gstWaitingNextStream = !!next && gstCompatibleTrack(next) && !gstTrimmedTrack(currentQueue[currentIndex]) && !gstTrimmedTrack(next);
      return;
    }
    if (name === 'STREAM_START') {
      if (!gstActive) return;
      if (gstExpectInitialStream) { gstExpectInitialStream = false; return; }
      if (gstWaitingNextStream) {
        const ni = getNextPlaybackIndex();
        if (ni >= 0 && ni !== currentIndex && currentQueue[ni]) {
          const next = currentQueue[ni];
          const old = currentQueue[currentIndex];
          if (old) playbackHistory.push(old);
          currentIndex = ni;
          selectedQueueIndex = ni;
          selectedQueueIndices.clear(); selectedQueueIndices.add(ni);
          gstTrackIndex = ni;
          const nextStart = Math.max(0, parseTimeValue(next.startTime));
          const nextEnd = Math.max(0, parseTimeValue(next.endTime));
          gstDuration = nextEnd > nextStart ? Math.max(0, Math.min(nextEnd, Number(next.duration) || nextEnd) - nextStart) : Math.max(0, Number(next.duration) || 0);
          gstPosition = 0;
          gstPositionUpdatedAt = performance.now();
          gstWaitingNextStream = false;
          enginePaused = false; engineEnded = false;
          engineSrc = window.beehive.fileUrl(next.path);
          updateNowPlayingUI(next);
          // Native gapless GStreamer transitions arrive here rather than through
          // the manual queue-selection path. Publish the new track immediately so
          // MPRIS clients (including Music Presence) receive the new metadata.
          syncMpris(next, false);
          renderQueue();
          saveQueueSession();
              gstSendNext();
          dispatchAudio('loadedmetadata');
          dispatchAudio('durationchange');
          dispatchAudio('play');
          // The native pipeline has crossed into a new song. Repaint the seek
          // control immediately from the new track's 0:00 position instead of
          // allowing the previous track's last user-selected value to linger.
          requestAnimationFrame(() => {
            if (gstActive && currentQueue[currentIndex] === next && !isScrubbing) updateSeekUI();
          });
        }
      }
      return;
    }
    if (name === 'PAUSED' && gstActive) {
      try { window.dispatchEvent(new Event('beehive-gst-paused')); } catch {}
      // A flush seek can briefly report PAUSED even when the user was playing.
      // When SEEKPLAY was requested, keep the transport logically playing until
      // the authoritative PLAYING event arrives. This prevents releasing the
      // scrubber from leaving the UI/audio engine stuck in pause.
      if (gstResumeAfterSeek) return;
      enginePaused = true; syncMpris(currentQueue[currentIndex], true); dispatchAudio('pause'); return;
    }
    if (name === 'PLAYING' && gstActive) {
      gstResumeAfterSeek = false;
      enginePaused = false;
      engineEnded = false;
      // Only announce playback once GStreamer has actually entered PLAYING.
      // This keeps the transport button synchronized with the real engine and
      // prevents a transitional PAUSED notification from leaving it stuck on
      // the Play icon after a double-click starts a song.
      dispatchAudio('play');
            syncMpris(currentQueue[currentIndex], false);
      const playingTrack = currentQueue[currentIndex];
      if (playingTrack && !embeddedCoverExists(playingTrack)) {
        // Background-only enrichment: never block playback and never embed the
        // result. It exists solely as temporary visual artwork for this session.
        ensureAutomaticCoverVisual(playingTrack);
      }
      return;
    }
    if (name === 'TRIM_END' && gstActive) {
      const endedTrack = currentQueue[currentIndex];
      saveRememberedTrackPosition(endedTrack, 0);
      enginePaused = true; engineEnded = true; gstPosition = gstDuration;
            syncMpris(currentQueue[currentIndex], true);
      dispatchAudio('timeupdate'); dispatchAudio('ended');
      window.beehive.setPlaybackProtectedPath?.(''); gstActive = false; gstWaitingNextStream = false; gstExpectInitialStream = false;
      goNext();
      return;
    }
    if (name === 'EOS' && gstActive) {
      const endedTrack = currentQueue[currentIndex];
      saveRememberedTrackPosition(endedTrack, 0);
      enginePaused = true; engineEnded = true; gstPosition = gstDuration; syncMpris(currentQueue[currentIndex], true); dispatchAudio('timeupdate'); dispatchAudio('ended');
      if (!gstWaitingNextStream) { gstActive = false; goNext(); }
      return;
    }
    if (name === 'FATAL_ERROR') {
      console.error('Beehive audio safety shutdown:', ev.value || 'unknown GStreamer audio error');
      gstFatalError = true;
      gstSend('MUTE\t1');
      gstSend('STOP');
      window.beehive.setPlaybackProtectedPath?.('');
      gstActive = false;
      gstWaitingNextStream = false;
      gstExpectInitialStream = false;
      gstResumeAfterSeek = false;
      enginePaused = true;
      engineEnded = true;
      dispatchAudio('pause');
      return;
    }
    if (name === 'PROCESS_EXIT') {
      // An unexpected native helper exit is an audio-path failure. Do not
      // automatically replay the current file through a fresh process: the
      // failure may be in the file, sink, decoder, or audio device, and an
      // automatic retry can expose the same unsafe condition repeatedly.
      const wasActive = gstActive;
      console.error('Beehive audio safety shutdown: GStreamer helper exited:', ev.value || 'unknown');
      gstFatalError = wasActive || gstExpectInitialStream || gstActive;
      window.beehive.setPlaybackProtectedPath?.('');
      gstActive = false;
      gstWaitingNextStream = false;
      gstExpectInitialStream = false;
      gstResumeAfterSeek = false;
      enginePaused = true;
      engineEnded = wasActive;
      dispatchAudio('pause');
      return;
    }
    if (name === 'ERROR' && gstActive) {
      console.warn('Beehive GStreamer backend:', ev.value || 'error');
      // Native ERROR is followed by FATAL_ERROR after the sink has already
      // been muted and the pipeline stopped. Do not start another transport.
      gstFatalError = true;
      window.beehive.setPlaybackProtectedPath?.('');
      gstActive = false;
      gstAvailable = false;
      gstAvailabilityKnown = true;
      enginePaused = true;
      engineEnded = true;
      dispatchAudio('pause');
      return;
    }
  });

  const audio = audioEngine;
  // Yearly Wrap tracking follows the MusicBeeWrapped model: a play becomes a
  // recorded listening event after 5 seconds, while the stored duration is the
  // actual active listening time with pauses excluded. History remains a separate
  // latest-per-track view and is not repurposed as a play-count database.
  let wrapListeningSession = null;
  function wrapTrackKey(t) { return [t?.path,t?.spotifyUri,t?.streamUrl,t?.title,t?.artist,t?.album].map(v=>String(v||'')).join('|'); }
  function wrapBeginListening(t) {
    if (!t) return;
    const key=wrapTrackKey(t);
    if (!key) return;
    if (wrapListeningSession && wrapListeningSession.key === key) {
      if (wrapListeningSession.pausedAt != null) { wrapListeningSession.activeSince=performance.now(); wrapListeningSession.pausedAt=null; }
      return;
    }
    void wrapFinishListening();
    wrapListeningSession={key, track:{...t}, playedAt:Date.now(), activeSince:performance.now(), accumulated:0, pausedAt:null, finishing:false};
  }
  function wrapPauseListening() {
    const s=wrapListeningSession;
    if (!s || s.pausedAt != null) return;
    s.accumulated += Math.max(0,(performance.now()-s.activeSince)/1000);
    s.pausedAt=performance.now();
  }
  async function wrapFinishListening() {
    const s=wrapListeningSession;
    if (!s || s.finishing) return;
    if (s.pausedAt == null) s.accumulated += Math.max(0,(performance.now()-s.activeSince)/1000);
    s.finishing=true;
    wrapListeningSession=null;
    const listened=Math.max(0,Number(s.accumulated)||0);
    const trackDuration=Math.max(0,Number(s.track?.duration)||0);
    const capped=trackDuration>0 ? Math.min(listened,trackDuration) : listened;
    if (capped < 5) return;
    try { await window.beehive.recordListeningEvent({
      playedAt:s.playedAt, duration:Math.round(capped), trackDuration,
      path:s.track?.path||'', title:s.track?.title||'', artist:s.track?.artist||'', album:s.track?.album||'',
      albumArtist:s.track?.albumArtist||'', genre:s.track?.genre||'', cover:visualCoverForTrack(s.track),
      artworkUrl:spotifyArtworkUrl(s.track), source:s.track?.source||'', spotifyUri:s.track?.spotifyUri||'', completed:false
    }); } catch (err) { console.warn('[Yearly Wrap] could not save listening event', err?.message || String(err)); }
  }
  audio.addEventListener('play', () => { const t=currentQueue[currentIndex]; if(t) { wrapBeginListening(t); beginPlayCountSession(t); void scrobbleStart(t); } });
  audio.addEventListener('pause', () => { wrapPauseListening(); pausePlayCountSession(); });
  audio.addEventListener('ended', () => { void wrapFinishListening(); endPlayCountSession(); });


  try { audioElement.pause(); audioElement.style.display = 'none'; audioElement.removeAttribute('src'); } catch {}

  const el = {
    folderList: document.getElementById('folder-list'),
    addFolderBtn: document.getElementById('add-folder-btn'),
    rescanBtn: document.getElementById('rescan-btn'),
    scanProgress: document.getElementById('scan-progress'),
    scanTitle: document.getElementById('scan-progress-title'),
    scanFill: document.getElementById('scan-progress-fill'),
    scanLabel: document.getElementById('scan-progress-label'),
    scanFailuresBtn: document.getElementById('scan-failures-btn'),
    metadataEmbedStatus: document.getElementById('metadata-embed-status'),
    metadataEmbedStatusText: document.getElementById('metadata-embed-status-text'),
    metadataEmbedSpinner: document.getElementById('metadata-embed-spinner'),
    selectionStatus: document.getElementById('selection-status'),
    tagFailuresModal: document.getElementById('tag-failures-modal'),
    tagFailuresSummary: document.getElementById('tag-failures-summary'),
    tagFailuresList: document.getElementById('tag-failures-list'),
    copyAllTagErrorsBtn: document.getElementById('copy-all-tag-errors-btn'),
    tagFailuresCopyStatus: document.getElementById('tag-failures-copy-status'),
    emptyState: document.getElementById('empty-state'),
    albumsToolbar: document.getElementById('albums-toolbar'),
    albumsGrid: document.getElementById('albums-grid'),
    songsTable: document.getElementById('songs-table'),
    artistsGrid: document.getElementById('artists-grid'),
    contentTools: document.getElementById('content-tools'),
    tagModal: document.getElementById('tag-modal'),
    playlistModal: document.getElementById('playlist-modal'),
    playlistName: document.getElementById('playlist-name'),
    playlistLabelStyles: document.getElementById('playlist-label-styles'),
    playlistLabelHtml: document.getElementById('playlist-label-html'),
    playlistLabelPreview: document.getElementById('playlist-label-preview'),
    playlistDisplayView: document.getElementById('playlist-display-view'),
    playlistModalTitle: document.getElementById('playlist-modal-title'),
    playlistSave: document.getElementById('playlist-save'),
    playlistCancel: document.getElementById('playlist-cancel'),
    playlistInfoModal: document.getElementById('playlist-info-modal'),
    playlistInfoTitle: document.getElementById('playlist-info-title'),
    playlistInfoBody: document.getElementById('playlist-info-body'),
    playlistInfoName: document.getElementById('playlist-info-name'),
    playlistInfoDisplayView: document.getElementById('playlist-info-display-view'),
    playlistInfoShuffle: document.getElementById('playlist-info-shuffle'),
    playlistInfoIconMenu: document.getElementById('playlist-info-icon-menu'),
    playlistInfoLabelStyles: document.getElementById('playlist-info-label-styles'),
    playlistInfoLabelHtml: document.getElementById('playlist-info-label-html'),
    playlistInfoLabelPreview: document.getElementById('playlist-info-label-preview'),
    playlistInfoHeroIcon: document.getElementById('playlist-info-hero-icon'),
    playlistInfoHeroLabel: document.getElementById('playlist-info-hero-label'),
    playlistInfoHeroSubtitle: document.getElementById('playlist-info-hero-subtitle'),
    playlistInfoPreviewIcon: document.getElementById('playlist-info-preview-icon'),
    playlistInfoSave: document.getElementById('playlist-info-save'),
    playlistInfoSaveStatus: document.getElementById('playlist-info-save-status'),
    noticeModal: document.getElementById('notice-modal'),
    noticeTitle: document.getElementById('notice-title'),
    noticeBody: document.getElementById('notice-body'),
    noticeCopyRow: document.getElementById('notice-copy-row'),
    noticeCopy: document.getElementById('notice-copy'),
    noticeCopyStatus: document.getElementById('notice-copy-status'),
    diskDeleteModal: document.getElementById('disk-delete-modal'),
    diskDeleteMessage: document.getElementById('disk-delete-message'),
    diskDeleteDetail: document.getElementById('disk-delete-detail'),
    diskDeleteProceed: document.getElementById('disk-delete-proceed'),
    diskDeleteCancel: document.getElementById('disk-delete-cancel'),
    diskDeleteFinalModal: document.getElementById('disk-delete-final-modal'),
    diskDeleteFinalDetail: document.getElementById('disk-delete-final-detail'),
    diskDeleteFinalYes: document.getElementById('disk-delete-final-yes'),
    diskDeleteFinalNo: document.getElementById('disk-delete-final-no'),
    playlistImportModal: document.getElementById('playlist-import-modal'),
    playlistImportFile: document.getElementById('playlist-import-file'),
    playlistImportSpotify: document.getElementById('playlist-import-spotify'),
    playlistImportCancel: document.getElementById('playlist-import-cancel'),
    smartPlaylistModal: document.getElementById('smart-playlist-modal'),
    smartPlaylistName: document.getElementById('smart-playlist-name'),
    smartPlaylistMatch: document.getElementById('smart-playlist-match'),
    smartPlaylistSort: document.getElementById('smart-playlist-sort'),
    smartPlaylistRules: document.getElementById('smart-playlist-rules'),
    smartPlaylistAddRule: document.getElementById('smart-playlist-add-rule'),
    smartPlaylistLimit: document.getElementById('smart-playlist-limit'),
    smartPlaylistSave: document.getElementById('smart-playlist-save'),
    smartPlaylistCancel: document.getElementById('smart-playlist-cancel'),
    tagSave: document.getElementById('tag-save'),
    tagCancel: document.getElementById('tag-cancel'),
    tagStatus: document.getElementById('tag-status'),
    sectionTitle: document.getElementById('section-title'),
    sectionTitleText: document.getElementById('section-title-text'),
    artistBackBtn: document.getElementById('artist-back-btn'),
    viewBtns: Array.from(document.querySelectorAll('.view-btn[data-mode]')),
    search: document.getElementById('search-input'),
    searchClear: document.getElementById('search-clear-btn'),

    queueList: document.getElementById('queue-list'),
    npCard: document.getElementById('now-playing-card'),
    npCover: document.getElementById('np-cover'),
    npArtist: document.getElementById('np-artist'),
    npYear: document.getElementById('np-year'),
    npTrack: document.getElementById('np-track'),
    npFormat: document.getElementById('np-format'),
    npBitrate: document.getElementById('np-bitrate'),
    npTitle: document.getElementById('np-title'),
    npArtist: document.getElementById('np-artist'),
    npAlbum: document.getElementById('np-album'),
    npTech: document.getElementById('np-tech'),

    lyricsSection: document.getElementById('lyrics-section'),
    lyricsText: document.getElementById('lyrics-text'),
    lyricsRail: document.getElementById('lyrics-rail'),

    main: document.getElementById('main'),
    tabPlaceholder: document.getElementById('tab-placeholder'),
    tabPlaceholderTitle: document.getElementById('tab-placeholder-title'),
    tabPlaceholderBody: document.getElementById('tab-placeholder-body'),
    topbarTabs: document.getElementById('topbar-tabs'),
    tabAddBtn: document.getElementById('tab-add-btn'),

    pbCover: document.getElementById('pb-cover'),
    pbTitle: document.getElementById('pb-title'),
    pbArtist: document.getElementById('pb-artist'),
    btnPlay: document.getElementById('btn-play'),
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    btnLove: document.getElementById('btn-love'),
    btnShuffle: document.getElementById('btn-shuffle'),
    btnRepeat: document.getElementById('btn-repeat'),
    pbSeek: document.getElementById('pb-seek'),
    pbElapsed: document.getElementById('pb-elapsed'),
    pbDuration: document.getElementById('pb-duration'),
    pbVolume: document.getElementById('pb-volume'),
    playerGlassToggle: document.getElementById('setting-player-glass'),
    themeWindowBarToggle: document.getElementById('setting-theme-window-bar'),

    sidebarItems: Array.from(document.querySelectorAll('.sidebar-item')),

    // brand dropdown
    brandBtn: document.getElementById('brand-btn'),
    brandDropdown: document.getElementById('brand-dropdown'),

    // settings modal
    settingsModal: document.getElementById('settings-modal'),
    lockResizeToggle: document.getElementById('setting-lock-resize'),
    resetLayoutBtn: document.getElementById('reset-layout-btn'),
    clearPlayCountsBtn: document.getElementById('clear-play-counts-btn'),
    clearPlayCountsModal: document.getElementById('clear-play-counts-modal'),
    clearPlayCountsCancel: document.getElementById('clear-play-counts-cancel'),
    clearPlayCountsConfirm: document.getElementById('clear-play-counts-confirm'),
    playbarNowPlayingBgToggle: document.getElementById('setting-playbar-now-playing-bg'),
    legacyArtScalingToggle: document.getElementById('setting-legacy-art-scaling'),
    gpuAccelerationToggle: document.getElementById('setting-gpu-acceleration'),
    embedPlayCountsToggle: document.getElementById('setting-embed-play-counts'),
    importMusicBeeWrappedBtn: document.getElementById('import-musicbee-wrapped-btn'),
    exportHiveWrappedBtn: document.getElementById('export-hive-wrapped-btn'),
    musicBeeWrappedImportStatus: document.getElementById('musicbee-wrapped-import-status'),
    appDialogModal: document.getElementById('app-dialog-modal'),
    appDialogTitle: document.getElementById('app-dialog-title'),
    appDialogMessage: document.getElementById('app-dialog-message'),
    appDialogInput: document.getElementById('app-dialog-input'),
    appDialogActions: document.getElementById('app-dialog-actions'),
    appDialogClose: document.getElementById('app-dialog-close'),
    logSource: document.getElementById('settings-log-source'),
    logRefresh: document.getElementById('settings-log-refresh'),
    logCopy: document.getElementById('settings-log-copy'),
    logStatus: document.getElementById('settings-log-status'),
    logOutput: document.getElementById('settings-log-output'),
    diagnosticsStart: document.getElementById('settings-diagnostics-start'),
    diagnosticsFinish: document.getElementById('settings-diagnostics-finish'),
    diagnosticsOpen: document.getElementById('settings-diagnostics-open'),
    crashReportsOpen: document.getElementById('settings-crash-reports-open'),
    crashReportsStatus: document.getElementById('settings-crash-reports-status'),
    diagnosticsStatus: document.getElementById('settings-diagnostics-status'),

    // about modal
    aboutModal: document.getElementById('about-modal'),
    aboutVersion: document.getElementById('about-version'),
    aboutCheckUpdatesBtn: document.getElementById('about-check-updates-btn'),
    aboutUpdateStatus: document.getElementById('about-update-status'),

    pbVolIcon: document.getElementById('pb-vol-icon'),

    // cover art lightbox
    coverLightbox: document.getElementById('cover-lightbox'),
    lightboxImg: document.getElementById('lightbox-img'),
    lightboxCaption: document.getElementById('lightbox-caption'),
    lightboxDots: document.getElementById('lightbox-dots'),
    lightboxPrev: document.getElementById('lightbox-prev'),
    lightboxNext: document.getElementById('lightbox-next')
  };

  // ---------------- brand dropdown menu ----------------
  // Keep the Hive menu self-contained. This is intentionally bound before the
  // rest of the late renderer initialization so a later optional feature error
  // can never make the Settings entry dead.
  function closeBrandDropdown() {
    if (!el.brandDropdown) return;
    el.brandDropdown.classList.add('hidden');
    el.brandBtn?.setAttribute('aria-expanded', 'false');
  }
  function toggleBrandDropdown() {
    if (!el.brandDropdown) return;
    const nextHidden = !el.brandDropdown.classList.contains('hidden');
    el.brandDropdown.classList.toggle('hidden', nextHidden);
    el.brandBtn?.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
  }
  el.brandBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleBrandDropdown();
  });
  el.brandDropdown?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.target.closest?.('.dropdown-item');
    if (!btn) return;
    closeBrandDropdown();
    if (btn.dataset.action === 'settings') {
      openModal(el.settingsModal);
      document.querySelector('.settings-tab-btn[data-settings-tab="general"]')?.focus({ preventScroll: true });
    }
    if (btn.dataset.action === 'about') openModal(el.aboutModal);
    // "check-updates" and any future items are placeholders for now.
  });
  document.addEventListener('click', (e) => {
    const brandTrigger = e.target.closest?.('#brand-btn');
    if (el.brandDropdown && !el.brandDropdown.classList.contains('hidden') && !el.brandDropdown.contains(e.target) && !brandTrigger) closeBrandDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.brandDropdown && !el.brandDropdown.classList.contains('hidden')) {
      e.preventDefault();
      closeBrandDropdown();
    }
  });


  // Modal surfaces share one stacking manager. A child dialog opened from a
  // button inside another modal must always paint above its parent instead of
  // appearing behind it. Native OS chooser windows remain OS-owned; this
  // manager covers every Hive-rendered modal/overlay.
  let modalZIndex = 100;
  function openModal(modal) {
    if (!modal) return;
    modal.classList.remove('hidden');
    modalZIndex = Math.min(2147483000, modalZIndex + 1);
    modal.style.zIndex = String(modalZIndex);
    modal.dataset.modalStackIndex = String(modalZIndex);
    // Bring the newly opened surface to the front even if it was already open.
    modal.dispatchEvent(new CustomEvent('beehive-modal-front'));
  }
  function closeModal(modal) {
    if (!modal) return;
    modal.classList.add('hidden');
    if (typeof modal._onClose === 'function') { modal._onClose(); modal._onClose = null; }
  }

  // Modal close handling uses capture-phase pointer/click delegation. Capture is
  // important here: a child surface can have its own click handlers that stop
  // propagation, but a close button must never become unclickable because of
  // whatever content happens to be inside the popup.
  const handleModalClosePointer = (e) => {
    const closeButton = e.target?.closest?.('.modal-overlay [data-close]');
    if (!closeButton) return;
    const overlay = closeButton.closest('.modal-overlay');
    if (!overlay) return;
    e.preventDefault();
    e.stopPropagation();
    closeModal(overlay);
  };
  document.addEventListener('pointerdown', handleModalClosePointer, true);
  document.addEventListener('click', (e) => {
    const closeButton = e.target.closest?.('.modal-overlay [data-close]');
    if (closeButton) {
      e.preventDefault();
      e.stopPropagation();
      const overlay = closeButton.closest('.modal-overlay');
      if (overlay) closeModal(overlay);
      return;
    }
    const overlay = e.target.closest?.('.modal-overlay');
    if (overlay && e.target === overlay) closeModal(overlay);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const visible = Array.from(document.querySelectorAll('.modal-overlay:not(.hidden)'))
      .sort((a,b)=>(Number(b.style.zIndex)||0)-(Number(a.style.zIndex)||0));
    if (visible[0]) { e.preventDefault(); closeModal(visible[0]); }
  });


  let library = { tracks: [] };
  let libraryTrackByPath = new Map();
  let libraryTrackByNormalizedPath = new Map();
  let libraryTrackByTitleArtist = new Map();
  let libraryTrackByBasename = new Map();
  let artistPickerEntries = [];
  let artistPickerEntriesReady = false;
  let artistPickerFiltered = [];
  let artistVirtualState = { rowHeight: 224, cardWidth: 178, gap: 18, lastStart: -1, lastEnd: -1, raf: 0, viewport: null, spacer: null, window: null };
  let albums = [];
  let currentQueue = [];
  let currentIndex = -1;
  let shuffle = false;
  // When shuffle is enabled, retain the exact pre-shuffle queue order so turning
  // shuffle back off restores the queue instead of leaving it randomized. The
  // snapshot is replaced only when shuffle is enabled again after being turned off.
  let shuffleRestoreQueue = null;
  // Playback history is separate from queue order so Previous works naturally in shuffle mode.
  let playbackHistory = [];
  const songCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const SONG_COLUMNS_KEY = 'hive:song-columns';
  let songColumnsFitToScreen = true;
  let songColumnsResizeObserver = null;
  let songColumnsFitRaf = 0;
  let songColumnsApplyRaf = 0;
  let songColumnsPendingWidths = null;
  // Keep display formatting separate from sorting semantics. A formatted value
  // such as "12/14", "320 kbps", or a localized date is for humans; sorting
  // must use the underlying value so every column behaves like its data type.
  const SONG_COLUMN_DEFS = [
    { key:'position', label:'#', defaultWidth:46, minWidth:42, type:'number', get:()=>'', sortGet:(_t,i)=>i },
    { key:'title', label:'Title', defaultWidth:240, minWidth:140, type:'string', get:t=>String(t?.title || ''), sortGet:t=>String(t?.title || '') },
    { key:'artist', label:'Artist', defaultWidth:170, minWidth:110, type:'string', get:t=>String(t?.artist || ''), sortGet:t=>String(t?.artist || '') },
    { key:'album', label:'Album', defaultWidth:190, minWidth:120, type:'string', get:t=>String(t?.album || ''), sortGet:t=>String(t?.album || '') },
    { key:'albumArtist', label:'Album Artist', defaultWidth:170, minWidth:110, type:'string', get:t=>String(t?.albumArtist || ''), sortGet:t=>String(t?.albumArtist || '') },
    { key:'genre', label:'Genre', defaultWidth:140, minWidth:90, type:'string', get:t=>String(t?.genre || ''), sortGet:t=>String(t?.genre || '') },
    { key:'year', label:'Year', defaultWidth:70, minWidth:55, type:'number', get:t=>String(t?.year || ''), sortGet:t=>Number(t?.year || 0) },
    { key:'track', label:'Track #', defaultWidth:75, minWidth:55, type:'number', get:t=>formatTrackNumber(t), sortGet:t=>Number(t?.track || 0) },
    { key:'disc', label:'Disc #', defaultWidth:70, minWidth:55, type:'number', get:t=>formatDiscNumber(t), sortGet:t=>Number(t?.disc || 0) },
    { key:'composer', label:'Composer', defaultWidth:150, minWidth:100, type:'string', get:t=>String(t?.composer || ''), sortGet:t=>String(t?.composer || '') },
    { key:'publisher', label:'Publisher', defaultWidth:150, minWidth:100, type:'string', get:t=>String(t?.publisher || ''), sortGet:t=>String(t?.publisher || '') },
    { key:'comment', label:'Comment', defaultWidth:180, minWidth:100, type:'string', get:t=>normalizeMetadataText(t?.comment), sortGet:t=>normalizeMetadataText(t?.comment) },
    { key:'plays', label:'Plays', defaultWidth:70, minWidth:55, type:'number', get:t=>String(Number(t?.playCount || 0)), sortGet:t=>Number(t?.playCount || 0) },
    { key:'rating', label:'Rating', defaultWidth:112, minWidth:80, type:'number', get:t=>Number(t?.ratingRaw) === 255 ? '5' : String(Number(t?.rating || 0)), sortGet:t=>Number(t?.ratingRaw) === 255 ? 5 : Number(t?.rating || 0) },
    { key:'length', label:'Length', defaultWidth:75, minWidth:60, type:'number', get:t=>fmtTime(t?.duration), sortGet:t=>Number(t?.duration || 0) },
    { key:'bitrate', label:'Bitrate', defaultWidth:85, minWidth:65, type:'number', get:t=>formatBitrate(t), sortGet:t=>Number(t?.bitrate || 0) },
    { key:'sampleRate', label:'Sample Rate', defaultWidth:100, minWidth:75, type:'number', get:t=>formatSampleRate(t), sortGet:t=>Number(t?.sampleRate || 0) },
    { key:'dateAdded', label:'Date Added', defaultWidth:115, minWidth:90, type:'number', get:t=>formatDateAdded(t), sortGet:t=>Number(t?.addedAt || 0) },
    { key:'filename', label:'Filename', defaultWidth:180, minWidth:110, type:'string', get:t=>String(t?.path || '').split(/[\\/]/).pop() || '', sortGet:t=>String(t?.path || '').split(/[\\/]/).pop() || '' },
    { key:'folder', label:'Folder', defaultWidth:220, minWidth:120, type:'string', get:t=>formatFolder(t), sortGet:t=>formatFolder(t) },
  ];
  let songColumns = loadSongColumns();
  let songVirtualState = { tracks: [], rowHeight: 46, headerHeight: 32, lastStart: -1, lastEnd: -1, raf: 0 };
  // Tracks use delegated interactions (bound once per persistent table) so virtual
  // window repaints only replace row markup; they do not allocate new event
  // listeners for every visible row.
  // The playback queue can contain the entire library. Keep only the visible
  // rows in the DOM so starting a song from Tracks never blocks the audio player.
  let queueVirtualState = { rowHeight: 42, lastStart: -1, lastEnd: -1, raf: 0, pool: [], poolSize: 0, spacer: null };
  let playlistVirtualState = { rowHeight: 66, lastStart: -1, lastEnd: -1, raf: 0, viewport: null, window: null, spacer: null };

  let repeat = 0; // 0 = play through and stop, 1 = repeat queue, 2 = repeat single
  let viewMode = 'albums';
  let searchTerm = '';
  // Album ordering is always release-date order. The toggle below only controls
  // whether the year dividers are shown visually.
  let albumYearDividers = true;
  let artistSearchTerm = '';
  // Artist search is a filtered view of the main Albums browser. Keep the
  // previous browser state so Back can return to the exact viewer/context,
  // including an album that was already expanded.
  let artistSearchReturnState = null;
  let albumSearchReturnState = null;
  let artistSearchFocusAlbumKey = null;
  let artistPickerScrollTop = 0;
  let playlists = [];
  let specialView = null;
  let albumFocusTitle = null;
  let activeFolderPath = '';
  let activePlaylistId = null;
  let editingTrack = null;
  let editingTracks = [];
  let editingTagSnapshots = [];
  // Tracks whether the tag editor form has any unsaved user edits, so
  // clicking a different track while it's open (see maybeSwitchTagEditorTrack)
  // knows whether to switch immediately or ask first. Only real user input
  // sets this -- openTagEditor's own programmatic `.value =` population does
  // not fire input/change events, so it never marks the form dirty by itself.
  let tagEditorDirty = false;
  let pendingArtworkPath = null;
  let pendingArtworkPreviewUrl = '';
  let pendingArtworkSlot = null;
  let pendingArtworkMode = 'front';
  let selectedQueueIndex = -1;
  const selectedQueueIndices = new Set();
  const queueUndoStack = [];
  const queueRedoStack = [];
  const MAX_QUEUE_UNDO = 20;
  let activeSelectionScope = 'songs';
  // Real bug, confirmed live: referenced and assigned in ~11 places
  // (syncLoveStateForPath, album/queue/bulk-delete selection tracking) but
  // never declared anywhere. In strict mode that throws ReferenceError on
  // every read AND every assignment -- every single Love/heart click threw
  // an uncaught "activeSelectionTracks is not defined" from
  // syncLoveStateForPath, silently skipping the rest of that function
  // (including the actual heart-icon UI update) and leaving every write
  // site's assignment a no-op throw instead of actually tracking the
  // active multi-select.
  let activeSelectionTracks = [];
  const lyricsLookupCache = new Map();
  // The tag editor's Lyrics tab only ever shows/edits the plain embedded
  // lyrics -- the field actually written to the audio file (see
  // resources/python/tag_helper.py, which strips any [mm:ss.xx] timestamps
  // unconditionally). There is no synced/plain toggle here: the player's
  // synced-lyrics highlighting during playback is a separate display-time
  // concern (renderLyrics) that never affects what gets embedded.
  let tagLyricsPayload = { text: '', editing: false };
  const HIGHLIGHTED_LYRICS_KEY = 'beehive:highlighted-lyrics';
  const EMBED_LYRICS_AUTOMATICALLY_KEY = 'beehive:embed-lyrics-automatically';
  function highlightedLyricsEnabled() {
    try { return localStorage.getItem(HIGHLIGHTED_LYRICS_KEY) !== 'false'; } catch { return true; }
  }
  function embedLyricsAutomaticallyEnabled() {
    try { return localStorage.getItem(EMBED_LYRICS_AUTOMATICALLY_KEY) === 'true'; } catch { return false; }
  }
  let renderedLyricsTrackPath = '';
  let syncedLyricsEntries = [];
  let activeSyncedLyricIndex = -1;
  let followHighlightedLyric = true;
  let lyricsProgrammaticScroll = false;
  let lyricsProgrammaticScrollTimer = 0;
  // Monotonic UI generation for Now Playing. Metadata/artwork/love work can
  // await disk/IPC operations; an older track update must never be allowed to
  // repaint the player after a newer track has become current.
  let nowPlayingUiGeneration = 0;

  function normalizeMetadataText(raw) {
    if (raw === null || raw === undefined) return '';
    if (Array.isArray(raw)) return raw.map(normalizeMetadataText).filter(Boolean).join('\n\n');
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      const text = String(raw);
      return text.trim() === '[object Object]' ? '' : text;
    }
    if (typeof raw === 'object') {
      for (const key of ['text', 'plainLyrics', 'lyrics', 'value', 'description']) {
        if (raw[key] !== undefined && raw[key] !== null) {
          const text = normalizeMetadataText(raw[key]);
          if (text) return text;
        }
      }
    }
    return '';
  }

  function normalizeLyricsText(raw) {
    return normalizeMetadataText(raw);
  }

  function normalizeLyricsPayload(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const synced = normalizeLyricsText(raw.syncedLyrics);
      if (synced) return synced;
      return normalizeLyricsText(raw.plainLyrics ?? raw.lyrics ?? raw.text ?? '');
    }
    return normalizeLyricsText(raw);
  }

  function parseSyncedLyrics(raw) {
    const source = normalizeLyricsText(raw).replace(/\r\n?/g, '\n').trim();
    if (!source) return [];
    const entries = [];
    const timestampRe = /\[(?:(\d+):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    for (const originalLine of source.split('\n')) {
      const line = originalLine.trimEnd();
      if (!line.trim()) continue;
      timestampRe.lastIndex = 0;
      const stamps = [];
      let match;
      let lastEnd = 0;
      while ((match = timestampRe.exec(line))) {
        const hours = Number(match[1] || 0);
        const minutes = Number(match[2] || 0);
        const seconds = Number(match[3] || 0);
        const fraction = String(match[4] || '');
        const fractionSeconds = fraction ? Number(`0.${fraction}`) : 0;
        stamps.push(hours * 3600 + minutes * 60 + seconds + fractionSeconds);
        lastEnd = timestampRe.lastIndex;
      }
      if (!stamps.length) {
        // LRC often wraps one timestamped lyric across multiple physical lines.
        // Keep those continuation lines with the preceding timed entry.
        if (entries.length && !/^\[(?:ar|ti|al|by|re|ve|offset):/i.test(line.trim())) {
          entries[entries.length - 1].text += `\n${line.trim()}`;
        }
        continue;
      }
      const text = line.slice(lastEnd).trim();
      // Metadata-only LRC lines such as [ar:Artist] have no lyric timestamp.
      for (const time of stamps) {
        entries.push({ time, text });
      }
    }
    return entries
      .filter(item => Number.isFinite(item.time) && item.text.trim())
      .sort((a, b) => a.time - b.time);
  }

  function renderLyrics(raw, track) {
    const text = normalizeLyricsPayload(raw).trim();
    syncedLyricsEntries = parseSyncedLyrics(text);
    activeSyncedLyricIndex = -1;
    followHighlightedLyric = true;
    renderedLyricsTrackPath = String(track?.path || '');
    const container = el.lyricsText;
    if (!container) return;
    if (!syncedLyricsEntries.length) {
      container.classList.remove('lyrics-synced');
      if (!text && String(track?.source || '') === 'podcast') {
        const description = String(track?.podcastDescription || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const date = track?.pubDate ? new Date(track.pubDate) : null;
        const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString([], {year:'numeric', month:'short', day:'numeric'}) : '';
        container.innerHTML = `<div class="podcast-info">
          <div class="podcast-info-kicker">PODCAST EPISODE</div>
          <strong class="podcast-info-title">${escapeHtml(track?.title || 'Untitled episode')}</strong>
          <div class="podcast-info-meta">${escapeHtml(track?.album || 'Podcast')}${dateText ? ` · ${escapeHtml(dateText)}` : ''}</div>
          ${description ? `<p class="podcast-info-description">${escapeHtml(description)}</p>` : '<p class="podcast-info-description dim">No episode description was provided by the feed.</p>'}
        </div>`;
      } else {
        container.textContent = text;
      }
      return;
    }
    container.classList.add('lyrics-synced');
    container.innerHTML = syncedLyricsEntries.map((entry, i) =>
      `<div class=\"lyrics-line\" data-lyric-index=\"${i}\">${escapeHtml(entry.text).replace(/\n/g, '<br>')}</div>`
    ).join('');
    // A new track should snap straight to its highlighted lyric, not visibly
    // slide over from wherever the previous track left the scroll position.
    // updateSyncedLyrics's normal path uses a smooth animated scroll (shared
    // with the deliberate "Show highlighted lyric" recenter action, which
    // should keep that animation) -- suppress it here and jump instantly.
    followHighlightedLyric = false;
    updateSyncedLyrics(Number(audio.currentTime) || 0, true);
    followHighlightedLyric = true;
    scrollHighlightedLyricIntoView('auto');
  }

  function scrollHighlightedLyricIntoView(behavior = 'smooth') {
    if (!syncedLyricsEntries.length || !el.lyricsRail || !el.lyricsText) return;
    // The command can be invoked while the playback clock has not painted a
    // lyric index yet (for example immediately after loading a track or while
    // paused). Recompute the active line first so "Show highlighted lyric"
    // always has a concrete target instead of silently doing nothing.
    if (activeSyncedLyricIndex < 0) updateSyncedLyrics(Number(audio.currentTime) || 0, true);
    if (activeSyncedLyricIndex < 0) return;
    const active = el.lyricsText.querySelector(`.lyrics-line[data-lyric-index=\"${activeSyncedLyricIndex}\"]`);
    if (!active) return;
    const box = el.lyricsRail;
    const maxTop = Math.max(0, box.scrollHeight - box.clientHeight);
    // The rail is the actual scrolling element; lyrics-text itself is only the
    // content layer. Center the active entry within the visible lyrics rail.
    const target = Math.max(0, Math.min(maxTop, active.offsetTop - Math.max(0, (box.clientHeight - active.offsetHeight) / 2)));
    lyricsProgrammaticScroll = true;
    clearTimeout(lyricsProgrammaticScrollTimer);
    try { box.scrollTo({ top: target, behavior }); }
    catch { box.scrollTop = target; }
    lyricsProgrammaticScrollTimer = window.setTimeout(() => { lyricsProgrammaticScroll = false; }, behavior === 'smooth' ? 700 : 100);
  }

  function lyricsOffsetSeconds(track) {
    const source = track || currentQueue[currentIndex] || libraryTrackByPath.get(renderedLyricsTrackPath);
    const raw = source?.customTags?.BEEHIVE_LYRICS_OFFSET ?? source?.nativeTags?.BEEHIVE_LYRICS_OFFSET ?? '';
    const value = Number.parseFloat(String(raw).trim());
    return Number.isFinite(value) ? value : 0;
  }

  function updateSyncedLyrics(position, force = false) {
    if (!syncedLyricsEntries.length || !el.lyricsText) return;
    const offset = lyricsOffsetSeconds();
    // Positive offset means the lyrics should appear later, so subtract it from
    // the player's transport position when selecting the active LRC line.
    const time = Math.max(0, (Number(position) || 0) - offset);
    let index = -1;
    // The active lyric is the most recent timestamp at or before playback.
    for (let i = 0; i < syncedLyricsEntries.length; i++) {
      if (syncedLyricsEntries[i].time <= time + 0.01) index = i;
      else break;
    }
    if (!force && index === activeSyncedLyricIndex) return;
    activeSyncedLyricIndex = index;
    el.lyricsText.querySelectorAll('.lyrics-line.current').forEach(node => node.classList.remove('current'));
    if (index < 0) return;
    const active = el.lyricsText.querySelector(`.lyrics-line[data-lyric-index=\"${index}\"]`);
    if (!active) return;
    active.classList.add('current');

    // Normally keep the active lyric centered in the lyrics box. If the listener
    // manually scrolls, follow mode is disabled so they can read ahead freely.
    if (followHighlightedLyric) scrollHighlightedLyricIntoView('smooth');
  }

  function handleLyricsScroll() {
    if (!el.lyricsRail || !syncedLyricsEntries.length || lyricsProgrammaticScroll) return;
    followHighlightedLyric = false;
  }

  let songSort = { key: null, dir: 1 };
  // A sidebar/playlist auto-shuffle is the opening order, not a lock against
  // manual sorting. Remember an explicit header-sort only for the currently
  // open collection so leaving and re-entering it can still start shuffled.
  let songSortOverrideContext = '';
  const selectedSongPaths = new Set();
  // Preserve the exact order in which songs were selected. This is intentionally
  // separate from the Set, whose iteration order can be affected by selection
  // changes; queue insertion follows this explicit selection order.
  const selectedSongOrder = [];
  let songSelectionAnchor = null;
  let trackTypeaheadBuffer = '';
  let trackTypeaheadTimer = 0;
  let songDragState = null;
  let queueDragState = null;
  let queueDropIndex = -1;
  const LAST_PLAYBACK_KEY = 'beehive:last-playback';
  const TRACK_REMEMBER_POSITIONS_KEY = 'beehive:track-remember-positions';
  const QUEUE_SESSION_KEY = 'beehive:queue-session';
  // Primary playback recovery is a small backend JSON snapshot. localStorage
  // remains as a compatibility fallback for sessions created by older builds.
  let backendPlaybackState = null;
  let restoredPlayback = false;
  // During asynchronous startup restoration, do not let the 500ms session saver
  // overwrite the saved position with the temporary 0:00 state before decoding
  // the restored track has completed.
  let playbackRestorePending = false;
  // Startup must read the saved session before the live renderer is allowed to overwrite it.
  let playbackPersistenceReady = false;
  let openAlbumKey = null;
  // The album highlight is a browser-selection affordance, independent of which
  // album is currently playing. It follows the album the user clicks/double-clicks
  // and is kept separately for each Music tab.
  let highlightedAlbumKey = null;
  // Albums use an explicit multi-selection model, independent of the single
  // highlighted/expanded album. Keep both the membership set and selection
  // order so Ctrl-click + drag preserves the user's chosen order.
  const selectedAlbumKeys = new Set();
  const selectedAlbumOrder = [];
  let albumSelectionAnchor = null;

  function selectedAlbumModelsInOrder() {
    const tracks = tracksForCurrentContext();
    const byKey = new Map(buildAlbums(tracks).map(a => [String(a?.key || ''), a]));
    const ordered = [];
    for (const key of selectedAlbumOrder) {
      if (!selectedAlbumKeys.has(key)) continue;
      const album = byKey.get(String(key));
      if (album) ordered.push(album);
    }
    return ordered;
  }

  // "2d 3h 15m 40s" -- only the units that actually apply. Once a larger unit
  // is shown, every smaller unit down to seconds is shown too (so "2d 0h 5m"
  // reads correctly), but a leading zero unit (e.g. "0 days" for anything
  // under a day) is omitted entirely rather than padding every duration out
  // to four fields.
  function formatDurationLong(totalSeconds) {
    let remaining = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const days = Math.floor(remaining / 86400); remaining -= days * 86400;
    const hours = Math.floor(remaining / 3600); remaining -= hours * 3600;
    const minutes = Math.floor(remaining / 60); remaining -= minutes * 60;
    const seconds = remaining;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (parts.length || hours > 0) parts.push(`${hours}h`);
    if (parts.length || minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
  }

  // "340mb" -- lowercase unit, no space, one decimal only when it's not a
  // whole number (e.g. "1.2gb" but "340mb", not "340.0mb").
  function formatFileSizeShort(totalBytes) {
    const bytes = Math.max(0, Number(totalBytes) || 0);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes, unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) { value /= 1024; unitIndex++; }
    const display = unitIndex === 0 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
    return `${display}${units[unitIndex].toLowerCase()}`;
  }

  function selectedTracksForStatus() {
    if (activeSelectionScope === 'queue') {
      return [...selectedQueueIndices].map(i => currentQueue[i]).filter(Boolean);
    }
    if (activeSelectionScope === 'albums') {
      const seen = new Set();
      const out = [];
      for (const album of selectedAlbumModelsInOrder()) {
        for (const track of (album?.tracks || [])) {
          const p = String(track?.path || '');
          if (p && !seen.has(p)) { seen.add(p); out.push(track); }
        }
      }
      return out;
    }
    return orderedSelectedTracks(library.tracks);
  }

  function updateSelectionStatus() {
    const node = el.selectionStatus;
    if (!node) return;
    let count = 0;
    if (activeSelectionScope === 'queue') {
      count = selectedQueueIndices.size;
    } else if (activeSelectionScope === 'albums') {
      const paths = new Set();
      for (const album of selectedAlbumModelsInOrder()) {
        for (const track of (album?.tracks || [])) {
          const path = String(track?.path || '');
          if (path) paths.add(path);
        }
      }
      count = paths.size;
    } else {
      count = selectedSongPaths.size;
    }
    node.textContent = count ? `${count.toLocaleString()} song${count === 1 ? '' : 's'} selected` : '';
    node.classList.toggle('hidden', count === 0);
    if (count) {
      const tracks = selectedTracksForStatus();
      const totalSeconds = tracks.reduce((sum, t) => sum + (Number(t?.duration) || 0), 0);
      const totalBytes = tracks.reduce((sum, t) => sum + (Number(t?.fileSize) || 0), 0);
      node.dataset.tooltip = `${formatDurationLong(totalSeconds)} · ${formatFileSizeShort(totalBytes)}`;
    } else {
      delete node.dataset.tooltip;
    }
  }

  function clearAlbumSelection() {
    selectedAlbumKeys.clear();
    selectedAlbumOrder.length = 0;
    albumSelectionAnchor = null;
    document.querySelectorAll('.album-card.album-selected').forEach(node => node.classList.remove('album-selected'));
  }

  function selectAlbumKey(key) {
    const k = String(key || '');
    if (!k || selectedAlbumKeys.has(k)) return;
    selectedAlbumKeys.add(k);
    selectedAlbumOrder.push(k);
  }

  function deselectAlbumKey(key) {
    const k = String(key || '');
    selectedAlbumKeys.delete(k);
    const i = selectedAlbumOrder.indexOf(k);
    if (i >= 0) selectedAlbumOrder.splice(i, 1);
  }

  function applyAlbumSelectionClasses(container = el.albumsGrid) {
    if (!container) return;
    container.querySelectorAll('.album-card').forEach(card => {
      card.classList.toggle('album-selected', selectedAlbumKeys.has(String(card.dataset.key || '')));
    });
    updateSelectionStatus();
  }

  function getDisplayedAlbumCards() {
    const root = getActiveTab()?.dom?.albumsGrid || el.albumsGrid;
    return Array.from(root?.querySelectorAll('.album-card') || []);
  }

  function selectAlbumRangeTo(card) {
    const cards = getDisplayedAlbumCards();
    const targetKey = String(card?.dataset?.key || '');
    if (!targetKey) return;
    let start = cards.findIndex(node => String(node.dataset.key || '') === String(albumSelectionAnchor || ''));
    const end = cards.findIndex(node => String(node.dataset.key || '') === targetKey);
    if (end < 0) return;
    if (start < 0) start = end;
    const from = Math.min(start, end), to = Math.max(start, end);
    clearAlbumSelection();
    for (let i = from; i <= to; i++) selectAlbumKey(cards[i].dataset.key);
    albumSelectionAnchor = targetKey;
    applyAlbumSelectionClasses();
  }

  function beginAlbumDrag(e, album) {
    if (viewMode !== 'albums' || !album?.tracks?.length || !e.dataTransfer) return;
    const albums = selectedAlbumKeys.has(String(album.key)) ? selectedAlbumModelsInOrder() : [album];
    const paths = [];
    const seen = new Set();
    for (const a of albums) for (const track of (a?.tracks || [])) {
      const path = String(track?.path || '');
      if (path && !seen.has(path)) { seen.add(path); paths.push(track); }
    }
    if (!paths.length) return;
    activeSelectionScope = 'albums';
    songDragState = { tracks: paths.slice(), preview: null };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', `beehive:${paths.length}`);
    e.dataTransfer.setData('text/uri-list', paths.map(t => `file://${encodeURI(String(t.path))}`).join('\r\n'));
    const preview = makeSongDragPreview(paths);
    songDragState.preview = preview;
    if (preview && e.dataTransfer.setDragImage) {
      e.dataTransfer.setDragImage(preview, 18, Math.min(24, preview.offsetHeight / 2));
      requestAnimationFrame(() => preview.remove());
    }
    try { window.beehive.startNativeFileDrag?.(paths.map(t => String(t.path))); } catch (err) { console.warn('[Beehive] native file drag unavailable:', err); }
  }


  // ---------------- utils ----------------
  function fmtTime(sec) {
    if (!sec || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function albumKey(t) {
    // Spotify album names are not globally unique and older imports could fall
    // back to the synthetic label "Spotify". When the bridge provides the
    // canonical album URI, use it so unrelated Spotify albums can never share
    // one album artwork/card just because their display names match.
    if (isSpotifyTrack(t) && t.albumUri) return `spotify||${String(t.albumUri).toLowerCase()}`;
    return `${(t.albumArtist || t.artist || '').toLowerCase()}||${(t.album || '').toLowerCase()}`;
  }

  // Track/disc values can arrive from different readers as numbers, "10/14",
  // or occasionally small objects. Album ordering must use the numeric first
  // component rather than falling through to the title tie-breaker (which made
  // a renamed "Brain Stew" sort ahead of tracks 1–9).
  function mediaPositionNumber(value) {
    if (value == null) return 0;
    if (typeof value === 'object') {
      const n = Number(value.no ?? value.number ?? value.position ?? 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    const match = String(value).trim().match(/^\s*(\d+)/);
    const n = match ? Number(match[1]) : Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function albumTrackCompare(a, b) {
    return mediaPositionNumber(a?.disk) - mediaPositionNumber(b?.disk)
      || mediaPositionNumber(a?.track) - mediaPositionNumber(b?.track)
      || songCollator.compare(String(a?.title || ''), String(b?.title || ''))
      || songCollator.compare(String(a?.path || ''), String(b?.path || ''));
  }

  // Build one lowercase search index per track so searching a 20k-song library
  // does not repeatedly stringify every metadata field on every keystroke.
  function buildTrackSearchIndex(t) {
    const values = [];
    const add = v => {
      if (v == null) return;
      if (typeof v === 'object') {
        if (Array.isArray(v)) v.forEach(add);
        else Object.values(v).forEach(add);
        return;
      }
      values.push(String(v));
    };
    Object.entries(t || {}).forEach(([key, value]) => {
      if (key === '_searchText' || key === 'covers') return;
      add(value);
    });
    return values.join(' ').toLowerCase();
  }

  function normalizeArtistSearchValue(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function trackMatchesArtistSearch(t) {
    if (!artistSearchTerm) return true;
    const wanted = normalizeArtistSearchValue(artistSearchTerm);
    const artist = normalizeArtistSearchValue(t?.artist);
    const albumArtist = normalizeArtistSearchValue(t?.albumArtist);
    // Artist searches are metadata-only. Match the complete artist field first,
    // but also recognize an individual credit inside a multi-artist field such
    // as "ISOxo, Ninajirachi". Do not search the whole text index: that can
    // pull in unrelated artists whose names merely appear in titles, lyrics,
    // comments, paths, etc.
    const splitCredits = value => value.split(/\s*(?:,|;|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+)\s*/i).filter(Boolean);
    return artist === wanted || albumArtist === wanted
      || splitCredits(artist).includes(wanted)
      || splitCredits(albumArtist).includes(wanted);
  }

  function trackMatchesSearch(t) {
    if (artistSearchTerm) return trackMatchesArtistSearch(t);
    if (!searchTerm) return true;
    if (!t._searchText) t._searchText = buildTrackSearchIndex(t);
    return t._searchText.includes(searchTerm);
  }

  function tracksForCurrentContext() {
    if (specialView === 'playlist' && activePlaylistId) {
      const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
      return pl ? tracksForPlaylist(pl) : [];
    }
    return library.tracks;
  }

  function buildAlbums(tracks) {
    const map = new Map();
    for (const t of tracks) {
      const key = albumKey(t);
      const visual = visualCoverForTrack(t);
      if (!map.has(key)) {
        map.set(key, { key, title: t.album, artist: t.albumArtist || t.artist, year: t.year, cover: visual, artworkUrl: spotifyArtworkUrl(t), covers: t.covers, tracks: [] });
      }
      const a = map.get(key);
      a.tracks.push(t);
      if (!a.cover && visual) { a.cover = visual; a.artworkUrl = spotifyArtworkUrl(t); a.covers = t.covers; }
      if (!a.year && t.year) a.year = t.year;
    }
    const list = Array.from(map.values());
    for (const a of list) {
      a.tracks.sort(albumTrackCompare);
    }
    list.sort((a, b) => (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title));
    return list;
  }

  function normalizeSpotifyArtworkSource(value) {
    const source = String(value || '').trim();
    if (/^spotify:image:/i.test(source)) {
      const id = source.slice('spotify:image:'.length).trim();
      if (/^[A-Za-z0-9_-]+$/.test(id)) return `https://i.scdn.co/image/${id}`;
    }
    return source;
  }

  function coverSrc(coverFile) {
    // Spotify's internal Player metadata uses spotify:image:<id> rather than a
    // browser-ready URL. Convert that provider URI before the generic mbcover:
    // resolver sees it; mbcover is only for Hive's local cached artwork.
    const normalized = normalizeSpotifyArtworkSource(coverFile);
    // Optimistic artwork edits use the freshly downloaded/selected image as a
    // data URL while the background metadata worker embeds it into every file.
    // Keep that preview visible immediately instead of routing the data URL
    // through mbcover:// (which only serves scanner-generated cached covers).
    if (/^(?:https?:\/\/|data:image\/|blob:)/i.test(normalized)) return normalized;
    return window.beehive.coverUrl(normalized) || placeholderCover();
  }

  // Automatic visual artwork is deliberately memory-only. When a currently
  // playing track has no embedded artwork, Beehive may find an online album
  // cover in the background and use its URL for the player visuals. Nothing is
  // written to the audio file, library tags, or artwork cache. The override is
  // discarded for the track as soon as real embedded artwork is available.
  const automaticCoverVisuals = new Map();
  const automaticCoverLookups = new Map();
  const automaticCoverTokens = new Map();
  const automaticCoverNoResults = new Set();
  let queueArtworkWarmupScheduled = false;

  function clearAutomaticCoverVisual(track) {
    const trackPath = String(track?.path || '');
    if (!trackPath) return;
    const current = automaticCoverVisuals.get(trackPath);
    if (current?.startsWith?.('blob:')) { try { URL.revokeObjectURL(current); } catch {} }
    automaticCoverVisuals.delete(trackPath);
    automaticCoverTokens.set(trackPath, (automaticCoverTokens.get(trackPath) || 0) + 1);
    for (const key of automaticCoverLookups.keys()) {
      if (key.startsWith(trackPath + '|')) automaticCoverLookups.delete(key);
    }
    for (const key of automaticCoverNoResults) {
      if (key.startsWith(trackPath + '|')) automaticCoverNoResults.delete(key);
    }
  }

  function embeddedCoverExists(track) {
    return distinctCovers(track).length > 0;
  }

  function visualCoverForTrack(track) {
    if (!track) return null;
    const embedded = distinctCovers(track);
    if (embedded.length) return embedded[0]?.file || track.cover || null;
    const cachedSpotify = spotifyCachedArtworkSrc(track);
    if (cachedSpotify) return cachedSpotify;
    const external = spotifyArtworkUrl(track);
    if (external) return external;
    return automaticCoverVisuals.get(String(track.path || '')) || null;
  }

  function artworkDebug(label, details = null) {
    try {
      const payload = details == null ? '' : ` ${JSON.stringify(details)}`;
      console.info(`[Beehive Artwork Debug ${new Date().toISOString()}] ${label}${payload}`);
    } catch {}
  }

  // Immediately synchronize the currently playing model with the file on disk
  // after artwork is changed by the Tags editor. Without this, the rotator can
  // keep displaying the previous in-memory cover until another playback change.
  // Successful metadata jobs already update the live library/queue optimistically.
  // Do not rescan the changed media here: that used to deserialize/rebuild the
  // entire library and database at the exact moment the final artwork write
  // completed, which could starve the renderer and make GStreamer appear frozen.
  // The next normal scan will pick up the changed mtime; failures are reported
  // separately and are never included in this success-only path list.
  async function reconcileArtworkAfterBackgroundWrite(paths, options = {}) {
    const wanted = [...new Set((Array.isArray(paths) ? paths : [paths]).map(p => String(p || '')).filter(Boolean))];
    if (!wanted.length) return;
    refreshCoverRotationTargets();
  }

  async function syncCurrentTrackArtwork(trackPath) {
    const wantedPath = String(trackPath || '');
    if (!wantedPath) return;
    const current = currentQueue[currentIndex];
    if (!current || String(current.path || '') !== wantedPath) return;
    try {
      const fresh = await window.beehive.readTags(wantedPath);
      const pictures = Array.isArray(fresh?.pictures) ? fresh.pictures : [];
      current.covers = pictures;
      current.cover = pictures.find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)')?.file || pictures[0]?.file || null;
      const libTrack = library.tracks.find(x => String(x?.path || '') === wantedPath);
      if (libTrack) {
        libTrack.covers = pictures;
        libTrack.cover = pictures.find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)')?.file || pictures[0]?.file || null;
      }
      // Any temporary online visual must disappear as soon as the real file is
      // known to have no artwork. refreshCoverRotationTargets() will then paint
      // the normal placeholder rather than retaining the old cover.
      if (!pictures.length) clearAutomaticCoverVisual(current);
      refreshCoverRotationTargets();
      const visual = visualCoverForTrack(current);
      if (visual) applyPaletteFromCover(coverSrc(visual));
      else {
        const backdrop = document.querySelector('.np-cover-stage');
        if (backdrop) backdrop.style.removeProperty('--cover-backdrop');
      }
    } catch (err) {
      artworkDebug('current-track artwork synchronization failed', { path: wantedPath, message: err?.message || String(err) });
    }
  }

  function isPlaceholderAlbum(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return !normalized || new Set(['unknown album','unknown album title','unknown','untitled album','n/a','na','none']).has(normalized);
  }

  async function ensureAutomaticCoverVisual(track) {
    const trackPath = String(track?.path || '');
    if (!trackPath) return;
    artworkDebug('automatic artwork check started', { path: trackPath, title: track?.title || '', album: track?.album || '', artist: track?.artist || '', queueIndex: currentQueue.indexOf(track), queueLength: currentQueue.length });

    // The library/queue object can lag behind the actual file for a moment after
    // artwork is removed externally or by the Tags editor. For this feature the
    // file on disk is authoritative: never start an online lookup until the
    // native metadata reader confirms that the current track truly has no
    // embedded pictures. This also guarantees an automatic result can never
    // override real embedded artwork that was added after the library snapshot.
    let diskHasEmbeddedArtwork = false;
    try {
      diskHasEmbeddedArtwork = !!(await window.beehive.hasEmbeddedArtwork(trackPath));
    } catch {}
    artworkDebug('disk artwork check complete', { path: trackPath, hasEmbeddedArtwork: diskHasEmbeddedArtwork });
    if (diskHasEmbeddedArtwork) {
      artworkDebug('automatic artwork skipped because embedded artwork exists', { path: trackPath });
      clearAutomaticCoverVisual(track);
      return;
    }
    if (embeddedCoverExists(track)) {
      // Cached artwork says a cover exists, but the disk check above says it does
      // not. Clear the stale cached artwork from this playback model so the
      // temporary search is allowed to run rather than being suppressed by an
      // obsolete library snapshot.
      track.cover = null;
      track.covers = [];
    }

    const album = String(track?.album || '').trim();
    const artist = String(track?.albumArtist || track?.artist || '').trim();
    if (isPlaceholderAlbum(album)) {
      clearAutomaticCoverVisual(track);
      return null;
    }
    if (automaticCoverVisuals.has(trackPath)) return automaticCoverVisuals.get(trackPath);
    const key = `${trackPath}|${album}|${artist}`;
    if (automaticCoverNoResults.has(key)) return null;
    if (automaticCoverLookups.has(key)) return automaticCoverLookups.get(key);

    const token = (automaticCoverTokens.get(trackPath) || 0) + 1;
    automaticCoverTokens.set(trackPath, token);
    const lookup = (async () => {
      try {
        artworkDebug('manual-search artwork lookup started', { path: trackPath, album, artist });
        const results = await window.beehive.searchInternetCover({ album, artist });
        artworkDebug('manual-search artwork lookup returned', { path: trackPath, resultCount: Array.isArray(results) ? results.length : 0 });
        if (automaticCoverTokens.get(trackPath) !== token || !currentQueue.some(item => item === track)) return null;
        try { if (await window.beehive.hasEmbeddedArtwork(trackPath)) { clearAutomaticCoverVisual(track); return null; } } catch {}

        // Use the exact same artwork URLs returned by the manual artwork search.
        // The manual picker already proves these URLs are displayable in Chromium,
        // so the automatic path must not introduce a separate Cover Art Archive
        // downloader that can reject a valid result with a false 404. The image is
        // displayed directly from the remote source; Beehive never writes a
        // temporary artwork file to disk and never embeds it.
        for (const item of Array.isArray(results) ? results : []) {
          const remoteUrl = String(item?.artworkUrl || '').trim();
          if (!/^https?:\/\//i.test(remoteUrl)) continue;
          if (automaticCoverTokens.get(trackPath) !== token || !currentQueue.some(item => item === track)) return null;
          try { if (await window.beehive.hasEmbeddedArtwork(trackPath)) { clearAutomaticCoverVisual(track); return null; } } catch {}

          const loaded = await new Promise(resolve => {
            const img = new Image();
            img.decoding = 'async';
            let settled = false;
            const finish = value => { if (!settled) { settled = true; resolve(value); } };
            img.onload = async () => { try { if (img.decode) await img.decode(); } catch {} finish(true); };
            img.onerror = () => finish(false);
            img.src = remoteUrl;
          });
          if (!loaded) continue;
          if (automaticCoverTokens.get(trackPath) !== token || currentQueue[currentIndex] !== track || embeddedCoverExists(track)) return null;

          automaticCoverVisuals.set(trackPath, remoteUrl);
          artworkDebug('automatic artwork image loaded', { album, artist, path: trackPath, source: item?.source || '', url: remoteUrl, resultIndex: Array.isArray(results) ? results.indexOf(item) : -1 });

          // Album-wide queue visual fallback: when one coverless track in an
          // album successfully finds artwork, reuse that same temporary image
          // for the other coverless tracks from the same album. This avoids
          // redundant searches and makes a whole album appear consistently in
          // Playing Tracks. Each peer is still checked against the actual file
          // on disk before receiving the temporary visual, so real embedded
          // artwork always wins.
          const albumKeyForVisual = `${album.toLowerCase()}|${artist.toLowerCase()}`;
          const peers = currentQueue.filter(peer => {
            // IMPORTANT: do not synchronously inspect every peer's audio file here.
            // The old implementation spawned a native tag-helper process for every
            // track in the album at the exact moment playback was starting. On a
            // large album that could create a burst of Python helpers and make the
            // renderer/player unstable. The current playing track was already
            // verified against the file on disk before this point. For other queue
            // rows, the normal scanned embedded-cover model is authoritative unless
            // that row is independently played and rechecked.
            if (!peer || peer === track || embeddedCoverExists(peer)) return false;
            const peerAlbum = String(peer?.album || '').trim();
            const peerArtist = String(peer?.albumArtist || peer?.artist || '').trim();
            return peerAlbum && `${peerAlbum.toLowerCase()}|${peerArtist.toLowerCase()}` === albumKeyForVisual;
          });
          artworkDebug('propagating temporary album artwork to queue peers', { path: trackPath, album, artist, peerCount: peers.length, queueLength: currentQueue.length });
          for (const peer of peers) {
            const peerPath = String(peer?.path || '');
            if (!peerPath) continue;
            automaticCoverVisuals.set(peerPath, remoteUrl);
            const row = el.queueList?.querySelector(`.queue-row[data-idx="${currentQueue.indexOf(peer)}"]`);
            const thumb = row?.querySelector('.q-thumb');
            if (thumb) thumb.src = remoteUrl;
          }

          // The current row participates in the normal player-cover rotation
          // logic; non-current album peers remain static. Keep this as a single
          // repaint after propagation so playback is not interrupted by repeated
          // rotation-target rebuilds.
          artworkDebug('temporary artwork propagation complete', { path: trackPath, peerCount: peers.length, currentIndex });
          refreshCoverRotationTargets();
          const paletteCover = visualCoverForTrack(track);
          if (paletteCover) applyPaletteFromCover(coverSrc(paletteCover));
          const backdrop = document.querySelector('.np-cover-stage');
          if (backdrop) backdrop.style.setProperty('--cover-backdrop', `url("${coverSrc(paletteCover).replace(/"/g, '\\"')}")`);
          return remoteUrl;
        }

      } catch (err) {
        console.error('[Beehive Debug] automatic visual artwork lookup failed', { album, artist, path: trackPath, message: err?.message || String(err), stack: err?.stack });
      }
      automaticCoverNoResults.add(key);
      return null;
    })();
    automaticCoverLookups.set(key, lookup);
    try { return await lookup; } finally {
      automaticCoverLookups.delete(key);
    }
  }

  // Only treat genuinely different embedded images as multiple covers.
  // Scanner-side deduplication normally guarantees this, but keeping the
  // renderer defensive prevents duplicate frames/paths from creating a
  // pointless carousel.
  function distinctCovers(model) {
    const raw = Array.isArray(model?.covers) ? model.covers : [];
    const seen = new Set();
    const out = [];
    const coverFile = model?.cover || null;
    for (const item of raw) {
      if (!item?.file) continue;
      // Scanner-generated covers are SHA1-named. Prefer that content hash when
      // available so the same artwork cannot become two carousel frames just
      // because it was encountered through two tag entries/paths.
      const file = String(item.file);
      const stem = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
      const key = String(item.hash || stem || file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    if (!out.length && coverFile) out.push({ file: coverFile, type: null });

    // Older library records may not have a hash on the cover entries. If the
    // main cover is already one of the listed files, never add it as another
    // image. This is deliberately file/hash based: a single cover means a
    // single lightbox frame, so there is nothing to rotate.
    // The designated Cover (Front) is always the first visual. Artwork array
    // order is not a semantic front/back ordering, so a user swapping the two
    // picture types must immediately see the newly designated front cover in
    // Sandbox, the playbar, album cards, and expanded album artwork.
    const frontIndex = out.findIndex(item => normalizeArtworkType(item?.type || 'Other') === 'Cover (Front)');
    if (frontIndex > 0) {
      const [front] = out.splice(frontIndex, 1);
      out.unshift(front);
    }
    // Only fall back to the legacy track.cover hint when there is no explicit
    // Cover (Front) type. Otherwise an older cached track.cover could undo the
    // front-cover ordering immediately after a front/back type swap.
    if (frontIndex < 0 && coverFile && out.length > 1) {
      const coverName = String(coverFile).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
      const coverIndex = out.findIndex(item => {
        const f = String(item.file || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
        return f === coverName || String(item.hash || '').toLowerCase() === coverName;
      });
      if (coverIndex > 0) {
        const [first] = out.splice(coverIndex, 1);
        out.unshift(first);
      }
    }
    return out;
  }

  let placeholderCache = null;
  function placeholderCover() {
    if (placeholderCache) return placeholderCache;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='100%' height='100%' fill='%231c1c22'/><text x='50%' y='55%' font-size='60' text-anchor='middle' fill='%233a3a44' font-family='sans-serif'>♪</text></svg>`;
    placeholderCache = `data:image/svg+xml;utf8,${svg}`;
    return placeholderCache;
  }

  // Use the same no-artwork image for an idle player as for tracks without
  // embedded cover art, rather than leaving the browser's broken-image icon.
  if (el.pbCover) el.pbCover.src = placeholderCover();
  if (el.npCover) el.npCover.src = placeholderCover();

  // ---------------- rendering: sidebar folders ----------------
  function tracksForFolder(folder) {
    const root = String(folder || '').replace(/[\\/]$/, '').toLowerCase();
    if (!root) return [];
    return library.tracks.filter(t => {
      const path = String(t?.path || '').toLowerCase();
      return path === root || path.startsWith(root + '/') || path.startsWith(root + '\\');
    });
  }

  let sidebarFolderTooltip = null;
  function ensureSidebarFolderTooltip() {
    if (sidebarFolderTooltip) return sidebarFolderTooltip;
    sidebarFolderTooltip = document.createElement('div');
    sidebarFolderTooltip.className = 'beehive-tooltip sidebar-folder-tooltip';
    document.body.appendChild(sidebarFolderTooltip);
    return sidebarFolderTooltip;
  }
  function showSidebarFolderTooltip(_item, folder, e) {
    const tip = ensureSidebarFolderTooltip();
    tip.textContent = String(folder || '');
    if (e) lastSidebarFolderPointer = { x: e.clientX, y: e.clientY };
    tip.classList.add('visible');
    requestAnimationFrame(() => moveSidebarFolderTooltip(lastSidebarFolderPointer));
  }
  let lastSidebarFolderPointer = { x: 0, y: 0 };
  function moveSidebarFolderTooltip(e) {
    if (!e) return;
    lastSidebarFolderPointer = { x: e.clientX, y: e.clientY };
    if (!sidebarFolderTooltip?.classList.contains('visible')) return;
    const r = sidebarFolderTooltip.getBoundingClientRect();
    sidebarFolderTooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, e.clientX + 14))}px`;
    sidebarFolderTooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, e.clientY + 16))}px`;
  }
  function hideSidebarFolderTooltip() { sidebarFolderTooltip?.classList.remove('visible'); }

  const FOLDER_ICON = '🗀\ufe0e';
  function folderNavKey(folder) { return `folder:${String(folder || '')}`; }
  async function refreshFolders() {
    const config=await window.beehive.getConfig(); el.folderList.innerHTML='';
    for(const folder of (config.folders||[])){
      const div=document.createElement('div'); div.className='sidebar-item sidebar-folder-item'; div.dataset.folder=folder;
      const icon=document.createElement('span'); icon.className='sidebar-nav-icon sidebar-folder-icon'; icon.textContent=sidebarNavigation?.meta?.[folderNavKey(folder)]?.icon||FOLDER_ICON;
      const label=document.createElement('span'); label.textContent=folder.split(/[\\/]/).filter(Boolean).pop()||folder; div.append(icon,label);
      div.addEventListener('mouseenter',e=>showSidebarFolderTooltip(div,folder,e)); div.addEventListener('mouseleave',hideSidebarFolderTooltip); div.addEventListener('mousemove',e=>moveSidebarFolderTooltip(e));
      div.addEventListener('click',e=>{if(e.button!==undefined&&e.button!==0)return;rememberMusicBrowserState();activeFolderPath=folder;specialView='folder';artistSearchTerm='';searchTerm='';el.search.value='';el.main.classList.remove('searching');openAlbumKey=null;el.sidebarItems.forEach(i=>i.classList.remove('active'));el.folderList.querySelectorAll('.sidebar-item').forEach(i=>i.classList.remove('active'));div.classList.add('active');viewMode='songs';el.viewBtns.forEach(b=>b.classList.toggle('active',b.dataset.mode==='songs'));applySidebarAutoShuffle(folderNavKey(folder));renderMusicViewer(folder.split(/[\\/]/).filter(Boolean).pop()||folder,tracksForFolder(folder),'folder');saveActiveTabState();updateActiveTabLabel();});
      div.addEventListener('contextmenu',e=>{
        e.preventDefault();
        e.stopPropagation();
        const folderTracks = tracksForFolder(folder);
        const folderName = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
        showContextMenu(e.clientX,e.clientY,[
          { label:'Rescan library', action:()=>runScan(true) },
          { label:'Play library', action:()=>playQueue(folderTracks,0) },
          { label:'Queue library', action:()=>addTracksToQueue(folderTracks) },
          { label:'Library Info', action:()=>showSidebarListInfo({key:folderNavKey(folder),name:folderName,description:folder,tracks:folderTracks,folder}) }
        ]);
      });
      el.folderList.appendChild(div);
    }
    const add=document.createElement('button');add.type='button';add.className='sidebar-add sidebar-library-add';add.textContent='+ Library';add.title='Add a music library folder';add.addEventListener('click',async()=>{const next=await window.beehive.addFolder();if(!next)return;await refreshFolders();await runScan(false);});el.folderList.appendChild(add);
  }

  function hideContentViews(){ stopNowPlayingSpectrum(); document.body.classList.remove('sandbox-mode'); [el.emptyState,el.tabPlaceholder,el.albumsToolbar,el.albumsGrid,el.songsTable,el.artistsGrid,el.contentTools].forEach(x=>x.classList.add('hidden')); }
  function ratingStars(t, interactive = true) {
    // MusicBee MP3 ratings are stored in POPM. Treat the raw 255 value as the
    // authoritative 5-star state so older cached library entries cannot hide it.
    const raw = Number(t?.ratingRaw);
    const rating = raw === 255 ? 5 : Math.max(0, Math.min(5, Number(t?.rating) || 0));
    if (rating <= 0) return '<span class="rating-stars rating-none" title="Rating: 0/5"></span>';
    const stars = Array.from({length: 5}, (_, i) => {
      const starValue = i + 1;
      const state = rating >= starValue ? 'filled' : (rating >= starValue - 0.5 ? 'half' : 'empty');
      return `<span class="rating-star ${state}" data-star="${starValue}" ${interactive ? '' : 'aria-hidden="true"'}>★</span>`;
    }).join('');
    return `<span class="rating-stars" title="Rating: ${rating % 1 ? rating.toFixed(1) : rating}/5">${stars}</span>`;
  }

  // Serialized per-path, mirroring loveWriteQueue: rapid re-clicks on the same
  // track's stars queue their disk writes in order instead of racing.
  const ratingWriteQueue = new Map();
  function queueRatingFileWrite(trackPath, rating) {
    const filePath = String(trackPath || '');
    if (!filePath) return Promise.resolve(0);
    const previous = ratingWriteQueue.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          const value = await window.beehive.setRating(filePath, rating);
          resolve(value);
        } catch (err) {
          console.warn('Rating write failed:', err);
          reject(err);
        }
      }, 0);
    }));
    ratingWriteQueue.set(filePath, next.finally(() => {
      if (ratingWriteQueue.get(filePath) === next) ratingWriteQueue.delete(filePath);
    }));
    return next;
  }

  function applyRatingToTrackModel(t, value) {
    const normalizedPath = String(t.path);
    // Always update the canonical library object. Some views (Favorites,
    // History, playlists) render from filtered arrays, so updating only the
    // clicked view object can make the new rating appear to make the song
    // vanish or revert on the next render.
    const libTrack = libraryTrackByPath.get(normalizedPath);
    if (libTrack) {
      libTrack.rating = value;
      libTrack.ratingRaw = value >= 5 ? 255 : 0;
      libTrack.ratingHydrated = true;
    }
    t.rating = value;
    t.ratingRaw = value >= 5 ? 255 : 0;
    t.ratingHydrated = true;
  }

  async function setTrackRating(t, rating, shouldRender = true) {
    if (!t?.path) return;
    const value = Math.max(0, Math.min(5, Number(rating) || 0));
    const oldValue = Number(t.rating) || 0;
    const normalizedPath = String(t.path);

    // Rating is intentionally optimistic, exactly like Love: update the
    // in-memory model and visible stars immediately, then write the embedded
    // tag in the background. This matters even more for rating than for Love,
    // because the write path waits for the currently-playing track's file to
    // be released by the native player before it can safely touch the file --
    // rating the song you're actively listening to would otherwise leave the
    // stars visually unresponsive until you skip to another track.
    applyRatingToTrackModel(t, value);
    const renderRatingUi = () => {
      // If rating is the active sort, rebuild because the row's position may
      // legitimately change. Otherwise update the visible rating cell in place
      // so rating a song never causes the current list to jump or disappear.
      if (songSort.key === 'rating') {
        if (shouldRender) renderCurrentView();
        return;
      }
      const row = el.songsTable?.querySelector(`.song-row[data-path=\"${CSS.escape(normalizedPath)}\"]`);
      const cell = row?.querySelector('.s-rating');
      if (cell) {
        cell.innerHTML = ratingStars(t);
        bindRatingClicks(cell, [t]);
      } else {
        renderCurrentView();
      }
    };
    renderRatingUi();

    queueRatingFileWrite(t.path, value).catch(err => {
      applyRatingToTrackModel(t, oldValue);
      renderRatingUi();
      console.warn('Rating write failed; reverted optimistic rating state:', err);
    });
  }

  function syncLoveStateForPath(trackPath, loved) {
    const normalizedPath = String(trackPath || '');
    if (!normalizedPath) return;
    const value = !!loved;

    // Most derived album/artist collections contain the same canonical track
    // objects as libraryTrackByPath. Updating that object therefore updates all
    // derived views without walking the entire library, every album, and every
    // artist entry. The old nested traversal made a single heart click scale with
    // the size of the whole library rather than with the number of affected queue
    // objects.
    const canonical = libraryTrackByPath.get(normalizedPath);
    if (canonical) canonical.loved = value;
    for (const track of (currentQueue || [])) {
      if (track && String(track.path || '') === normalizedPath) track.loved = value;
    }
    for (const track of (activeSelectionTracks || [])) {
      if (track && String(track.path || '') === normalizedPath) track.loved = value;
    }
    const nowPlaying = window.__beehiveNowPlayingTrack;
    if (nowPlaying && String(nowPlaying.path || '') === normalizedPath) nowPlaying.loved = value;
    const current = currentQueue[currentIndex];
    if (current && String(current.path || '') === normalizedPath) {
      el.btnLove.innerHTML = (value ? ic.heartFilled : ic.heartOutline) || '';
      el.btnLove.classList.toggle('loved', value);
      el.btnLove.setAttribute('aria-pressed', value ? 'true' : 'false');
      el.btnLove.title = value ? 'Unlove' : 'Love';
    }
  }

  // Keep Love writes serialized per file, but let the UI update immediately.
  // This is the behavior of the old stable Beehive build: the heart/Favorites
  // state changes instantly while the embedded tag write happens off the render
  // path. The main process still performs the real disk write and verification.
  const loveWriteQueue = new Map();
  let favoriteTimestampSaveQueue = Promise.resolve();
  function queueFavoriteTimestampSave(starPlaylist) {
    if (!starPlaylist?.id) return Promise.resolve(null);
    const snapshot = { ...starPlaylist, favoriteAddedAt: { ...(starPlaylist.favoriteAddedAt || {}) } };
    favoriteTimestampSaveQueue = favoriteTimestampSaveQueue.catch(() => {}).then(async () => {
      const updated = await window.beehive.savePlaylist(snapshot);
      if (updated?.id != null) {
        const index = playlists.findIndex(p => String(p.id) === String(updated.id));
        if (index >= 0) playlists[index] = updated;
      }
      return updated;
    });
    return favoriteTimestampSaveQueue;
  }
  function queueLoveFileWrite(trackPath, loved) {
    const filePath = String(trackPath || '');
    if (!filePath) return Promise.resolve(true);
    const previous = loveWriteQueue.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          await window.beehive.toggleLove(filePath, !!loved);
          resolve(true);
        } catch (err) {
          console.warn('Love tag write failed:', err);
          reject(err);
        }
      }, 0);
    }));
    loveWriteQueue.set(filePath, next.finally(() => {
      if (loveWriteQueue.get(filePath) === next) loveWriteQueue.delete(filePath);
    }));
    return next;
  }

  async function setTrackLove(t, loved, shouldRender = true) {
    if (!t?.path) return false;
    const value = !!loved;
    const oldValue = !!t.loved;
    if (oldValue === value) return value;

    // Love is intentionally optimistic: update Beehive's canonical in-memory
    // library and Favorites immediately, then write the embedded tag in the
    // background. The physical file remains the durable source of truth, but
    // the UI must never make the user wait for file I/O just to see a song
    // become Loved/Favorited.
    syncLoveStateForPath(t.path, value);
    const starPlaylist = starFavoritesPlaylist();
    if (starPlaylist) {
      starPlaylist.favoriteAddedAt = { ...(starPlaylist.favoriteAddedAt || {}) };
      if (value) starPlaylist.favoriteAddedAt[String(t.path)] = Date.now();
      else delete starPlaylist.favoriteAddedAt[String(t.path)];
      // This is a tiny playlist metadata update, not a media-file write. Keep it
      // independent of the Love tag worker so Favorites order is durable even
      // while the audio tag is being written in the background.
      void queueFavoriteTimestampSave(starPlaylist).catch(err => console.warn('Could not persist Favorite-added time:', err));
    }
    if (value && !library.tracks.some(track => String(track?.path || '') === String(t.path))) {
      library.tracks.push(t);
      libraryTrackByPath.set(String(t.path), t);
    }

    // The metadata worker is serialized per file and runs outside the current
    // render interaction. Favorites does not wait for this promise. If the
    // write fails, roll the optimistic state back and refresh the visible view.
    queueLoveFileWrite(t.path, value).catch(err => {
      syncLoveStateForPath(t.path, oldValue);
      console.warn('Love tag write failed; reverted optimistic Love state:', err);
    });
    return value;
  }

  // Apply a Love/rating command to a multi-selection without changing the
  // normal single-track behavior. Work in small batches so a selection of
  // hundreds or thousands of files does not flood the IPC/file-writer queue.
  async function applyBulkTrackAction(tracks, action) {
    const list = Array.isArray(tracks) ? tracks.filter(t => t?.path) : [];
    if (!list.length) return;
    const batchSize = 8;
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      await Promise.all(batch.map(t => action(t)));
    }
    renderCurrentView();
  }

  async function applyBulkRating(paths, rating) {
    const list = [...new Set((paths || []).filter(Boolean).map(String))];
    if (!list.length) return;
    const value = Math.max(0, Math.min(5, Number(rating) || 0));
    // Optimistic, like single-track setTrackRating: the bulk IPC call writes
    // files one at a time in the main process and can block on a single
    // currently-playing track's playback-protection wait. Blocking every
    // selected row's visible rating on that one write would stall the whole
    // selection's UI for as long as that song keeps playing.
    const previousByPath = new Map();
    for (const track of library.tracks) {
      const p = String(track?.path || '');
      if (!list.includes(p)) continue;
      previousByPath.set(p, { rating: track.rating, ratingRaw: track.ratingRaw, ratingHydrated: track.ratingHydrated });
      track.rating = value;
      track.ratingRaw = value >= 5 ? 255 : 0;
      track.ratingHydrated = true;
    }
    renderCurrentView();
    setTimeout(async () => {
      const result = await window.beehive.setRatings(list, rating);
      if (result?.failed) {
        console.warn('Some bulk rating writes failed:', result.errors);
        const failedPaths = new Set((result.errors || []).map(e => String(e?.path || '')));
        for (const track of library.tracks) {
          const p = String(track?.path || '');
          if (!failedPaths.has(p)) continue;
          const prev = previousByPath.get(p);
          if (prev) Object.assign(track, prev);
        }
        renderCurrentView();
      }
    }, 0);
  }


  function bindRatingClicks(container, tracks) {
    container.querySelectorAll('.rating-star').forEach(star => star.addEventListener('click', e => {
      e.stopPropagation();
      const row = star.closest('.song-row');
      const path = row?.dataset.path;
      const t = tracks.find(x => String(x?.path || '') === String(path || ''));
      if (!t) return;
      const rect = star.getBoundingClientRect();
      const half = e.clientX < rect.left + rect.width / 2;
      const value = Number(star.dataset.star) - (half ? 0.5 : 0);
      setTrackRating(t, value);
    }));
  }

  function searchFor(value) {
    artistSearchTerm = '';
    searchTerm = String(value || '').trim().toLowerCase();
    el.search.value = value || '';
    specialView = null;
    el.main.classList.remove('searching');
    setView('songs');
    saveActiveTabState();
    updateActiveTabLabel();
  }

  function renderCurrentView() {
    if (specialView === 'history') {
      window.beehive.getHistory().then(h => renderSpecialSongs(historyTracks(h || [])));
      return;
    }
    if (specialView === 'recent') { const t=getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100); return viewMode==='albums'?renderSpecialAlbums(t):renderSpecialSongs(t); }
    if (specialView === 'top') { const t=[...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25); return viewMode==='albums'?renderSpecialAlbums(t):renderSpecialSongs(t); }
    if (specialView === 'folder' && activeFolderPath) {
      const t = tracksForFolder(activeFolderPath);
      return viewMode === 'albums' ? renderSpecialAlbums(t) : renderSpecialSongs(t);
    }
    if (specialView === 'playlist' && activePlaylistId) {
      const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
      if (pl) return renderMusicViewer(playlistLabel(pl), tracksForPlaylist(pl), 'playlist');
    }
    setView(viewMode);
  }

  function historyTracks(entries) {
    return (Array.isArray(entries) ? entries : [])
      .slice()
      .sort((a,b) => Number(b.playedAt || 0) - Number(a.playedAt || 0))
      .map(x => {
        const found = libraryTrackByPath.get(String(x.path || ''));
        if (found) return {...found, historyPlayedAt: Number(x.playedAt || 0)};
        return { path:x.path, source:x.source || '', spotifyUri:x.spotifyUri || '', title:x.title || x.path?.split(/[\\/]/).pop() || 'Unknown track', artist:x.artist || 'Unknown Artist', album:x.album || 'Unknown Album', cover:x.cover || x.artworkUrl || null, artworkUrl:x.artworkUrl || x.cover || '', rating:0, playCount:0, duration:0, historyPlayedAt:Number(x.playedAt || 0) };
      });
  }

  function formatTrackNumber(t) {
    const n = Number(t?.track);
    if (!Number.isFinite(n) || n <= 0) return '';
    const total = Number(t?.trackCount);
    return Number.isFinite(total) && total > 0 ? `${n}/${total}` : String(n);
  }

  function formatDiscNumber(t) {
    const n = Number(t?.disc);
    if (!Number.isFinite(n) || n <= 0) return '';
    const total = Number(t?.discCount);
    return Number.isFinite(total) && total > 0 ? `${n}/${total}` : String(n);
  }

  function formatBitrate(t) {
    const n = Number(t?.bitrate);
    if (!Number.isFinite(n) || n <= 0) return '';
    return `${Math.round(n / 1000)} kbps`;
  }

  function formatSampleRate(t) {
    const n = Number(t?.sampleRate);
    if (!Number.isFinite(n) || n <= 0) return '';
    return `${Math.round(n / 1000)} kHz`;
  }

  function formatDateAdded(t) {
    const n = Number(t?.addedAt);
    if (!Number.isFinite(n) || n <= 0) return '';
    try { return new Date(n).toLocaleDateString(); } catch { return ''; }
  }

  function formatFolder(t) {
    const path = String(t?.path || '');
    const parts = path.split(/[\\/]/);
    parts.pop();
    return parts.join('/');
  }

  function loadSongColumns() {
    const defaults = SONG_COLUMN_DEFS.slice(0, 6).map(d => d.key);
    try {
      const saved = JSON.parse(localStorage.getItem(SONG_COLUMNS_KEY) || 'null');
      const keys = Array.isArray(saved?.keys) ? saved.keys.filter(k => SONG_COLUMN_DEFS.some(d => d.key === k)) : defaults;
      const unique = [...new Set(keys)];
      // The position column is the stable left-edge index for the song list. Older
      // saved column layouts could predate it, which made automatic fitting look
      // like it had swallowed the # column and gave the rightmost visible column
      // (usually Plays) too much horizontal room. Preserve every user's chosen
      // column set, but migrate the legacy/default layout by restoring # first.
      if (!unique.includes('position')) unique.unshift('position');
      const widths = {};
      for (const def of SONG_COLUMN_DEFS) {
        const n = Number(saved?.widths?.[def.key]);
        widths[def.key] = Number.isFinite(n) ? Math.max(def.minWidth, Math.round(n)) : def.defaultWidth;
      }
      // The Music track list always fits its columns to the visible Music viewer.
      // Keep the legacy preference readable for migration, but never restore the
      // old overflowing/non-fit mode from older builds.
      songColumnsFitToScreen = true;
      return { keys: unique.length ? unique : defaults, widths };
    } catch {
      songColumnsFitToScreen = true;
      return { keys: defaults, widths: Object.fromEntries(SONG_COLUMN_DEFS.map(d => [d.key, d.defaultWidth])) };
    }
  }

  function saveSongColumns() {
    // Fit-to-viewer is the permanent Music-list layout invariant. Keep the key
    // for compatibility with older settings, but always persist the safe default.
    try { localStorage.setItem(SONG_COLUMNS_KEY, JSON.stringify({ ...songColumns, fitToScreen: true })); } catch {}
  }

  function songColumnDef(key) { return SONG_COLUMN_DEFS.find(d => d.key === key) || null; }

  function fitSongColumnsToScreen({ persist = true } = {}) {
    if (!el.songsTable || !songColumns.keys.length) return;

    // Grid track widths describe only the grid's content box. The song header/rows
    // also have horizontal padding and gaps between grid tracks. The old fitter
    // allocated the entire table width to the tracks, so the padding + gaps were
    // added on top and the rightmost column crossed the Music viewer boundary.
    // Measure the actual layout values so the final grid consumes exactly the
    // usable content width.
    const sample = el.songsTable.querySelector('.song-row, .song-header');
    const computed = sample ? getComputedStyle(sample) : null;
    const paddingLeft = Number.parseFloat(computed?.paddingLeft || '10') || 0;
    const paddingRight = Number.parseFloat(computed?.paddingRight || '10') || 0;
    const gap = Number.parseFloat(computed?.columnGap || computed?.gap || '12') || 0;
    const trackCount = songColumns.keys.length;
    const horizontalExtras = paddingLeft + paddingRight + Math.max(0, trackCount - 1) * gap;
    const available = Math.max(0, el.songsTable.clientWidth - horizontalExtras);
    if (!available) return;

    const defs = songColumns.keys.map(songColumnDef).filter(Boolean);
    const minimumTotal = defs.reduce((sum, def) => sum + def.minWidth, 0);
    const widths = {};

    if (available < minimumTotal) {
      // The Music viewer must never create a horizontal spill past its scrollbar.
      // When the normal minimums cannot all fit, scale them proportionally to the
      // actual viewport. This is preferable to introducing a second horizontal
      // scrolling surface into the track list.
      const scale = available / Math.max(1, minimumTotal);
      const raw = defs.map(def => Math.max(28, def.minWidth * scale));
      const rounded = raw.map(n => Math.max(28, Math.floor(n)));
      let remainder = available - rounded.reduce((sum, n) => sum + n, 0);
      const order = raw.map((n, i) => ({ i, fraction: n - Math.floor(n) }))
        .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
      for (let cursor = 0; remainder > 0 && order.length; cursor++, remainder--) {
        rounded[order[cursor % order.length].i] += 1;
      }
      defs.forEach((def, i) => { widths[def.key] = rounded[i]; });
    } else {
      // Treat the current widths as weights so a user's preferred proportions
      // survive a window resize. Scale once, then distribute rounding error
      // deterministically so the columns consume the viewport exactly.
      const weights = defs.map(def => Math.max(def.minWidth, Number(songColumns.widths[def.key]) || def.defaultWidth));
      const totalWeight = weights.reduce((sum, n) => sum + n, 0) || 1;
      const raw = defs.map((def, i) => Math.max(def.minWidth, available * weights[i] / totalWeight));
      const rounded = raw.map((n, i) => Math.max(defs[i].minWidth, Math.floor(n)));
      let remainder = available - rounded.reduce((sum, n) => sum + n, 0);
      const order = raw.map((n, i) => ({ i, fraction: n - Math.floor(n) }))
        .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
      for (let cursor = 0; remainder > 0 && order.length; cursor++, remainder--) {
        rounded[order[cursor % order.length].i] += 1;
      }
      defs.forEach((def, i) => { widths[def.key] = rounded[i]; });
    }

    Object.assign(songColumns.widths, widths);
    if (persist) saveSongColumns();
    applySongColumnGrid();
  }

  function scheduleSongColumnGridApply() {
    if (songColumnsApplyRaf) return;
    songColumnsApplyRaf = requestAnimationFrame(() => {
      songColumnsApplyRaf = 0;
      if (songColumnsPendingWidths) {
        Object.assign(songColumns.widths, songColumnsPendingWidths);
        songColumnsPendingWidths = null;
      }
      applySongColumnGrid();
    });
  }

  function applySongColumnGrid() {
    if (!el.songsTable) return;
    // Fit-to-viewer is a hard layout invariant. Do not re-apply the editor
    // minimums here: when the viewport is narrower than the sum of normal
    // minimums, fitSongColumnsToScreen deliberately produces smaller tracks.
    // Clamping them back to minWidth here was the reason the previous fitter
    // still overflowed/clipped the rightmost columns in narrow viewers.
    const widths = songColumns.keys.map(key => {
      const def = songColumnDef(key);
      const raw = Number(songColumns.widths[key]);
      const floor = songColumnsFitToScreen ? 1 : (def?.minWidth || 40);
      return `${Math.max(floor, Number.isFinite(raw) ? raw : (def?.defaultWidth || 80))}px`;
    });
    const total = widths.reduce((sum,w)=>sum + parseFloat(w),0);
    el.songsTable.style.setProperty('--song-grid', widths.join(' '));
    el.songsTable.classList.toggle('song-table-scrollable', !songColumnsFitToScreen && total > el.songsTable.clientWidth + 1);
  }

  function scheduleFitSongColumnsToScreen() {
    if (songColumnsFitRaf) return;
    songColumnsFitRaf = requestAnimationFrame(() => {
      songColumnsFitRaf = 0;
      if (songColumnsFitToScreen && !el.songsTable?.classList.contains('hidden')) {
        fitSongColumnsToScreen({ persist: false });
      }
    });
  }

  function resetSongColumnWidths() {
    songColumnsFitToScreen = true;
    for (const def of SONG_COLUMN_DEFS) songColumns.widths[def.key] = def.defaultWidth;
    fitSongColumnsToScreen({ persist: false });
    saveSongColumns();
  }

  function setSongColumnsFitToScreen(_enabled = true) {
    // Fit-to-viewer is an invariant for the main Music track list. Keep the
    // preference key for backwards compatibility, but do not allow a mode that
    // can make the table wider than the visible viewer.
    songColumnsFitToScreen = true;
    fitSongColumnsToScreen({ persist: false });
    saveSongColumns();
    scheduleSongColumnGridApply();
  }

  function ensureSongColumnResizeObserver() {
    if (!el.songsTable || typeof ResizeObserver === 'undefined') return;
    if (!songColumnsResizeObserver) {
      songColumnsResizeObserver = new ResizeObserver(() => {
        if (songColumnsFitToScreen && !el.songsTable.classList.contains('hidden')) {
          scheduleFitSongColumnsToScreen();
        } else {
          scheduleSongColumnGridApply();
        }
      });
    }
    // Each Music tab owns its own songs table. Rebind the single observer to
    // whichever table is currently active; otherwise switching Music ->
    // Favorites -> Music could leave column fitting attached to a hidden tab.
    songColumnsResizeObserver.disconnect();
    songColumnsResizeObserver.observe(el.songsTable);
  }

  function showSongColumnMenu(x, y) {
    const submenu = SONG_COLUMN_DEFS.map(def => ({
      label: def.label,
      active: songColumns.keys.includes(def.key),
      action: () => {
        const next = songColumns.keys.includes(def.key)
          ? songColumns.keys.filter(k => k !== def.key)
          : [...songColumns.keys, def.key];
        if (!next.length) return;
        songColumns.keys = next;
        saveSongColumns();
        renderCurrentView();
      }
    }));
    showContextMenu(x, y, [
      { label:'Columns', submenu },
      { label:'Reset column widths', action:() => { resetSongColumnWidths(); renderCurrentView(); } }
    ]);
  }

  function bindSongHeaderResizer(handle, key) {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      const index = songColumns.keys.indexOf(key);
      if (index < 0) return;
      const nextKey = songColumns.keys[index + 1];
      const def = songColumnDef(key);
      const nextDef = songColumnDef(nextKey);
      if (!def) return;
      const startX = e.clientX;
      songColumnsFitToScreen = true;
      const startWidth = Number(songColumns.widths[key]) || def.defaultWidth;
      const nextStartWidth = nextKey ? (Number(songColumns.widths[nextKey]) || nextDef.defaultWidth) : 0;
      const maxFirst = nextKey ? startWidth + Math.max(0, nextStartWidth - nextDef.minWidth) : Infinity;
      let latestWidths = null;
      const onMove = ev => {
        const delta = ev.clientX - startX;
        const width = Math.max(def.minWidth, Math.min(maxFirst, Math.round(startWidth + delta)));
        latestWidths = { [key]: width };
        if (nextKey) latestWidths[nextKey] = Math.max(nextDef.minWidth, Math.round(nextStartWidth - (width - startWidth)));
        songColumnsPendingWidths = latestWidths;
        scheduleSongColumnGridApply();
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('song-column-resizing');
        if (latestWidths) Object.assign(songColumns.widths, latestWidths);
        songColumnsPendingWidths = null;
        // Preserve the user's new proportions, then normalize the complete grid
        // back to the exact viewer width so the right edge cannot cross the scrollbar.
        fitSongColumnsToScreen({ persist: false });
        saveSongColumns();
      };
      document.body.classList.add('song-column-resizing');
      document.addEventListener('pointermove', onMove, { passive:true });
      document.addEventListener('pointerup', onUp, { once:true });
      document.addEventListener('pointercancel', onUp, { once:true });
      handle.setPointerCapture?.(e.pointerId);
    });
  }

  function favoriteAddedAtForTrack(pl, track) {
    const key = String(track?.path || '');
    const value = Number(pl?.favoriteAddedAt?.[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function sortFavoritesByAddedAt(tracks, pl) {
    const out = [...tracks];
    out.sort((a, b) => {
      const av = favoriteAddedAtForTrack(pl, a);
      const bv = favoriteAddedAtForTrack(pl, b);
      const delta = av - bv;
      if (delta) return delta * songSort.dir;
      const title = songCollator.compare(String(a?.title || ''), String(b?.title || ''));
      if (title) return title * songSort.dir;
      return songCollator.compare(String(a?.path || ''), String(b?.path || '')) * songSort.dir;
    });
    return out;
  }

  function sortTracks(tracks) {
    const out = [...tracks];
    const key = songSort.key;
    if (!key || key === 'position') {
      if (key === 'position' && specialView === 'playlist' && activePlaylistId) {
        const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
        if (pl?.systemKey === 'star-favorites' || pl?.id === 'hive-star-favorites') return sortFavoritesByAddedAt(out, pl);
      }
      if (key === 'position' && songSort.dir === -1) out.reverse();
      return out;
    }
    const def = songColumnDef(key);
    if (!def) return out;
    const sortValue = t => {
      try { return def.sortGet ? def.sortGet(t) : def.get?.(t) ?? ''; }
      catch { return def.type === 'number' ? 0 : ''; }
    };
    const tieBreak = (a, b) => {
      const title = songCollator.compare(String(a?.title || ''), String(b?.title || ''));
      if (title) return title;
      const artist = songCollator.compare(String(a?.artist || ''), String(b?.artist || ''));
      if (artist) return artist;
      return songCollator.compare(String(a?.album || ''), String(b?.album || ''));
    };
    out.sort((a, b) => {
      if (def.type === 'number') {
        const av = Number(sortValue(a));
        const bv = Number(sortValue(b));
        const aNum = Number.isFinite(av) ? av : 0;
        const bNum = Number.isFinite(bv) ? bv : 0;
        const delta = aNum - bNum;
        return delta ? delta * songSort.dir : tieBreak(a, b) * songSort.dir;
      }
      if (def.type === 'string') {
        const delta = songCollator.compare(String(sortValue(a)), String(sortValue(b)));
        return delta ? delta * songSort.dir : tieBreak(a, b) * songSort.dir;
      }
      return 0;
    });
    return out;
  }

  function songHeader() {
    const cells = songColumns.keys.map((key, index) => {
      const def = songColumnDef(key);
      if (!def) return '';
      const isLast = index === songColumns.keys.length - 1;
      return `<div class="song-header-cell" data-column="${def.key}" draggable="true" title="Drag to reposition ${escapeHtml(def.label)}"><button type="button" draggable="false" class="song-header-btn ${songSort.key===key?'active':''}" data-sort="${def.key}" title="Sort by ${escapeHtml(def.label)}">${escapeHtml(def.label)}${songSort.key===key?(songSort.dir===1?' ↑':' ↓'):''}</button>${isLast?'':`<span class="song-column-resizer" data-column-resize="${def.key}" title="Drag to resize column"></span>`}</div>`;
    }).join('');
    return `<div class="song-header">${cells}</div>`;
  }

  function reorderSongColumn(sourceKey, targetKey, placeAfter = false) {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return false;
    const current = songColumns.keys.slice();
    const sourceIndex = current.indexOf(sourceKey);
    const targetIndex = current.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return false;
    current.splice(sourceIndex, 1);
    let insertAt = current.indexOf(targetKey);
    if (insertAt < 0) return false;
    if (placeAfter) insertAt += 1;
    current.splice(insertAt, 0, sourceKey);
    if (current.join('|') === songColumns.keys.join('|')) return false;
    songColumns.keys = current;
    saveSongColumns();
    renderCurrentView();
    return true;
  }

  function bindSongHeaderColumnReordering(header) {
    if (!header) return;
    let draggedKey = '';
    const clearDropIndicators = () => {
      header.querySelectorAll('.song-header-cell.song-column-drop-before, .song-header-cell.song-column-drop-after')
        .forEach(cell => cell.classList.remove('song-column-drop-before', 'song-column-drop-after'));
    };

    header.querySelectorAll('.song-header-cell[draggable="true"]').forEach(cell => {
      cell.addEventListener('dragstart', e => {
        // Sorting buttons live inside draggable header cells. Chromium can arm
        // the ancestor's native drag gesture after an earlier sort/render,
        // which makes later header clicks disappear into dragstart. A button
        // interaction is never a column reorder.
        if (e.target?.closest?.('.song-header-btn')) {
          e.preventDefault();
          return;
        }
        // A resize handle is its own interaction; never turn a resize into a
        // column reorder.
        if (e.target?.closest?.('[data-column-resize]')) {
          e.preventDefault();
          return;
        }
        draggedKey = cell.dataset.column || '';
        if (!draggedKey) { e.preventDefault(); return; }
        cell.classList.add('song-column-dragging');
        e.dataTransfer?.setData('text/plain', draggedKey);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      cell.addEventListener('dragend', () => {
        draggedKey = '';
        cell.classList.remove('song-column-dragging');
        clearDropIndicators();
      });
      cell.addEventListener('dragover', e => {
        const targetKey = cell.dataset.column || '';
        if (!draggedKey || !targetKey || draggedKey === targetKey) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        clearDropIndicators();
        const rect = cell.getBoundingClientRect();
        cell.classList.add(e.clientX >= rect.left + rect.width / 2 ? 'song-column-drop-after' : 'song-column-drop-before');
      });
      cell.addEventListener('dragleave', e => {
        if (!cell.contains(e.relatedTarget)) cell.classList.remove('song-column-drop-before', 'song-column-drop-after');
      });
      cell.addEventListener('drop', e => {
        e.preventDefault();
        const sourceKey = draggedKey || e.dataTransfer?.getData('text/plain') || '';
        const targetKey = cell.dataset.column || '';
        const rect = cell.getBoundingClientRect();
        const placeAfter = e.clientX >= rect.left + rect.width / 2;
        clearDropIndicators();
        reorderSongColumn(sourceKey, targetKey, placeAfter);
      });
    });
  }

  function bindSongHeader() {
    bindSongInteractions(el.songsTable);
    ensureSongColumnResizeObserver();
    // The Music track list is always fitted to the visible viewer.
    fitSongColumnsToScreen({ persist: false });
    const header = el.songsTable.querySelector('.song-header');
    // Sorting is delegated from the persistent table rather than the freshly
    // rendered header. The header itself is rebuilt after every sort, while the
    // table node survives. Keeping one listener on that stable node avoids a
    // Chromium draggable-header edge case where the first sort works and later
    // clicks get swallowed after the header is replaced.
    const table = el.songsTable;
    if (!table.__beehiveSortHandlerBound) {
      // DOM datasets are copied by cloneNode(). Music/playlist tabs use cloned
      // table shells, so a dataset guard can incorrectly say a cloned table is
      // already bound even though event listeners are never cloned. Keep this
      // binding marker as an expando property on the actual DOM node instead.
      // Capture the table node too: el.songsTable is rebound whenever an
      // independent top-level tab becomes active, so a delegated handler must
      // never test containment against a different tab's table.
      table.__beehiveSortHandlerBound = true;
      table.addEventListener('click', e => {
        const btn = e.target?.closest?.('.song-header-btn');
        if (!btn || !table.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset.sort;
        if (!key) return;
        // Every new column starts with its natural ascending order: text A→Z,
        // numbers low→high. A second click reverses that same column.
        if (songSort.key === key) songSort.dir *= -1;
        else {
          songSort.key = key;
          songSort.dir = 1;
        }
        // Explicitly sorting is stronger than a destination's automatic
        // opening shuffle. Keep that override scoped to this collection so
        // leaving/re-entering can still honor its shuffle-on-enter setting.
        songSortOverrideContext = currentSongSortContextKey();
        renderCurrentView();
      });
    }
    bindSongHeaderColumnReordering(header);
    header?.addEventListener('contextmenu', e => {
      e.preventDefault();
      showSongColumnMenu(e.clientX, e.clientY);
    });
    header?.querySelectorAll('[data-column-resize]').forEach(handle => bindSongHeaderResizer(handle, handle.dataset.columnResize));
  }

  function renderSpecialAlbums(tracks){
    el.albumsGrid.classList.add('album-browse-grid');
    const preservedOpenAlbumKey = el.albumsGrid.querySelector('.album-card.inline-expanded')?.dataset.key || null;
    const filtered0=searchTerm ? tracks.filter(trackMatchesSearch) : tracks;
    const grouped=buildAlbums(filtered0);
    // Recently Added is ordered by the actual library-add timestamp, not by
    // release year/title. For an album, use the earliest track add time so
    // the album is placed according to when it first entered the library.
    const albumAddedAt = album => {
      const times = (album?.tracks || []).map(t => Number(t?.addedAt || 0)).filter(Number.isFinite).filter(v => v > 0);
      return times.length ? Math.min(...times) : 0;
    };
    el.albumsGrid.innerHTML='';
    // Album-focus/search results are still rendered through the special album
    // path, but they must use the same full-width section layout as the main
    // Years view. Without this toggle, the base `.grid` class makes the single
    // year section a 178px-wide grid item, which squashes the album page and its
    // expanded track panel to the width of one card.
    el.albumsGrid.classList.toggle('album-years-grouped', !!albumYearDividers);
    const playingKey=currentQueue[currentIndex]?albumKey(currentQueue[currentIndex]):null;

    const makeCard = a => {
      const card=document.createElement('div');
      card.className='album-card'+(a.key===playingKey?' now-playing':'')+(String(a.key)===String(highlightedAlbumKey)?' album-highlighted':'')+(selectedAlbumKeys.has(String(a.key))?' album-selected':'');
      card.dataset.key=a.key;
      card.dataset.tooltip = 'Click to show tracks';
      card.innerHTML=`<div class="art-wrap">${lazyCoverImg(coverSrc(a.cover))}</div><div class="title">${escapeHtml(a.title)}</div><div class="artist">${escapeHtml(a.artist)} · ${a.tracks.length} track${a.tracks.length===1?'':'s'}</div>`;
      attachCoverInteractions(card,a);
      card.addEventListener('contextmenu',e=>{e.preventDefault();showAlbumContextMenu(e,a);});
      return card;
    };

    if (albumYearDividers) {
      const years = new Map();
      for (const album of grouped) {
        const year = albumReleaseYear(album);
        if (!years.has(year)) years.set(year, []);
        years.get(year).push(album);
      }
      const orderedYears = Array.from(years.keys()).sort((a,b) => {
        // Recently Added + Years On: order year sections by the most recent
        // library-add timestamp represented in that year, rather than by
        // release year. A newly added 1977 release can therefore appear above
        // older 2019 and 1989 releases.
        if (specialView === 'recent') {
          const latestAdded = year => Math.max(...(years.get(year) || []).map(albumAddedAt));
          const ba = latestAdded(a), bb = latestAdded(b);
          if (ba !== bb) return bb - ba;
        }
        if (a === 0) return 1;
        if (b === 0) return -1;
        return b - a;
      });
      for (const year of orderedYears) {
        const section = document.createElement('section');
        section.className = 'album-year-section';
        const heading = document.createElement('div');
        heading.className = 'album-year-heading';
        heading.innerHTML = `<span>${year || 'Unknown release year'}</span><div class="album-year-rule"></div>`;
        section.appendChild(heading);
        const grid = document.createElement('div');
        grid.className = 'album-year-grid';
        const yearAlbums = years.get(year).slice().sort((a,b) => {
          if (specialView === 'recent') {
            const aa = albumAddedAt(a), ba = albumAddedAt(b);
            if (aa !== ba) return ba - aa;
          }
          const ay = albumReleaseYear(a), by = albumReleaseYear(b);
          if (ay !== by) return by - ay;
          return songCollator.compare(a.title || '', b.title || '') || songCollator.compare(a.artist || '', b.artist || '');
        });
        yearAlbums.forEach(a => grid.appendChild(makeCard(a)));
        section.appendChild(grid);
        el.albumsGrid.appendChild(section);
      }
    } else {
      const ordered = grouped.slice().sort((a,b) => {
        if (specialView === 'recent') {
          const aa = albumAddedAt(a), ba = albumAddedAt(b);
          if (aa !== ba) return ba - aa;
        }
        const ay = albumReleaseYear(a), by = albumReleaseYear(b);
        if (ay !== by) {
          if (ay === 0) return 1;
          if (by === 0) return -1;
          return by - ay;
        }
        return songCollator.compare(a.title || '', b.title || '') || songCollator.compare(a.artist || '', b.artist || '');
      });
      for (const a of ordered) el.albumsGrid.appendChild(makeCard(a));
    }

    // The highlight follows the user's selected album, not the currently playing
    // album. On a fresh browser with no remembered selection, start with the
    // currently playing album so the existing single-highlight affordance remains.
    if (!highlightedAlbumKey && playingKey) highlightedAlbumKey = String(playingKey);
    el.albumsGrid.querySelectorAll('.album-card.album-highlighted').forEach(node => node.classList.remove('album-highlighted'));
    if (highlightedAlbumKey) {
      el.albumsGrid.querySelector(`.album-card[data-key="${CSS.escape(String(highlightedAlbumKey))}"]`)?.classList.add('album-highlighted');
    }

    observeLazyImages(el.albumsGrid);
    applyAlbumSelectionClasses(el.albumsGrid);
    refreshCoverRotationTargets();

    if (preservedOpenAlbumKey) {
      const preservedAlbum = grouped.find(a => String(a?.key || '') === String(preservedOpenAlbumKey));
      const preservedCard = el.albumsGrid.querySelector(`.album-card[data-key="${CSS.escape(String(preservedOpenAlbumKey))}"]`);
      if (preservedAlbum && preservedCard) toggleInlineAlbum(preservedCard, preservedAlbum);
    }
  }


  function normalizeTypeaheadText(value) {
    return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function clearSongSelection() {
    selectedSongPaths.clear();
    selectedSongOrder.length = 0;
    updateSelectionStatus();
  }

  function selectSongPath(path) {
    const p = String(path || '');
    if (!p) return;
    if (!selectedSongPaths.has(p)) {
      selectedSongPaths.add(p);
      selectedSongOrder.push(p);
      updateSelectionStatus();
    }
  }

  function deselectSongPath(path) {
    const p = String(path || '');
    if (!p) return;
    selectedSongPaths.delete(p);
    const i = selectedSongOrder.indexOf(p);
    if (i >= 0) selectedSongOrder.splice(i, 1);
    updateSelectionStatus();
  }

  function orderedSelectedTracks(sourceTracks) {
    const tracks = Array.isArray(sourceTracks) ? sourceTracks : [];
    const byPath = new Map();
    for (const t of tracks) {
      const p = String(t?.path || '');
      if (p && !byPath.has(p)) byPath.set(p, t);
    }
    const ordered = [];
    for (const p of selectedSongOrder) {
      if (!selectedSongPaths.has(p)) continue;
      const t = byPath.get(p);
      if (t) ordered.push(t);
    }
    // Compatibility for any selection created before the explicit order list
    // was populated. Keep those entries in the source's natural order.
    if (ordered.length < selectedSongPaths.size) {
      for (const t of tracks) {
        const p = String(t?.path || '');
        if (p && selectedSongPaths.has(p) && !ordered.some(x => String(x?.path || '') === p)) ordered.push(t);
      }
    }
    return ordered;
  }

  function typeaheadMatches(track, query) {
    const q = normalizeTypeaheadText(query).replace(/\s+/g, '');
    if (!q) return false;
    const title = normalizeTypeaheadText(track?.title || '').replace(/\s+/g, '');
    const artist = normalizeTypeaheadText(track?.artist || '').replace(/\s+/g, '');
    const album = normalizeTypeaheadText(track?.album || '').replace(/\s+/g, '');
    const fields = [title, artist, album];
    // Normal substring matching gets the common case right.
    if (fields.some(field => field.includes(q))) return true;
    // Also allow omitted/mistyped characters, e.g. "ultra shx" -> "ultra shxt".
    // Require the typed characters to occur in order so random matches don't win.
    return fields.some(field => {
      let i = 0;
      for (const ch of field) if (ch === q[i]) i++;
      return i === q.length;
    });
  }

  function selectTrackFromTypeahead(query) {
    if (viewMode !== 'songs' || !el.songsTable || el.songsTable.classList.contains('hidden')) return false;
    const tracks = songVirtualState.tracks || [];
    if (!tracks.length) return false;
    const q = normalizeTypeaheadText(query).replace(/\s+/g, '');
    if (!q) return false;

    let index = tracks.findIndex(t => normalizeTypeaheadText(t?.title || '').replace(/\s+/g, '').startsWith(q));
    if (index < 0) index = tracks.findIndex(t => normalizeTypeaheadText(t?.title || '').replace(/\s+/g, '').includes(q));
    if (index < 0) index = tracks.findIndex(t => typeaheadMatches(t, query));
    if (index < 0) return false;

    const track = tracks[index];
    const path = String(track?.path || '');
    if (!path) return false;
    clearSongSelection();
    selectSongPath(path);
    activeSelectionScope = 'songs';
    songSelectionAnchor = path;

    // The Tracks view is virtualized, so select and reveal the row by position
    // instead of trying to query a row that may not currently exist in the DOM.
    const header = el.songsTable.querySelector('.song-header');
    const headerHeight = header ? header.offsetHeight : songVirtualState.headerHeight;
    const tableTop = el.songsTable.offsetTop;
    const rowHeight = songVirtualState.rowHeight;
    const targetTop = Math.max(0, tableTop + headerHeight + index * rowHeight - (getActiveViewport().clientHeight - rowHeight) * 0.35);
    getActiveViewport().scrollTop = targetTop;
    updateVirtualSongRows(true);
    applySongSelectionClasses();
    return true;
  }

  function handleTrackTypeaheadKeydown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1 || /[\u0000-\u001f]/.test(e.key)) return;
    const target = e.target;
    if (target && (target.closest?.('input, textarea, select, [contenteditable="true"]'))) return;
    if (viewMode !== 'songs' || !el.songsTable || el.songsTable.classList.contains('hidden')) return;

    e.preventDefault();
    trackTypeaheadBuffer += e.key;
    clearTimeout(trackTypeaheadTimer);
    trackTypeaheadTimer = setTimeout(() => { trackTypeaheadBuffer = ''; }, 1000);
    if (!selectTrackFromTypeahead(trackTypeaheadBuffer)) {
      // Keep the typeahead forgiving: if a longer query has no match, try the
      // newest character by itself before giving up.
      trackTypeaheadBuffer = e.key;
      selectTrackFromTypeahead(trackTypeaheadBuffer);
    }
  }

  function makeSongDragPreview(tracks) {
    const list = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
    if (!list.length) return null;

    const preview = document.createElement('div');
    preview.className = `song-drag-preview${list.length > 1 ? ' multi' : ' single'}`;
    preview.setAttribute('aria-hidden', 'true');

    const visible = list.length === 1 ? list.slice(0, 1) : list.slice(0, 3);
    preview.innerHTML = visible.map((t) => `
      <div class="song-drag-preview-row">
        <img src="${coverSrc(visualCoverForTrack(t))}" alt="" />
        <div class="song-drag-preview-meta">
          <div class="song-drag-preview-title">${escapeHtml(t.title || 'Unknown Title')}</div>
          <div class="song-drag-preview-artist">${escapeHtml(t.artist || 'Unknown Artist')}</div>
        </div>
      </div>`).join('');

    // Chromium snapshots the drag image during dragstart. Keep it in the DOM
    // just long enough for that snapshot, then remove it on the next frame.
    preview.style.position = 'fixed';
    preview.style.left = '-10000px';
    preview.style.top = '-10000px';
    document.body.appendChild(preview);
    return preview;
  }

  function beginSongDrag(e, track) {
    if (!track?.path || !e.dataTransfer) return;
    // When dragging a selected track, resolve the selected paths against the
    // full library rather than the currently sorted/virtualized view. The
    // explicit selection-order list is authoritative, so Ctrl-clicking 7, 4,
    // then 9 always produces 7 -> 4 -> 9 in the queue.
    const sourceTracks = Array.isArray(library?.tracks) && library.tracks.length
      ? library.tracks
      : (Array.isArray(activeSelectionTracks) ? activeSelectionTracks : (songVirtualState.tracks || []));
    const path = String(track.path);
    const paths = selectedSongPaths.has(path)
      ? orderedSelectedTracks(sourceTracks).filter(t => t?.path)
      : [track];
    if (!paths.length) return;

    activeSelectionScope = 'songs';
    songDragState = { tracks: paths.slice(), preview: null };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', `beehive:${paths.length}`);
    e.dataTransfer.setData('text/uri-list', paths.map(t => `file://${encodeURI(String(t.path))}`).join('\r\n'));

    const preview = makeSongDragPreview(paths);
    songDragState.preview = preview;
    if (preview && e.dataTransfer.setDragImage) {
      e.dataTransfer.setDragImage(preview, 18, Math.min(24, preview.offsetHeight / 2));
      requestAnimationFrame(() => preview.remove());
    }
    try { window.beehive.startNativeFileDrag?.(paths.map(t => String(t.path))); } catch (err) { console.warn('[Beehive] native file drag unavailable:', err); }
  }

  function clearQueueDropTarget() {
    if (el.queueList) el.queueList.querySelectorAll('.queue-drop-target').forEach(row => { row.classList.remove('queue-drop-target'); delete row.dataset.dropSide; });
    queueDropIndex = -1;
  }

  function captureQueueState() {
    // Queue undo/redo is deliberately independent from playback. Keep the
    // identity of the currently playing track so an insertion/removal before
    // it can restore the correct queue index without touching the audio
    // element, its source, position, or play/pause state.
    return {
      queue: currentQueue.slice(),
      currentIndex,
      currentPath: currentQueue[currentIndex]?.path || '',
      selectedQueueIndex,
      selectedIndices: new Set(selectedQueueIndices)
    };
  }

  function syncShuffleRestoreQueue() {
    if (!shuffle || !Array.isArray(shuffleRestoreQueue)) return;
    // Keep the original ordering for tracks that still exist, then append any
    // newly added queue tracks in their current order. This lets queue edits
    // made while shuffle is enabled still be restored sensibly when shuffle is
    // turned off.
    const currentByPath = new Map();
    for (const t of currentQueue) {
      const path = String(t?.path || '');
      if (!path) continue;
      if (!currentByPath.has(path)) currentByPath.set(path, []);
      currentByPath.get(path).push(t);
    }
    const restored = [];
    const usedCounts = new Map();
    for (const t of shuffleRestoreQueue) {
      const path = String(t?.path || '');
      const bucket = currentByPath.get(path);
      const used = usedCounts.get(path) || 0;
      if (bucket && used < bucket.length) {
        restored.push(bucket[used]);
        usedCounts.set(path, used + 1);
      }
    }
    for (const t of currentQueue) {
      const path = String(t?.path || '');
      if (!path) continue;
      const bucket = currentByPath.get(path);
      const used = usedCounts.get(path) || 0;
      if (bucket && used < bucket.length) {
        restored.push(bucket[used]);
        usedCounts.set(path, used + 1);
      }
    }
    shuffleRestoreQueue = restored;
  }

  function serializeQueueTrack(t) {
    if (!t?.path) return null;
    return { path:String(t.path), source:String(t.source||'local'), spotifyUri:String(t.spotifyUri||''), spotifyId:String(t.spotifyId||''), spotifyContextUri:String(t.spotifyContextUri||t.contextUri||''), contextUri:String(t.contextUri||t.spotifyContextUri||''), streamUrl:String(t.streamUrl||''), title:String(t.title||''), artist:String(t.artist||''), album:String(t.album||''), albumUri:String(t.albumUri||''), albumArtist:String(t.albumArtist||''), duration:Number(t.duration)||0, cover:String(t.cover||''), artworkUrl:String(t.artworkUrl||''), spotifyArtworkCacheFile:String(t.spotifyArtworkCacheFile||''), year:String(t.year||''), podcastId:String(t.podcastId||''), podcastFeedUrl:String(t.podcastFeedUrl||''), podcastDescription:String(t.podcastDescription||''), pubDate:String(t.pubDate||'') };
  }
  function restoreQueueItems(items, paths, byPath, allowSerializedLocal = false) {
    if (!Array.isArray(items) || !items.length) return (paths||[]).map(p => byPath.get(String(p))).filter(Boolean);
    return items.map(item => {
      if (item && (item.source === 'spotify' || item.source === 'podcast')) return {...item};
      const pathKey = String(item?.path || item || '');
      return byPath.get(pathKey) || (allowSerializedLocal && item && item.path ? {...item} : null);
    }).filter(Boolean);
  }

  function saveQueueSession() {
    if (!playbackPersistenceReady || playbackRestorePending) return;
    const paths = currentQueue.map(t => String(t?.path || '')).filter(Boolean);
    const savedAt = Date.now();
    const currentPath = currentQueue[currentIndex]?.path || '';
    const currentState = {
      paths,
      queueItems: currentQueue.map(serializeQueueTrack).filter(Boolean),
      currentIndex: Number.isInteger(currentIndex) ? currentIndex : -1,
      currentPath,
      selectedQueueIndex: Number.isInteger(selectedQueueIndex) ? selectedQueueIndex : -1,
      selectedIndices: [...selectedQueueIndices].filter(Number.isInteger),
      position: getPlaybackPositionForSave(),
      shuffle: !!shuffle,
      shuffleBasePaths: shuffleRestoreQueue ? shuffleRestoreQueue.map(t => String(t?.path || '')).filter(Boolean) : [],
      shuffleBaseItems: shuffleRestoreQueue ? shuffleRestoreQueue.map(serializeQueueTrack).filter(Boolean) : [],
      repeat: Number.isInteger(repeat) ? repeat : 0,
      volume: Math.max(0, Math.min(1, Number(audio.volume) || 0)),
      wasPlaying: !!(currentQueue[currentIndex]?.path && !audio.paused && !audio.ended),
      savedAt
    };
    try {
      localStorage.setItem(QUEUE_SESSION_KEY, JSON.stringify(currentState));
    } catch {}
    // Keep the backend snapshot synchronized with every queue/session mutation,
    // including an intentionally cleared queue. This prevents an old first-played
    // song from surviving forever as stale recovery data.
    //
    // This is a *synchronous* IPC call (sendSync), which structured-clones its
    // whole argument across the process boundary while blocking the renderer.
    // The main-process handler for it only ever reads the scalar fields below
    // plus `paths` -- it does not use queueItems/shuffleBaseItems at all. Send
    // only those fields instead of the full buildPlaybackState() (which
    // includes per-track metadata for every queued track): for a large
    // collection like Favorites (thousands of tracks), cloning that full
    // metadata synchronously was a visible stall between double-clicking Play
    // and audio actually starting. The full data still reaches localStorage
    // above for queue restoration; the backend file never needed it.
    try {
      window.beehive.savePlaybackStateSync({
        paths,
        currentIndex: currentState.currentIndex,
        currentPath,
        position: currentState.position,
        shuffle: currentState.shuffle,
        repeat: currentState.repeat,
        volume: currentState.volume,
        selectedQueueIndex: currentState.selectedQueueIndex,
        selectedIndices: currentState.selectedIndices,
        wasPlaying: currentState.wasPlaying,
        savedAt
      });
    } catch {}
  }

  function getPlaybackPositionForSave() {
    // GStreamer is the authoritative transport on the normal Linux playback
    // path. The old saver only knew about the Web Audio buffer, so while
    // GStreamer was playing it fell through to the hidden HTML media shell
    // (whose currentTime is effectively 0). On shutdown that could overwrite
    // the real position with a bogus value and make the next launch resume at
    // the wrong place.
    if (gstActive) {
      const base = Math.max(0, Number(gstPosition) || 0);
      if (enginePaused || !gstPositionUpdatedAt) return base;
      const elapsed = Math.max(0, (performance.now() - gstPositionUpdatedAt) / 1000);
      return Math.max(0, Math.min(gstDuration || Number.MAX_SAFE_INTEGER, base + elapsed));
    }
    if (activeBuffer && audioCtx) {
      if (enginePaused) return Math.max(0, Math.min(activeDuration, activeOffset));
      return Math.max(0, Math.min(activeDuration, activeOffset + (audioCtx.currentTime - activeStartedAt)));
    }
    // During startup restoration the buffer is intentionally not decoded yet.
    // Keep the restored logical offset instead of falling back to the hidden
    // compatibility element, whose currentTime is always zero for the Web Audio engine.
    if (Number.isFinite(activeOffset) && activeDuration > 0) {
      return Math.max(0, Math.min(activeDuration, activeOffset));
    }
    return Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
  }

  function buildTransportPlaybackState() {
    const t = currentQueue[currentIndex];
    return {
      currentIndex: Number.isInteger(currentIndex) ? currentIndex : -1,
      currentPath: t?.path || '',
      position: getPlaybackPositionForSave(),
      shuffle: !!shuffle,
      repeat: Number.isInteger(repeat) ? repeat : 0,
      volume: Math.max(0, Math.min(1, Number(audio.volume) || 0)),
      wasPlaying: !!(t && !audio.paused && !audio.ended)
    };
  }

  function buildPlaybackState() {
    const t = currentQueue[currentIndex];
    return {
      paths: currentQueue.map(x => String(x?.path || '')).filter(Boolean),
      queueItems: currentQueue.map(serializeQueueTrack).filter(Boolean),
      currentIndex: Number.isInteger(currentIndex) ? currentIndex : -1,
      currentPath: t?.path || '',
      position: getPlaybackPositionForSave(),
      shuffle: !!shuffle,
      shuffleBasePaths: shuffleRestoreQueue ? shuffleRestoreQueue.map(x => String(x?.path || '')).filter(Boolean) : [],
      shuffleBaseItems: shuffleRestoreQueue ? shuffleRestoreQueue.map(serializeQueueTrack).filter(Boolean) : [],
      repeat: Number.isInteger(repeat) ? repeat : 0,
      volume: Math.max(0, Math.min(1, Number(audio.volume) || 0)),
      selectedQueueIndex: Number.isInteger(selectedQueueIndex) ? selectedQueueIndex : -1,
      selectedIndices: [...selectedQueueIndices].filter(Number.isInteger),
      wasPlaying: !!(t && !audio.paused && !audio.ended)
    };
  }

  let lastTransportBackendSaveAt = 0;
  function savePlaybackSession(forceSync = false) {
    if (!playbackPersistenceReady || playbackRestorePending) return;
    const state = buildTransportPlaybackState();
    const rememberedTrack = currentQueue[currentIndex];
    if (rememberedTrack) {
      const rememberedPosition = gstActive ? Number(gstPosition) : Number(state.position);
      saveRememberedTrackPosition(rememberedTrack, rememberedPosition);
    }
    // Keep the fast local position mirror small. Do not stringify the entire queue
    // every 500ms; large libraries/queues made that synchronous work cause severe
    // startup and playback hitches.
    try {
      localStorage.setItem(LAST_PLAYBACK_KEY, JSON.stringify({
        path: state.currentPath,
        time: state.position,
        currentIndex: state.currentIndex,
        wasPlaying: state.wasPlaying,
        shuffle: !!state.shuffle,
        repeat: Number.isInteger(state.repeat) ? state.repeat : 0,
        volume: Math.max(0, Math.min(1, Number(state.volume) || 0)),
        savedAt: Date.now()
      }));
    } catch {}

    // Queue contents are persisted by saveQueueSession() on queue mutations.
    // Transport-only updates use a tiny atomic backend merge, avoiding repeated
    // serialization of potentially thousands of queue paths.
    const now = Date.now();
    if (forceSync || now - lastTransportBackendSaveAt >= 2000) {
      try {
        // Queue contents are already persisted by saveQueueSession() when the
        // queue changes. Even on shutdown, only the small transport snapshot
        // needs to be forced synchronously; rebuilding/stringifying a large
        // queue here can block the BrowserWindow close path.
        window.beehive.updatePlaybackTransportSync(state);
        lastTransportBackendSaveAt = now;
      } catch {}
    }
  }

  function saveSession() {
    saveQueueSession();
    savePlaybackSession();
  }

  function restoreSavedQueue() {
    if (restoredPlayback) return false;
    let localQueueState = null;
    let localPlaybackState = null;
    try { localQueueState = JSON.parse(localStorage.getItem(QUEUE_SESSION_KEY) || 'null'); } catch {}
    try { localPlaybackState = JSON.parse(localStorage.getItem(LAST_PLAYBACK_KEY) || 'null'); } catch {}

    // Volume is application-wide playback state, so restore it independently of
    // whether the user happened to have a queue when they last closed Beehive.
    // The old restore path required a non-empty queue before it restored anything,
    // which could leave the player at the default 80% and blast audio on startup.
    const volumeCandidates = [backendPlaybackState, localQueueState, localPlaybackState]
      .filter(Boolean)
      .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    const savedVolume = volumeCandidates.find(s => Number.isFinite(Number(s.volume)))?.volume;
    if (Number.isFinite(Number(savedVolume))) {
      const normalizedVolume = Math.max(0, Math.min(1, Number(savedVolume)));
      audio.volume = normalizedVolume;
      renderVolumeSliderFromEngine(normalizedVolume);
    }

    // Playback modes are application-wide state, not properties of whether a
    // queue currently exists. Restore them from the newest available snapshot
    // even when the last session had an empty queue. This makes Shuffle/Repeat
    // durable across reboot instead of accidentally resetting them to defaults
    // when there is nothing to restore into the queue.
    const modeCandidates = [backendPlaybackState, localQueueState, localPlaybackState]
      .filter(Boolean)
      .filter(s => typeof s.shuffle === 'boolean' || Number.isFinite(Number(s.repeat)))
      .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    const modeState = modeCandidates[0] || null;
    if (modeState) {
      if (typeof modeState.shuffle === 'boolean') shuffle = modeState.shuffle;
      const modeRepeat = Number(modeState.repeat);
      if (Number.isInteger(modeRepeat) && modeRepeat >= 0 && modeRepeat <= 2) repeat = modeRepeat;
    }
    renderShuffleButton();
    renderRepeatButton();

    // Prefer the newest non-empty queue snapshot. The backend file is the
    // primary persistence store, while localStorage remains useful for older
    // sessions and for recovering from an interrupted backend write.
    const candidates = [backendPlaybackState, localQueueState].filter(s => Array.isArray(s?.paths) && s.paths.length);
    if (!candidates.length) return true;
    const queueState = candidates.reduce((best, item) =>
      !best || Number(item.savedAt || 0) >= Number(best.savedAt || 0) ? item : best, null);

    // Restore transport mode from the same atomic session snapshot as the queue.
    // This happens before rendering so the controls reflect exactly what the user
    // left behind.
    shuffle = !!queueState.shuffle;
    const restoredRepeat = Number(queueState.repeat);
    repeat = Number.isInteger(restoredRepeat) && restoredRepeat >= 0 && restoredRepeat <= 2 ? restoredRepeat : repeat;

    // Prefer position from the same snapshot that supplied the queue. This keeps
    // queue/current-track/position/shuffle/repeat atomic instead of combining a
    // newer queue with an older position from another persistence layer.
    let playbackState = (Number.isFinite(Number(queueState.position)) || queueState.currentPath)
      ? {
          path: queueState.currentPath || '',
          position: Number.isFinite(Number(queueState.position)) ? Number(queueState.position) : 0,
          currentIndex: queueState.currentIndex,
          shuffle: queueState.shuffle,
          repeat: queueState.repeat,
          volume: queueState.volume
        }
      : backendPlaybackState;
    if (!playbackState?.path && localPlaybackState?.path) playbackState = localPlaybackState;

    // restoreLastPlayback() deliberately runs before the cached library
    // arrives (see initialLoad()'s comment: the tiny playback snapshot must
    // not wait on decoding/rendering the multi-megabyte library). That means
    // `library.tracks` -- and therefore `byPath` -- is normally still empty
    // right here on an ordinary launch, not just during the BrowserWindow
    // recreation this fallback was originally written for. Without it, every
    // local track's byPath lookup missed and the entire queue was silently
    // dropped on every regular restart. queueItems already carries enough
    // serialized metadata (path/title/artist/album/duration/cover) to start
    // playback and render a reasonable row immediately; renderMusicViewer's
    // queue rendering already re-resolves each row against the authoritative
    // library object once it loads (see populateQueueVirtualRow), so this
    // fallback self-corrects display metadata without needing a separate
    // reconciliation pass.
    const byPath = new Map((library.tracks || []).map(t => [String(t?.path || ''), t]));
    const restoredQueue = restoreQueueItems(queueState.queueItems, queueState.paths, byPath, true);
    if (!restoredQueue.length) return false;

    shuffleRestoreQueue = null;
    if (shuffle && Array.isArray(queueState.shuffleBasePaths) && queueState.shuffleBasePaths.length) {
      const restoredBase = restoreQueueItems(queueState.shuffleBaseItems, queueState.shuffleBasePaths, byPath, true);
      if (restoredBase.length) shuffleRestoreQueue = restoredBase;
    }

    currentQueue = restoredQueue;
    syncShuffleRestoreQueue();
    const requestedIndex = Number(queueState.currentIndex);
    currentIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < currentQueue.length
      ? requestedIndex : 0;
    if (playbackState?.path) {
      const playbackIndex = currentQueue.findIndex(t => String(t?.path || '') === String(playbackState.path));
      if (playbackIndex >= 0) currentIndex = playbackIndex;
    }
    selectedQueueIndices.clear();
    const selected = Array.isArray(queueState.selectedIndices) ? queueState.selectedIndices : [];
    for (const i of selected) if (i >= 0 && i < currentQueue.length) selectedQueueIndices.add(i);
    selectedQueueIndex = Number(queueState.selectedQueueIndex);
    if (!Number.isInteger(selectedQueueIndex) || selectedQueueIndex < 0 || selectedQueueIndex >= currentQueue.length) selectedQueueIndex = currentIndex;
    if (!selectedQueueIndices.size) selectedQueueIndices.add(currentIndex);
    activeSelectionScope = 'queue';
    restoredPlayback = true;
    renderShuffleButton();
    renderRepeatButton();
    renderQueue();

    const restored = currentQueue[currentIndex];
    if (!restored?.path) return true;
    audio.src = window.beehive.fileUrl(restored.path);
    currentQueue[currentIndex] = restored;
    const desired = Math.max(0, Number(playbackState?.position ?? playbackState?.time) || 0);

    if (rendererRecreationMode && queueState.wasPlaying && restored.path) {
      // The main process deliberately keeps the persistent GStreamer helper alive
      // while Electron recreates the BrowserWindow for the themed title bar. Do
      // not LOAD or PLAY here: that would replace/restart the already-audible
      // pipeline. Instead, adopt its existing transport and let the next native
      // POSITION event correct the persisted handoff position.
      activateLocalProvider();
      gstAvailable = true;
      gstAvailabilityKnown = true;
      gstActive = true;
      gstTrackIndex = currentIndex;
      gstPositionUpdatesEnabled = true;
      gstWaitingNextStream = false;
      gstExpectInitialStream = false;
      gstResumeAfterSeek = false;
      gstDuration = Math.max(0, Number(restored.duration) || 0);
      gstPosition = Math.max(0, Math.min(gstDuration || Number.MAX_SAFE_INTEGER, desired));
      gstPositionUpdatedAt = performance.now();
      enginePaused = false;
      engineEnded = false;
      startupPlaybackLocked = false;
      updateNowPlayingUI(restored);
      dispatchAudio('loadedmetadata');
      dispatchAudio('durationchange');
      dispatchAudio('play');
      updateSeekUI();
      renderQueue();
      savePlaybackSession();
      return true;
    }

    updateNowPlayingUI(restored);
    // Startup restoration is asynchronous because the selected track must be
    // decoded before Web Audio can expose its duration/position. Prevent the
    // periodic session saver from replacing the real saved position with 0:00
    // while that decode is in progress.
    playbackRestorePending = true;
    // Normal application startup always restores the queue, current song, and
    // saved position, but never restores the previous playing state. Beehive must
    // remain paused until the user explicitly presses Play. Renderer recreation
    // is the one exception because the existing native GStreamer pipeline never
    // stopped playing while the BrowserWindow was replaced.
    loadCurrentPausedAt(desired)
      .catch(() => {})
      .finally(() => {
        playbackRestorePending = false;
        saveQueueSession();
        savePlaybackSession();
      });
    return true;
  }

  function pushQueueUndo(before) {
    queueUndoStack.push({ before, after: captureQueueState() });
    if (queueUndoStack.length > MAX_QUEUE_UNDO) queueUndoStack.shift();
    // A new queue edit starts a new branch, just like normal desktop undo.
    queueRedoStack.length = 0;
  }

  function addTracksToQueue(tracks, insertIndex = currentQueue.length) {
    const additions = (Array.isArray(tracks) ? tracks : []).filter(t => t?.path);
    if (!additions.length) return false;
    const at = Math.max(0, Math.min(Number(insertIndex) || 0, currentQueue.length));
    const before = captureQueueState();

    const beforeCurrent = currentIndex >= at;
    currentQueue.splice(at, 0, ...additions);
    if (shuffle) syncShuffleRestoreQueue();
    if (currentIndex >= 0 && beforeCurrent) currentIndex += additions.length;

    selectedQueueIndices.clear();
    for (let i = at; i < at + additions.length; i++) selectedQueueIndices.add(i);
    selectedQueueIndex = at;
    activeSelectionScope = 'queue';
    renderQueue();
    // Keep the newly inserted block visible when it was added farther down
    // the virtualized queue.
    if (el.queueList) {
      const target = at * queueVirtualState.rowHeight;
      el.queueList.scrollTop = Math.max(0, target - Math.floor((el.queueList.clientHeight || 220) / queueVirtualState.rowHeight / 2) * queueVirtualState.rowHeight);
      updateQueueVirtualRows(true);
      applyQueueSelectionClasses();
    }
    pushQueueUndo(before);
    return true;
  }

  function insertDraggedSongsIntoQueue(insertIndex) {
    if (!songDragState?.tracks?.length) return false;
    return addTracksToQueue(songDragState.tracks, insertIndex);
  }

  // Song rows are frequently rebuilt by the virtualized Tracks view, and tab
  // surfaces are cloned when a new browser tab is created. DOM cloning does
  // not copy addEventListener handlers, so keep the track context menu on the
  // persistent songs table itself. This preserves the full right-click menu
  // (queue, Love, ratings, tag editing, playlists, etc.) on every Music tab.
  function bindSongContextMenu(table) {
    if (!table || table.__beehiveSongContextMenuBound) return;
    table.__beehiveSongContextMenuBound = true;
    table.addEventListener('contextmenu', e => {
      const row = e.target?.closest?.('.song-row');
      if (!row || !table.contains(row)) return;
      const index = Number(row.dataset.idx);
      const tracks = songVirtualState.tracks || [];
      let track = Number.isInteger(index) && index >= 0 ? tracks[index] : null;
      if (!track && row.dataset.path) {
        track = library.tracks.find(t => String(t?.path || '') === String(row.dataset.path || '')) || null;
      }
      if (!track) return;
      e.preventDefault();
      e.stopPropagation();
      prepareTrackContextSelection(track, tracks.length ? tracks : null);
      showTrackContextMenu(e.clientX, e.clientY, track);
    });
  }

  function applySongSelectionClasses(container = el.songsTable) {
    container.querySelectorAll('.song-row').forEach(row => {
      const path = row.dataset.path || '';
      row.classList.toggle('selected', selectedSongPaths.has(path));
    });
  }

  function bindSongInteractions(table) {
    if (!table || table.__beehiveSongInteractionsBound) return;
    table.__beehiveSongInteractionsBound = true;

    // Virtualized rows are destroyed/recreated while scrolling. Delegate the
    // interaction handlers from the persistent table instead of attaching four
    // listeners to every visible row on every repaint. This keeps the hot scroll
    // path allocation-light and makes the number of listeners independent of
    // library size and virtualization churn.
    table.addEventListener('click', e => {
      const star = e.target?.closest?.('.rating-star');
      const row = e.target?.closest?.('.song-row');
      if (!row || !table.contains(row)) return;
      const tracks = songVirtualState.tracks || [];
      const index = Number(row.dataset.idx);
      const track = Number.isInteger(index) && index >= 0 ? tracks[index] : null;
      if (!track) return;

      if (star) {
        e.preventDefault();
        e.stopPropagation();
        const rect = star.getBoundingClientRect();
        const half = e.clientX < rect.left + rect.width / 2;
        const value = Number(star.dataset.star) - (half ? 0.5 : 0);
        void setTrackRating(track, value);
        return;
      }

      activeSelectionScope = 'songs';
      activeSelectionTracks = tracks;
      const path = String(track.path || '');
      if (e.shiftKey && songSelectionAnchor != null) {
        const anchorIndex = tracks.findIndex(t => String(t?.path || '') === songSelectionAnchor);
        const from = anchorIndex >= 0 ? Math.min(anchorIndex, index) : index;
        const to = anchorIndex >= 0 ? Math.max(anchorIndex, index) : index;
        for (let i = from; i <= to; i++) {
          const p = String(tracks[i]?.path || '');
          if (p) selectSongPath(p);
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (path) {
          if (selectedSongPaths.has(path)) deselectSongPath(path);
          else selectSongPath(path);
          songSelectionAnchor = path;
        }
      } else {
        clearSongSelection();
        if (path) selectSongPath(path);
        songSelectionAnchor = path || null;
      }
      if (path) songSelectionAnchor = path;
      applySongSelectionClasses(table);

      // Clicking a track previews its accent the same way opening an album
      // does, so the top-left brand logo and every other frosted-glass
      // surface follow the clicked track instead of only reacting once
      // playback actually starts.
      const previewCover = visualCoverForTrack(track);
      if (previewCover) applyPaletteFromCover(coverSrc(previewCover));
    });

    table.addEventListener('dblclick', e => {
      const row = e.target?.closest?.('.song-row');
      if (!row || !table.contains(row) || e.target?.closest?.('.rating-star')) return;
      const index = Number(row.dataset.idx);
      const tracks = songVirtualState.tracks || [];
      if (Number.isInteger(index) && index >= 0 && tracks[index]) playQueue(tracks, index);
    });

    table.addEventListener('dragstart', e => {
      const row = e.target?.closest?.('.song-row');
      if (!row || !table.contains(row)) return;
      const index = Number(row.dataset.idx);
      const track = songVirtualState.tracks?.[index];
      if (track) beginSongDrag(e, track);
    });

    table.addEventListener('dragend', e => {
      if (!e.target?.closest?.('.song-row')) return;
      if (songDragState?.preview?.isConnected) songDragState.preview.remove();
      songDragState = null;
      clearQueueDropTarget();
    });
  }

  function renderSpecialSongs(tracks){
    const filtered0=searchTerm ? tracks.filter(trackMatchesSearch) : tracks;
    const base = specialView === 'recent'
      ? filtered0.slice().sort((a,b) => Number(b?.addedAt || 0) - Number(a?.addedAt || 0))
      : filtered0;
    const ordered = specialView === 'playlist' && activePlaylistId
      ? base.slice().reverse()
      : base;
    let filtered;
    if (specialView === 'playlist' && activePlaylistId) {
      const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
      // Automatic shuffle defines the opening/default presentation order. A
      // deliberate column-header sort is an explicit user override and must
      // always win, even when the sidebar/playlist destination has
      // "Shuffle automatically when opened" enabled.
      const manualSort = manualSongSortActive();
      filtered = (playlistVisualShuffleEnabled(pl) && !manualSort)
        ? visualShuffleTracks(visualShuffleKeyForPlaylist(pl), ordered, true)
        : sortTracks(ordered);
    } else {
      const navForView = specialView === 'recent' ? 'pl-recent'
        : specialView === 'top' ? 'pl-top'
        : specialView === 'history' ? 'history'
        : specialView === 'folder' ? null
        : specialView === 'sandbox' ? 'sandbox'
        : null;
      const navKey = navForView ? visualShuffleKeyForSidebar(navForView) : (specialView === 'folder' && activeFolderPath ? visualShuffleKeyForSidebar(folderNavKey(activeFolderPath)) : '');
      const enabled = navForView ? sidebarVisualShuffleEnabled(navForView) : (specialView === 'folder' && activeFolderPath ? sidebarNavigation?.meta?.[folderNavKey(activeFolderPath)]?.shuffleOnEnter === true : false);
      const manualSort = manualSongSortActive();
      filtered = (enabled && !manualSort) ? visualShuffleTracks(navKey, ordered, true) : sortTracks(ordered);
    }

    // Favorites, History, Recently Added, Top Played, folders, and normal
    // playlists use the exact same virtualized renderer as the main Tracks
    // view. Previously these special views created one DOM row per track while
    // Music created only the visible rows, which made Favorites feel slower
    // despite containing far fewer tracks. Keep the data selection/sort rules
    // above, but share the rendering path so performance characteristics stay
    // consistent across every track collection.
    el.contentTools.classList.add('hidden');
    el.contentTools.innerHTML = '';
    el.albumsGrid.classList.add('hidden');
    el.songsTable.classList.remove('hidden');
    songVirtualState.tracks = filtered;
    songVirtualState.lastStart = -1;
    songVirtualState.lastEnd = -1;
    el.songsTable.innerHTML = songHeader() + '<div class="song-virtual-spacer"></div><div class="song-virtual-window"></div>';
    el.songsTable.style.position = 'relative';
    bindSongHeader();
    bindSongContextMenu(el.songsTable);
    updateVirtualSongRows(true);
  }
  function resetActiveMusicTabAlbum() {
    const tab = getActiveTab?.();
    if (!tab || tab.kind !== 'music') return;
    const grid = tab.dom?.albumsGrid;
    if (grid) {
      grid.querySelectorAll(':scope > .inline-album-dropdown').forEach(node => node.remove());
      grid.querySelectorAll(':scope > .album-card.inline-expanded').forEach(node => node.classList.remove('inline-expanded'));
    }
    openAlbumKey = null;
  }

  function setActiveTabBaseContext(label, icon = null) {
    const tab = getActiveTab?.();
    if (!tab) return;
    if (tab.kind === 'music') resetActiveMusicTabAlbum();
    tab.baseLabel = String(label || (tab.kind === 'music' ? (sidebarLabel('music') || 'Music') : 'PLAYLISTS')).trim() || (tab.kind === 'music' ? (sidebarLabel('music') || 'Music') : 'PLAYLISTS');
    tab.label = tab.baseLabel;
    if (icon != null) tab.baseIcon = String(icon);
    if (tab.baseIcon) tab.icon = tab.baseIcon;
    renderTabs();
    saveActiveTabState();
  }

  function setActiveMusicTabBaseLabel(label, icon = null) {
    const tab = getActiveTab?.();
    if (!tab || tab.kind !== 'music') return;
    setActiveTabBaseContext(label, icon);
  }

  // Reverse of sidebarPlaylistForEntry(): given a playlist id, find which
  // sidebar nav row (if any) represents it, so a restored 'playlist' special
  // view can re-highlight the row it actually came from instead of falling
  // through to "no match" and clearing every row's highlight.
  function sidebarNavIdForPlaylistId(playlistId) {
    if (!playlistId) return null;
    // Favorites is usually a real *custom* playlist entry with a generated
    // sidebar id (see enforceLockedTopbarPins()'s "generated sidebar id"
    // comment), not the literal string 'pl-favorites' -- that literal id is
    // only a legacy fallback for older profiles that never migrated. Check
    // the actual rendered entries first, so the row that really has
    // data-nav="<generated id>" is the one that gets highlighted; only fall
    // back to the legacy literal id if nothing else matches.
    const candidateIds = [...(sidebarNavigation.order || []), ...(sidebarNavigation.custom || []).map(c => c.id)];
    for (const id of candidateIds) {
      const pl = sidebarPlaylistForEntry(id);
      if (pl && String(pl.id) === String(playlistId)) return id;
    }
    const favorites = starFavoritesPlaylist();
    if (favorites && String(favorites.id) === String(playlistId)) return 'pl-favorites';
    return null;
  }

  function syncSidebarSelectionForContext() {
    const active = getActiveTab?.();
    // This used to only recognize recent/top/history/sandbox/folder plus the
    // single shared Music tab, so every other sidebar destination -- Playlists,
    // Favorites/any pinned playlist, Podcasts -- got its highlight cleared the
    // instant this ran (it runs on every tab restore, right after the click
    // handler that had just set it correctly).
    const contextNav = specialView === 'recent' ? 'pl-recent'
      : specialView === 'top' ? 'pl-top'
      : specialView === 'history' ? 'history'
      : specialView === 'sandbox' ? 'sandbox'
      : specialView === 'podcasts' ? 'podcasts'
      : specialView === 'playlist' ? sidebarNavIdForPlaylistId(activePlaylistId)
      : specialView === 'folder' && activeFolderPath ? null
      : (!specialView && active?.kind === 'music') ? 'music'
      : (!specialView && active?.kind === 'playlists') ? 'pl-explorer'
      : null;
    el.sidebarItems?.forEach(i => i.classList.toggle('active', !!contextNav && i.dataset.nav === contextNav));
    el.folderList?.querySelectorAll('.sidebar-item').forEach(i => {
      i.classList.toggle('active', specialView === 'folder' && i.dataset.folder === activeFolderPath);
    });
  }

  // Music Viewer is the shared presentation surface for every playable music collection.
  // The source may be the library, a playlist, Favorites, History, Recently Added,
  // Top Played, or a folder; the viewer always exposes Albums / Tracks / Artists and Years.
  function renderMusicViewer(title,tracks,kind){
    specialView=kind;
    hideContentViews();
    el.albumsToolbar.classList.remove('hidden');
    el.albumsToolbar.dataset.musicViewer = 'true';
    if (el.sectionTitleText) el.sectionTitleText.textContent=title;
    if(viewMode==='albums'){
      el.albumsGrid.classList.remove('hidden');
      renderSpecialAlbums(tracks);
    } else if(viewMode==='songs'){
      el.songsTable.classList.remove('hidden');
      renderSpecialSongs(tracks);
    } else if(viewMode==='artists'){
      el.artistsGrid.classList.remove('hidden');
      renderArtists(tracks);
    }
    // Keep the toolbar buttons authoritative for the actual rendered view.
    // Special collections can render Tracks while the previous generic Music
    // view left Albums highlighted, which made Favorites appear to be in the
    // wrong visual mode.
    syncTabControls();
    syncSidebarSelectionForContext();
    const activeTab = getActiveTab();
    if (activeTab?.kind === 'music') {
      // A sidebar collection is the tab's base context. The tab is opened in
      // the Music browser, but it must be allowed to replace the generic
      // MUSIC label until an album is actually opened in that tab.
      activeTab.baseLabel = title || sidebarLabel('music') || 'Music';
      activeTab.label = activeTab.baseLabel;
      renderTabs();
    }
    saveActiveTabState();
    updateActiveTabLabel();
  }
  function normalizeSpotifyTrackRecord(track){
    if (!track || String(track.source || '').toLowerCase() !== 'spotify') return track;
    const out={...track, source:'spotify'};
    if (out.album === 'Spotify') out.album = '';
    if (out.artist === 'Unknown artist') out.artist = '';
    const uri=String(out.spotifyUri || '').trim();
    if (uri) { out.spotifyUri=uri; if(!out.spotifyId) out.spotifyId=uri.split(':').pop(); }
    let duration=Number(out.duration)||0;
    // Hive stores provider durations in seconds. Older Spotify imports persisted
    // raw milliseconds, which rendered values such as 1293:40 for a ~1:18 track.
    // Repair those records at the provider boundary without touching normal
    // second-based durations. Spotify tracks longer than an hour are unusual;
    // only values above that boundary are treated as stale millisecond data.
    if (duration > 3600) duration /= 1000;
    out.duration=duration;
    const artwork=normalizeSpotifyArtworkSource(out.artworkUrl || out.cover || '');
    if (/^https?:\/\//i.test(artwork)) { out.cover=artwork; out.artworkUrl=artwork; }
    return out;
  }

  function normalizeSpotifyPlaylistRecord(pl){
    if (pl?.source !== 'spotify' || !Array.isArray(pl?.spotifyTracks)) return pl;
    const tracks=pl.spotifyTracks.map(normalizeSpotifyTrackRecord);
    const playlistArtwork=normalizeSpotifyArtworkSource(pl.cover || pl.artworkUrl || '');
    return {...pl, spotifyTracks:tracks, cover:/^https?:\/\//i.test(playlistArtwork)?playlistArtwork:(pl.cover||''), artworkUrl:/^https?:\/\//i.test(playlistArtwork)?playlistArtwork:(pl.artworkUrl||'')};
  }

  const spotifyPlaylistHydrationInFlight=new Map();
  async function hydrateSpotifyPlaylist(pl){
    if (pl?.source !== 'spotify' || !pl?.sourceUrl) return pl;
    const id=String(pl.id||pl.spotifyPlaylistId||pl.sourceUrl);
    if (spotifyPlaylistHydrationInFlight.has(id)) return spotifyPlaylistHydrationInFlight.get(id);
    const task=(async()=>{
      const normalized=normalizeSpotifyPlaylistRecord(pl);
      try {
        const fresh=await window.beehive.importSpotifyPlaylist(pl.sourceUrl);
        if (!fresh?.tracks?.length) return normalized;
        const freshByUri=new Map(fresh.tracks.map(t=>[String(t.spotifyUri||''),t]).filter(([uri])=>uri));
        const merged=(normalized.spotifyTracks||[]).map(old=>{
          const next=freshByUri.get(String(old.spotifyUri||''));
          if (!next) return normalizeSpotifyTrackRecord(old);
          // A provider refresh may legitimately omit artwork even though the
          // persisted playlist already has a cached/remote cover. Never let a
          // metadata refresh erase useful queue artwork.
          return normalizeSpotifyTrackRecord({
            ...old,
            ...next,
            cover: next.cover || old.cover || '',
            artworkUrl: next.artworkUrl || old.artworkUrl || '',
            spotifyArtworkCacheFile: next.spotifyArtworkCacheFile || old.spotifyArtworkCacheFile || ''
          });
        });
        const existingUris=new Set(merged.map(t=>String(t.spotifyUri||'')));
        for(const freshTrack of fresh.tracks){
          if(!existingUris.has(String(freshTrack.spotifyUri||''))) merged.push(normalizeSpotifyTrackRecord(freshTrack));
        }
        const freshArtwork=normalizeSpotifyArtworkSource(fresh.cover || fresh.artworkUrl || merged.find(t=>spotifyArtworkUrl(t))?.artworkUrl || '');
        const warm = await preloadSpotifyArtwork(merged, freshArtwork);
        const updated={...normalized, name:fresh.name || normalized.name, sourceUrl:fresh.sourceUrl || normalized.sourceUrl, spotifyPlaylistId:fresh.id || normalized.spotifyPlaylistId, spotifyTracks:merged, cover:/^https?:\/\//i.test(freshArtwork)?freshArtwork:normalized.cover, artworkUrl:/^https?:\/\//i.test(freshArtwork)?freshArtwork:normalized.artworkUrl, spotifyArtworkCacheFile:warm?.playlistCoverFile || normalized.spotifyArtworkCacheFile || ''};
        await window.beehive.savePlaylist(updated);
        playlists=playlists.map(item=>String(item.id)===String(updated.id)?updated:item);
        return updated;
      } catch(err) {
        console.warn('[Spotify Playlist] metadata refresh failed:', err?.message || String(err));
        return normalized;
      }
    })();
    spotifyPlaylistHydrationInFlight.set(id,task);
    try { return await task; } finally { spotifyPlaylistHydrationInFlight.delete(id); }
  }

  function tracksForPlaylist(pl){
    if(pl?.smart) return evaluateSmartPlaylist(pl);
    if (pl?.source === 'spotify' && Array.isArray(pl?.spotifyTracks)) return pl.spotifyTracks.map(normalizeSpotifyTrackRecord);
    const source = Array.isArray(pl?.tracks) ? pl.tracks : [];
    const podcastEpisodes = pl?.podcastEpisodes && typeof pl.podcastEpisodes === 'object' ? pl.podcastEpisodes : null;
    const out = [];
    for (const x of source) {
      const key = String(x);
      const t = libraryTrackByPath.get(key) || (podcastEpisodes ? podcastEpisodes[key] : null);
      if (t) out.push(t);
    }
    return out;
  }

  // Playlist/sidebar "Shuffle automatically when opened" is deliberately a
  // presentation-order feature, not the transport Shuffle switch. Keep its
  // randomized order separate from currentQueue so entering a collection never
  // silently changes the player's shuffle state. The same visual order is reused
  // for rendering/searching/playing until that context is reopened or its
  // membership changes.
  const visualShuffleOrders = new Map();

  function visualShuffleKeyForSidebar(nav) {
    return nav ? `sidebar:${String(nav)}` : '';
  }

  function visualShuffleKeyForPlaylist(pl) {
    return pl?.id != null ? `playlist:${String(pl.id)}` : '';
  }

  function plainVisualShuffle(tracks) {
    const out = Array.isArray(tracks) ? tracks.slice() : [];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function visualShuffleTracks(key, tracks, enabled) {
    const source = Array.isArray(tracks) ? tracks.slice() : [];
    if (!enabled || !key || source.length < 2) {
      if (key) visualShuffleOrders.delete(key);
      return source;
    }
    const paths = source.map(t => String(t?.path || '')).filter(Boolean);
    const signature = paths.join('\u0001');
    const cached = visualShuffleOrders.get(key);
    if (cached?.signature === signature && Array.isArray(cached.paths)) {
      const byPath = new Map(source.map(t => [String(t?.path || ''), t]));
      const ordered = cached.paths.map(path => byPath.get(path)).filter(Boolean);
      if (ordered.length === source.length) return ordered;
    }
    if (cached?.paths?.length) {
      // Searches/filters are subsets of the already-randomized list. Preserve
      // their established visual order instead of reshuffling on every keypress.
      const rank = new Map(cached.paths.map((path, index) => [path, index]));
      const known = source.filter(t => rank.has(String(t?.path || ''))).sort((a,b) => rank.get(String(a?.path || '')) - rank.get(String(b?.path || '')));
      const unknown = plainVisualShuffle(source.filter(t => !rank.has(String(t?.path || ''))));
      const combined = known.concat(unknown);
      if (combined.length === source.length) {
        visualShuffleOrders.set(key, { signature, paths: combined.map(t => String(t?.path || '')).filter(Boolean) });
        return combined;
      }
    }
    const shuffled = plainVisualShuffle(source);
    visualShuffleOrders.set(key, { signature, paths: shuffled.map(t => String(t?.path || '')).filter(Boolean) });
    return shuffled;
  }

  function beginVisualShuffle(key) {
    if (key) visualShuffleOrders.delete(key);
  }

  function sidebarVisualShuffleEnabled(nav) {
    return sidebarNavigation?.meta?.[sidebarMetaKey(nav)]?.shuffleOnEnter === true;
  }

  function sidebarDisplayView(nav, fallback='albums') {
    const allowed = ['albums','songs','artists'];
    const key = sidebarMetaKey(nav);
    const configured = sidebarNavigation?.meta?.[key]?.displayView;
    if (allowed.includes(configured)) return configured;
    // Read older per-destination localStorage preferences as a compatibility
    // fallback. New saves are kept in the same sidebar meta record as the
    // shuffle preference so every destination has one coherent settings object.
    try {
      const shortKey = String(nav || '');
      const legacy = localStorage.getItem(`beehive:sidebar-display-view:${shortKey}`)
        || localStorage.getItem(`beehive:dynamic-playlist-display-view:${shortKey}`);
      if (allowed.includes(legacy)) return legacy;
    } catch {}
    return allowed.includes(fallback) ? fallback : 'albums';
  }

  function currentSidebarContextNav() {
    if (specialView === 'recent') return 'pl-recent';
    if (specialView === 'top') return 'pl-top';
    if (specialView === 'history') return 'history';
    if (specialView === 'folder' && activeFolderPath) return folderNavKey(activeFolderPath);
    if (!specialView && getActiveTab?.()?.kind === 'music') return 'music';
    return null;
  }

  function currentSongSortContextKey() {
    if (specialView === 'playlist' && activePlaylistId != null) return `playlist:${String(activePlaylistId)}`;
    const nav = currentSidebarContextNav();
    if (nav) return `sidebar:${String(nav)}`;
    const tab = getActiveTab?.();
    return tab?.id ? `tab:${String(tab.id)}` : '';
  }

  function manualSongSortActive() {
    return !!songSort.key && songSortOverrideContext === currentSongSortContextKey();
  }

  function playlistVisualShuffleEnabled(pl) {
    return pl?.shuffleOnEnter === true;
  }

  function shuffleForPlayback(tracks){
    const out=tracks.slice();
    for(let i=out.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [out[i],out[j]]=[out[j],out[i]];
    }
    return out;
  }

  async function playPlaylist(pl){
    if (pl?.source === 'spotify') {
      pl = await hydrateSpotifyPlaylist(pl);
      if (pl?.id) playlists=playlists.map(item=>String(item.id)===String(pl.id)?pl:item);
    }
    const baseTracks=tracksForPlaylist(pl);
    const tracks=visualShuffleTracks(visualShuffleKeyForPlaylist(pl), baseTracks, playlistVisualShuffleEnabled(pl));
    if(!tracks.length)return false;
    // The playlist's automatic-shuffle preference only determines the order
    // shown to the user. The bottom player Shuffle switch remains independent.
    // If player Shuffle is already on, playQueue() performs a second shuffle of
    // this already-randomized list, exactly as intended.
    const startIndex = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
    playQueue(tracks,startIndex);
    return true;
  }

  function formatPlaylistRuntime(seconds){
    const total=Math.max(0,Math.round(Number(seconds)||0));
    const days=Math.floor(total/86400);
    const hours=Math.floor((total%86400)/3600);
    const minutes=Math.floor((total%3600)/60);
    const secs=total%60;
    return `${days ? `${days}d ` : ''}${hours}h ${minutes}m ${secs}s`;
  }

  function formatPlaylistDate(ts){
    const n=Number(ts)||0;
    if(!n) return 'Not available';
    return new Date(n).toLocaleString([], {dateStyle:'medium', timeStyle:'short'});
  }

  const SIDEBAR_ICON_CHOICES = ['', '★','☆','✦','✧','◆','◇','●','○','■','□','▲','△','☼','☾','♫','♬','≡','≈','⚑','❖','❯','⌁','◈','※','⊙','+'];
  let playlistInfoEditingId = null;
  let playlistInfoEditingDynamicNav = null;
  let playlistInfoEditingTarget = null;
  let playlistInfoLabelStyleGenerated = false;
  function renderPlaylistInfoIcons(selected='') {
    if(!el.playlistInfoIconMenu || !el.playlistInfoHeroIcon) return;
    // Lightning was a legacy choice; normalize old saved values to no icon so it
    // cannot reappear after opening the editor.
    if(selected === '⚡') selected = '';
    el.playlistInfoIconMenu.innerHTML = SIDEBAR_ICON_CHOICES.map(icon => `<button type="button" class="playlist-info-icon-menu-item${icon===selected?' selected':''}" data-icon="${escapeHtml(icon)}" role="menuitemradio" aria-checked="${icon===selected?'true':'false'}"><span>${icon ? escapeHtml(icon) : 'None'}</span>${icon===selected ? '<span class="playlist-info-icon-menu-check" aria-hidden="true">✓</span>' : ''}</button>`).join('');
    el.playlistInfoIconMenu.querySelectorAll('.playlist-info-icon-menu-item').forEach(b => b.addEventListener('click', e => {
      e.preventDefault();
      const icon = b.dataset.icon || '';
      el.playlistInfoIconMenu.querySelectorAll('.playlist-info-icon-menu-item').forEach(x => {
        x.classList.toggle('selected', x === b);
        x.setAttribute('aria-checked', x === b ? 'true' : 'false');
        const check = x.querySelector('.playlist-info-icon-menu-check');
        if (x === b && !check) x.insertAdjacentHTML('beforeend', '<span class="playlist-info-icon-menu-check" aria-hidden="true">✓</span>');
        if (x !== b && check) check.remove();
      });
      setPlaylistInfoHeroIcon(icon);
      closePlaylistInfoIconMenu();
    }));
    setPlaylistInfoHeroIcon(selected);
  }
  function setPlaylistInfoHeroIcon(icon='') {
    const glyph = String(icon || '♫');
    const glyphNode = el.playlistInfoHeroIcon?.querySelector?.('.playlist-info-hero-icon-glyph');
    if (glyphNode) glyphNode.textContent = glyph;
    else if (el.playlistInfoHeroIcon) el.playlistInfoHeroIcon.textContent = glyph;
    if(el.playlistInfoPreviewIcon) el.playlistInfoPreviewIcon.textContent = glyph;
  }
  function openPlaylistInfoIconMenu() {
    if (!el.playlistInfoIconMenu || !el.playlistInfoHeroIcon) return;
    el.playlistInfoIconMenu.classList.remove('hidden');
    el.playlistInfoHeroIcon.setAttribute('aria-expanded', 'true');
  }
  function closePlaylistInfoIconMenu() {
    if (!el.playlistInfoIconMenu || !el.playlistInfoHeroIcon) return;
    el.playlistInfoIconMenu.classList.add('hidden');
    el.playlistInfoHeroIcon.setAttribute('aria-expanded', 'false');
  }
  function selectedPlaylistInfoIcon(){return el.playlistInfoIconMenu?.querySelector('.playlist-info-icon-menu-item.selected')?.dataset.icon||'';}
  function renderPlaylistInfoLabelStyles(selected='plain') {
    const host=el.playlistInfoLabelStyles; if(!host) return;
    host.innerHTML=PLAYLIST_LABEL_STYLE_CHOICES.map(choice=>`<button type="button" class="playlist-label-style-choice${choice.id===selected?' selected':''}" data-style="${choice.id}" aria-pressed="${choice.id===selected?'true':'false'}"><strong>${choice.label}</strong><small>${choice.description}</small></button>`).join('');
    host.querySelectorAll('.playlist-label-style-choice').forEach(btn=>btn.addEventListener('click',()=>{
      const choice=PLAYLIST_LABEL_STYLE_CHOICES.find(x=>x.id===btn.dataset.style)||PLAYLIST_LABEL_STYLE_CHOICES[0];
      host.querySelectorAll('.playlist-label-style-choice').forEach(x=>{x.classList.toggle('selected',x===btn);x.setAttribute('aria-pressed',x===btn?'true':'false');});
      playlistInfoLabelStyleGenerated = true;
      if(el.playlistInfoLabelHtml) el.playlistInfoLabelHtml.value=choice.id==='plain' ? String(el.playlistInfoName?.value||'') : choice.html.replace('{text}',escapeHtml(String(el.playlistInfoName?.value||'Untitled Playlist')));
      applyPlaylistInfoLabelPreview();
      syncSidebarInfoLabelLive();
    }));
  }
  function applyPlaylistInfoLabelPreview(){
    const value=String(el.playlistInfoLabelHtml?.value||'').trim()||String(el.playlistInfoName?.value||'Untitled Playlist');
    if(el.playlistInfoLabelPreview) setRichLabel(el.playlistInfoLabelPreview,value);
    if(el.playlistInfoHeroLabel) setRichLabel(el.playlistInfoHeroLabel,value);
  }
  function setPlaylistInfoLabelEditor(value='') {
    const raw=String(value||'');
    if(el.playlistInfoLabelHtml) el.playlistInfoLabelHtml.value=raw;
    playlistInfoLabelStyleGenerated = !raw || raw === String(el.playlistInfoName?.value || '').trim();
    let selected='plain'; const m=raw.match(/hive-(glow|pulse|rainbow)/i); if(m) selected=m[1].toLowerCase();
    renderPlaylistInfoLabelStyles(selected); applyPlaylistInfoLabelPreview();
  }
  function selectedPlaylistInfoLabel(){ return sanitizeRichText(String(el.playlistInfoLabelHtml?.value||'').trim() || String(el.playlistInfoName?.value||'Untitled Playlist').trim()); }
  function sidebarInfoLabelKey(key) {
    const raw=String(key||'');
    if(!raw.startsWith('nav:')) return null;
    const nav=raw.slice(4);
    return sidebarDef(nav) ? nav : null;
  }
  function syncSidebarInfoLabelLive() {
    const key=playlistInfoEditingDynamicNav||playlistInfoEditingTarget?.key;
    const labelKey=sidebarInfoLabelKey(key);
    if(!labelKey) return;
    const label=selectedPlaylistInfoLabel();
    if(!label) return;
    sidebarNavigation.labels[labelKey]=label;
    renderSidebarNavigation();
    renderTabs();
    updateActiveTabLabel();
  }
  function showSidebarListInfo({key,name,description='',tracks=[],folder=''}) {
    if(!el.playlistInfoModal)return;
    playlistInfoEditingId=null;
    playlistInfoEditingDynamicNav=key;
    playlistInfoEditingTarget={key,folder};
    const runtime=tracks.reduce((sum,t)=>sum+(Number(t.duration)||0),0),meta=sidebarNavigation?.meta?.[key]||{},labelKey=sidebarInfoLabelKey(key);
    const isPodcastInfo = String(key).replace(/^nav:/,'') === 'podcasts';
    setRichLabel(el.playlistInfoTitle, String((labelKey&&sidebarNavigation?.labels?.[labelKey])||name||'Playlist'));
    if(el.playlistInfoHeroSubtitle) el.playlistInfoHeroSubtitle.textContent = isPodcastInfo ? 'Saved podcast shows and discovery settings.' : 'Customize how this collection appears in Hive.';
    el.playlistInfoBody.innerHTML=isPodcastInfo
      ? `<div class="playlist-info-stat-grid playlist-info-grid"><div><span>Favorite shows</span><strong>${Number(tracks.length||0).toLocaleString()}</strong></div><div><span>Source</span><strong>Podcast directory and saved shows</strong></div><div><span>Location</span><strong>${escapeHtml(description||'Podcasts')}</strong></div></div>`
      : `<div class="playlist-info-stat-grid playlist-info-grid"><div><span>Tracks</span><strong>${Number(tracks.length||0).toLocaleString()}</strong></div><div><span>Length</span><strong>${escapeHtml(formatPlaylistRuntime(runtime))}</strong></div><div><span>Location</span><strong>${escapeHtml(description||'Sidebar collection')}</strong></div></div>`;
    if(el.playlistInfoName){el.playlistInfoName.value=richLabelText(String(name||'Playlist'));el.playlistInfoName.disabled=!!folder;}
    const shortKey=String(key).startsWith('nav:')?String(key).slice(4):String(key);
    const savedView=sidebarDisplayView(shortKey, 'albums');
    const isPodcastSettings = shortKey === 'podcasts';
    if(el.playlistInfoDisplayView){el.playlistInfoDisplayView.value=savedView;el.playlistInfoDisplayView.disabled=isPodcastSettings;}
    if(el.playlistInfoShuffle){el.playlistInfoShuffle.checked=meta.shuffleOnEnter===true;el.playlistInfoShuffle.disabled=isPodcastSettings;}
    renderPlaylistInfoIcons(String(meta.icon||''));
    setPlaylistInfoLabelEditor(String((labelKey&&sidebarNavigation?.labels?.[labelKey])||name||''));
    if(el.playlistInfoSaveStatus)el.playlistInfoSaveStatus.textContent='';
    openModal(el.playlistInfoModal);
  }

  function showPlaylistInfo(pl){
    if(!pl||!el.playlistInfoModal)return;
    const tracks=tracksForPlaylist(pl),runtime=tracks.reduce((sum,t)=>sum+(Number(t.duration)||0),0),added=(pl.trackAddedAt&&typeof pl.trackAddedAt==='object')?Object.values(pl.trackAddedAt).map(Number).filter(Number.isFinite):[],lastAdded=added.length?Math.max(...added):0,missing=Math.max(0,(pl.tracks||[]).length-tracks.length);
    playlistInfoEditingId=pl.id;playlistInfoEditingDynamicNav=null;playlistInfoEditingTarget={key:`playlist:${pl.id}`,playlistId:pl.id};setRichLabel(el.playlistInfoTitle, String(pl.label||pl.name||'Untitled Playlist'));
    if(el.playlistInfoHeroSubtitle) el.playlistInfoHeroSubtitle.textContent = pl.smart ? 'Dynamic membership is generated from its Auto Playlist rules.' : 'Customize how this playlist appears in Hive.';
    el.playlistInfoBody.innerHTML=`<div class="playlist-info-stat-grid playlist-info-grid"><div><span>Tracks</span><strong>${tracks.length.toLocaleString()}${missing?` (${missing.toLocaleString()} missing locally)`:''}</strong></div><div><span>Length</span><strong>${escapeHtml(formatPlaylistRuntime(runtime))}</strong></div><div><span>Last track added</span><strong>${escapeHtml(pl.smart?'Dynamic playlist — membership is generated from its rules.':formatPlaylistDate(lastAdded))}</strong></div></div>`;if(el.playlistInfoName){el.playlistInfoName.value=pl.name||'Untitled Playlist';el.playlistInfoName.disabled=false;}if(el.playlistInfoDisplayView){el.playlistInfoDisplayView.value=['albums','songs','artists'].includes(pl.displayView)?pl.displayView:'albums';el.playlistInfoDisplayView.disabled=false;}if(el.playlistInfoShuffle){el.playlistInfoShuffle.checked=pl.shuffleOnEnter===true;el.playlistInfoShuffle.disabled=false;}renderPlaylistInfoIcons(String(pl.icon||''));setPlaylistInfoLabelEditor(String(pl.label||pl.name||''));if(el.playlistInfoSaveStatus)el.playlistInfoSaveStatus.textContent='';openModal(el.playlistInfoModal);
  }
  async function savePlaylistInfoChanges(){
    const displayView=['albums','songs','artists'].includes(el.playlistInfoDisplayView?.value)?el.playlistInfoDisplayView.value:'albums';const shuffleOnEnter=!!el.playlistInfoShuffle?.checked;const icon=selectedPlaylistInfoIcon();const label=selectedPlaylistInfoLabel();
    if(playlistInfoEditingId!=null&&!playlistInfoEditingDynamicNav){const pl=playlists.find(p=>String(p.id)===String(playlistInfoEditingId));if(!pl)return;const name=el.playlistInfoName?.value.trim();if(!name)return;const updated=await window.beehive.savePlaylist({...pl,name,displayView,shuffleOnEnter,icon,label});playlists=playlists.map(p=>String(p.id)===String(updated.id)?updated:p);
      // Favorites and user playlists can also have a canonical sidebar entry. Keep
      // that projection synchronized with the persisted playlist so rich labels
      // and icons do not silently disappear from the sidebar.
      sidebarNavigation.custom = sidebarNavigation.custom.map(entry => String(entry?.playlistId) === String(updated.id)
        ? {...entry, label: updated.label || updated.name || entry.label, icon: String(updated.icon || '')}
        : entry);
      syncPlaylistSidebarPresentation();
      refreshPlaylistTabPresentation(updated);
      // Rebuild pinned navigation immediately after a live playlist edit.
      // Without this, a pinned Favorites/custom-playlist tab can retain the
      // pre-edit projection until the next cold-start hydration pass.
      syncPinnedTabs();
      saveNavigationPrefs();
      // Playlist Info edits are also immediately reflected in the sidebar and
      // tab projections. Persistence alone is insufficient because those
      // projections are not rebuilt until a later navigation/startup cycle.
      renderSidebarNavigation();
      renderTabs();
      updateActiveTabLabel();
      visualShuffleOrders.delete(visualShuffleKeyForPlaylist(updated));if(activePlaylistId===updated.id){viewMode=displayView;setView(viewMode);if(el.sectionTitleText)el.sectionTitleText.textContent=updated.name;syncTabControls();renderTabs();saveActiveTabState();}renderPlaylistManager();try{await window.beehive.saveUiState?.(serializeUiState());}catch{}if(el.playlistInfoSaveStatus)el.playlistInfoSaveStatus.textContent='Saved';return;}
    const key=playlistInfoEditingDynamicNav||playlistInfoEditingTarget?.key;if(!key)return;sidebarNavigation.meta=sidebarNavigation.meta||{};const isPodcastInfo=String(key).replace(/^nav:/,'')==='podcasts';sidebarNavigation.meta[key]={...(sidebarNavigation.meta[key]||{}),...(isPodcastInfo?{}:{shuffleOnEnter,displayView}),icon};if(!playlistInfoEditingTarget?.folder){const newName=String(el.playlistInfoName?.value||'').trim();const labelKey=sidebarInfoLabelKey(key);if(newName&&labelKey)sidebarNavigation.labels[labelKey]=label||newName;}const visualKey=key.startsWith('nav:')?visualShuffleKeyForSidebar(key.slice(4)):key;visualShuffleOrders.delete(visualKey);saveNavigationPrefs();if(playlistInfoEditingTarget?.folder)await refreshFolders();renderSidebarNavigation();renderTabs();if(specialView && ((specialView==='folder' && playlistInfoEditingTarget?.folder) || (specialView==='recent' && key==='nav:pl-recent') || (specialView==='top' && key==='nav:pl-top') || (specialView==='history' && key==='nav:history') || (specialView==='sandbox' && key==='nav:sandbox') || (specialView==='podcasts' && key==='nav:podcasts'))) renderCurrentView();updateActiveTabLabel();if(el.playlistInfoSaveStatus)el.playlistInfoSaveStatus.textContent='Saved';
  }

  function duplicatePlaylistName(name, allPlaylists = playlists) {
    const base = String(name || 'Untitled Playlist').trim() || 'Untitled Playlist';
    const existing = new Set((Array.isArray(allPlaylists) ? allPlaylists : []).map(p => String(p?.name || '').trim()));
    const first = `${base} Copy`;
    if (!existing.has(first)) return first;
    let n = 2;
    while (existing.has(`${base} Copy ${n}`)) n += 1;
    return `${base} Copy ${n}`;
  }

  async function duplicatePlaylist(pl) {
    if (!pl) return null;
    const copy = { ...pl, id: undefined, name: duplicatePlaylistName(pl.name), systemKey: undefined, createdAt: undefined, updatedAt: undefined };
    delete copy.id;
    delete copy.systemKey;
    const saved = await window.beehive.savePlaylist(copy);
    playlists = await window.beehive.getPlaylists();
    renderPlaylistManager();
    renderNavigationEditors();
    showAppNotice(`Created “${saved.name}”.`);
    return saved;
  }

  function playlistSidebarEntryId(pl) { return `playlist-${String(pl?.id || '').replace(/[^a-zA-Z0-9_-]/g, '-')}`; }
  function playlistIsInSidebar(pl) {
    return !!pl && sidebarNavigation.custom.some(x => x?.type === 'playlist' && String(x.playlistId) === String(pl.id));
  }
  function addPlaylistToSidebar(pl) {
    if (!pl || playlistIsInSidebar(pl)) return false;
    const id = playlistSidebarEntryId(pl);
    const entry = { id, type:'playlist', playlistId:String(pl.id), label:playlistLabel(pl), icon:pl.systemKey === 'star-favorites' ? '★' : String(pl.icon || ''), description:pl.smart ? 'Auto Playlist' : 'Playlist' };
    sidebarNavigation.custom.push(entry);
    const insertAt = sidebarNavigation.order.indexOf('pl-explorer');
    sidebarNavigation.order.splice(insertAt >= 0 ? insertAt + 1 : sidebarNavigation.order.length, 0, id);
    saveNavigationPrefs();
    renderSidebarNavigation();
    renderNavigationEditors();
    showAppNotice(`Added “${pl.name}” to the sidebar.`);
    return true;
  }

  function removePlaylistFromSidebar(id) {
    const entry = sidebarCustom(id);
    if (!entry || entry.type !== 'playlist') return false;
    sidebarNavigation.custom = sidebarNavigation.custom.filter(x => x.id !== id);
    sidebarNavigation.order = sidebarNavigation.order.filter(x => x !== id);
    saveNavigationPrefs();
    renderSidebarNavigation();
    renderNavigationEditors();
    return true;
  }

  function showPlaylistContextMenu(e, pl){
    if(!pl) return;
    e.preventDefault();
    showContextMenu(e.clientX,e.clientY,[
      {label:'Add playlist to queue',action:()=>{const tracks=tracksForPlaylist(pl);if(!tracks.length){showAppNotice('This playlist has no tracks.');return;}addTracksToQueue(tracks);}},
      {label:'Info',action:()=>showPlaylistInfo(pl)},
      {label:'Play playlist',action:()=>playPlaylist(pl)},
      {label:'Duplicate playlist',action:()=>duplicatePlaylist(pl)},
      {label:playlistIsInSidebar(pl) ? 'Remove from sidebar' : 'Add to sidebar',action:()=>playlistIsInSidebar(pl) ? removePlaylistFromSidebar(sidebarNavigation.custom.find(x=>x.type==='playlist'&&String(x.playlistId)===String(pl.id))?.id) : addPlaylistToSidebar(pl)},
      ...(pl.smart ? [{label:'Edit smart playlist',action:()=>openSmartPlaylistModal(pl)}] : []),
      {label:'Export as M3U',action:()=>exportNamedPlaylist(pl)},
      {label:'Delete playlist',danger:true,action:async()=>{await window.beehive.deletePlaylist(pl.id);playlists=playlists.filter(x=>x.id!==pl.id);if(activePlaylistId===pl.id){activePlaylistId=null;specialView=null;}renderPlaylistManager();}}
    ]);
  }

  function smartFieldValue(t,field){
    const n = v => Number(v || 0);
    const text = v => normalizeMetadataText(v);
    const map = {
      title:t.title, artist:t.artist, album:t.album, albumArtist:t.albumArtist,
      genre:t.genre, composer:t.composer, publisher:t.publisher, conductor:t.conductor,
      comment:normalizeMetadataText(t.comment), grouping:t.grouping, copyright:t.copyright,
      originalArtist:t.originalArtist, originalAlbum:t.originalAlbum, originalYear:t.originalYear,
      language:t.language, mood:t.mood, occasion:t.occasion, keywords:t.keywords,
      quality:t.quality, tempo:t.tempo, isrc:t.isrc, barcode:t.barcode,
      year:n(t.year), releaseDate:text(t.releaseDate || t.year || ''), plays:n(t.playCount), skipCount:n(t.skipCount), rating:n(t.rating), love:t.loved?'Loved':'Not Loved', favorite:!!t.loved,
      duration:n(t.duration), time:n(t.duration), sampleRate:n(t.sampleRate), bitrate:n(t.bitrate),
      track:n(t.track), disc:n(t.disk), trackCount:n(t.trackCount), discCount:n(t.discCount),
      addedAt:n(t.addedAt), dateAdded:n(t.addedAt), lastPlayedAt:n(t.lastPlayedAt),
      playlist:playlists.filter(p=>!p.smart && Array.isArray(p.tracks) && p.tracks.includes(t.path)).map(p=>p.name).join(' | '),
      path:text(t.path), codec:text(t.codec), fileType:text(t.codec), channels:n(t.channels),
      season:text(t.season), ticketed:text(t.ticketed), trackGain:text(t.trackGain), sortAlbum:text(t.sortAlbum || t.album),
      sortAlbumArtist:text(t.sortAlbumArtist || t.albumArtist), sortArtist:text(t.sortArtist || t.artist), sortComposer:text(t.sortComposer || t.composer), sortTitle:text(t.sortTitle || t.title),
      videoKind:text(t.videoKind), virtual1:text(t.customTags?.VIRTUAL1), virtual2:text(t.customTags?.VIRTUAL2), virtual3:text(t.customTags?.VIRTUAL3),
      lyrics:normalizeMetadataText(t.lyrics), albumRating:n(t.albumRating), quality:text(t.quality),
      ...Object.fromEntries(Object.entries(t.customTags || {}).map(([k,v])=>[k,v]))
    };
    return map[field] !== undefined ? map[field] : text(t[field]);
  }
  function smartCompare(t,rule){
    const value=smartFieldValue(t,rule.field), op=rule.op, target=rule.value ?? '';
    if(rule.field==='favorite') return op==='is' ? value === (target==='true') : value !== (target==='true');
    if(rule.field==='love') { const wanted=String(target).toLowerCase(); return op==='is' ? String(value).toLowerCase()===wanted : String(value).toLowerCase()!==wanted; }
    const numericFields=['year','originalYear','plays','skipCount','rating','duration','sampleRate','bitrate','track','disc','trackCount','discCount','addedAt','lastPlayedAt','channels','tempo','quality'];
    if(numericFields.includes(rule.field)){
      const n=Number(target); if(!Number.isFinite(n))return false;
      if(op==='eq')return Number(value)===n; if(op==='gt')return Number(value)>n; if(op==='gte')return Number(value)>=n; if(op==='lt')return Number(value)<n; if(op==='lte')return Number(value)<=n;
      return false;
    }
    const a=String(value).toLowerCase(), b=String(target).toLowerCase();
    if(op==='contains')return a.includes(b); if(op==='is')return a===b; if(op==='not')return a!==b; if(op==='starts')return a.startsWith(b); if(op==='ends')return a.endsWith(b); if(op==='empty')return !a.trim(); if(op==='notempty')return !!a.trim();
    return false;
  }
  function smartSourceTracks(pl){
    const source=pl?.sourceType||'library';
    if(source==='playlist'){
      const sourcePl=playlists.find(x=>String(x.id)===String(pl.sourceValue));
      return sourcePl ? tracksForPlaylist(sourcePl) : [];
    }
    if(source==='folder'){
      const folder=String(pl.sourceValue||'').replace(/[\\/]$/,'').toLowerCase();
      return folder ? library.tracks.filter(t=>String(t.path||'').toLowerCase()===folder || String(t.path||'').toLowerCase().startsWith(folder+'\\') || String(t.path||'').toLowerCase().startsWith(folder+'/')) : [];
    }
    return library.tracks.slice();
  }
  function smartDeduplicate(tracks){
    const seen=new Set(), out=[];
    for(const t of tracks){
      const key=String(t.path||'').toLowerCase();
      const identity=String(t.title||'').trim().toLowerCase()+'|'+String(t.artist||'').trim().toLowerCase()+'|'+String(t.duration||0);
      const k=identity || key;
      if(seen.has(k)) continue;
      seen.add(k); out.push(t);
    }
    return out;
  }
  function sortSmartTracks(out,sort){
    if(sort==='random') return shuffleForPlayback(out);
    if(sort==='title') out.sort((a,b)=>String(a.title||'').localeCompare(String(b.title||''),undefined,{numeric:true,sensitivity:'base'}));
    else if(sort==='artist') out.sort((a,b)=>String(a.artist||'').localeCompare(String(b.artist||''),undefined,{numeric:true,sensitivity:'base'}));
    else if(sort==='album') out.sort((a,b)=>String(a.album||'').localeCompare(String(b.album||''),undefined,{numeric:true,sensitivity:'base'}));
    else if(sort==='playsDesc') out.sort((a,b)=>Number(b.playCount||0)-Number(a.playCount||0));
    else if(sort==='ratingDesc') out.sort((a,b)=>Number(b.rating||0)-Number(a.rating||0));
    else if(sort==='lastPlayedDesc') out.sort((a,b)=>Number(b.lastPlayedAt||0)-Number(a.lastPlayedAt||0));
    else out.sort((a,b)=>Number(b.addedAt||0)-Number(a.addedAt||0));
    return out;
  }
  function evaluateSmartPlaylist(pl){
    const rules=Array.isArray(pl.rules)?pl.rules.filter(r=>r?.field):[];
    let out=smartSourceTracks(pl).filter(t=>!rules.length || (pl.match==='any' ? rules.some(r=>smartCompare(t,r)) : rules.every(r=>smartCompare(t,r))));
    if(pl.filterDuplicates) out=smartDeduplicate(out);
    out=sortSmartTracks(out, pl.sort || 'addedDesc');
    const isStarFavorites = pl?.systemKey === 'star-favorites' || pl?.id === 'hive-star-favorites';
    // No limit is set (0/null/undefined) by default -- a smart playlist
    // includes every matching track unless the user explicitly caps it.
    const hasLimit = Number(pl.limit) > 0;
    const limit=isStarFavorites || !hasLimit ? Infinity : Math.max(1,Number(pl.limit));
    // Favorites is a canonical, unlimited track collection. Do not apply the
    // generic select-by-artist/album reduction here: that would turn thousands
    // of Loved files into roughly one row per artist/album when Infinity is used.
    if(!isStarFavorites){
      const selectBy=pl.selectBy||'track';
      if(selectBy==='track') out=out.slice(0,limit);
      else {
        const seen=new Set(), selected=[];
        for(const t of out){
          const key=selectBy==='album' ? String(t.album||'').toLowerCase() : String(t.artist||'').toLowerCase();
          if(seen.has(key)) continue;
          seen.add(key); selected.push(t);
          if(selected.length>=limit) break;
        }
        out=selected;
      }
    }
    if(pl.smartShuffle==='random') out=shuffleForPlayback(out);
    return out;
  }

  async function logFavoritesPipelineDiagnostics(stage = 'unknown') {
    const favorites = starFavoritesPlaylist();
    const sourceTracks = favorites ? smartSourceTracks(favorites) : [];
    const rules = Array.isArray(favorites?.rules) ? favorites.rules.filter(r => r?.field) : [];
    const matches = sourceTracks.filter(t => !rules.length || (favorites.match === 'any' ? rules.some(r => smartCompare(t, r)) : rules.every(r => smartCompare(t, r))));
    const evaluatorTracks = favorites ? evaluateSmartPlaylist(favorites) : [];
    let libraryLovedCount = 0;
    let libraryUnhydratedLoveCount = 0;
    const libraryLovedPaths = [];
    for (const track of (library.tracks || [])) {
      if (track?.loved) {
        libraryLovedCount++;
        if (track?.path) libraryLovedPaths.push(String(track.path));
      }
      if (track?.path && track?.loveHydrated !== true) libraryUnhydratedLoveCount++;
    }
    const libraryLovedPathSet = new Set(libraryLovedPaths);
    const matchedPaths = new Set(matches.map(t => String(t?.path || '')).filter(Boolean));
    const evaluatorPaths = new Set(evaluatorTracks.map(t => String(t?.path || '')).filter(Boolean));
    const libraryLovedNotMatched = libraryLovedPaths.filter(p => !matchedPaths.has(p));
    const matchedNotLoved = [...matchedPaths].filter(p => !libraryLovedPathSet.has(p));
    const report = {
      stage,
      generatedAt: new Date().toISOString(),
      libraryTrackCount: Array.isArray(library.tracks) ? library.tracks.length : 0,
      libraryLovedCount,
      libraryUnhydratedLoveCount,
      favoriteInputTrackCount: sourceTracks.length,
      favoriteRuleMatchCount: matches.length,
      favoriteEvaluatorCount: evaluatorTracks.length,
      favoriteEvaluatorDelta: matches.length - evaluatorTracks.length,
      favoriteEvaluatorLostPaths: [...matchedPaths].filter(p => !evaluatorPaths.has(p)),
      libraryLovedNotMatchedPaths: libraryLovedNotMatched,
      matchedNotLovedPaths: matchedNotLoved,
      favoriteLimit: favorites?.systemKey === 'star-favorites' || favorites?.id === 'hive-star-favorites' ? Infinity : Number(favorites?.limit || 0),
      favoriteSelectBy: favorites?.selectBy || 'track',
      favoriteSystemKey: favorites?.systemKey || '',
      favoriteId: favorites?.id || '',
      favoriteMatchMode: favorites?.match || 'all',
      favoriteFilterDuplicates: !!favorites?.filterDuplicates,
      favoriteRules: rules
    };
    console.info('[Beehive] FAVORITES PIPELINE DIAGNOSTIC', {
      stage: report.stage,
      libraryTrackCount: report.libraryTrackCount,
      libraryLovedCount: report.libraryLovedCount,
      libraryUnhydratedLoveCount: report.libraryUnhydratedLoveCount,
      favoriteInputTrackCount: report.favoriteInputTrackCount,
      favoriteRuleMatchCount: report.favoriteRuleMatchCount,
      favoriteEvaluatorCount: report.favoriteEvaluatorCount,
      favoriteEvaluatorDelta: report.favoriteEvaluatorDelta,
      libraryLovedNotMatchedCount: report.libraryLovedNotMatchedPaths.length,
      matchedNotLovedCount: report.matchedNotLovedPaths.length,
      favoriteEvaluatorLostCount: report.favoriteEvaluatorLostPaths.length,
      favoriteLimit: report.favoriteLimit,
      favoriteSelectBy: report.favoriteSelectBy,
      favoriteSystemKey: report.favoriteSystemKey,
      favoriteId: report.favoriteId,
      favoriteMatchMode: report.favoriteMatchMode,
      favoriteFilterDuplicates: report.favoriteFilterDuplicates,
      favoriteRules: report.favoriteRules
    });
    try {
      if (window.beehive.writeFavoritesPipelineDiagnostic) {
        const result = await window.beehive.writeFavoritesPipelineDiagnostic(report);
        console.info('[Beehive] FAVORITES PIPELINE DIAGNOSTIC REPORT', result || {});
        return result;
      }
    } catch (err) {
      console.warn('[Beehive] FAVORITES PIPELINE DIAGNOSTIC REPORT WRITE FAILED', err);
    }
    return null;
  }
  function normalizePlaylistPath(value){
    let raw=String(value||'').trim();
    if(!raw)return '';
    if(/^file:\/\//i.test(raw)){
      try { raw=decodeURIComponent(new URL(raw).pathname); } catch { raw=raw.replace(/^file:\/\//i,''); }
    } else {
      try { raw=decodeURIComponent(raw); } catch {}
    }
    return raw.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
  }
  function normalizeMusicText(value){ return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
  function matchImportedTrack(entry){
    const ep=normalizePlaylistPath(entry.path);
    let t=libraryTrackByNormalizedPath.get(ep);
    if(t)return t;
    // When a playlist is moved to another computer, absolute paths will usually
    // differ. Prefer the MusicBee/EXTINF metadata match before basename matching
    // so duplicate filenames from different albums do not get remapped incorrectly.
    const artist=normalizeMusicText(entry.info?.artist), title=normalizeMusicText(entry.info?.title);
    if(title){
      t=libraryTrackByTitleArtist.get(`${title}||${artist}`) || null;
      if(!t && !artist) t=libraryTrackByTitleArtist.get(`${title}||`) || null;
      if(t)return t;
    }
    const base=ep.split('/').pop();
    t=libraryTrackByBasename.get(base) || null;
    return t || null;
  }
  function matchSpotifyTrack(entry){
    const title=normalizeMusicText(entry.title), artist=normalizeMusicText(entry.artist);
    const exact = libraryTrackByTitleArtist.get(`${title}||${artist}`);
    if (exact) return exact;
    return libraryTrackByTitleArtist.get(`${title}||`) || null;
  }
  async function exportPlaylist(name, tracks){
    if(!tracks?.length){ showAppNotice('This playlist has no matching local tracks to export.'); return; }
    const result=await window.beehive.exportPlaylistM3U({name,tracks});
    if(!result?.canceled) showAppNotice(`Exported ${result.count} tracks to ${result.path}`);
  }
  async function exportNamedPlaylist(pl){ if(pl?.source==='spotify'){ showAppNotice('Spotify playlists cannot be exported as local M3U files.'); return; } return exportPlaylist(pl.name, tracksForPlaylist(pl)); }
  async function importPlaylistFile(){
    try{
      const picked=await window.beehive.choosePlaylistImportFile(); if(!picked)return;
      const matched=[], unmatched=[];
      for(const entry of picked.entries||[]){ const t=matchImportedTrack(entry); if(t)matched.push(t.path); else unmatched.push(entry); }
      const unique=[...new Set(matched)];
      if(!unique.length){ showAppNotice(`No tracks from “${picked.name}” matched your Beehive library.`); return; }
      const pl=await window.beehive.savePlaylist({name:picked.name,tracks:unique,smart:false,source:'m3u',sourcePath:picked.path,unmatched:unmatched.map(x=>x.info?.title||x.path)});
      playlists=await window.beehive.getPlaylists(); closeModal(el.playlistImportModal); renderPlaylistManager();
      showAppNotice(`Imported “${pl.name}” with ${unique.length} local tracks${unmatched.length?` (${unmatched.length} not found in the library)`:''}.`);
    }catch(err){ showAppNotice(err.message||'Could not import playlist.'); }
  }
  function spotifyDurationSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    // Spotify metadata normally uses milliseconds. Some public playlist
    // payloads expose seconds instead, so accept either without turning a
    // three-minute track into a three-thousand-minute monster.
    return n > 10000 ? n / 1000 : n;
  }
  async function preloadSpotifyArtwork(tracks, playlistCover='') {
    const urls = [...new Set([
      playlistCover,
      ...(Array.isArray(tracks) ? tracks.map(t => spotifyArtworkUrl(t)) : [])
    ].map(normalizeSpotifyArtworkSource).filter(u => /^https?:\/\//i.test(u)))];
    if (!urls.length) return { tracks, playlistCoverFile:'' };
    try {
      const cached = await window.beehive.spotifyCacheArtwork?.(urls);
      for (const track of Array.isArray(tracks) ? tracks : []) {
        const url = normalizeSpotifyArtworkSource(spotifyArtworkUrl(track));
        if (url && cached?.[url]) track.spotifyArtworkCacheFile = cached[url];
      }
      const normalizedCover = normalizeSpotifyArtworkSource(playlistCover);
      return { tracks, playlistCoverFile:cached?.[normalizedCover] || '' };
    } catch (err) {
      console.warn('[Spotify Artwork] persistent cache warmup failed:', err?.message || String(err));
      return { tracks, playlistCoverFile:'' };
    }
  }

  async function importSpotifyPlaylist(){
    const input=await themedPrompt('Spotify playlist URL:', 'https://open.spotify.com/playlist/', 'Import Spotify playlist');
    if(!input)return;
    try{
      const data=await window.beehive.importSpotifyPlaylist(input);
      const spotifyTracks=(data.tracks||[]).map((entry,i)=>({
        path:`spotify:track:${entry.spotifyId || i}`,
        source:'spotify', spotifyUri:entry.spotifyUri || `spotify:track:${entry.spotifyId}`,
        spotifyId:entry.spotifyId || '', spotifyContextUri:entry.contextUri || data.contextUri || (data.id ? `spotify:playlist:${data.id}` : ''), contextUri:entry.contextUri || data.contextUri || (data.id ? `spotify:playlist:${data.id}` : ''), title:entry.title || 'Unknown title', artist:entry.artist || 'Unknown artist',
        album:entry.album || '', albumUri:entry.albumUri || '', year:entry.year || '', duration:spotifyDurationSeconds(entry.duration), cover:entry.cover || entry.artworkUrl || '', artworkUrl:entry.artworkUrl || entry.cover || '', track:i+1,
        albumArtist:entry.albumArtist || entry.artist || '', year:entry.year || ''
      })).filter(t=>t.spotifyUri);
      if(!spotifyTracks.length){ showAppNotice(`Spotify playlist “${data.name}” did not contain playable tracks.`); return; }
      const playlistCover = normalizeSpotifyArtworkSource(data.cover || data.artworkUrl || spotifyTracks[0]?.artworkUrl || '');
      const warm = await preloadSpotifyArtwork(spotifyTracks, playlistCover);
      const pl=await window.beehive.savePlaylist({name:data.name,tracks:[],spotifyTracks,smart:false,source:'spotify',sourceUrl:data.sourceUrl,spotifyPlaylistId:data.id,cover:playlistCover,artworkUrl:playlistCover,spotifyArtworkCacheFile:warm?.playlistCoverFile || '',description:'Spotify streaming playlist. Audio remains in Spotify; Hive controls the Spotify player.'});
      playlists=await window.beehive.getPlaylists(); closeModal(el.playlistImportModal); renderPlaylistManager();
      showAppNotice(`Imported “${pl.name}” with ${spotifyTracks.length} Spotify tracks. Audio will stream through Spotify.`);
    }catch(err){
      showAppNotice(`${err.message||'Could not import Spotify playlist.'} If Spotify authentication is required, start Spotify with spicetify auto, sign in there, and try the import again.`);
    }
  }

  function rowImportButtons(list){
    list.querySelectorAll('.playlist-row').forEach((row,i)=>{
      const pl=playlists[i];
      row.addEventListener('contextmenu',e=>showPlaylistContextMenu(e,pl));
    });
  }

  function preparePlaylistMusicTab(tab, pl) {
    if (!tab || !pl) return tab;
    // A playlist owns its opening presentation. New/open-from-sidebar activation
    // follows Playlist Info's configured Albums/Tracks/Artists view; once the
    // independent tab is already open, ordinary reactivation preserves the
    // user's current view unless Playlist Info was just edited.
    const configuredView = ['albums','songs','artists'].includes(pl.displayView) ? pl.displayView : 'albums';
    const view = ['albums','songs','artists'].includes(tab.state?.viewMode) ? tab.state.viewMode : configuredView;
    tab.state = {...(tab.state || {}), searchTerm:'', artistSearchTerm:'', viewMode:view, specialView:'playlist', activeFolderPath:'', activePlaylistId:pl.id};
    tab.baseLabel = playlistLabel(pl) || 'Playlist';
    tab.label = tab.baseLabel;
    tab.baseIcon = String(pl.icon || '');
    tab.icon = tab.baseIcon;
    return tab;
  }

  function openOrReusePlaylistMusicTab(pl) {
    if (!pl) return;
    const existing = tabs.find(t => t.kind === 'music' && String(t.state?.activePlaylistId || '') === String(pl.id) && t.state?.specialView === 'playlist');
    if (existing) {
      // Re-entering a playlist from the sidebar is an activation of that
      // playlist's independent Music tab, never a request to show the manager.
      preparePlaylistMusicTab(existing, pl);
      if (activeTabId !== existing.id) {
        activeTabId = existing.id;
        renderTabs();
        restoreTabState(existing);
      } else {
        restoreTabState(existing);
        renderCurrentView();
        updateActiveTabLabel();
        syncTabControls();
      }
      return existing;
    }
    saveActiveTabState();
    tabSeq += 1;
    const id = 'tab-extra-' + tabSeq;
    const label = playlistLabel(pl) || 'Favorites';
    const icon = pl.systemKey === 'star-favorites' ? '★' : String(pl.icon || '');
    const tab = {
      id,
      label,
      icon,
      kind: 'music',
      closable: true,
      baseLabel: label,
      baseIcon: icon,
      state: {
        searchTerm: '',
        artistSearchTerm: '',
        albumYearDividers: true,
        viewMode: ['albums','songs','artists'].includes(pl.displayView) ? pl.displayView : 'albums',
        specialView: 'playlist',
        activeFolderPath: '',
        activePlaylistId: pl.id,
        openAlbumKey: null,
        highlightedAlbumKey: null,
        scrollTop: 0
      },
      dom: null
    };
    tab.dom = makeTabDom(defaultMusicTab);
    tab.dom.albumsGrid.innerHTML = '';
    tab.dom.songsTable.innerHTML = '';
    tab.dom.artistsGrid.innerHTML = '';
    tab.dom.initialized = false;
    preparePlaylistMusicTab(tab, pl);
    tabs.push(tab);
    activeTabId = id;
    renderTabs();
    restoreTabState(tab);
    renderCurrentView();
    saveActiveTabState();
    updateActiveTabLabel();
    syncTabControls();
    return tab;
  }

  function openPlaylistInNewMusicTab(pl) { return openOrReusePlaylistMusicTab(pl); }

  async function renderPlaylistManager(tab = getActiveTab()){
    // Playlist Manager owns the DOM surface of the canonical Playlists context.
    // Never resolve its nodes through document-global ids: hidden canonical
    // contexts remain mounted, so a global lookup can target the wrong surface.
    if (!tab || tab.kind !== 'playlists' || getActiveTab()?.id !== tab.id) return false;
    const placeholder = tab.dom?.tabPlaceholder;
    if (!placeholder) return false;
    hideContentViews();
    placeholder.classList.remove('hidden');
    placeholder.innerHTML='<div class="playlist-manager"><div class="playlist-manager-head"><div><p class="playlist-manager-kicker">PLAYLISTS</p><p class="dim">Create local playlists, dynamic smart playlists, or Spotify streaming playlists.</p></div><div class="playlist-manager-create"><button type="button" data-role="playlist-import" class="sidebar-add">Import Playlist</button><button type="button" data-role="playlist-new" class="sidebar-add">+ New playlist</button><button type="button" data-role="playlist-smart" class="sidebar-add">✦ Smart playlist</button></div></div><div data-role="playlist-manager-list"></div></div>';
    const list=placeholder.querySelector('[data-role="playlist-manager-list"]');

    // Bind through the stable placeholder so a playlist-manager rerender cannot
    // strand the controls. The manager is rebuilt whenever playlist state changes.
    el.tabPlaceholder.onclick=(event)=>{
      const target=event.target?.closest?.('button');
      if(!target) return;
      if(target.dataset.role==='playlist-import'){ event.preventDefault(); openModal(el.playlistImportModal); }
      else if(target.dataset.role==='playlist-new'){ event.preventDefault(); openNewPlaylistModal(); }
      else if(target.dataset.role==='playlist-smart'){ event.preventDefault(); openSmartPlaylistModal(); }
    };

    if(!playlists.length){ list.innerHTML='<div class="empty-state small-empty"><p>No playlists yet. Create one to get started.</p></div>'; renderNavigationEditors(); return; }

    // Playlist membership can contain thousands of paths. Never build one DOM
    // row per playlist and never resolve every membership path just to display
    // the manager. Static playlist counts are O(1); smart counts are evaluated
    // only when the user actually opens/inspects the playlist.
    list.innerHTML='<div class="playlist-list-viewport"><div class="playlist-list-spacer"></div><div class="playlist-list-window"></div></div>';
    const viewport=list.querySelector('.playlist-list-viewport');
    const spacer=list.querySelector('.playlist-list-spacer');
    const win=list.querySelector('.playlist-list-window');
    playlistVirtualState.viewport=viewport;
    playlistVirtualState.spacer=spacer;
    playlistVirtualState.window=win;
    playlistVirtualState.lastStart=-1;
    playlistVirtualState.lastEnd=-1;

    function makePlaylistRow(pl, index){
      const row=document.createElement('div');
      row.className='playlist-row';
      row.dataset.index=String(index);
      const count = pl.smart ? null : (Array.isArray(pl.tracks) ? pl.tracks.length : 0);
      const plIcon = String(pl.icon || '');
      row.innerHTML=`<div class="playlist-row-name">${pl.source==='spotify' && (pl.cover || pl.artworkUrl) ? `<img class="playlist-row-cover" src="${escapeHtml(coverSrc(pl.cover || pl.artworkUrl))}" alt="" loading="eager" decoding="async" />` : ''}${plIcon ? `<span class="playlist-row-icon">${escapeHtml(plIcon)}</span>` : ''}<strong class="playlist-row-rich-name"></strong>${pl.smart?'<span class="smart-badge">AUTO PLAYLIST</span>':''}${pl.source==='spotify'?'<span class="smart-badge">SPOTIFY</span>':''}<div class="dim small">${pl.smart?'Dynamic · updates automatically':pl.source==='spotify'?`${Array.isArray(pl.spotifyTracks)?pl.spotifyTracks.length:0} Spotify track${(Array.isArray(pl.spotifyTracks)?pl.spotifyTracks.length:0)===1?'':'s'}`:`${count} track${count===1?'':'s'}`}</div></div><div class="playlist-actions"><button class="sidebar-add play-pl">▶ Play</button><button class="sidebar-add del-pl">Delete</button></div>`;
      setRichLabel(row.querySelector('.playlist-row-rich-name'), playlistLabel(pl));
      row.querySelector('.play-pl').onclick=e=>{e.stopPropagation();playPlaylist(pl);};
      row.querySelector('.del-pl').onclick=async e=>{e.stopPropagation();await window.beehive.deletePlaylist(pl.id);playlists=playlists.filter(x=>x.id!==pl.id);if(activePlaylistId===pl.id){activePlaylistId=null;specialView=null;}renderPlaylistManager();};
      row.addEventListener('click',async()=>{
        // A playlist is its own browser context. Open it in a new Music tab
        // instead of reusing the primary Music tab, so its scroll position and
        // expanded album state remain independent like every other Music tab.
        if (pl?.source === 'spotify') {
          const normalized = normalizeSpotifyPlaylistRecord(pl);
          playlists = playlists.map(item => String(item.id) === String(pl.id) ? normalized : item);
          pl = normalized;
        }
        openPlaylistInNewMusicTab(pl);
        if (pl?.source === 'spotify') {
          void hydrateSpotifyPlaylist(pl).then(updated => {
            if (!updated || String(activePlaylistId) !== String(updated.id) || specialView !== 'playlist') return;
            const active = playlists.find(item => String(item.id) === String(updated.id));
            if (!active) return;
            renderTabs();
            setView(viewMode);
            syncTabControls();
            updateActiveTabLabel();
          });
        }
      });
      row.addEventListener('dblclick',()=>pl.smart ? openSmartPlaylistModal(pl) : playPlaylist(pl));
      row.addEventListener('contextmenu',e=>{e.preventDefault();showPlaylistContextMenu(e,pl);});
      return row;
    }

    function updatePlaylistVirtualRows(force=false){
      const state=playlistVirtualState;
      const rowHeight=state.rowHeight;
      const viewportHeight=state.viewport.clientHeight || 500;
      const scrollTop=state.viewport.scrollTop;
      const overscan=5;
      const start=Math.max(0,Math.floor(scrollTop/rowHeight)-overscan);
      const end=Math.min(playlists.length,Math.ceil((scrollTop+viewportHeight)/rowHeight)+overscan);
      if(!force && start===state.lastStart && end===state.lastEnd)return;
      state.lastStart=start; state.lastEnd=end;
      state.spacer.style.height=`${playlists.length*rowHeight}px`;
      state.window.style.transform=`translateY(${start*rowHeight}px)`;
      state.window.innerHTML='';
      for(let i=start;i<end;i++)state.window.appendChild(makePlaylistRow(playlists[i],i));
    }
    viewport.addEventListener('scroll',()=>{
      if(playlistVirtualState.raf)return;
      playlistVirtualState.raf=requestAnimationFrame(()=>{playlistVirtualState.raf=0;updatePlaylistVirtualRows();});
    },{passive:true});
    updatePlaylistVirtualRows(true);
    renderNavigationEditors();

  }

  let editingPlaylistId = null;
  let editingSmartPlaylistId = null;
  const PLAYLIST_LABEL_STYLE_CHOICES = [
    { id:'plain', label:'Plain', html:'{text}', description:'Normal text' },
    { id:'glow', label:'Glow', html:'<span class="hive-glow">{text}</span>', description:'Soft animated glow' },
    { id:'pulse', label:'Pulse', html:'<span class="hive-pulse">{text}</span>', description:'Gentle pulse' },
    { id:'rainbow', label:'Rainbow', html:'<span class="hive-rainbow">{text}</span>', description:'Animated hue shift' },
    { id:'bold', label:'Bold', html:'<strong>{text}</strong>', description:'Strong label' }
  ];
  let playlistLabelStyleChoice = 'plain';
  let playlistLabelStyleGenerated = false;
  function generatedPlaylistLabel() {
    const text=String(el.playlistName?.value||'').trim() || 'My Playlist';
    const choice=PLAYLIST_LABEL_STYLE_CHOICES.find(x=>x.id===playlistLabelStyleChoice)||PLAYLIST_LABEL_STYLE_CHOICES[0];
    return choice.id === 'plain' ? text : choice.html.replace('{text}',escapeHtml(text));
  }
  function renderPlaylistLabelStyles(selected='plain') {
    const host=el.playlistLabelStyles; if(!host) return;
    host.innerHTML=PLAYLIST_LABEL_STYLE_CHOICES.map(choice=>`<button type="button" class="playlist-label-style-choice${choice.id===selected?' selected':''}" data-style="${choice.id}" aria-pressed="${choice.id===selected?'true':'false'}"><strong>${choice.label}</strong><small>${choice.description}</small></button>`).join('');
    host.querySelectorAll('.playlist-label-style-choice').forEach(btn=>btn.addEventListener('click',()=>{
      playlistLabelStyleChoice=btn.dataset.style||'plain';
      host.querySelectorAll('.playlist-label-style-choice').forEach(x=>{x.classList.toggle('selected',x===btn);x.setAttribute('aria-pressed',x===btn?'true':'false');});
      playlistLabelStyleGenerated=true;
      if(el.playlistLabelHtml) el.playlistLabelHtml.value=generatedPlaylistLabel();
      applyPlaylistLabelStyle();
    }));
  }
  function applyPlaylistLabelStyle() {
    const input=el.playlistLabelHtml, preview=el.playlistLabelPreview; if(!input||!preview) return;
    const value=input.value.trim() || generatedPlaylistLabel();
    setRichLabel(preview,value);
  }
  function setPlaylistLabelEditor(value='') {
    const raw=String(value||'');
    const input=el.playlistLabelHtml;
    if(!input) return;
    input.value = raw;
    playlistLabelStyleGenerated = false;
    playlistLabelStyleChoice = 'plain';
    const classes = raw.match(/hive-(glow|pulse|rainbow)/i);
    if(classes) playlistLabelStyleChoice = classes[1].toLowerCase();
    renderPlaylistLabelStyles(playlistLabelStyleChoice);
    applyPlaylistLabelStyle();
  }
  function playlistLabelForSave() {
    const custom=String(el.playlistLabelHtml?.value||'').trim();
    if(custom) return sanitizeRichText(custom);
    return sanitizeRichText(generatedPlaylistLabel());
  }
  function openNewPlaylistModal(){
    editingPlaylistId = null;
    if (el.playlistModalTitle) el.playlistModalTitle.textContent = 'New playlist';
    el.playlistName.value='New Playlist';
    setPlaylistLabelEditor('');
    if (el.playlistDisplayView) el.playlistDisplayView.value='albums';
    if (el.playlistSave) el.playlistSave.textContent='Create playlist';
    openModal(el.playlistModal); setTimeout(()=>{el.playlistName.focus();el.playlistName.select();},0);
  }
  function openEditPlaylistModal(pl){
    if(!pl) return;
    editingPlaylistId = pl.id;
    if (el.playlistModalTitle) el.playlistModalTitle.textContent = 'Rename playlist';
    el.playlistName.value = pl.name || 'Untitled Playlist';
    setPlaylistLabelEditor(pl.label || '');
    if (el.playlistDisplayView) el.playlistDisplayView.value = ['albums','songs','artists'].includes(pl.displayView) ? pl.displayView : 'albums';
    if (el.playlistSave) el.playlistSave.textContent='Save changes';
    openModal(el.playlistModal); setTimeout(()=>{el.playlistName.focus();el.playlistName.select();},0);
  }
  function addSmartRuleRow(rule={field:'artist',op:'contains',value:''}){
    const row=document.createElement('div');row.className='smart-rule-row';
    const fields=[
      ['title','Title'],['artist','Artist'],['album','Album'],['albumArtist','Album Artist'],['genre','Genre'],['composer','Composer'],['publisher','Publisher'],['conductor','Conductor'],['comment','Comment'],['grouping','Grouping'],['copyright','Copyright'],['originalArtist','Original Artist'],['originalAlbum','Original Album'],['originalYear','Original Year'],['releaseDate','Release Date'],['year','Year'],['love','Love'],['rating','Rating'],['favorite','Favorite'],['plays','Play Count'],['skipCount','Skip Count'],['playlist','Playlist'],['quality','Quality'],['sampleRate','Sample Rate'],['season','Season'],['tempo','Tempo'],['ticketed','Ticketed'],['time','Time'],['duration','Time (sec)'],['trackCount','Track Count'],['track','Track #'],['disc','Disc #'],['trackGain','Track Gain'],['sortAlbum','Sort Album'],['sortAlbumArtist','Sort Album Artist'],['sortArtist','Sort Artist'],['sortComposer','Sort Composer'],['sortTitle','Sort Title'],['language','Language'],['mood','Mood'],['occasion','Occasion'],['keywords','Keywords'],['isrc','ISRC'],['barcode','Barcode'],['bpm','BPM'],['bitrate','Bitrate'],['channels','Channels'],['codec','Codec'],['fileType','File Type'],['path','File Path'],['dateAdded','Date Added'],['lastPlayedAt','Last Played'],['videoKind','Video Kind'],['virtual1','Virtual1'],['virtual2','Virtual2'],['virtual3','Virtual3'],['lyrics','Lyrics'],['albumRating','Album Rating'],['discCount','Disc Count'],['quality','Quality']
    ];
    row.innerHTML=`<select class="smart-field">${fields.map(x=>`<option value="${x[0]}">${x[1]}</option>`).join('')}</select><select class="smart-op"></select><input class="smart-value" placeholder="Value"><button type="button" class="sidebar-add smart-remove">×</button>`;
    el.smartPlaylistRules.appendChild(row);
    const field=row.querySelector('.smart-field'), op=row.querySelector('.smart-op'), value=row.querySelector('.smart-value');
    field.value=rule.field;
    const textOps=[['contains','contains'],['is','is'],['not','is not'],['starts','starts with'],['ends','ends with'],['empty','is empty'],['notempty','is not empty']];
    const numOps=[['eq','is'],['gt','greater than'],['gte','at least'],['lt','less than'],['lte','at most']];
    const favOps=[['is','is'],['not','is not']];
    const numericFields=['year','originalYear','plays','skipCount','rating','duration','sampleRate','bitrate','track','disc','trackCount','discCount','addedAt','lastPlayedAt','channels','tempo','quality'];
    function refreshOps(){
      const type=(field.value==='favorite'||field.value==='love')?'favorite':numericFields.includes(field.value)?'num':'text';
      const ops=type==='favorite'?favOps:type==='num'?numOps:textOps;
      op.innerHTML=ops.map(x=>`<option value="${x[0]}">${x[1]}</option>`).join('');
      op.value=rule.op && ops.some(x=>x[0]===rule.op)?rule.op:ops[0][0];
      value.type=type==='num'?'number':'text';
      value.placeholder=field.value==='favorite'?'true / false':field.value==='love'?'Loved / Not Loved':field.value==='duration'?'Seconds':field.value==='rating'?'0–5':field.value==='addedAt'||field.value==='lastPlayedAt'?'Unix timestamp or 0':'Value';
    }
    field.addEventListener('change',refreshOps);row.querySelector('.smart-remove').onclick=()=>{row.remove();if(!el.smartPlaylistRules.children.length)addSmartRuleRow();};refreshOps();value.value=rule.value??'';
  }
  function populateSmartSources(){
    const plSel=document.getElementById('smart-source-playlist'), folderSel=document.getElementById('smart-source-folder');
    if(plSel){plSel.innerHTML='<option value="">Choose playlist…</option>'+playlists.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');}
    if(folderSel){window.beehive.getConfig().then(cfg=>{folderSel.innerHTML='<option value="">Choose folder…</option>'+(cfg.folders||[]).map(f=>`<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');}).catch(()=>{});}
  }
  function bindSmartSourceControls(){
    ['library','playlist','folder'].forEach(type=>document.getElementById(`smart-source-${type}${type==='library'?'':'-option'}`)?.addEventListener('change',()=>{
      const active=document.querySelector('input[name="smart-source"]:checked')?.value||'library';
      document.querySelectorAll('.smart-source-card').forEach(card=>card.classList.toggle('selected', card.querySelector('input')?.checked));
      const playlist=document.getElementById('smart-source-playlist');
      const folder=document.getElementById('smart-source-folder');
      if(playlist) playlist.disabled=active!=='playlist';
      if(folder) folder.disabled=active!=='folder';
    }));
    const refresh=document.getElementById('smart-refresh-now');
    const auto=document.getElementById('smart-auto-refresh');
    if(refresh) refresh.disabled=!(auto?.checked);
    auto?.addEventListener('change',()=>{if(refresh)refresh.disabled=!auto.checked;});
  }
  function openSmartPlaylistModal(pl = null){
    editingSmartPlaylistId = pl?.id ?? null;
    const editing = !!pl;
    if (el.smartPlaylistModal) {
      const title = el.smartPlaylistModal.querySelector('.modal-header h3');
      const subtitle = el.smartPlaylistModal.querySelector('.modal-subtitle');
      if (title) title.textContent = editing ? 'Edit smart playlist' : 'Create smart playlist';
      if (subtitle) subtitle.textContent = editing ? 'Change the rules or presentation of this Auto Playlist.' : 'Build a playlist that updates itself from your library.';
    }
    el.smartPlaylistName.value=pl?.name || 'Smart Playlist';
    el.smartPlaylistMatch.value=pl?.match==='any' ? 'any' : 'all';
    el.smartPlaylistLimit.value=Number(pl?.limit) > 0 ? Number(pl.limit) : '';
    if(el.smartPlaylistSort)el.smartPlaylistSort.value=pl?.sort || 'addedDesc';
    const description=document.getElementById('smart-playlist-description');
    if(description)description.value=String(pl?.description||'');
    const sourceType=pl?.sourceType || 'library';
    const sourceRadio=document.querySelector(`input[name="smart-source"][value="${CSS.escape(sourceType)}"]`);
    document.querySelectorAll('input[name="smart-source"]').forEach(r=>r.checked=false);
    (sourceRadio || document.getElementById('smart-source-library')).checked=true;
    document.getElementById('smart-filter-duplicates').checked=!!pl?.filterDuplicates;
    document.getElementById('smart-playlist-select-by').value=pl?.selectBy || 'track';
    document.getElementById('smart-playlist-shuffle').value=pl?.smartShuffle || 'none';
    document.getElementById('smart-playlist-display').value=pl?.displayView || 'songs';
    document.getElementById('smart-auto-refresh').checked=pl?.autoRefresh !== false;
    document.getElementById('smart-export-static').checked=!!pl?.exportStatic;
    document.getElementById('smart-refresh-now').disabled=false;
    const sourcePlaylist=document.getElementById('smart-source-playlist');
    const sourceFolder=document.getElementById('smart-source-folder');
    if(sourcePlaylist)sourcePlaylist.value=sourceType==='playlist' ? String(pl?.sourceValue||'') : '';
    if(sourceFolder)sourceFolder.value=sourceType==='folder' ? String(pl?.sourceValue||'') : '';
    document.querySelectorAll('.smart-source-card').forEach(card=>card.classList.toggle('selected', card.querySelector('input')?.checked));
    populateSmartSources();
    if(sourcePlaylist && sourceType==='playlist') sourcePlaylist.value=String(pl?.sourceValue||'');
    if(sourceFolder && sourceType==='folder') sourceFolder.value=String(pl?.sourceValue||'');
    el.smartPlaylistRules.innerHTML='';
    const rules=Array.isArray(pl?.rules) && pl.rules.length ? pl.rules : [{field:'artist',op:'contains',value:''}];
    for(const rule of rules) addSmartRuleRow(rule);
    bindSmartSourceControls();
    if (el.smartPlaylistSave) el.smartPlaylistSave.textContent = editing ? 'Save changes' : 'Create smart playlist';
    openModal(el.smartPlaylistModal);
    setTimeout(()=>{el.smartPlaylistName.focus();el.smartPlaylistName.select();},0);
  }

  function starFavoritesPlaylist(){
    return playlists.find(p => p?.systemKey === 'star-favorites' || p?.id === 'hive-star-favorites') || null;
  }

  function favoritesTracks(){
    const pl=starFavoritesPlaylist();
    return pl?.smart ? tracksForPlaylist(pl) : library.tracks.filter(t=>t.loved);
  }

  function dynamicSidebarPlaylist(nav){
    if(nav==='pl-favorites') { const pl=starFavoritesPlaylist(); return pl ? {...pl, dynamicTracks:tracksForPlaylist(pl)} : null; }
    if(nav==='pl-recent') { const tracks=getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100); return {id:'sidebar-recent',name:'Recently Added',smart:true,tracks:tracks.map(t=>t.path),dynamicTracks:tracks}; }
    if(nav==='pl-top') { const tracks=[...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25); return {id:'sidebar-top',name:'Top 25 Most Played',smart:true,tracks:tracks.map(t=>t.path),dynamicTracks:tracks}; }
    return null;
  }

  function openPlaylistInfo(name, count, runtime, lastAdded = 0, dynamicNav = null) {
    const nav = dynamicNav ? String(dynamicNav).replace(/^pl-/, '') : '';
    const dynamic = nav ? dynamicSidebarPlaylist(nav) : null;
    const tracks = dynamic?.dynamicTracks || [];
    showSidebarListInfo({key:sidebarMetaKey(nav || String(name || 'dynamic')),name,description:'Sidebar collection',tracks});
  }

  function showAppNotice(message, title = 'Hive', { copyable = false } = {}) {
    if (!el.noticeModal) return;
    el.noticeTitle.textContent = String(title || 'Hive');
    el.noticeBody.textContent = String(message || '');
    if (el.noticeCopyRow) el.noticeCopyRow.classList.toggle('hidden', !copyable);
    if (el.noticeCopyStatus) el.noticeCopyStatus.textContent = '';
    openModal(el.noticeModal);
  }

  async function copyNoticeDiagnostics() {
    if (!el.noticeBody) return;
    const text = String(el.noticeBody.textContent || '');
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand('copy');
        area.remove();
        if (!copied) throw new Error('Clipboard copy was rejected');
      }
      if (el.noticeCopyStatus) el.noticeCopyStatus.textContent = 'Copied';
    } catch (err) {
      if (el.noticeCopyStatus) el.noticeCopyStatus.textContent = 'Copy failed — select the text above to copy it manually.';
    }
  }
  el.noticeCopy?.addEventListener('click', copyNoticeDiagnostics);

  // Browser alert/confirm/prompt dialogs are intentionally replaced with the same
  // glass/accent surface used everywhere else in Hive. Each invocation gets its
  // own overlay, so a dialog opened from another popup is a true child layer rather
  // than replacing the parent's contents.
  let themedDialogSerial = 0;
  function themedDialog({ title='Hive', message='', mode='alert', value='', placeholder='', choices=[] } = {}) {
    const template = el.appDialogModal;
    if (!template) return Promise.resolve(mode === 'confirm' ? false : mode === 'prompt' ? null : undefined);
    const modal = template.cloneNode(true);
    const serial = ++themedDialogSerial;
    modal.id = `app-dialog-modal-${serial}`;
    modal.classList.remove('hidden');
    const titleNode = modal.querySelector('#app-dialog-title');
    const messageNode = modal.querySelector('#app-dialog-message');
    const inputNode = modal.querySelector('#app-dialog-input');
    const actionsNode = modal.querySelector('#app-dialog-actions');
    if (titleNode) titleNode.id = `app-dialog-title-${serial}`;
    if (messageNode) messageNode.id = `app-dialog-message-${serial}`;
    if (inputNode) inputNode.id = `app-dialog-input-${serial}`;
    if (actionsNode) actionsNode.id = `app-dialog-actions-${serial}`;
    modal.querySelector('.app-dialog-modal')?.setAttribute('aria-labelledby', `app-dialog-title-${serial}`);
    titleNode && (titleNode.textContent = String(title || 'Hive'));
    messageNode && (messageNode.textContent = String(message || ''));
    inputNode?.classList.toggle('hidden', mode !== 'prompt');
    if (inputNode) {
      inputNode.value = String(value ?? '');
      inputNode.placeholder = String(placeholder || '');
    }
    if (actionsNode) actionsNode.innerHTML = '';

    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        closeModal(modal);
        modal.remove();
        resolve(typeof result === 'function' ? result() : result);
      };
      modal._onClose = () => {
        if (!settled) {
          settled = true;
          const fallback = mode === 'confirm' ? false : mode === 'choice' || mode === 'prompt' ? null : undefined;
          resolve(fallback);
        }
        modal.remove();
      };
      const makeButton = (label, result, cls='') => {
        const b = document.createElement('button'); b.type='button'; b.className=`sidebar-add ${cls}`; b.textContent=label;
        b.addEventListener('click', () => finish(result));
        actionsNode?.appendChild(b); return b;
      };
      if (mode === 'alert') makeButton('OK', undefined);
      else if (mode === 'confirm') { makeButton('Cancel', false); makeButton('Confirm', true); }
      else if (mode === 'choice') { for (const choice of (Array.isArray(choices) ? choices : [])) makeButton(String(choice.label || ''), choice.value, choice.className || ''); }
      else { makeButton('Cancel', null); makeButton('OK', () => inputNode?.value || ''); }
      modal.addEventListener('click', e => { if (e.target === modal) finish(mode === 'confirm' || mode === 'choice' ? false : mode === 'prompt' ? null : undefined); });
      document.body.appendChild(modal);
      openModal(modal);
      if (mode === 'prompt') setTimeout(() => { inputNode?.focus(); inputNode?.select(); }, 0);
    });
  }
  const themedAlert = (message, title='Hive') => themedDialog({title, message, mode:'alert'});
  const themedConfirm = (message, title='Confirm') => themedDialog({title, message, mode:'confirm'});
  const themedChoice = (message, choices, title='Hive') => themedDialog({title, message, mode:'choice', choices});
  const themedPrompt = (message, value='', title='Hive') => themedDialog({title, message, value, mode:'prompt'});

  function showDynamicPlaylistContextMenu(e, pl){
    if(!pl) return;
    e.preventDefault();
    const tracks=pl.dynamicTracks||[];
    const runtime=tracks.reduce((sum,t)=>sum+(Number(t.duration)||0),0);
    const lastAdded=pl.id==='sidebar-recent' && tracks.length ? Number(tracks[0].addedAt||0) : 0;
    const nav = pl.id === 'sidebar-recent' ? 'pl-recent' : pl.id === 'sidebar-top' ? 'pl-top' : pl.id === 'sidebar-favorites' ? 'pl-favorites' : null;
    showContextMenu(e.clientX,e.clientY,[
      {label:'Add playlist to queue',action:()=>{if(!tracks.length){showAppNotice('This playlist has no tracks.');return;}addTracksToQueue(tracks);}},
      {label:'Info',action:()=>showSidebarListInfo({key:sidebarMetaKey(nav || pl.id.replace('sidebar-','pl-')),name:pl.name,description:'Sidebar collection',tracks})},
      ...(nav ? [{label:'Rename',action:()=>renameSidebarEntry(nav)}] : [])
    ]);
  }

  let activeSandboxPluginId = null;
  function showSandboxLauncher(tab = getActiveTab()) {
    if (!tab || getActiveTab()?.id !== tab.id) return false;
    specialView = 'sandbox';
    activePlaylistId = null;
    activeFolderPath = '';
    hideContentViews();
    const contentTools = tab.dom?.contentTools;
    if (!contentTools) return false;
    contentTools.classList.remove('hidden');
    document.body.classList.remove('sandbox-mode');
    const plugins = [...hivePluginState.plugins.values()].filter(p => p.enabled !== false);
    if (!activeSandboxPluginId || !plugins.some(p => p.id === activeSandboxPluginId)) activeSandboxPluginId = plugins[0]?.id || null;
    const cards = plugins.map(plugin => `<button type="button" class="sandbox-app-card" data-sandbox-plugin="${escapeHtml(plugin.id)}"><span class="sandbox-app-icon">${escapeHtml(plugin.icon || 'MC')}</span><strong>${escapeHtml(plugin.name)}</strong><span>${escapeHtml(plugin.description || 'Hive sandbox extension')}</span></button>`).join('');
    contentTools.innerHTML = `<section class="sandbox-launcher" aria-label="Hive Sandbox"><header class="sandbox-launcher-head"><div><div class="sandbox-kicker">HIVE EXTENSIONS</div><h1>Sandbox</h1><p>Independent spaces for extensions and experiments.</p></div></header><div class="sandbox-app-grid">${cards || '<div class="sandbox-empty">No enabled extensions are installed.</div>'}</div></section>`;
    contentTools.querySelectorAll('[data-sandbox-plugin]').forEach(card => card.addEventListener('click', () => { activeSandboxPluginId = card.dataset.sandboxPlugin; showSandboxPlugin(activeSandboxPluginId, tab); }));
    syncSidebarSelectionForContext();
    updateActiveTabLabel();
    return true;
  }
  function showSandboxPlugin(pluginId, tab = getActiveTab()) {
    if (!tab || getActiveTab()?.id !== tab.id) return false;
    const plugin = [...hivePluginState.plugins.values()].find(p => p.id === pluginId);
    if (!plugin) return showSandboxLauncher(tab);
    hideContentViews();
    const contentTools = tab.dom?.contentTools;
    if (!contentTools) return false;
    contentTools.classList.remove('hidden');
    document.body.classList.add('sandbox-mode');
    const panel = [...hivePluginState.panels.values()].find(p => p.pluginId === plugin.id);
    contentTools.innerHTML = `<section class="sandbox-plugin-view" aria-label="${escapeHtml(plugin.name)}"><header class="sandbox-plugin-head"><button type="button" class="sidebar-add sandbox-back">← Sandbox</button><div><div class="sandbox-kicker">SANDBOX</div><h1>${escapeHtml(plugin.name)}</h1><p>${escapeHtml(plugin.description || '')}</p></div></header><div id="hive-plugin-sandbox-panels" class="hive-plugin-sandbox-panels"></div></section>`;
    const host=document.getElementById('hive-plugin-sandbox-panels');
    if (panel && host) { const section=document.createElement('section'); section.className='hive-plugin-panel'; section.dataset.pluginId=panel.pluginId; section.dataset.panelId=panel.id; host.appendChild(section); try { panel.mount(section); } catch(err) { section.textContent=err?.message || 'Plugin failed to load.'; } }
    contentTools.querySelector('.sandbox-back')?.addEventListener('click', showSandboxLauncher);
    syncSidebarSelectionForContext();
    return true;
  }

  function showSandboxView(tab = getActiveTab()) {
    return showSandboxLauncher(tab);
  }

  async function renderYearlyWrap(tab = getActiveTab()) {
    if (!tab || getActiveTab()?.id !== tab.id) return false;
    const contentTools = tab.dom?.contentTools;
    if (!contentTools) return false;
    hideContentViews();
    contentTools.classList.remove('hidden');
    specialView='yearly-wrap'; activePlaylistId=null; activeFolderPath=''; searchTerm=''; artistSearchTerm='';
    const year = new Date().getFullYear();
    let history = [];
    try { history = await window.beehive.getHistory(); } catch {}
    if (getActiveTab()?.id !== tab.id) return false;
    const entries = (Array.isArray(history) ? history : []).filter(x => {
      const ts = Number(x?.playedAt || 0); return ts > 0 && new Date(ts).getFullYear() === year;
    });
    const byTrack = new Map(), byArtist = new Map(), byAlbum = new Map(), byDay = new Map();
    let totalSeconds = 0;
    for (const x of entries) {
      const title=String(x.title||'Unknown track'), artist=String(x.artist||'Unknown artist'), album=String(x.album||'Unknown album');
      const duration=Math.max(0,Number(x.duration)||0); totalSeconds += duration;
      const add=(map,key,amount=1)=>map.set(key,(map.get(key)||0)+amount);
      add(byTrack,`${title}\u0000${artist}`,1); add(byArtist,artist,1); add(byAlbum,album,1);
      const day=new Date(Number(x.playedAt)); const dayKey=day.toISOString().slice(0,10); add(byDay,dayKey,duration);
    }
    const top = (map, limit=5) => [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit);
    const fmtHours = seconds => { const mins=Math.round(seconds/60); if(mins<60)return `${mins} min`; const h=Math.floor(mins/60),m=mins%60; return `${h}h ${m}m`; };
    const topTrack=top(byTrack,1)[0]; const topArtist=top(byArtist,1)[0]; const topAlbum=top(byAlbum,1)[0]; const topDay=top(byDay,1)[0];
    const trackRows=top(byTrack).map(([key,count],i)=>{const [title,artist]=key.split('\u0000');return `<div class="yearly-wrap-row"><span>${i+1}</span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(artist)}</small></div><b>${count.toLocaleString()} plays</b></div>`;}).join('');
    const artistRows=top(byArtist).map(([name,count],i)=>`<div class="yearly-wrap-row"><span>${i+1}</span><div><strong>${escapeHtml(name)}</strong></div><b>${count.toLocaleString()}</b></div>`).join('');
    const empty=entries.length===0;
    contentTools.innerHTML=`<section class="yearly-wrap-page"><div class="yearly-wrap-hero"><div><div class="beta-kicker">HIVE LISTENING RETROSPECTIVE</div><h1>Yearly Wrap · ${year}</h1><p>A calm summary of the music you actually played this year.</p></div><div class="yearly-wrap-year">${year}</div></div>${empty?`<div class="yearly-wrap-empty"><strong>No listening history for ${year} yet.</strong><span>As Hive records plays, your Yearly Wrap will build automatically.</span></div>`:`<div class="yearly-wrap-stats"><article><span>Listening time</span><strong>${fmtHours(totalSeconds)}</strong></article><article><span>Plays</span><strong>${entries.length.toLocaleString()}</strong></article><article><span>Artists</span><strong>${byArtist.size.toLocaleString()}</strong></article><article><span>Albums</span><strong>${byAlbum.size.toLocaleString()}</strong></article></div><div class="yearly-wrap-featured"><article><span>Top artist</span><strong>${escapeHtml(topArtist?.[0]||'—')}</strong><small>${topArtist?.[1]?.toLocaleString()||0} plays</small></article><article><span>Top track</span><strong>${escapeHtml(topTrack?.[0]?.split('\u0000')[0]||'—')}</strong><small>${topTrack?.[1]?.toLocaleString()||0} plays</small></article><article><span>Top album</span><strong>${escapeHtml(topAlbum?.[0]||'—')}</strong><small>${topAlbum?.[1]?.toLocaleString()||0} plays</small></article><article><span>Most listened day</span><strong>${topDay?.[0] ? escapeHtml(new Date(`${topDay[0]}T12:00:00`).toLocaleDateString([], {month:'short',day:'numeric'})) : '—'}</strong><small>${topDay?.[1] ? fmtHours(topDay[1]) : '—'}</small></article></div><div class="yearly-wrap-columns"><section><div class="yearly-wrap-section-title">Top tracks</div>${trackRows||'<div class="dim">Not enough history yet.</div>'}</section><section><div class="yearly-wrap-section-title">Top artists</div>${artistRows||'<div class="dim">Not enough history yet.</div>'}</section></div>`}</section>`;
    if(el.sectionTitleText) el.sectionTitleText.textContent=`Yearly Wrap · ${year}`;
    updateActiveTabLabel(); saveActiveTabState();
  }

  async function openPlaylistFromSidebar(pl, navId) {
    if (!pl) return false;
    // Sidebar and Playlist Manager both open the same persisted playlist object.
    // Never route a playlist click through the Playlists manager: every playlist
    // is an independent Music browser with its own Albums/Tracks/Artists state.
    el.sidebarItems?.forEach(item => item.classList.toggle('active', item.dataset.nav === String(navId || '')));
    applySidebarAutoShuffle(navId || `playlist:${String(pl.id)}`);
    const pinned = tabs.find(t => t.navId === String(navId || '') && t.kind === 'music');
    const tab = pinned || openOrReusePlaylistMusicTab(pl);
    if (!tab) return false;
    if (activeTabId !== tab.id) switchTab(tab.id);
    // Reassert the playlist context after the tab switch. This is deliberately
    // after openOrReusePlaylistMusicTab() because that helper may persist the
    // previously active tab before changing activeTabId.
    specialView = 'playlist';
    activePlaylistId = pl.id;
    activeFolderPath = '';
    searchTerm = '';
    artistSearchTerm = '';
    tab.state = {...(tab.state || {}), specialView:'playlist', activePlaylistId:pl.id};
    restoreTabState(tab);
    renderCurrentView();
    renderTabs();
    syncTabControls();
    syncSidebarSelectionForContext();
    persistUiStateSoon();
    return true;
  }

  // Re-selecting the canonical Music/Home destination while it is already
  // active is an intentional reset gesture: clear the global search and any
  // transient browser context, then return to the normal Albums home view.
  // This does not affect other independent Music/playlist tabs.
  function resetMusicHomeView(tab) {
    if (!tab || tab.navId !== 'music' || tab.kind !== 'music') return false;
    searchTerm = '';
    artistSearchTerm = '';
    specialView = null;
    activeFolderPath = '';
    activePlaylistId = null;
    albumFocusTitle = null;
    artistSearchReturnState = null;
    albumSearchReturnState = null;
    artistSearchFocusAlbumKey = null;
    openAlbumKey = null;
    viewMode = 'albums';
    if (el.search) el.search.value = '';
    updateSearchClearButton();
    el.main?.classList.remove('searching');
    tab.returnState = null;
    tab.state = {
      ...(tab.state || {}),
      searchTerm: '',
      artistSearchTerm: '',
      specialView: null,
      activeFolderPath: '',
      activePlaylistId: null,
      openAlbumKey: null,
      viewMode: 'albums',
      scrollTop: 0,
    };
    applyTabView('music', tab);
    syncTabControls();
    updateActiveTabLabel();
    requestAnimationFrame(() => {
      if (activeTabId !== tab.id) return;
      getActiveViewport().scrollTop = 0;
      saveActiveTabState();
    });
    persistUiStateSoon();
    return true;
  }

  let navigationRequestSeq = 0;
  async function showSpecialNavigation(nav){
    const navigationRequest = ++navigationRequestSeq;

    // Favorites is a persisted canonical Auto Playlist. Keep the explicit legacy
    // identity resolution here so old navigation state can never create a second
    // visual representation; openPlaylistFromSidebar() resolves the same canonical tab.
    if(nav==='pl-favorites'){
      const pl = starFavoritesPlaylist();
      if (!pl) return false;
      return openPlaylistFromSidebar(pl, nav);
    }

    // User playlists are also canonical Music-browser destinations. Resolve the
    // persisted playlist object before activating the context.
    const playlistEntry = sidebarEntry(nav);
    if (playlistEntry?.type === 'playlist') {
      const pl = sidebarPlaylistForEntry(nav);
      if (!pl) { showAppNotice('That playlist no longer exists. Remove it from Settings → Navigation.'); return false; }
      return openPlaylistFromSidebar(pl, nav);
    }

    const tab = tabs.find(t => t.navId === nav);
    if (!tab) return false;

    // Podcasts is a sidebar destination, not a default pinned top-bar tab.
    // It still owns a permanent canonical context; pinning only projects it into the top bar.
    // Sidebar navigation always activates its own canonical context. Pinning only
    // controls whether that context is projected into the top bar; it never
    // determines where the destination renders.
    if (activeTabId !== tab.id) switchTab(tab.id);
    if (activeTabId !== tab.id) return false;

    applySidebarAutoShuffle(nav);
    el.sidebarItems?.forEach(i => i.classList.toggle('active', i.dataset.nav === nav));
    el.folderList?.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));

    if (tab.kind === 'music') {
      const entry = sidebarEntry(nav);
      if (entry?.type === 'playlist') {
        const pl = sidebarPlaylistForEntry(nav);
        if (!pl) { showAppNotice('That playlist no longer exists. Remove it from Settings → Navigation.'); return false; }
        preparePlaylistMusicTab(tab, pl);
        loadTabStateIntoGlobals(tab);
        specialView = 'playlist';
        activePlaylistId = pl.id;
        activeFolderPath = '';
        renderCurrentView();
        renderTabs();
        syncTabControls();
        persistUiStateSoon();
        return true;
      }
      loadTabStateIntoGlobals(tab);
      const kind = navigationSpecialView(nav);
      if (nav === 'music') {
        // Clicking Music again while it is already the active Home destination
        // is the user's explicit request to leave the current search/context
        // and return to the normal Albums home screen. A first click from
        // another destination still uses the existing state-restore behavior.
        if (activeTabId === tab.id) {
          resetMusicHomeView(tab);
          return true;
        }
        specialView = null;
        activePlaylistId = null;
        activeFolderPath = '';
        restoreMusicBrowserState();
        if (activeTabId !== tab.id) return false;
        applyTabView('music', tab);
        updateActiveTabLabel();
        return true;
      }
      if (kind === 'history') {
        viewMode = sidebarDisplayView('history', 'songs');
        const h = await window.beehive.getHistory();
        if (navigationRequest !== navigationRequestSeq || activeTabId !== tab.id) return false;
        return renderMusicViewer('History', historyTracks(h || []), 'history');
      }
      if (kind === 'recent') {
        viewMode = sidebarDisplayView('pl-recent', 'albums');
        return renderMusicViewer('Recently Added', getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100), 'recent');
      }
      if (kind === 'top') {
        viewMode = sidebarDisplayView('pl-top', 'albums');
        return renderMusicViewer('Top 25 Most Played', [...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25), 'top');
      }
    }

    loadTabStateIntoGlobals(tab);
    if (nav === 'podcasts') {
      specialView = 'podcasts';
      applyTabView('podcasts', tab);
      renderTabs();
      return true;
    }
    if(nav==='pl-explorer'){
      specialView = null;
      applyTabView('playlists', tab);
      renderTabs();
      return true;
    }
    if (nav === 'sandbox') {
      specialView = 'sandbox';
      showSandboxView(tab);
      renderTabs();
      return true;
    }
    if (nav === 'yearly-wrap') {
      // Yearly Wrap is a dedicated slideshow window (real per-play listening
      // time, top track/artist/album slides, share/save-image tools) opened
      // via window.beehive.openYearlyWrap(), not an inline sidebar view.
      // renderYearlyWrap() below is legacy Build 37 inline-summary code kept
      // only for reference; routing this destination through it instead of
      // opening the real window was an unintentional regression.
      applySidebarAutoShuffle(nav);
      el.sidebarItems.forEach(i => i.classList.toggle('active', i.dataset.nav === nav));
      try {
        // Theme the window at open time to whatever's currently playing;
        // pushYearlyWrapTheme() keeps it in sync afterward as the track changes.
        const currentAccent = accentRgbFromColor(getComputedStyle(document.documentElement).getPropertyValue('--accent'));
        const currentGlow = accentRgbFromColor(getComputedStyle(document.documentElement).getPropertyValue('--accent-glow')) || currentAccent;
        const theme = currentAccent ? { accent: currentAccent.map(n => Math.round(n)).join(','), accent2: (currentGlow || currentAccent).map(n => Math.round(n)).join(',') } : null;
        await window.beehive.openYearlyWrap(new Date().getFullYear(), theme);
      }
      catch (err) { console.warn('[Yearly Wrap] window open failed', err?.message || String(err)); }
      return true;
    }
    return false;
  }

  function ensureContextMenu(){
    let shield=document.getElementById('context-menu-shield');
    if(!shield){
      shield=document.createElement('div');
      shield.id='context-menu-shield';
      shield.addEventListener('contextmenu', e => { e.preventDefault(); hideContextMenu(); });
      shield.addEventListener('click', () => hideContextMenu());
      document.body.appendChild(shield);
    }
    let m=document.getElementById('context-menu');
    if(!m){
      m=document.createElement('div');
      m.id='context-menu';
      document.body.appendChild(m);
    }
    return m;
  }
  function hideContextMenu(){
    document.getElementById('context-menu')?.classList.remove('visible');
    document.getElementById('context-menu-shield')?.classList.remove('visible');
  }
  function showContextMenu(x,y,items){
    const m=ensureContextMenu();
    const shield=document.getElementById('context-menu-shield');
    m.innerHTML='';
    m.classList.remove('context-menu-left','context-menu-right','context-menu-top','context-menu-bottom');
    items.forEach(it=>{
      if(it.submenu){
        const wrap=document.createElement('div'); wrap.className='context-submenu-wrap' + (String(it.label || '').trim().toLowerCase() === 'add to' ? ' context-add-to' : '');
        const b=document.createElement('button'); b.className='context-item context-submenu-trigger';
        if (it.icon) { const icon=document.createElement('span'); icon.className='context-item-icon'; icon.innerHTML=window.BeehiveIcons?.[it.icon] || ''; b.appendChild(icon); }
        const label=document.createElement('span'); label.className='context-item-label'; label.textContent=it.label || ''; b.appendChild(label);
        const arrow=document.createElement('span'); arrow.className='context-arrow'; arrow.textContent='›'; b.appendChild(arrow);
        const sub=document.createElement('div'); sub.className='context-submenu';
        let help = null;
        if (it.submenu.some(si => si.help)) {
          help = document.createElement('div');
          help.className = 'context-rating-help';
          help.setAttribute('aria-live', 'polite');
          help.textContent = it.submenu.find(si => si.help)?.help || '';
          sub.appendChild(help);
        }
        it.submenu.forEach(si=>{
          const sb=document.createElement('button');
          const isRatingItem = !!si.ratingSymbol;
          sb.className='context-item' + (isRatingItem ? ' context-rating-item' : '') + (si.active ? ' active' : '') + (si.loved ? ' loved' : '');
          if (si.icon) {
            const icon=document.createElement('span'); icon.className=isRatingItem ? 'context-rating-icon' : 'context-item-icon';
            icon.innerHTML=window.BeehiveIcons?.[si.icon] || '';
            if (!window.BeehiveIcons?.[si.icon]) icon.textContent=si.icon;
            sb.append(icon);
          } else if (!isRatingItem) {
            const icon=document.createElement('span'); icon.className='context-item-icon'; sb.append(icon);
          }
          if (!isRatingItem) {
            const label=document.createElement('span'); label.className='context-submenu-label'; label.textContent=si.label || '';
            sb.append(label);
          }
          if (isRatingItem) {
            sb.setAttribute('aria-label', si.label || si.help || 'Rating action');
            if (help && si.help) sb.addEventListener('mouseenter', () => { help.textContent = si.help; });
          }
          if (si.active) {
            const check=document.createElement('span'); check.className='context-rating-check'; check.textContent='✓'; sb.append(check);
          }
          sb.onclick=async()=>{hideContextMenu();await si.action();};
          sub.appendChild(sb);
        });
        wrap.appendChild(b); wrap.appendChild(sub); m.appendChild(wrap);
      } else {
        const b=document.createElement('button'); b.className='context-item'+(it.danger?' danger':'')+(it.playlistRemove?' playlist-remove':'');
        const icon=document.createElement('span'); icon.className='context-item-icon';
        if (it.icon) icon.innerHTML=window.BeehiveIcons?.[it.icon] || '';
        b.appendChild(icon);
        const label=document.createElement('span'); label.className='context-item-label'; label.textContent=it.label || ''; b.appendChild(label);
        b.onclick=async()=>{hideContextMenu();await it.action();}; m.appendChild(b);
      }
    });

    // Measure the real menu instead of assuming a fixed size. Near a screen
    // edge, open inward so the whole menu is visible and the cursor can move
    // directly from the source item into the menu without crossing a hidden
    // or off-screen portion of it.
    m.style.visibility='hidden';
    m.classList.add('visible');
    const rect=m.getBoundingClientRect();
    const margin=6;
    // Keep the menu flush with the pointer/source edge. A non-zero gap can
    // expose the global shield and make a slow mouse crossing feel like the
    // menu vanishes before the pointer reaches it.
    const gap=0;
    let left=x+gap;
    let top=y+gap;
    let horizontal='context-menu-right';
    let vertical='context-menu-bottom';

    if(left+rect.width > window.innerWidth-margin){
      left=x-rect.width-gap;
      horizontal='context-menu-left';
    }
    if(left < margin){
      left=Math.max(margin,Math.min(x-gap,window.innerWidth-rect.width-margin));
      horizontal='context-menu-right';
    }

    if(top+rect.height > window.innerHeight-margin){
      top=y-rect.height-gap;
      vertical='context-menu-top';
    }
    if(top < margin){
      top=Math.max(margin,Math.min(y-gap,window.innerHeight-rect.height-margin));
      vertical='context-menu-bottom';
    }

    m.classList.add(horizontal,vertical);
    m.style.left=Math.round(left)+'px';
    m.style.top=Math.round(top)+'px';
    m.style.visibility='visible';
    shield.classList.add('visible');
  }
  document.addEventListener('click',(e)=>{
    const m=document.getElementById('context-menu');
    if(m?.classList.contains('visible') && !m.contains(e.target)) hideContextMenu();
  }, true);
  function showCoverContextMenu(e,file,model=null){
    if(!file)return;
    const albumTracks = Array.isArray(model?.tracks) ? model.tracks.filter(track => track?.path) : [];
    const isAlbumSurface = albumTracks.length > 1;
    const items=distinctCovers(model||{cover:file});
    const menu=[{label:'Open full-size cover',action:()=>openCoverLightbox(model||{cover:file})}];
    if (isAlbumSurface) {
      menu.push({label:'Change album cover…', icon:'edit', action:async()=>{
        await openTagEditor(albumTracks[0], albumTracks);
        setTagEditorTab('artwork');
      }});
      menu.push({label:'Search Internet for album cover…', icon:'search', action:async()=>{
        await openTagEditor(albumTracks[0], albumTracks);
        setTagEditorTab('artwork');
        await searchEditorArtwork();
      }});
    }
    // When multiple genuinely distinct covers are embedded in the active track,
    // expose direct Cover 1 / Cover 2 / ... choices instead of forcing the user
    // to wait for or cycle through the carousel. A single cover gets no extra
    // Cover N entries.
    if(items.length>1){
      items.forEach((item,i)=>menu.push({label:`Show Cover ${i+1}`,action:()=>openCoverLightbox(model||{cover:file,covers:items},i)}));
    }
    menu.push({label:'Copy cover to clipboard',action:()=>window.beehive.copyCover(file)});
    menu.push({label:'Save cover to disk…',action:()=>window.beehive.saveCover(file)});
    showContextMenu(e.clientX,e.clientY,menu);
  }

  function prepareTrackContextSelection(t, tracks = null) {
    if (!t) return;
    const path = String(t.path || '');
    if (!path) return;
    activeSelectionScope = 'songs';
    if (Array.isArray(tracks) && tracks.length) activeSelectionTracks = tracks;

    // Right-click behaves like a selection click for an unselected track,
    // but never destroys an existing multi-selection when the clicked track
    // is already part of that selection. This keeps bulk tag editing intact.
    if (!selectedSongPaths.has(path)) {
      clearSongSelection();
      selectSongPath(path);
      songSelectionAnchor = path;
    }

    applySongSelectionClasses();
    document.querySelectorAll('.inline-track-row').forEach(row => {
      row.classList.toggle('selected', selectedSongPaths.has(row.dataset.path || ''));
    });
  }

  async function showTrackFileInBrowser(track) {
    const filePath = String(track?.path || '');
    if (!filePath) return;
    const result = await window.beehive.showFileInBrowser(filePath);
    if (!result?.ok && !result?.error) console.warn('Could not show file in browser:', filePath);
    else if (result?.error) console.warn('Could not show file in browser:', result.error);
  }

  async function performDeleteTracksFromDisk(selectedTracks) {
    const paths = [...new Set(selectedTracks.map(t => String(t.path)).filter(Boolean))];
    if (!paths.length) return;
    const result = await window.beehive.deleteTracksFromDisk(paths);
    if (!result?.deleted?.length) return;

    const deletedSet = new Set(result.deleted.map(String));
    const deletedCurrentPath = String(currentQueue[currentIndex]?.path || '');
    if (deletedCurrentPath && deletedSet.has(deletedCurrentPath)) {
      try { audio.pause(); } catch {}
      audio.removeAttribute('src');
      audio.load();
      currentIndex = -1;
      selectedQueueIndex = -1;
      selectedQueueIndices.clear();
      savePlaybackSession();
    }

    library.tracks = (library.tracks || []).filter(track => !deletedSet.has(String(track?.path || '')));
    currentQueue = (currentQueue || []).filter(track => !deletedSet.has(String(track?.path || '')));
    if (shuffle) syncShuffleRestoreQueue();
    selectedSongPaths.forEach(p => { if (deletedSet.has(String(p))) selectedSongPaths.delete(p); });
    activeSelectionTracks = (activeSelectionTracks || []).filter(track => !deletedSet.has(String(track?.path || '')));
    if (currentQueue.length === 0) {
      currentIndex = -1;
      selectedQueueIndex = -1;
      selectedQueueIndices.clear();
    } else if (currentIndex >= currentQueue.length) {
      currentIndex = currentQueue.length - 1;
    }
    applyLibrary(library);
    saveQueueSession();
    renderQueue();
    renderCurrentView();
    if (result.errors?.length) console.warn('Some disk deletions failed:', result.errors);
  }

  function closeDiskDeleteModals() {
    closeModal(el.diskDeleteModal);
    closeModal(el.diskDeleteFinalModal);
  }

  async function removeTracksFromActivePlaylist(tracks) {
    const pl = playlists.find(x => String(x?.id) === String(activePlaylistId));
    if (!pl || specialView !== 'playlist' || !activePlaylistId) return false;
    if (pl.smart) {
      showAppNotice('Smart playlists are generated from their rules and cannot have individual tracks removed.');
      return false;
    }
    const candidates = Array.isArray(tracks) ? tracks : [];
    const requested = new Set(candidates.map(t => String(t?.path || '')).filter(Boolean));
    const currentPaths = Array.isArray(pl.tracks) ? pl.tracks.map(String) : [];
    const removePaths = currentPaths.filter(p => requested.has(p));
    if (!removePaths.length) return false;
    const count = removePaths.length;
    const label = count === 1
      ? `Remove “${String(candidates.find(t => String(t?.path || '') === removePaths[0])?.title || removePaths[0].split(/[\\/]/).pop() || 'this track')}” from “${pl.name}”?`
      : `Remove ${count} selected tracks from “${pl.name}”?`;
    const confirmed = await themedConfirm(`${label}\n\nThis cannot be undone.`, 'Remove from playlist');
    if (!confirmed) return false;

    const removeSet = new Set(removePaths);
    const updated = { ...pl, tracks: currentPaths.filter(p => !removeSet.has(p)) };
    const saved = await window.beehive.savePlaylist(updated);
    playlists = playlists.map(x => String(x?.id) === String(saved?.id) ? saved : x);
    clearSongSelection();
    activeSelectionTracks = [];
    renderCurrentView();
    saveActiveTabState();
    showAppNotice(`Removed ${count} track${count === 1 ? '' : 's'} from “${saved.name}”.`);
    return true;
  }

  async function deleteTracksFromDisk(tracks) {
    const selectedTracks = Array.isArray(tracks) ? tracks.filter(t => t?.path) : [];
    if (!selectedTracks.length || !el.diskDeleteModal || !el.diskDeleteFinalModal) return;
    const count = selectedTracks.length;
    const label = count === 1 ? `Delete “${String(selectedTracks[0].title || selectedTracks[0].path.split(/[\\/]/).pop() || 'this file')}” from disk?` : `Delete ${count} selected audio files from disk?`;
    const detail = count === 1
      ? 'This will remove the actual audio file from your computer.'
      : 'This will remove the selected audio files from your computer.';

    el.diskDeleteMessage.textContent = label;
    el.diskDeleteDetail.textContent = detail;
    el.diskDeleteFinalDetail.textContent = count === 1
      ? `The file “${String(selectedTracks[0].title || selectedTracks[0].path.split(/[\\/]/).pop() || 'this file')}” will be permanently deleted from disk.`
      : `${count} audio files will be permanently deleted from disk.`;

    closeModal(el.diskDeleteFinalModal);
    openModal(el.diskDeleteModal);
    el.diskDeleteProceed.onclick = () => {
      closeModal(el.diskDeleteModal);
      openModal(el.diskDeleteFinalModal);
    };
    el.diskDeleteCancel.onclick = () => closeModal(el.diskDeleteModal);
    el.diskDeleteFinalNo.onclick = () => closeModal(el.diskDeleteFinalModal);
    el.diskDeleteFinalYes.onclick = async () => {
      closeModal(el.diskDeleteFinalModal);
      await performDeleteTracksFromDisk(selectedTracks);
    };
  }

  // Playlists store an ordered list of plain path strings (pl.tracks), which
  // works for local library files because every path resolves through
  // libraryTrackByPath. A podcast episode's synthetic "podcast:<id>" path
  // never appears in that index (podcasts aren't part of the scanned
  // library), so without this snapshot map, adding an episode to a playlist
  // silently "succeeded" but the episode vanished the next time the playlist
  // was opened -- tracksForPlaylist had nothing to resolve that path to.
  // pl.podcastEpisodes keeps a { path: fullEpisodeTrack } snapshot alongside
  // pl.tracks so podcast entries survive exactly like Spotify's
  // pl.spotifyTracks snapshot does for its own tracks.
  function collectPodcastEpisodeSnapshots(tracks) {
    const out = {};
    for (const t of tracks) {
      if (isPodcastTrack(t)) out[String(t.path)] = { ...t };
    }
    return out;
  }

  function buildAddToPlaylistSubmenu(tracks) {
    const list = Array.isArray(tracks) ? tracks.filter(t => t?.path) : [];
    const paths = [...new Set(list.map(t => String(t.path)).filter(Boolean))];
    if (!paths.length) return [];
    const podcastEpisodeSnapshots = collectPodcastEpisodeSnapshots(list);
    const localList = list.filter(isLocalPlaybackTrack);

    const items = [{
      label: 'Queue',
      icon: 'queue',
      action: async () => {
        addTracksToQueue(list.slice());
        showAppNotice(`Added ${paths.length === 1 ? 'the selected track' : `${paths.length} selected tracks`} to the queue.`);
      }
    }, {
      label: '+ New Playlist',
      icon: 'plus',
      action: async () => {
        const name = await themedPrompt('Playlist name:', 'My Playlist', 'New playlist');
        if (!name?.trim()) return;
        const created = await window.beehive.savePlaylist({ name: name.trim(), tracks: paths, podcastEpisodes: podcastEpisodeSnapshots, smart: false });
        playlists = await window.beehive.getPlaylists();
        renderPlaylistManager();
        renderNavigationEditors();
        showAppNotice(`Created “${created.name}” with ${paths.length} track${paths.length === 1 ? '' : 's'}.`);
      }
    }];

    // Love/Favorites writes an embedded file tag, which only makes sense for
    // real local audio files -- a podcast episode has no file to write to.
    if (localList.length) {
      const favorites = starFavoritesPlaylist();
      if (favorites) {
        const allLoved = localList.every(t => !!t.loved);
        items.push({
          label: 'Favorites',
          icon: allLoved ? '♥' : '♡',
          loved: true,
          active: allLoved,
          action: async () => {
            if (allLoved) {
              showAppNotice('All selected tracks are already in Favorites.');
              return;
            }
            await applyBulkTrackAction(localList.filter(t => !t.loved), t => setTrackLove(t, true, false));
            renderCurrentView();
          }
        });
      }
    }

    for (const pl of playlists) {
      if (!pl || pl.smart || String(pl.source || '').toLowerCase() === 'spotify') continue;
      const existing = Array.isArray(pl.tracks) ? new Set(pl.tracks.map(String)) : new Set();
      const alreadyAll = paths.every(path => existing.has(path));
      items.push({
        label: playlistLabel(pl),
        icon: '♪',
        active: alreadyAll,
        action: async () => {
          const merged = [...new Set([...existing, ...paths])];
          if (merged.length === existing.size) {
            showAppNotice(`All selected tracks are already in “${playlistLabel(pl)}”.`);
            return;
          }
          const mergedPodcastEpisodes = { ...(pl.podcastEpisodes || {}), ...podcastEpisodeSnapshots };
          const saved = await window.beehive.savePlaylist({ ...pl, tracks: merged, podcastEpisodes: mergedPodcastEpisodes });
          playlists = playlists.map(item => String(item.id) === String(saved.id) ? saved : item);
          renderPlaylistManager();
          renderNavigationEditors();
          showAppNotice(`Added ${paths.length === 1 ? 'the selected track' : `${paths.length} selected tracks`} to “${playlistLabel(saved)}”.`);
        }
      });
    }
    return items;
  }

  function contextAlbumLabel(value){
    const text = String(value || 'Unknown Album').trim() || 'Unknown Album';
    return text.length > 15 ? `${text.slice(0,15)}…` : text;
  }

  async function showTrackContextMenu(x,y,t){
    if(!t)return;
    // Do not block menu display on Android discovery: refreshAndroidDevices()
    // round-trips to the main process, which shells out to `gio mount -li`
    // (up to a 5s timeout). Awaiting it here made every right-click feel
    // unresponsive whenever no Android device was already known, which is the
    // common case. Fire-and-forget instead, same as the Settings > Devices
    // refresh; "Send to" simply won't list a device until the next menu open.
    if (!androidDevices.length && window.beehive.listDevices) { void refreshAndroidDevices(); }
    const selected = selectedSongPaths.has(String(t.path || ''))
      ? orderedSelectedTracks(library.tracks)
      : [t];
    const bulk = selected.length > 1;
    const countLabel = bulk ? ` (${selected.length} selected)` : '';
    const allLoved = bulk && selected.every(track => !!track.loved);
    const ratingIs = value => bulk
      ? selected.every(track => {
          const r = Number(track.ratingRaw) === 255 ? 5 : Number(track.rating) || 0;
          return r === value;
        })
      : (Number(t.ratingRaw) === 255 ? 5 : Number(t.rating) || 0) === value;
    const applyLove = value => {
      if (!bulk) return setTrackLove(t, value);
      // When adding Love, only queue tracks that are not already Loved.
      // Existing favorites are already in the desired state and should not be
      // rewritten on disk. Unlove still applies to every selected Loved track.
      const paths = selected
        .filter(track => !value || !track.loved)
        .map(track => track.path)
        .filter(Boolean);
      const selectedSet = new Set(paths.map(String));
      // Update only tracks that actually need the disk operation. Existing
      // Loved tracks stay Loved without being touched.
      for (const track of library.tracks) {
        if (selectedSet.has(String(track?.path || ''))) track.loved = !!value;
      }
      for (const track of selected) {
        if (selectedSet.has(String(track?.path || ''))) track.loved = !!value;
      }
      renderCurrentView();
      syncLoveStateForPath(t.path, !!value);
      if (!paths.length) return Promise.resolve(!!value);
      // Defer the actual disk writes until after the current interaction has
      // painted. The library should never feel blocked by tag serialization.
      // Do not fire-and-forget a bulk metadata transaction. The visible UI is
      // updated immediately, but the action must stay alive until every disk
      // write has either succeeded or failed so closing/restarting Beehive
      // cannot silently strand the remaining Love writes.
      setTimeout(async () => {
        const result = await window.beehive.setLove(paths, !!value);
        if (result?.failed) {
          console.warn('Some bulk Love writes failed:', result.errors);
          const failedSet = new Set((result.errors || []).map(e => String(e.path || '')));
          for (const track of library.tracks) {
            if (failedSet.has(String(track?.path || ''))) track.loved = !value;
          }
          renderCurrentView();
        }
      }, 0);
      return Promise.resolve(!!value);
    };
    const applyRating = value => bulk
      ? applyBulkRating(selected.map(track => track.path), value)
      : setTrackRating(t, value);
    const queueTracks = bulk ? selected.slice() : [t];
    const queueLabel = bulk ? `Add selected songs to queue (${selected.length})` : 'Add to queue';
    const editLabel = bulk ? `Edit tags… (${selected.length} selected)` : 'Edit tags…';
    // library.tracks (the only source `selected` is ever built from for a
    // multi-select) never contains podcast/Spotify entries, so a non-local
    // track here only ever means the single now-playing-bar case (bulk is
    // always false then). Rating/Love, tag editing, revealing the file, and
    // deleting from disk all require a real local audio file to act on --
    // showing them for a podcast episode meant every one of those either
    // silently failed against a synthetic "podcast:<id>" path or, worse,
    // surfaced a confusing raw IPC error.
    const isLocal = isLocalPlaybackTrack(t);
    showContextMenu(x,y,[
      {label:'Play',icon:'play',action:()=>playQueue([t],0)},
      {label:queueLabel,icon:'queue',action:()=>addTracksToQueue(queueTracks)},
      ...(isLocal && !bulk && t.artist ? [{label:'Play More',icon:'play',submenu:[
        {label:`Play artist: ${t.artist}`,icon:'play',action:()=>playArtistShuffled(t.artist)},
        {label:`Play similar to: ${t.artist}`,icon:'play',action:()=>playSimilarArtist(t.artist)}
      ]}] : []),
      ...(isLocal ? [{label:'Rating',icon:'star',submenu:[
        // Bulk selections use two distinct actions rather than one toggle: a
        // selection where every track is already Loved must still leave
        // everything Loved when the user clicks "Love" -- it is a "make sure
        // these are Loved" action, not an "invert the current state" toggle.
        // "Remove Love" is the explicit, separate way to bulk-unlove.
        ...(bulk ? [
          {label:'Love', icon:'♥♥♥', loved:true, active:allLoved, ratingSymbol:true, help:`Set all ${selected.length} selected tracks to Loved`, action:()=>applyLove(true)},
          {label:'Remove Love', icon:'♡', loved:true, active:false, ratingSymbol:true, help:`Remove Love from ${selected.length} selected tracks`, action:()=>applyLove(false)}
        ] : [
          {label:'Love', icon:t.loved ? '♥' : '♡', loved:true, active:!!t.loved, ratingSymbol:true, help:t.loved ? 'Remove Love' : 'Add Love', action:()=>applyLove(!t.loved)}
        ]),
        {label:'5 stars', icon:'★★★★★', active:ratingIs(5), ratingSymbol:true, help:bulk ? `Set ${selected.length} selected tracks to 5 stars` : 'Set rating to 5 stars', action:()=>applyRating(5)},
        {label:'4 stars', icon:'★★★★☆', active:ratingIs(4), ratingSymbol:true, help:bulk ? `Set ${selected.length} selected tracks to 4 stars` : 'Set rating to 4 stars', action:()=>applyRating(4)},
        {label:'3 stars', icon:'★★★☆☆', active:ratingIs(3), ratingSymbol:true, help:bulk ? `Set ${selected.length} selected tracks to 3 stars` : 'Set rating to 3 stars', action:()=>applyRating(3)},
        {label:'2 stars', icon:'★★☆☆☆', active:ratingIs(2), ratingSymbol:true, help:bulk ? `Set ${selected.length} selected tracks to 2 stars` : 'Set rating to 2 stars', action:()=>applyRating(2)},
        {label:'1 star', icon:'★☆☆☆☆', active:ratingIs(1), ratingSymbol:true, help:bulk ? `Set ${selected.length} selected tracks to 1 star` : 'Set rating to 1 star', action:()=>applyRating(1)},
        {label:'Clear', icon:'×', active:ratingIs(0), ratingSymbol:true, help:bulk ? `Clear ratings from ${selected.length} selected tracks` : 'Clear the star rating', action:()=>applyRating(0)}
      ]}] : []),
      ...(isLocal && androidDevices.length ? [{label:'Send to',icon:'plus',submenu:androidDevices.map(device => ({label:`${device.name || 'Android device'}${device.mounted ? '' : ' (not mounted)'}`,active:false,action:()=>sendTracksToAndroidDevice(device, queueTracks)}))}] : []),
      {label:'Add to',icon:'plus',submenu:buildAddToPlaylistSubmenu(queueTracks)},
      {label:`Search artist: ${t.artist || 'Unknown Artist'}`,icon:'search',action:()=>searchForArtist(t.artist, t)},
      {label:`Search album: ${contextAlbumLabel(t.album)}`,icon:'search',action:()=>showAlbumFromTrack(t)},
      ...(isLocal ? [{label:'Show file in browser',icon:'search',action:()=>showTrackFileInBrowser(t)}] : []),
      ...(specialView === 'playlist' && activePlaylistId ? [{label:bulk ? `Remove tracks from playlist (${selected.length} selected)` : 'Remove tracks from playlist', playlistRemove:true, action:()=>removeTracksFromActivePlaylist(selected)}] : []),
      ...(isLocal ? [{label:bulk ? `Delete files from disk… (${selected.length} selected)` : 'Delete file from disk…',icon:'trash',danger:true,action:()=>deleteTracksFromDisk(selected)}] : []),
      ...(isLocal ? [{label:editLabel,icon:'edit',action:()=>openTagEditor(t, selected)}] : []),
      ...(isLocal ? [{label:'Auto-tag album…', icon:'tag', action:()=>{
        const key = albumKey(t);
        const albumTracks = library.tracks.filter(track => albumKey(track) === key).sort(albumTrackCompare);
        openAutoTagAlbum({ title: t.album, artist: t.albumArtist || t.artist, tracks: albumTracks });
      }}] : [])
    ]);
  }
  function parseTimeValue(value) {
    const s = String(value ?? '').trim();
    if (!s) return 0;
    if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s) || 0;
    const parts = s.split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return 0;
    if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
    if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return 0;
  }
  function nativeTagValue(native, wanted) {
    const target = String(wanted).toUpperCase();
    for (const tagList of Object.values(native || {})) {
      for (const tag of (Array.isArray(tagList) ? tagList : [])) {
        const id = String(tag?.id || '').toUpperCase();
        const desc = String(tag?.value?.description || '').toUpperCase();
        if (id === target || desc === target || id.includes(target) || desc.includes(target)) {
          return String(tag?.value?.text ?? tag?.value?.value ?? tag?.value ?? '').trim();
        }
      }
    }
    return '';
  }
  function setTagEditorTab(tab) {
    document.querySelectorAll('.tag-editor-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tagTab === tab));
    document.querySelectorAll('.tag-editor-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.tagPanel === tab));
    if (tab === 'lyrics' && editingTrack) void refreshTagEditorLyrics(editingTrack);
  }

  // Matches a timestamp token in either LRC's line-level [mm:ss.xx] form or
  // enhanced/word-level LRC's inline <mm:ss.xx> karaoke form, with either a
  // period or comma as the fractional separator (some providers/tools use
  // a comma). Previously this only matched the bracket form with a period
  // or colon separator; any other real-world variant silently passed
  // through unchanged instead of failing safely, so a provider using one of
  // these was leaking raw synced text (with visible timestamps) straight
  // into both the tag editor and the actually-embedded "plain" lyrics tag.
  const LYRICS_TIMESTAMP_RE = /[[<](?:(?:\d+):)?\d{1,3}:\d{2}(?:[.,:]\d{1,3})?[\]>]/g;
  function plainLyricsFromSynced(raw) {
    const source = normalizeLyricsText(raw).replace(/\r\n?/g, '\n').trim();
    if (!source) return '';
    return source.split('\n').map(line => line.replace(LYRICS_TIMESTAMP_RE, '').replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join('\n');
  }

  // Always reduce any source (embedded text, or an online result's
  // {syncedLyrics, plainLyrics} shape) down to plain text -- this tab never
  // shows or edits synced/LRC content, regardless of where the text came from.
  function extractLyricsPayload(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const plain = normalizeLyricsText(raw.plainLyrics ?? raw.lyrics ?? raw.text ?? '');
      return plain || plainLyricsFromSynced(normalizeLyricsText(raw.syncedLyrics || ''));
    }
    const text = normalizeLyricsText(raw);
    return plainLyricsFromSynced(text) || text;
  }

  function setTagLyricsEditing(editing) {
    tagLyricsPayload.editing = !!editing;
    const card = document.querySelector('.lyrics-result-card');
    const preview = document.getElementById('tag-lyrics-preview');
    const textarea = document.getElementById('tag-lyrics');
    const button = document.getElementById('tag-lyrics-edit');
    if (card) card.classList.toggle('editing', tagLyricsPayload.editing);
    if (preview) preview.hidden = tagLyricsPayload.editing;
    if (textarea) { textarea.hidden = !tagLyricsPayload.editing; textarea.value = tagLyricsPayload.text || textarea.value || ''; }
    if (button) button.textContent = tagLyricsPayload.editing ? 'Done editing' : 'Edit Lyrics';
    if (tagLyricsPayload.editing) textarea?.focus();
  }

  function renderTagEditorLyricsPreview(raw, meta = {}) {
    const preview = document.getElementById('tag-lyrics-preview');
    const sourceNode = document.getElementById('tag-lyrics-source');
    const titleNode = document.getElementById('tag-lyrics-result-title');
    const metaNode = document.getElementById('tag-lyrics-result-meta');
    if (!preview) return;
    const text = normalizeLyricsPayload(raw).trim();
    if (titleNode) titleNode.textContent = 'Lyrics';
    if (metaNode) metaNode.textContent = meta.source ? `${meta.source} · plain text` : 'Embedded lyrics are preferred.';
    if (sourceNode) sourceNode.textContent = meta.embedded ? 'Embedded in audio file' : (meta.source ? `Online result · ${meta.source}` : 'No lyrics found');
    preview.innerHTML = text ? `<pre>${escapeHtml(text)}</pre>` : '';
  }

  async function refreshTagEditorLyrics(track, forceSearch = false) {
    if (!track || editingTracks.length !== 1) return;
    const searchNode = document.getElementById('tag-lyrics-search');
    const embeddedText = extractLyricsPayload(track.lyrics || '');
    // The embedded-lyrics shortcut below only applies to the initial load of
    // this tab. "Search online" (forceSearch=true) is an explicit redo
    // request and must always reach the actual search below -- previously,
    // any track with embedded lyrics (which is now effectively every track
    // with lyrics at all, since the embedded tag is always plain text) hit
    // this shortcut and returned immediately, silently ignoring the button.
    // A fresh search result only populates the editable text for review; it
    // is not saved until the user clicks Save, and embedSearchedLyricsIfEnabled
    // still refuses to auto-embed over a track that already has lyrics.
    if (!forceSearch) {
      tagLyricsPayload = { ...tagLyricsPayload, text: embeddedText };
      if (embeddedText) {
        if (!tagLyricsPayload.editing) document.getElementById('tag-lyrics').value = tagLyricsPayload.text;
        renderTagEditorLyricsPreview(tagLyricsPayload.text, { embedded: true, source: 'Embedded' });
        if (searchNode) { searchNode.textContent = 'Search online'; searchNode.disabled = false; }
        return;
      }
    }
    if (!track.artist || !track.title) {
      renderTagEditorLyricsPreview('', {});
      if (searchNode) { searchNode.textContent = 'Search online'; searchNode.disabled = true; }
      return;
    }
    const generation = nowPlayingUiGeneration;
    // The tag editor always wants Genius/plain lyrics specifically -- the
    // "Highlighted lyrics" setting controls the left-side synced display
    // only, per the actual design (see extractLyricsPayload's comment).
    // This needs its own cache namespace, not the bare per-track id: the
    // left-side panel's own lookup (refreshTrackLyricsForDisplay) shares
    // that id and caches whatever highlightedLyricsEnabled() preferred at
    // the time, which could be an LRCLIB-preferred synced result -- reusing
    // that cache here meant "Search online" (forceSearch) and even the
    // initial tab-open cache check could serve/consider LRCLIB's result
    // instead of actually searching Genius as the user expects.
    const lookupId = `${lyricsLookupIdForTrack(track)}|editor-plain`;
    if (!forceSearch) {
      const cached = lyricsLookupCache.get(lookupId);
      if (cached !== undefined) {
        tagLyricsPayload = { ...tagLyricsPayload, text: extractLyricsPayload(cached) };
        if (!tagLyricsPayload.editing) document.getElementById('tag-lyrics').value = tagLyricsPayload.text;
        renderTagEditorLyricsPreview(tagLyricsPayload.text, { source: cached?.source || '' });
        return;
      }
    }
    if (searchNode) { searchNode.disabled = true; searchNode.textContent = 'Searching…'; }
    renderTagEditorLyricsPreview('', {});
    try {
      const found = await window.beehive.searchLyrics({ artist: track.artist, title: track.title, album: track.album, duration: track.duration, highlightedLyrics: false });
      if (generation !== nowPlayingUiGeneration && editingTrack !== track) return;
      lyricsLookupCache.set(lookupId, found || '');
      tagLyricsPayload = { ...tagLyricsPayload, text: extractLyricsPayload(found || '') };
      if (!tagLyricsPayload.editing) document.getElementById('tag-lyrics').value = tagLyricsPayload.text;
      renderTagEditorLyricsPreview(tagLyricsPayload.text, { source: found?.source || 'Genius' });
      // Embedding (if the setting is on) always writes plain text regardless
      // of what the provider returned -- see tag_helper.py's write path.
      await embedSearchedLyricsIfEnabled(track, found);
      if (searchNode) { searchNode.disabled = false; searchNode.textContent = 'Search online'; }
    } catch {
      lyricsLookupCache.set(lookupId, '');
      renderTagEditorLyricsPreview('', {});
      if (searchNode) { searchNode.disabled = false; searchNode.textContent = 'Search online'; }
    }
  }

  document.querySelectorAll('.tag-editor-tab').forEach(btn => btn.addEventListener('click', () => setTagEditorTab(btn.dataset.tagTab)));
  document.getElementById('tag-lyrics-search')?.addEventListener('click', () => {
    if (editingTrack) void refreshTagEditorLyrics(editingTrack, true);
  });
  document.getElementById('tag-lyrics-edit')?.addEventListener('click', () => setTagLyricsEditing(!tagLyricsPayload.editing));
  document.getElementById('tag-lyrics')?.addEventListener('input', e => { tagLyricsPayload.text = e.target.value; });

  // 'pcount' and 'compilation' are deliberately excluded here even though they
  // are ordinary per-track fields: pcount has its own dedicated save loop below
  // (mapping to the real backend key 'p_count' -- including it here too would
  // additionally write a second, bogus 'pcount' TXXX tag), and compilation is a
  // checkbox, whose real state lives in `.checked`, not the `.value` this
  // generic text-field loop reads.
  const TAG_EDITOR_FIELDS = [
    ['title', 'tag-title'], ['artist', 'tag-artist'], ['album', 'tag-album'], ['albumartist', 'tag-albumArtist'],
    ['genre', 'tag-genre'], ['year', 'tag-year'], ['track', 'tag-track'], ['disk', 'tag-disk'],
    ['composer', 'tag-composer'], ['publisher', 'tag-publisher'], ['conductor', 'tag-conductor'], ['bpm', 'tag-bpm'],
    ['grouping', 'tag-grouping'], ['copyright', 'tag-copyright'], ['comment', 'tag-comment'],
    ...Array.from({length:19}, (_, i) => [`custom${i+2}`, `tag-custom${i+2}`]),
    ['lyrics', 'tag-lyrics'], ['lyricist', 'tag-lyricist'], ['originalartist', 'tag-originalArtist'],
    ['originalalbum', 'tag-originalAlbum'], ['originalyear', 'tag-originalYear'], ['quality', 'tag-quality'],
    ['tempo', 'tag-tempo'], ['mood', 'tag-mood'], ['occasion', 'tag-occasion'], ['keywords', 'tag-keywords'], ['language', 'tag-language']
  ];

  function editorTextValue(common, native, key) {
    const text = (v) => Array.isArray(v) ? (v[0] ?? '') : v;
    if (key === 'genre') return text(common?.genre);
    if (key === 'composer') return text(common?.composer);
    if (key === 'publisher') return text(common?.label) || text(common?.publisher);
    if (key === 'conductor') return text(common?.conductor);
    if (key === 'comment') return normalizeMetadataText(common?.comment);
    if (key === 'lyrics') return normalizeLyricsText(common?.lyrics);
    if (key === 'lyricist') return text(common?.lyricist);
    if (key === 'originalartist') return text(common?.originalartist);
    if (key === 'originalalbum') return text(common?.originalalbum);
    if (key === 'originalyear') return common?.originalyear ?? '';
    if (key === 'mood') return text(common?.mood) || nativeTagValue(native, 'MOOD');
    if (key === 'occasion') return text(common?.occasion) || nativeTagValue(native, 'OCCASION');
    if (key === 'quality') return nativeTagValue(native, 'QUALITY');
    if (key === 'tempo') return common?.tempo ?? nativeTagValue(native, 'TEMPO');
    if (key === 'keywords') return text(common?.keywords);
    if (key === 'language') return common?.language ?? '';
    if (key === 'replaygain_track_gain') return nativeTagValue(native, 'REPLAYGAIN_TRACK_GAIN');
    if (key === 'replaygain_track_peak') return nativeTagValue(native, 'REPLAYGAIN_TRACK_PEAK');
    if (key === 'replaygain_album_gain') return nativeTagValue(native, 'REPLAYGAIN_ALBUM_GAIN');
    if (key === 'replaygain_album_peak') return nativeTagValue(native, 'REPLAYGAIN_ALBUM_PEAK');
    if (key === 'r128_track_gain') return nativeTagValue(native, 'R128_TRACK_GAIN');
    if (key === 'track') return common?.track?.no ?? '';
    if (key === 'disk') return common?.disk?.no ?? '';
    if (key === 'compilation') {
      const commonCompilation = common?.compilation === true || String(common?.compilation || '').trim() === '1';
      const nativeCompilation = nativeTagValue(native, 'TCMP') || nativeTagValue(native, 'COMPILATION') || nativeTagValue(native, 'cpil');
      return (commonCompilation || /^(1|true|yes)$/i.test(String(nativeCompilation || '').trim())) ? '1' : '';
    }
    if (key === 'pcount') return nativeTagValue(native, 'p_count') || nativeTagValue(native, 'PCOUNT') || nativeTagValue(native, 'PCNT');
    if (/^custom\d+$/.test(key)) return nativeTagValue(native, key);
    return common?.[key] ?? '';
  }

  function editorSortValue(native, key, fallback='') {
    const sortIds = { title:'TSOT', album:'TSOA', albumartist:'TSO2', artist:'TSOP', composer:'TSOC' };
    return nativeTagValue(native, sortIds[key] || '') || fallback || '';
  }

  function editorNativeObject(native) {
    const out = {};
    for (const tagList of Object.values(native || {})) {
      for (const tag of (Array.isArray(tagList) ? tagList : [])) {
        if (!tag?.id || tag.value === undefined) continue;
        const raw = tag.value?.text ?? tag.value?.description ?? tag.value?.value ?? tag.value;
        if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') out[tag.id] = raw;
      }
    }
    return out;
  }


  function applyEmptyEditGhosts(root = document) {
    // Empty editable fields should never look accidentally broken. Keep fields
    // that already have a format/example placeholder, but give truly blank
    // text inputs and textareas the universal Empty ghost.
    root.querySelectorAll('input:not([type]), input[type="text"], input[type="number"], input[type="password"], textarea').forEach(node => {
      if (node.readOnly || node.disabled) return;
      if (!String(node.placeholder || '').trim()) node.placeholder = 'Empty';
    });
  }

  function editorComparable(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v).trim();
  }

  function mergeEditorValues(values) {
    const normalized = values.map(editorComparable);
    return normalized.every(v => v === normalized[0]) ? (values[0] ?? '') : '';
  }

  let artworkEditorPictures = [];
  let artworkEditorSnapshots = [];
  let artworkEditorSelected = -1;
  let artworkEditorBlankSlots = [];
  let artworkEditorNextBlankId = 1;

  // MusicBee-style artwork type vocabulary. Keep the stored value canonical
  // and the visible text human-friendly. Native readers can return numeric
  // ID3 types or enum strings such as PictureType.COVER_BACK; all of those
  // must resolve to the same dropdown option.
  const ARTWORK_TYPES = [
    'Cover (Front)','Cover (Back)','Leaflet Page','Media','Lead Artist','Artist',
    'Conductor','Band','Composer','Lyricist','Recording Location','During Recording',
    'During Performance','Video Screen Capture','Illustration','Other'
  ];
  const ARTWORK_TYPE_LABELS = {
    'Cover (Front)': 'Album Cover',
    'Cover (Back)': 'Album Cover (back)',
    'Leaflet Page': 'Leaflet Page',
    'Media': 'Media Label',
    'Lead Artist': 'Lead Artist',
    'Artist': 'Artist',
    'Conductor': 'Conductor',
    'Band': 'Band',
    'Composer': 'Composer',
    'Lyricist': 'Lyricist',
    'Recording Location': 'Recording Location',
    'During Recording': 'During Recording',
    'During Performance': 'During Performance',
    'Video Screen Capture': 'Video Screen Capture',
    'Illustration': 'Illustration',
    'Other': 'Other'
  };
  function normalizeArtworkType(type) {
    const raw = String(type ?? '').trim();
    if (!raw) return 'Other';
    const key = raw.toLowerCase().replace(/\s+/g, ' ');
    const compact = key.replace(/^picturetype[._]/, '').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const aliases = {
      '0':'Other', '1':'File Icon', '2':'Other File Icon', '3':'Cover (Front)', '4':'Cover (Back)',
      '5':'Leaflet Page', '6':'Media', '7':'Lead Artist', '8':'Artist', '9':'Conductor',
      '10':'Band', '11':'Composer', '12':'Lyricist', '13':'Recording Location',
      '14':'During Recording', '15':'During Performance', '16':'Video Screen Capture',
      '18':'Illustration',
      'cover (front)':'Cover (Front)', 'cover front':'Cover (Front)', 'front cover':'Cover (Front)',
      'album cover':'Cover (Front)', 'front':'Cover (Front)', 'cover':'Cover (Front)',
      'cover (back)':'Cover (Back)', 'cover back':'Cover (Back)', 'back cover':'Cover (Back)',
      'album cover (back)':'Cover (Back)', 'album cover back':'Cover (Back)', 'back':'Cover (Back)',
      'leaflet page':'Leaflet Page', 'media':'Media', 'media label':'Media', 'lead artist':'Lead Artist',
      'artist':'Artist', 'conductor':'Conductor', 'band':'Band', 'composer':'Composer', 'lyricist':'Lyricist',
      'recording location':'Recording Location', 'during recording':'During Recording',
      'during performance':'During Performance', 'video screen capture':'Video Screen Capture',
      'movie/video screen capture':'Video Screen Capture', 'illustration':'Illustration', 'other':'Other'
    };
    if (aliases[key]) return aliases[key];
    if (aliases[compact]) return aliases[compact];
    if (compact.includes('cover') && compact.includes('back')) return 'Cover (Back)';
    if (compact.includes('cover') || compact.includes('front')) return 'Cover (Front)';
    return ARTWORK_TYPES.includes(raw) ? raw : 'Other';
  }
  function artworkTypeLabel(type) {
    return ARTWORK_TYPE_LABELS[normalizeArtworkType(type)] || 'Other';
  }
  function artworkTypeOptions(selected='Cover (Front)') {
    const selectedValue = normalizeArtworkType(selected);
    return ARTWORK_TYPES.map(type => `<option value="${escapeHtml(type)}" ${type === selectedValue ? 'selected' : ''}>${escapeHtml(ARTWORK_TYPE_LABELS[type])}</option>`).join('');
  }
  function artworkEditorPrimary(pictures) {
    return (pictures || []).find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)') || pictures?.[0] || null;
  }
  function artworkEditorPictureSrc(picture, fallback = null) {
    if (picture?.dataUrl) return String(picture.dataUrl);
    if (picture?.dataBase64) return `data:${String(picture.mime || 'image/jpeg')};base64,${picture.dataBase64}`;
    if (picture?.file) return coverSrc(picture.file);
    return fallback ? coverSrc(fallback) : placeholderCover();
  }
  function defaultArtworkBlankType(pictures = artworkEditorPictures) {
    const hasFront = (pictures || []).some(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)');
    return hasFront ? 'Cover (Back)' : 'Cover (Front)';
  }
  function ensureArtworkEditorBlankSlot() {
    if (!Array.isArray(artworkEditorBlankSlots)) artworkEditorBlankSlots = [];
    if (!artworkEditorBlankSlots.length) {
      artworkEditorBlankSlots.push({ id: artworkEditorNextBlankId++, type: defaultArtworkBlankType(), description: '' });
    }
    return artworkEditorBlankSlots[artworkEditorBlankSlots.length - 1];
  }
  function artworkEditorBlankSlotLabel(slot) {
    return artworkTypeLabel(slot?.type || 'Cover (Back)');
  }
  function artworkEditorBlankIndex(slotId) {
    return (artworkEditorBlankSlots || []).findIndex(slot => Number(slot?.id) === Number(slotId));
  }
  function artworkEditorBlankSlotForIndex(blankIndex) {
    return artworkEditorBlankSlots?.[blankIndex] || null;
  }
  function focusArtworkEditorBlankSlot(blankIndex = Math.max(0, (artworkEditorBlankSlots?.length || 1) - 1)) {
    const list = document.getElementById('tag-artwork-list');
    const card = list?.querySelector(`[data-artwork-blank-index="${blankIndex}"]`);
    if (card) {
      list.querySelectorAll('.artwork-library-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  function addArtworkBlankSlot() {
    ensureArtworkEditorBlankSlot();
    const slot = { id: artworkEditorNextBlankId++, type: 'Cover (Back)', description: '' };
    artworkEditorBlankSlots.push(slot);
    renderArtworkEditorList();
    focusArtworkEditorBlankSlot(artworkEditorBlankSlots.length - 1);
    el.tagStatus.textContent = 'Blank artwork slot added. Choose an image or search for a cover.';
  }
  function renderArtworkEditorList() {
    const list = document.getElementById('tag-artwork-list');
    const count = document.getElementById('tag-artwork-count');
    if (!list) return;
    const pictures = artworkEditorPictures || [];
    ensureArtworkEditorBlankSlot();
    if (count) count.textContent = `${pictures.length} picture${pictures.length === 1 ? '' : 's'}`;

    const pictureCards = pictures.map((picture, i) => {
      const primary = artworkTypeLabel(picture?.type) === 'Album Cover' && i === pictures.findIndex(p => artworkTypeLabel(p?.type) === 'Album Cover');
      const image = picture?.dataUrl || artworkEditorPictureSrc(picture);
      return `<article class="artwork-library-card ${i === artworkEditorSelected ? 'selected' : ''}" data-artwork-index="${i}">
        <div class="artwork-library-thumb-column">
          <div class="artwork-library-thumb-wrap"><img class="artwork-library-thumb" src="${escapeHtml(image)}" alt=""><span class="artwork-index-badge">${i + 1}</span>${primary ? '<span class="artwork-primary-badge">PRIMARY</span>' : ''}</div>
        </div>
        <div class="artwork-library-details">
          <div class="artwork-library-heading"><strong>${escapeHtml(artworkTypeLabel(picture?.type))}</strong><span>${escapeHtml(picture?.mime || '')}</span></div>
          <label>Picture type<select data-artwork-type>${artworkTypeOptions(picture?.type || 'Other')}</select></label>
          <label>Comments<textarea data-artwork-comment rows="2">${escapeHtml(picture?.description || '')}</textarea></label>
          <div class="artwork-library-actions"><button type="button" data-artwork-search>Search Internet for Cover…</button><button type="button" data-artwork-upload>Upload…</button><button type="button" data-artwork-save>Save To…</button><button type="button" data-artwork-delete class="danger">Delete</button></div>
        </div>
      </article>`;
    }).join('');

    const blankCards = artworkEditorBlankSlots.map((slot, blankIndex) => {
      const displayIndex = pictures.length + blankIndex + 1;
      const label = artworkEditorBlankSlotLabel(slot);
      const selected = artworkEditorSelected === -1000 - Number(slot.id);
      const preview = slot?.previewDataUrl || '';
      const hasPreview = !!preview;
      const previewMime = String(slot?.previewMime || 'image/jpeg');
      const previewState = hasPreview ? 'Ready to embed' : 'Not embedded';
            return `<article class="artwork-library-card artwork-library-blank-card ${hasPreview ? 'artwork-library-preview-card' : ''} ${selected ? 'selected' : ''}" data-artwork-blank-index="${blankIndex}" data-artwork-blank-id="${Number(slot.id)}">
        <div class="artwork-library-thumb-column">
          <div class="artwork-library-thumb-wrap artwork-library-blank-thumb ${hasPreview ? 'has-preview' : ''}"><img class="artwork-library-thumb" src="${escapeHtml(hasPreview ? preview : placeholderCover())}" alt=""><span class="artwork-index-badge">${displayIndex}</span></div>
        </div>
        <div class="artwork-library-details">
          <div class="artwork-library-heading"><strong>${escapeHtml(label)}</strong><span>${previewState}${hasPreview ? ` · ${escapeHtml(previewMime)}` : ''}</span></div>
          <label>Picture type<select data-artwork-blank-type>${artworkTypeOptions(slot?.type || 'Cover (Back)')}</select></label>
          <label>Comments<textarea data-artwork-blank-comment rows="2" placeholder="Optional description">${escapeHtml(slot?.description || '')}</textarea></label>
          <div class="artwork-library-actions"><button type="button" data-artwork-blank-search>Search Internet for Cover…</button><button type="button" data-artwork-blank-upload>Choose Picture…</button><button type="button" data-artwork-blank-paste>Paste Picture</button>${artworkEditorBlankSlots.length > 1 ? '<button type="button" data-artwork-blank-remove>Remove Slot</button>' : ''}</div>
        </div>
      </article>`;
    }).join('');

    list.innerHTML = `<div class="artwork-quick-actions" role="toolbar" aria-label="Quick artwork actions"><button type="button" data-artwork-quick-front>Front Cover</button><button type="button" data-artwork-quick-back>Back Cover</button></div>` + pictureCards + blankCards;

    list.querySelector('[data-artwork-quick-front]')?.addEventListener('click', async e => {
      e.stopPropagation();
      await quickArtworkAction('Cover (Front)');
    });
    list.querySelector('[data-artwork-quick-back]')?.addEventListener('click', async e => {
      e.stopPropagation();
      await quickArtworkAction('Cover (Back)');
    });

    list.querySelectorAll('.artwork-library-card[data-artwork-index]').forEach(card => {
      const index = Number(card.dataset.artworkIndex);
      card.addEventListener('click', () => {
        artworkEditorSelected = index;
        list.querySelectorAll('.artwork-library-card').forEach(c => c.classList.toggle('selected', c === card));
      });
      card.querySelector('[data-artwork-search]')?.addEventListener('click', async e => {
        e.stopPropagation();
        await searchEditorArtwork(true, artworkEditorSlotForIndex(index));
      });
      card.querySelector('[data-artwork-upload]')?.addEventListener('click', async e => {
        e.stopPropagation();
        await replaceArtworkItem(index, card);
      });
      card.querySelector('[data-artwork-delete]')?.addEventListener('click', async e => {
        e.stopPropagation();
        await deleteArtworkItem(index);
      });
      // Keep the artwork thumbnails consistent with the Tags-page artwork
      // context menu. Right-clicking a specific embedded picture acts on that
      // picture only; it must never fall back to the album/front-cover action.
      const showArtworkCardContextMenu = e => {
        e.preventDefault();
        e.stopPropagation();
        artworkEditorSelected = index;
        list.querySelectorAll('.artwork-library-card').forEach(c => c.classList.toggle('selected', c === card));
        // Keep the artwork-tab context menu identical to the Tags-tab menu,
        // but scope each action to the specific picture that was right-clicked.
        showContextMenu(e.clientX, e.clientY, [
          { label:'Choose Picture…', action:()=>replaceArtworkItem(index, card) },
          { label:'Search Internet for Cover…', action:()=>searchEditorArtwork(true, artworkEditorSlotForIndex(index)) },
          { label:'Paste Picture', action:async()=>{
              try {
                const chosen = await window.beehive.pasteCover();
                if (chosen) await replaceArtworkItem(index, card, chosen);
                else el.tagStatus.textContent = 'No image was available on the clipboard.';
              } catch(err) { el.tagStatus.textContent = err.message || 'Could not paste artwork.'; }
            } },
          { label:'Remove Picture', danger:true, action:()=>deleteArtworkItem(index) }
        ]);
      };
      const thumb = card.querySelector('.artwork-library-thumb-wrap');
      thumb?.addEventListener('contextmenu', showArtworkCardContextMenu);
      card.querySelector('.artwork-library-thumb')?.addEventListener('contextmenu', showArtworkCardContextMenu);
      card.querySelector('[data-artwork-save]')?.addEventListener('click', async e => {
        e.stopPropagation();
        const picture = artworkEditorPictures[index];
        if (!picture?.dataUrl) return;
        try {
          const temp = await window.beehive.saveDataUrlImage(picture.dataUrl, `beehive-artwork-${index + 1}.${String(picture.mime || 'image/jpeg').split('/')[1] || 'jpg'}`);
          if (temp) await window.beehive.saveImageFile(temp);
        } catch (err) { el.tagStatus.textContent = err.message || 'Could not save artwork.'; }
      });
      const persistArtworkMeta = () => {
        artworkEditorSelected = index;
        const type = normalizeArtworkType(card.querySelector('[data-artwork-type]')?.value || artworkEditorPictures[index]?.type || 'Cover (Front)');
        const comment = card.querySelector('[data-artwork-comment]')?.value || '';
        const changedPicture = artworkEditorPictures[index];
        const stableSlot = {
          ...artworkEditorSlotForIndex(index),
          // Keep the identity captured before the type changes. The hash is
          // stable for metadata-only edits and lets queued swaps find the same
          // picture even after its type moves from Front to Back (or vice versa).
          hash: String(changedPicture?.hash || artworkEditorSlotForIndex(index)?.hash || '')
        };
        // Type/comment edits are real metadata writes, so run them through the
        // same serialized background queue as image replacements/deletions. This
        // prevents rapid front/back swaps from racing and overwriting one another.
        queueBackgroundMetadataTask(`Saving artwork metadata ${index + 1}`, async () => {
          for (const track of editingTracks) {
            const data = await window.beehive.readTags(track.path);
            const targetIndex = artworkEditorIndexForSlot(data?.pictures || [], stableSlot);
            if (targetIndex < 0) throw new Error(`The ${artworkEditorSlotLabel(stableSlot)} is not present in one of the selected files.`);
            await window.beehive.modifyArtwork(track.path, { action:'update', index:targetIndex, pictureType:type, comment }, { background: true });
          }
          el.tagStatus.textContent = 'Artwork metadata saved.';
        }, null, { protectPlayback: true, bulkWrite: true, paths: editingTracks.map(track => track.path) });
      };
      card.querySelector('[data-artwork-type]')?.addEventListener('change', persistArtworkMeta);
      card.querySelector('[data-artwork-comment]')?.addEventListener('change', persistArtworkMeta);
    });

    list.querySelectorAll('.artwork-library-blank-card').forEach(card => {
      const blankIndex = Number(card.dataset.artworkBlankIndex);
      const slot = artworkEditorBlankSlotForIndex(blankIndex);
      if (!slot) return;
      card.addEventListener('click', () => {
        artworkEditorSelected = -1000 - Number(slot.id);
        list.querySelectorAll('.artwork-library-card').forEach(c => c.classList.toggle('selected', c === card));
      });
      card.querySelector('[data-artwork-blank-search]')?.addEventListener('click', async e => {
        e.stopPropagation();
        await searchEditorArtwork(true, { blank: true, blankId: Number(slot.id) });
      });
      card.querySelector('[data-artwork-blank-upload]')?.addEventListener('click', async e => {
        e.stopPropagation();
        const chosen = await chooseArtworkForItem();
        if (!chosen) return;
        const type = card.querySelector('[data-artwork-blank-type]')?.value || slot.type || defaultArtworkBlankType();
        const comment = card.querySelector('[data-artwork-blank-comment]')?.value || slot.description || '';
        await fillArtworkBlankSlot(slot.id, chosen, type, comment);
      });
      card.querySelector('[data-artwork-blank-paste]')?.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          const chosen = await window.beehive.pasteCover();
          if (!chosen) { el.tagStatus.textContent = 'No image was available on the clipboard.'; return; }
          const type = card.querySelector('[data-artwork-blank-type]')?.value || slot.type || defaultArtworkBlankType();
          const comment = card.querySelector('[data-artwork-blank-comment]')?.value || slot.description || '';
          await fillArtworkBlankSlot(slot.id, chosen, type, comment);
        } catch (err) { el.tagStatus.textContent = err.message || 'Could not paste artwork.'; }
      });
      bindArtworkDropTarget(card, async chosen => {
        const type = card.querySelector('[data-artwork-blank-type]')?.value || slot.type || defaultArtworkBlankType();
        const comment = card.querySelector('[data-artwork-blank-comment]')?.value || slot.description || '';
        await fillArtworkBlankSlot(slot.id, chosen, type, comment);
      });
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        artworkEditorSelected = -1000 - Number(slot.id);
        showContextMenu(e.clientX, e.clientY, [
          { label:'Choose Picture…', action:async()=>{ const chosen=await chooseArtworkForItem(); if(chosen) await fillArtworkBlankSlot(slot.id, chosen, card.querySelector('[data-artwork-blank-type]')?.value || slot.type, card.querySelector('[data-artwork-blank-comment]')?.value || slot.description || ''); } },
          { label:'Search Internet for Cover…', action:()=>searchEditorArtwork(true, { blank:true, blankId:Number(slot.id) }) },
          { label:'Paste Picture', action:async()=>{ try { const chosen=await window.beehive.pasteCover(); if(chosen) await fillArtworkBlankSlot(slot.id, chosen, card.querySelector('[data-artwork-blank-type]')?.value || slot.type, card.querySelector('[data-artwork-blank-comment]')?.value || slot.description || ''); else el.tagStatus.textContent='No image was available on the clipboard.'; } catch(err) { el.tagStatus.textContent=err.message || 'Could not paste artwork.'; } } },
          ...(artworkEditorBlankSlots.length > 1 ? [{ label:'Remove Slot', danger:true, action:()=>{ const idx=artworkEditorBlankIndex(slot.id); if(idx>=0){ artworkEditorBlankSlots.splice(idx,1); ensureArtworkEditorBlankSlot(); renderArtworkEditorList(); } } }] : [])
        ]);
      });
      card.querySelector('[data-artwork-blank-remove]')?.addEventListener('click', e => {
        e.stopPropagation();
        if (artworkEditorBlankSlots.length <= 1) return;
        artworkEditorBlankSlots.splice(blankIndex, 1);
        ensureArtworkEditorBlankSlot();
        renderArtworkEditorList();
      });
      card.querySelector('[data-artwork-blank-type]')?.addEventListener('change', () => {
        slot.type = normalizeArtworkType(card.querySelector('[data-artwork-blank-type]')?.value || 'Cover (Back)');
        renderArtworkEditorList();
      });
      card.querySelector('[data-artwork-blank-comment]')?.addEventListener('change', () => {
        slot.description = card.querySelector('[data-artwork-blank-comment]')?.value || '';
      });
    });
  }
  let artworkEditorReloadGeneration = 0;
  async function reloadArtworkEditor() {
    if (!editingTracks?.length) return;
    const reloadGeneration = ++artworkEditorReloadGeneration;
    const loaded = await Promise.all(editingTracks.map(async track => ({ track, data: await window.beehive.readTags(track.path) })));
    if (reloadGeneration !== artworkEditorReloadGeneration) return;
    artworkEditorSnapshots = loaded;
    // The Tags preview and the Artwork tab must always derive from the same
    // freshly-read picture set. Keep every editing track synchronized with the
    // read-back result instead of allowing its older in-memory `cover/covers`
    // values (especially queued tracks) to disagree with the Artwork tab.
    for (const item of loaded) {
      const pictures = Array.isArray(item.data?.pictures) ? item.data.pictures : [];
      const track = item.track;
      if (!track) continue;
      track.covers = pictures.map(p => ({ type: p.type, mime: p.mime, description: p.description, hash: p.hash, index: p.index, file: p.file || null }));
      // readTags now returns stable Beehive cache filenames for embedded pictures;
      // keep those filenames on the live queue object so MPRIS/Music Presence can
      // expose the exact same local artwork instead of falling back to a data URL.
      const front = track.covers.find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)');
      track.cover = front?.file || track.covers[0]?.file || null;
      if (track.covers.length) clearAutomaticCoverVisual(track);
    }
    const first = loaded[0]?.data?.pictures || [];
    const keys = loaded.map(x => (x.data?.pictureSignatures || []).map(p => `${p.type}|${p.mime}|${p.hash}`).sort().join('\n'));
    const mismatch = loaded.length > 1 && keys.some(k => k !== keys[0]);
    artworkEditorPictures = mismatch ? [] : first;
    artworkEditorSelected = artworkEditorPictures.length ? 0 : -1;
    if (!Array.isArray(artworkEditorBlankSlots) || !artworkEditorBlankSlots.length) {
      artworkEditorBlankSlots = [{ id: artworkEditorNextBlankId++, type: defaultArtworkBlankType(), description: '' }];
    }
    const list = document.getElementById('tag-artwork-list');
    list?.classList.toggle('mismatching-covers', mismatch);
    if (mismatch) {
      if (list) list.innerHTML = `<div class="artwork-library-mismatch"><strong>Mismatching Covers</strong><span>The selected files do not contain the same embedded artwork set. Open a single file to edit its pictures individually, or use the main Tags cover control to apply one front cover to the whole selection.</span></div>`;
      const count = document.getElementById('tag-artwork-count'); if (count) count.textContent = `${loaded.length} files differ`;
      return;
    }
    renderArtworkEditorList();
  }
  async function chooseArtworkForItem() {
    return await window.beehive.chooseCover();
  }
  // A row represents an artwork *slot*, not merely an array index. This matters
  // for multi-track editing because native artwork arrays can be ordered
  // differently between files. For cover art, the slot is the normalized type
  // plus its occurrence: front, back 1, back 2, etc.
  function artworkEditorSlotForIndex(index) {
    const picture = artworkEditorPictures?.[index];
    const type = normalizeArtworkType(picture?.type || 'Other');
    let occurrence = 0;
    for (let i = 0; i <= index; i++) {
      if (normalizeArtworkType(artworkEditorPictures?.[i]?.type || 'Other') === type) occurrence++;
    }
    // The content hash is a stable identity while changing a picture's type or
    // comment. Keep it on the slot so two artwork cards can be swapped (front
    // <-> back) without the second queued write accidentally targeting the
    // wrong picture after the first write changes its type.
    return { type, occurrence, hash: String(picture?.hash || '') };
  }
  function artworkEditorIndexForSlot(pictures, slot) {
    if (!slot) return -1;
    const wantedHash = String(slot.hash || '').toLowerCase();
    if (wantedHash) {
      const byHash = (pictures || []).findIndex(p => String(p?.hash || '').toLowerCase() === wantedHash);
      if (byHash >= 0) return byHash;
    }
    const type = normalizeArtworkType(slot.type || 'Other');
    const wantedOccurrence = Math.max(1, Number(slot.occurrence) || 1);
    let occurrence = 0;
    for (let i = 0; i < (pictures || []).length; i++) {
      if (normalizeArtworkType(pictures[i]?.type || 'Other') !== type) continue;
      occurrence++;
      if (occurrence === wantedOccurrence) return i;
    }
    return -1;
  }
  function artworkEditorSlotLabel(slot) {
    const type = normalizeArtworkType(slot?.type || 'Other');
    const occurrence = Math.max(1, Number(slot?.occurrence) || 1);
    if (type === 'Cover (Front)') return 'front cover';
    if (type === 'Cover (Back)') return `back cover ${occurrence}`;
    return `${artworkTypeLabel(type)} ${occurrence}`;
  }
  // Replacing an audio file underneath the active GStreamer playbin can make
  // the source report EOS/ERROR even though the song itself has not finished.
  // Artwork edits are otherwise safe background work, but the *currently
  // playing* file is special: let the transport finish/switch away from that
  // path before committing the atomic metadata replacement. The UI remains
  // optimistic, so the user still sees the artwork disappear immediately; only
  // the final disk commit waits for a playback-safe window.
  async function waitForPlaybackSafeArtworkWrite(paths) {
    const protectedPaths = new Set((Array.isArray(paths) ? paths : [paths])
      .map(p => String(p || '')).filter(Boolean));
    if (!protectedPaths.size) return;

    const isProtected = () => {
      const currentPath = String(currentQueue[currentIndex]?.path || '');
      if (!currentPath || !protectedPaths.has(currentPath)) return false;
      // Web Audio: an actively scheduled source is represented by enginePaused=false.
      // GStreamer: gstActive remains true while playbin owns the current URI.
      return !enginePaused || gstActive;
    };

    if (!isProtected()) return;
    el.tagStatus.textContent = 'Waiting for the current track to finish before saving artwork…';

    await new Promise(resolve => {
      const started = performance.now();
      const poll = () => {
        // A path change, natural stop, or a paused/non-GStreamer transport gives
        // us a safe point. Keep a generous upper bound so an endlessly repeating
        // or otherwise stuck track can never hold the metadata queue forever.
        if (!isProtected() || performance.now() - started > 12 * 60 * 60 * 1000) {
          resolve();
          return;
        }
        setTimeout(poll, 250);
      };
      poll();
    });
  }

  function queueBackgroundMetadataTask(label, task, onDone = null, options = {}) {
    // Metadata writes are deliberately serialized so two fast edits cannot race
    // and overwrite each other. The UI is already optimistic; this queue is only
    // responsible for the physical file and verification work.
    window.__beehiveMetadataQueue = (window.__beehiveMetadataQueue || Promise.resolve())
      .then(async () => {
        try {
          if (options.protectPlayback) {
            await waitForPlaybackSafeArtworkWrite(options.paths || []);
          }
          el.tagStatus.textContent = `${label} in background…`;
          if (options.bulkWrite) await window.beehive.metadataBulkWriteStart?.(label);
          try {
            const result = await task();
            if (onDone) await onDone(result);
            return result;
          } finally {
            if (options.bulkWrite) await window.beehive.metadataBulkWriteEnd?.(label);
          }
        } catch (err) {
          console.error(`Background metadata operation failed (${label}):`, err);
          el.tagStatus.textContent = `${label} failed: ${err.message || err}`;
          return null;
        }
      });
    return window.__beehiveMetadataQueue;
  }


  let backgroundMetadataProgress = { active: false, done: 0, total: 0, label: '' };
  function showMetadataProgress(label, done = 0, total = 1) {
    backgroundMetadataProgress = { active: true, done, total: Math.max(1, total), label };
    const box = document.getElementById('scan-progress');
    const title = document.getElementById('scan-progress-title');
    const fill = document.getElementById('scan-progress-fill');
    const text = document.getElementById('scan-progress-label');
    if (!box || !title || !fill || !text) return;
    box.classList.remove('hidden');
    title.textContent = label;
    const pct = Math.max(0, Math.min(100, Math.round((done / Math.max(1, total)) * 100)));
    fill.style.width = `${pct}%`;
    text.textContent = `${done} of ${total} file${total === 1 ? '' : 's'}`;
  }
  function finishMetadataProgress(label = 'Changes saved') {
    const box = document.getElementById('scan-progress');
    const title = document.getElementById('scan-progress-title');
    const fill = document.getElementById('scan-progress-fill');
    const text = document.getElementById('scan-progress-label');
    if (!box || !title || !fill || !text) return;
    title.textContent = label;
    fill.style.width = '100%';
    text.textContent = 'Finished';
    setTimeout(() => {
      if (!backgroundMetadataProgress.active) box.classList.add('hidden');
    }, 900);
    backgroundMetadataProgress.active = false;
  }

  async function artworkDropFileToChosen(file) {
    if (!file || !String(file.type || '').startsWith('image/')) return null;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read dropped artwork.'));
      reader.readAsDataURL(file);
    });
    const path = String(file.path || '');
    if (path) return { path, dataUrl, mime: String(file.type || 'image/jpeg') };
    const temp = await window.beehive.saveDataUrlImage(dataUrl, `dropped-artwork-${Date.now()}.png`);
    return temp ? { path: temp, dataUrl, mime: String(file.type || 'image/png') } : null;
  }
  function bindArtworkDropTarget(card, onImage) {
    if (!card || typeof onImage !== 'function') return;
    card.addEventListener('dragover', e => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); card.classList.add('drag-over'); }
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', async e => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('drag-over');
      try {
        const file = e.dataTransfer?.files?.[0];
        const chosen = await artworkDropFileToChosen(file);
        if (chosen) await onImage(chosen);
      } catch (err) { el.tagStatus.textContent = err.message || 'Could not import dropped artwork.'; }
    });
  }
  async function quickArtworkAction(type) {
    const normalized = normalizeArtworkType(type);
    const existingIndex = artworkEditorPictures.findIndex(p => normalizeArtworkType(p?.type || 'Other') === normalized);
    if (existingIndex >= 0) {
      const card = document.querySelector(`.artwork-library-card[data-artwork-index="${existingIndex}"]`);
      await replaceArtworkItem(existingIndex, card);
      return;
    }
    let slot = artworkEditorBlankSlots.find(s => normalizeArtworkType(s?.type || 'Other') === normalized);
    if (!slot) {
      slot = { id: artworkEditorNextBlankId++, type: normalized, description: '' };
      artworkEditorBlankSlots.push(slot);
      renderArtworkEditorList();
    }
    const chosen = await chooseArtworkForItem();
    if (!chosen) return;
    await fillArtworkBlankSlot(slot.id, chosen, normalized, slot.description || '');
  }

  async function replaceArtworkItem(index, card, chosenOverride = null) {
    try {
      const chosen = chosenOverride || await chooseArtworkForItem();
      if (!chosen) return;
      const slot = artworkEditorSlotForIndex(index);
      const type = card?.querySelector('[data-artwork-type]')?.value || artworkEditorPictures[index]?.type || 'Cover (Front)';
      const comment = card?.querySelector('[data-artwork-comment]')?.value || artworkEditorPictures[index]?.description || '';
      const previous = artworkEditorPictures[index];
      // Optimistic artwork update: paint the new image immediately and keep the
      // editor open. Disk tagging is queued after the UI has responded.
      artworkEditorPictures[index] = { ...(previous || {}), type: normalizeArtworkType(type), description: comment, dataUrl: chosen.dataUrl || chosen.url || previous?.dataUrl || '', mime: chosen.mime || previous?.mime || 'image/jpeg' };
      renderArtworkEditorList();
      // The album/library view uses the same editing track objects, so update
      // every selected track optimistically instead of waiting for the disk scan.
      for (const track of editingTracks) {
        const pictures = Array.isArray(track.covers) ? track.covers.slice() : [];
        const targetIndex = artworkEditorIndexForSlot(pictures, slot);
        if (targetIndex >= 0) pictures[targetIndex] = { ...pictures[targetIndex], file: chosen.path, type: normalizeArtworkType(type), description: comment };
        track.covers = pictures;
        track.cover = pictures.find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)')?.file || pictures[0]?.file || track.cover || chosen.path;
        clearAutomaticCoverVisual(track);
      }
      applyLibrary(library);
      // Do not synchronously rebuild a potentially 30k-track view while the artwork
      // picker/save operation is returning. Queue one paint-coalesced refresh instead.
      if (!window.__beehiveArtworkRenderQueued) {
        window.__beehiveArtworkRenderQueued = true;
        requestAnimationFrame(() => {
          window.__beehiveArtworkRenderQueued = false;
          try { renderCurrentView(); } catch (err) { console.error('[Beehive Artwork] deferred view refresh failed:', err); }
        });
      }
      const currentPath = String(currentQueue[currentIndex]?.path || '');
      if (currentPath && editingTracks.some(t => String(t.path || '') === currentPath)) {
        const current = currentQueue[currentIndex];
        const currentPictures = Array.isArray(current.covers) ? current.covers.slice() : [];
        const targetIndex = artworkEditorIndexForSlot(currentPictures, slot);
        if (targetIndex >= 0) currentPictures[targetIndex] = { ...currentPictures[targetIndex], dataUrl: chosen.dataUrl || chosen.url || '', file: chosen.path, type: normalizeArtworkType(type), description: comment };
        current.covers = currentPictures;
        current.cover = currentPictures.find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)')?.file || currentPictures[0]?.file || chosen.path || current.cover;
        clearAutomaticCoverVisual(current);
        refreshCoverRotationTargets();
      }
      el.tagStatus.textContent = `${artworkEditorSlotLabel(slot)} updated. Saving in background…`;
      queueBackgroundMetadataTask(`Replacing ${artworkEditorSlotLabel(slot)}`, async () => {
        for (const track of editingTracks) {
          const data = await window.beehive.readTags(track.path);
          const targetIndex = artworkEditorIndexForSlot(data?.pictures || [], slot);
          if (targetIndex < 0) throw new Error(`The ${artworkEditorSlotLabel(slot)} is not present in one of the selected files.`);
          await window.beehive.modifyArtwork(track.path, { action:'replace', index:targetIndex, imagePath:chosen.path, pictureType:type, comment }, { background: true });
        }
        el.tagStatus.textContent = `${artworkEditorSlotLabel(slot)} saved.`;
      }, null, { protectPlayback: true, bulkWrite: true, paths: editingTracks.map(track => track.path) });
    } catch (err) { el.tagStatus.textContent = err.message || 'Could not replace artwork.'; }
  }

  async function deleteArtworkItem(index) {
    if (!(await themedConfirm('Delete this embedded artwork from the selected file(s)?', 'Delete embedded artwork'))) return;
    try {
      const slot = artworkEditorSlotForIndex(index);
      const removed = artworkEditorPictures[index];
      // Optimistically remove the row now; the physical deletion is queued.
      artworkEditorPictures.splice(index, 1);
      artworkEditorSelected = Math.min(index, artworkEditorPictures.length - 1);
      renderArtworkEditorList();
      for (const track of editingTracks) {
        const pictures = Array.isArray(track.covers) ? track.covers.slice() : [];
        const targetIndex = artworkEditorIndexForSlot(pictures, slot);
        if (targetIndex >= 0) pictures.splice(targetIndex, 1);
        track.covers = pictures;
        track.cover = pictures.find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)')?.file || pictures[0]?.file || null;
        // An explicit artwork deletion is authoritative. Do not immediately
        // replace the deleted artwork with the automatic missing-cover visual.
        if (!pictures.length) clearAutomaticCoverVisual(track);
      }
      applyLibrary(library);
      if (!window.__beehiveArtworkRenderQueued) {
        window.__beehiveArtworkRenderQueued = true;
        requestAnimationFrame(() => { window.__beehiveArtworkRenderQueued = false; try { renderCurrentView(); } catch (err) { console.error('[Beehive Artwork] deferred view refresh failed:', err); } });
      }
      if (removed) {
        for (const track of editingTracks) {
          if (String(currentQueue[currentIndex]?.path || '') !== String(track.path || '')) continue;
          const current = currentQueue[currentIndex];
          // Removing one picture must never erase the other embedded pictures
          // from the live queue. Rebuild the queue artwork from the editor's
          // optimistic set, then let the background write reconcile it with disk.
          const remaining = Array.isArray(track.covers) ? track.covers.slice() : [];
          current.covers = remaining;
          current.cover = remaining.find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)')?.file || remaining[0]?.file || null;
          if (!remaining.length) clearAutomaticCoverVisual(current);
          refreshCoverRotationTargets();
        }
      }
      el.tagStatus.textContent = `${artworkEditorSlotLabel(slot)} removed. Saving in background…`;
      queueBackgroundMetadataTask(`Deleting ${artworkEditorSlotLabel(slot)}`, async () => {
        for (const track of editingTracks) {
          const data = await window.beehive.readTags(track.path);
          const targetIndex = artworkEditorIndexForSlot(data?.pictures || [], slot);
          if (targetIndex < 0) throw new Error(`The ${artworkEditorSlotLabel(slot)} is not present in one of the selected files.`);
          await window.beehive.modifyArtwork(track.path, { action:'delete', index:targetIndex }, { background: true });
        }
        el.tagStatus.textContent = `${artworkEditorSlotLabel(slot)} deleted.`;
      }, null, { protectPlayback: true, bulkWrite: true, paths: editingTracks.map(track => track.path) });
    } catch (err) { el.tagStatus.textContent = err.message || 'Could not delete artwork.'; }
  }

  async function fillArtworkBlankSlot(blankId, chosen, type = 'Cover (Back)', comment = '') {
    if (!chosen) return;
    const blankIndex = artworkEditorBlankIndex(blankId);
    const slot = artworkEditorBlankSlotForIndex(blankIndex);
    if (!slot) throw new Error('That blank artwork slot is no longer available.');
    const normalizedType = normalizeArtworkType(type || 'Cover (Back)');
    const normalizedComment = String(comment || '');
    const previewDataUrl = chosen.dataUrl || chosen.url || '';
    const previewMime = chosen.mime || 'image/jpeg';
    // Keep the item visually in its blank slot while the physical metadata write
    // is pending. This prevents a fast read-back from making a freshly selected
    // online cover appear to disappear, and lets the user see exactly what will
    // be embedded. Once the write is verified, reloadArtworkEditor converts it
    // into a real embedded picture and appends the next empty slot.
    slot.previewDataUrl = previewDataUrl;
    slot.previewMime = previewMime;
    slot.previewPath = chosen.path || '';
    slot.type = normalizedType;
    slot.description = normalizedComment;
    slot.pending = true;
    artworkEditorSelected = -1000 - Number(slot.id);
    renderArtworkEditorList();

    for (const track of editingTracks) {
      const pictures = [...(Array.isArray(track.covers) ? track.covers : []), { file: chosen.path, type: normalizedType, description: normalizedComment, mime: chosen.mime || 'image/jpeg' }];
      track.covers = pictures;
      track.cover = pictures.find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)')?.file || pictures[0]?.file || chosen.path;
      clearAutomaticCoverVisual(track);
    }
    applyLibrary(library);
    if (!window.__beehiveArtworkRenderQueued) {
      window.__beehiveArtworkRenderQueued = true;
      requestAnimationFrame(() => {
        window.__beehiveArtworkRenderQueued = false;
        try { renderCurrentView(); } catch (err) { console.error('[Beehive Artwork] deferred view refresh failed:', err); }
      });
    }
    el.tagStatus.textContent = `${artworkTypeLabel(normalizedType)} selected for this slot. Saving in background…`;
    queueBackgroundMetadataTask(`Adding ${artworkTypeLabel(normalizedType)}`, async () => {
      for (const track of editingTracks) {
        await window.beehive.modifyArtwork(track.path, { action:'add', imagePath:chosen.path, pictureType:normalizedType, comment:normalizedComment }, { background: true });
      }
      // Only discard the slot preview after every selected file has accepted the
      // image. reloadArtworkEditor will then show the actual embedded picture and
      // create the next blank slot at the end.
      slot.previewDataUrl = '';
      slot.previewMime = '';
      slot.previewPath = '';
      slot.pending = false;
      el.tagStatus.textContent = `${artworkTypeLabel(normalizedType)} added.`;
    }, null, { protectPlayback: true, bulkWrite: true, paths: editingTracks.map(track => track.path) });
  }

  async function addArtworkItem() {
    addArtworkBlankSlot();
  }

  async function openTagEditor(t, tracksOverride=null){
    editingTrack=t;
    editingTracks = Array.isArray(tracksOverride) && tracksOverride.length ? tracksOverride : [t];
    pendingArtworkPath = null;
    pendingArtworkPreviewUrl = '';
    pendingArtworkSlot = null;
    pendingArtworkMode = 'front';
    artworkEditorBlankSlots = [{ id: artworkEditorNextBlankId++, type: defaultArtworkBlankType(), description: '' }];
    window.__beehiveRemoveArtwork = false;
    window.__beehiveRemoveFrontArtwork = false;
    openModal(el.tagModal);
    const bulkMode = editingTracks.length > 1;
    const albumMode = bulkMode && editingTracks.every(track => albumKey(track) === albumKey(t));
    document.getElementById('tag-editor-title').textContent = albumMode
      ? `Edit album · ${t.album || 'Unknown Album'}`
      : (bulkMode ? `Edit ${editingTracks.length} selected tracks` : 'Edit track');
    document.getElementById('tag-editor-scope').textContent = albumMode
      ? `Changes will be applied to all ${editingTracks.length} tracks in this album.`
      : (bulkMode ? `Changes will be applied to all ${editingTracks.length} selected tracks.` : 'Changes apply to this track.');
    setTagEditorTab('tags');
    el.tagStatus.textContent='Loading tags from file…';

    // IMPORTANT: never use the cached library metadata as the edit source of truth.
    // Reload every selected file from disk, just like Strawberry's edit dialog does.
    const loaded = await Promise.all(editingTracks.map(async track => ({
      track,
      data: await window.beehive.readTags(track.path)
    })));
    editingTagSnapshots = loaded;

    const set=(id,v)=>{ const node=document.getElementById(id); if(node) { node.value=v??''; if (!String(node.value || '').trim() && !String(node.placeholder || '').trim()) node.placeholder='Empty'; } };
    const setMerged=(id, values, bulk, multiLabel)=>{
      const node=document.getElementById(id);
      if(!node) return;
      const merged = bulk ? mergeEditorValues(values) : (values[0] ?? '');
      node.value = merged ?? '';
      const differs = values.some(v => editorComparable(v) !== editorComparable(values[0] ?? ''));
      if (bulk && merged === '' && differs) {
        node.placeholder = multiLabel;
      } else if (!String(node.value || '').trim() && !String(node.placeholder || '').trim()) {
        node.placeholder = 'Empty';
      }
      // Preserve useful field-specific examples when a real value is absent.
      // The old editor removed those placeholders on every open, leaving blank
      // boxes with no clue what belonged there.
    };
    const multiValueGhost = 'Multiple Values';
    const firstData = loaded[0]?.data || {};
    const firstCommon = firstData.common || {};

    // For multi-selection, show a value only when every selected file has the same
    // value. This prevents silently copying track #1's metadata over every file.
    for (const [key, id] of TAG_EDITOR_FIELDS) {
      const values = loaded.map(item => editorTextValue(item.data?.common || {}, item.data?.native || {}, key));
      setMerged(id, values, bulkMode, multiValueGhost);
    }
    const customMaps = loaded.map(item => editorNativeObject(item.data?.native || {}));
    const allCustomKeys = [...new Set(customMaps.flatMap(obj => Object.keys(obj)))];
    const mergedCustom = {};
    for (const key of allCustomKeys) {
      const vals = customMaps.map(obj => obj[key] ?? '');
      const merged = mergeEditorValues(vals);
      if (merged !== '') mergedCustom[key] = merged;
    }
    set('tag-advanced', JSON.stringify(mergedCustom,null,2));
    applyEmptyEditGhosts(el.tagEditorModal || document);

    const starts = loaded.map(item => item.track.startTime || nativeTagValue(item.data?.native,'START_TIME'));
    const ends = loaded.map(item => item.track.endTime || nativeTagValue(item.data?.native,'END_TIME'));
    const lyricOffsets = loaded.map(item => nativeTagValue(item.data?.native,'BEEHIVE_LYRICS_OFFSET'));
    setMerged('tag-start-time', starts, bulkMode, multiValueGhost);
    setMerged('tag-end-time', ends, bulkMode, multiValueGhost);
    setMerged('tag-lyrics-offset', lyricOffsets, bulkMode, multiValueGhost);
    for (const [key,id] of [['REPLAYGAIN_TRACK_GAIN','tag-replaygain-track-gain'],['REPLAYGAIN_TRACK_PEAK','tag-replaygain-track-peak'],['REPLAYGAIN_ALBUM_GAIN','tag-replaygain-album-gain'],['REPLAYGAIN_ALBUM_PEAK','tag-replaygain-album-peak'],['R128_TRACK_GAIN','tag-r128-track-gain']]) {
      setMerged(id, loaded.map(item => nativeTagValue(item.data?.native, key)), bulkMode, multiValueGhost);
    }
    const lyricValues = loaded.map(item => editorTextValue(item.data?.common || {}, item.data?.native || {}, 'lyrics'));
    const lyricText = bulkMode ? mergeEditorValues(lyricValues) : lyricValues[0];
    tagLyricsPayload = { text: extractLyricsPayload(lyricText || ''), editing: false };
    setMerged('tag-lyrics', lyricValues, bulkMode, multiValueGhost);
    renderTagEditorLyricsPreview(tagLyricsPayload.text, { embedded: true, source: 'Embedded' });
    setTagLyricsEditing(false);
    const noLyrics = nativeTagValue(firstData.native, 'NO_LYRICS');
    const noLyricsNode = document.getElementById('tag-no-lyrics');
    if (noLyricsNode) noLyricsNode.checked = /^(1|true|yes)$/i.test(String(noLyrics || ''));

    const embeddedPcount = editorTextValue(firstCommon, firstData.native || {}, 'pcount');
    setMerged('tag-pcount', loaded.map(item => editorTextValue(item.data?.common || {}, item.data?.native || {}, 'pcount')), bulkMode, multiValueGhost);
    const trackParts = String(firstCommon?.track?.of || '').trim();
    const discParts = String(firstCommon?.disk?.of || '').trim();
    set('tag-track-total', trackParts);
    set('tag-disc-total', discParts);
    const trackRating = Number(t.rating || firstCommon?.rating || 0);
    const ratingText = value => `${'★'.repeat(Math.max(0, Math.min(5, value)))}${'☆'.repeat(5 - Math.max(0, Math.min(5, value)))}`;
    const trackRatingNode = document.getElementById('tag-track-rating-display');
    if (trackRatingNode) trackRatingNode.textContent = ratingText(trackRating);
    set('tag-sort-title', editorTextValue(firstCommon, firstData.native, 'title'));
    set('tag-sort-title-as', editorSortValue(firstData.native, 'title', editorTextValue(firstCommon, firstData.native, 'title')));
    set('tag-sort-album', editorTextValue(firstCommon, firstData.native, 'album'));
    set('tag-sort-album-as', editorSortValue(firstData.native, 'album', editorTextValue(firstCommon, firstData.native, 'album')));
    set('tag-sort-albumArtist', editorTextValue(firstCommon, firstData.native, 'albumartist'));
    set('tag-sort-albumArtist-as', editorSortValue(firstData.native, 'albumartist', editorTextValue(firstCommon, firstData.native, 'albumartist')));
    set('tag-sort-artist', editorTextValue(firstCommon, firstData.native, 'artist'));
    set('tag-sort-artist-as', editorSortValue(firstData.native, 'artist', editorTextValue(firstCommon, firstData.native, 'artist')));
    set('tag-sort-composer', editorTextValue(firstCommon, firstData.native, 'composer'));
    set('tag-sort-composer-as', editorSortValue(firstData.native, 'composer', editorTextValue(firstCommon, firstData.native, 'composer')));
    const customSorting = document.getElementById('tag-custom-sorting');
    if (customSorting) customSorting.checked = /^(1|true|yes)$/i.test(String(nativeTagValue(firstData.native, 'BEEHIVE_CUSTOM_SORTING') || ''));
    const compilationNode = document.getElementById('tag-compilation');
    if (compilationNode) compilationNode.checked = /^(1|true|yes)$/i.test(String(editorTextValue(firstCommon, firstData.native, 'compilation') || ''));

    const f=firstData.format||{}, stat=firstData.stat||{};
    const prop=(id,v)=>{const n=document.getElementById(id);if(n)n.textContent=(v===undefined||v===null||v==='')?'—':String(v);};
    const propertyTracks = albumMode ? editingTracks : [t];
    const propertyDurations = loaded.map((item, i) => Number(item.data?.format?.duration ?? item.track?.duration ?? 0) || 0);
    const propertySizes = loaded.map(item => Number(item.data?.stat?.size || 0));
    const albumDuration = propertyDurations.reduce((a,b)=>a+b,0);
    const albumSize = propertySizes.reduce((a,b)=>a+b,0);
    const formats = [...new Set(loaded.map(item => String(item.data?.format?.codec || pathExtLabel(item.track?.path).replace(/ audio file$/i,'') || '').toUpperCase()).filter(Boolean))];
    const lovedValues = propertyTracks.map(track => !!track?.loved);
    const lovedLabel = lovedValues.every(Boolean) ? 'Loved' : lovedValues.every(v => !v) ? 'Not loved' : 'Mixed';
    const ratingValues = propertyTracks.map(track => Number(track?.rating || 0));
    const ratingLabel = ratingValues.every(v => v === ratingValues[0]) ? ratingStars({rating:ratingValues[0]}).replace(/<[^>]*>/g,'') : 'Multiple';
    const locations = propertyTracks.map(track => String(track?.path || ''));
    const locationDir = pathDirCommon(locations);
    prop('tag-prop-type', f.codec ? `${String(f.codec).toUpperCase()} audio file` : pathExtLabel(t.path));
    prop('tag-prop-encoder', f.encoder); prop('tag-prop-version', Array.isArray(f.tagTypes) && f.tagTypes.length ? f.tagTypes.join(', ') : (firstCommon.artwork ? 'embedded artwork' : (f.codec||''))); prop('tag-prop-channels', f.numberOfChannels ? `${f.numberOfChannels}` : '—');
    prop('tag-prop-size', stat.size ? formatBytes(stat.size) : '—'); prop('tag-prop-bitrate', f.bitrate ? `${Math.round(f.bitrate/1000)} kbps` : '—');
    prop('tag-prop-duration', albumMode ? fmtTime(albumDuration) : (f.duration ? fmtTime(f.duration) : fmtTime(t.duration))); prop('tag-prop-samplerate', f.sampleRate ? `${(f.sampleRate/1000).toFixed(1)} kHz` : '—');
    prop('tag-prop-added', stat.birthtimeMs ? new Date(stat.birthtimeMs).toLocaleString() : (t.addedAt ? new Date(t.addedAt).toLocaleString() : '—'));
    prop('tag-prop-lastplayed', bulkMode ? 'Multiple' : (t.lastPlayedAt ? new Date(t.lastPlayedAt).toLocaleString() : 'Unknown')); prop('tag-prop-plays', bulkMode ? 'Multiple' : String(t.playCount||0));
    prop('tag-prop-rating', ratingLabel); prop('tag-prop-loved', lovedLabel);
    prop('tag-prop-track-count', propertyTracks.length); prop('tag-prop-album-duration', fmtTime(albumDuration)); prop('tag-prop-album-size', formatBytes(albumSize)); prop('tag-prop-formats', formats.join(', '));
    const heading=document.getElementById('tag-properties-heading'); if(heading) heading.textContent=albumMode ? 'Album properties' : 'Track properties';
    const summary=document.getElementById('tag-properties-summary'); if(summary) summary.textContent=albumMode ? `${propertyTracks.length} tracks · ${lovedLabel.toLowerCase()}` : (t.album ? `${t.album}${t.albumArtist ? ` · ${t.albumArtist}` : ''}` : '');
    set('tag-prop-location', albumMode ? locationDir : (t.path||''));
    const artworkSignatures = loaded.map(item => Array.isArray(item.data?.pictureSignatures) ? item.data.pictureSignatures : []);
    const artworkSignatureKey = signatures => signatures
      .map(p => `${String(p?.type || 'Other')}|${String(p?.mime || '')}|${String(p?.hash || '')}`)
      .sort()
      .join('\n');
    const artworkKeys = artworkSignatures.map(artworkSignatureKey);
    const mismatchingArtwork = bulkMode && artworkKeys.length > 1 && artworkKeys.some(key => key !== artworkKeys[0]);
    ['tag-art-preview','tag-artwork-preview'].forEach(id=>{
      const img=document.getElementById(id);
      if(img) {
        const previewPicture = artworkEditorPrimary(firstData.pictures || firstCommon.picture || []);
        img.src = artworkEditorPictureSrc(previewPicture, t.cover);
        img.closest('.tag-cover-preview')?.classList.toggle('mismatching-covers', mismatchingArtwork);
      }
    });
    const firstPicture = artworkEditorPrimary(firstData.pictures || firstCommon.picture || []);
    const pictureType = String(firstPicture?.type || 'Cover (Front)');
    const pictureSelect = document.getElementById('tag-picture-type');
    if (pictureSelect) {
      const matching = [...pictureSelect.options].find(o => o.value.toLowerCase() === pictureType.toLowerCase() || o.textContent.toLowerCase() === pictureType.toLowerCase());
      pictureSelect.value = matching ? matching.value : 'Cover (Front)';
    }
    set('tag-artwork-comment', firstPicture?.description || '');
    await reloadArtworkEditor();
    const settingValues = {
      'tag-exclude-playback': nativeTagValue(firstData.native, 'BEEHIVE_EXCLUDE_PLAYBACK'),
      'tag-do-not-crossfade': nativeTagValue(firstData.native, 'BEEHIVE_DO_NOT_CROSSFADE'),
      'tag-remember-position': nativeTagValue(firstData.native, 'BEEHIVE_REMEMBER_POSITION')
    };
    Object.entries(settingValues).forEach(([id, value]) => { const node=document.getElementById(id); if(node) node.checked=/^(1|true|yes)$/i.test(String(value||'')); });
    el.tagStatus.textContent = bulkMode ? `${editingTracks.length} files loaded from disk. Blank fields mean the selected files differ.` : (t.path||'');
    if (!bulkMode) void refreshTagEditorLyrics(t);
  }
  function pathDirCommon(paths) {
    const clean = paths.map(p => String(p || '').replace(/\\/g, '/').replace(/\/+$/,'')).filter(Boolean);
    if (!clean.length) return '';
    if (clean.length === 1) return clean[0].split('/').slice(0,-1).join('/') || '/';
    const parts = clean.map(p => p.split('/').slice(0,-1));
    const limit = Math.min(...parts.map(p => p.length));
    let i=0; while(i<limit && parts.every(p => p[i] === parts[0][i])) i++;
    return (parts[0].slice(0,i).join('/') || '/');
  }
  function pathExtLabel(file){ const ext=String(file||'').split('.').pop()?.toUpperCase(); return ext ? `${ext} audio file` : 'Audio file'; }
  function formatBytes(n){ let v=Number(n)||0; const units=['B','KB','MB','GB']; let i=0; while(v>=1024&&i<units.length-1){v/=1024;i++;} return `${v.toFixed(i?1:0)} ${units[i]}`; }

  function applyLyricsAlignment(value) {
    const allowed = new Set(['left','center','right','justify']);
    const align = allowed.has(value) ? value : 'center';
    el.lyricsText.style.textAlign = align;
    el.lyricsText.dataset.alignment = align;
    localStorage.setItem('beehive:lyrics-alignment', align);
  }

  function lyricsLookupIdForTrack(t) {
    return `${t?.path || ''}|${t?.artist || ''}|${t?.title || ''}|${t?.album || ''}|${t?.duration || 0}`;
  }

  function clearLyricsLookupCacheForTrack(t) {
    const path = String(t?.path || '');
    const prefix = `${path}|`;
    for (const key of lyricsLookupCache.keys()) {
      if (String(key).startsWith(prefix)) lyricsLookupCache.delete(key);
    }
  }

  // Decide whether an online lyrics lookup is worth doing purely for
  // DISPLAY, and if so, show its result -- without ever writing it back to
  // the file (embedSearchedLyricsIfEnabled already refuses to embed once a
  // track has any embedded lyrics at all). The embedded tag is always plain
  // text (see tag_helper.py's plain_from_lrc), so when "Use highlighted
  // lyrics" is on, a lookup can still find a genuinely synced result worth
  // showing instead of the static embedded text. An online plain-only result
  // is never allowed to replace already-shown embedded text, since that
  // would just risk a flicker to a slightly different transcription with no
  // benefit. Assumes renderLyrics(embeddedLyrics, t) has already painted the
  // baseline state before this is called.
  function refreshTrackLyricsForDisplay(t) {
    if (!t || t.podcast || !t.artist || !t.title) return;
    const embeddedLyrics = String(t.lyrics || '').trim();
    const embeddedIsSynced = embeddedLyrics && parseSyncedLyrics(embeddedLyrics).length > 0;
    const wantsSyncedLookup = !embeddedLyrics || (highlightedLyricsEnabled() && !embeddedIsSynced);
    if (!wantsSyncedLookup) return;
    const generation = nowPlayingUiGeneration;
    const lookupId = lyricsLookupIdForTrack(t);
    const applyResult = found => {
      const text = normalizeLyricsPayload(found).trim();
      if (embeddedLyrics && !(text && parseSyncedLyrics(text).length > 0)) return;
      renderLyrics(found || '', t);
    };
    const previous = lyricsLookupCache.get(lookupId);
    if (previous !== undefined) {
      applyResult(previous);
      return;
    }
    if (!embeddedLyrics) renderLyrics('', t);
    window.beehive.searchLyrics({artist:t.artist,title:t.title,album:t.album,duration:t.duration,highlightedLyrics:highlightedLyricsEnabled()}).then(async found => {
      if (generation !== nowPlayingUiGeneration || currentQueue[currentIndex] !== t) return;
      lyricsLookupCache.set(lookupId, found || '');
      applyResult(found);
      await embedSearchedLyricsIfEnabled(t, found);
    }).catch(() => lyricsLookupCache.set(lookupId, ''));
  }

  function updateTrackLyricsModel(t, lyrics) {
    const value = String(lyrics || '');
    const path = String(t?.path || '');
    if (!path) return;
    const update = track => {
      if (track && String(track.path || '') === path) track.lyrics = value;
    };
    update(t);
    update(window.__beehiveNowPlayingTrack);
    update(currentQueue[currentIndex]);
    update(libraryTrackByPath.get(path));
    for (const track of (library.tracks || [])) update(track);
    for (const album of (albums || [])) for (const track of (album?.tracks || [])) update(track);
  }

  async function embedSearchedLyricsIfEnabled(t, found) {
    if (!embedLyricsAutomaticallyEnabled() || !t?.path || !found?.lyrics) return;
    // The lookup was only made because the track had no embedded lyrics. Recheck
    // the current model before writing so a filesystem update cannot be overwritten.
    const current = libraryTrackByPath.get(String(t.path || '')) || t;
    if (String(current?.lyrics || '').trim()) return;
    const lyrics = String(found.lyrics || '').trim();
    if (!lyrics) return;
    queueBackgroundMetadataTask('Embedding searched lyrics', async () => {
      await window.beehive.writeTags(t.path, { lyrics });
      return true;
    }, () => {
      updateTrackLyricsModel(t, lyrics);
    }, { protectPlayback: false, bulkWrite: false });
  }

  async function searchLyricsAgain(t) {
    if (!t?.artist || !t?.title || t?.podcast) return;
    if (String(t.lyrics || '').trim()) {
      await themedAlert('This track has embedded lyrics. Delete the embedded lyrics first to use online lyric search.', 'Lyrics search');
      return;
    }
    const generation = nowPlayingUiGeneration;
    const lookupId = lyricsLookupIdForTrack(t);
    lyricsLookupCache.delete(lookupId);
    renderLyrics('', t);
    try {
      const found = await window.beehive.searchLyrics({artist:t.artist,title:t.title,album:t.album,duration:t.duration,highlightedLyrics:highlightedLyricsEnabled()});
      if (generation !== nowPlayingUiGeneration || currentQueue[currentIndex] !== t) return;
      lyricsLookupCache.set(lookupId, found || '');
      renderLyrics(found || '', t);
      await embedSearchedLyricsIfEnabled(t, found);
    } catch {
      lyricsLookupCache.set(lookupId, '');
      if (generation === nowPlayingUiGeneration && currentQueue[currentIndex] === t) renderLyrics('', t);
    }
  }

  function deleteLyricsFromTrack(t) {
    if (!t?.path) return;
    const hadEmbedded = !!String(t.lyrics || '').trim();
    clearLyricsLookupCacheForTrack(t);
    updateTrackLyricsModel(t, '');
    if (currentQueue[currentIndex] === t || String(currentQueue[currentIndex]?.path || '') === String(t.path || '')) {
      renderLyrics('', t);
    }
    if (!hadEmbedded) return;

    queueBackgroundMetadataTask('Deleting embedded lyrics', async () => {
      await window.beehive.writeTags(t.path, { lyrics: '' });
      return true;
    }, () => {
      // The filesystem watcher/reconciliation remains the authoritative refresh;
      // this callback only keeps the optimistic model clean while it catches up.
      updateTrackLyricsModel(t, '');
    }, { protectPlayback: false, bulkWrite: false });
  }

  function showLyricsContextMenu(e, t) {
    if (!t) return;
    const hasEmbedded = !!String(t.lyrics || '').trim();
    showContextMenu(e.clientX, e.clientY, [
      {label:'Show highlighted lyric', icon:'lyrics', action:()=>{
        followHighlightedLyric = true;
        updateSyncedLyrics(Number(audio.currentTime) || 0, true);
        scrollHighlightedLyricIntoView('smooth');
      }},
      {label:'Search lyrics again', icon:'search', action:()=>searchLyricsAgain(t)},
      {label:hasEmbedded ? 'Delete embedded lyrics' : 'Clear searched lyrics', icon:'trash', action:()=>deleteLyricsFromTrack(t)},
      {label:'Edit lyrics…', icon:'edit', action:()=>{ openTagEditor(t); setTagEditorTab('lyrics'); }},
      {label:'Alignment', icon:'align', submenu:[
        {label:'Left', action:()=>applyLyricsAlignment('left')},
        {label:'Center', action:()=>applyLyricsAlignment('center')},
        {label:'Right', action:()=>applyLyricsAlignment('right')}
      ]}
    ]);
  }

  function showAlbumFromTrack(t) {
    if (!t || !t.album) return;
    const tab = getActiveTab();
    // Album search is an isolated browser context. A sidebar/playlist
    // `shuffle on enter` permutation belongs only to that collection and must
    // never leak into the album-search result or its playback queue. When the
    // user returns, the collection may establish a fresh visual permutation.
    const sourceNav = currentSidebarContextNav();
    if (sourceNav) visualShuffleOrders.delete(visualShuffleKeyForSidebar(sourceNav));
    if (specialView === 'playlist' && activePlaylistId) {
      const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
      if (pl) visualShuffleOrders.delete(visualShuffleKeyForPlaylist(pl));
    }
    // Album search is another entry point into the same Albums viewer. Snapshot
    // the current browser so Back restores the exact view, expanded album, and
    // scroll position instead of leaving the user stranded in album-focus.
    if (!albumSearchReturnState && tab) {
      saveActiveTabState();
      const state = tab.state || currentTabState(tab);
      albumSearchReturnState = {
        searchTerm: String(state.searchTerm || ''),
        artistSearchTerm: String(state.artistSearchTerm || ''),
        albumYearDividers: state.albumYearDividers !== false,
        viewMode: state.viewMode || 'albums',
        specialView: state.specialView || null,
        activeFolderPath: state.activeFolderPath || '',
        activePlaylistId: state.activePlaylistId ?? null,
        openAlbumKey: state.openAlbumKey || null,
        highlightedAlbumKey: state.highlightedAlbumKey || null,
        scrollTop: Number(state.scrollTop || 0),
      };
    }
    albumFocusTitle = String(t.album || '').trim();
    artistSearchTerm = '';
    searchTerm = '';
    el.search.value = '';
    updateSearchClearButton();
    activeFolderPath = '';
    activePlaylistId = null;
    specialView = 'album-focus';
    el.main.classList.add('searching');
    setView('albums');
  }

  function restoreAlbumSearchContext() {
    const tab = getActiveTab();
    const saved = albumSearchReturnState;
    if (!tab || !saved) {
      albumSearchReturnState = null;
      albumFocusTitle = null;
      searchTerm = '';
      artistSearchTerm = '';
      el.search.value = '';
      updateSearchClearButton();
      el.main.classList.remove('searching');
      setView('albums');
      return;
    }

    albumSearchReturnState = null;
    albumFocusTitle = null;
    artistSearchTerm = String(saved.artistSearchTerm || '');
    searchTerm = String(saved.searchTerm || '');
    albumYearDividers = saved.albumYearDividers !== false;
    viewMode = saved.viewMode || 'albums';
    specialView = saved.specialView || null;
    activeFolderPath = saved.activeFolderPath || '';
    activePlaylistId = saved.activePlaylistId ?? null;
    openAlbumKey = saved.openAlbumKey ? String(saved.openAlbumKey) : null;
    highlightedAlbumKey = saved.highlightedAlbumKey ? String(saved.highlightedAlbumKey) : null;
    el.search.value = artistSearchTerm || searchTerm;
    updateSearchClearButton();
    el.main.classList.toggle('searching', !!(artistSearchTerm || searchTerm));

    const reopenAlbumKey = openAlbumKey;
    const savedScrollTop = Math.max(0, Number(saved.scrollTop) || 0);
    setView(viewMode);
    requestAnimationFrame(() => {
      if (activeTabId !== tab.id) return;
      if (viewMode === 'albums' && reopenAlbumKey) {
        const card = el.albumsGrid.querySelector(`.album-card[data-key="${CSS.escape(String(reopenAlbumKey))}"]`);
        if (card && !card.classList.contains('inline-expanded')) {
          const tracks = tracksForCurrentContext();
          const album = buildAlbums(tracks).find(a => String(a?.key || '') === String(reopenAlbumKey));
          if (album) toggleInlineAlbum(card, album);
        }
      }
      getActiveViewport().scrollTop = savedScrollTop;
      saveActiveTabState();
      updateActiveTabLabel();
    });
  }

  function restoreArtistSearchContext() {
    const tab = getActiveTab();
    const saved = artistSearchReturnState;
    if (!tab || !saved) {
      artistSearchTerm = '';
      searchTerm = '';
      el.search.value = '';
      updateSearchClearButton();
      el.main.classList.remove('searching');
      setView('artists');
      return;
    }

    artistSearchReturnState = null;
    artistSearchFocusAlbumKey = null;
    searchTerm = String(saved.searchTerm || '');
    artistSearchTerm = String(saved.artistSearchTerm || '');
    albumYearDividers = saved.albumYearDividers !== false;
    viewMode = saved.viewMode || 'albums';
    specialView = saved.specialView || null;
    activeFolderPath = saved.activeFolderPath || '';
    activePlaylistId = saved.activePlaylistId ?? null;
    openAlbumKey = saved.openAlbumKey ? String(saved.openAlbumKey) : null;
    highlightedAlbumKey = saved.highlightedAlbumKey ? String(saved.highlightedAlbumKey) : null;
    el.search.value = artistSearchTerm || searchTerm;
    updateSearchClearButton();
    el.main.classList.toggle('searching', !!(artistSearchTerm || searchTerm));

    const reopenAlbumKey = openAlbumKey;
    const savedScrollTop = Math.max(0, Number(saved.scrollTop) || 0);
    setView(viewMode);
    requestAnimationFrame(() => {
      if (activeTabId !== tab.id) return;
      if (viewMode === 'albums' && reopenAlbumKey) {
        const card = el.albumsGrid.querySelector(`.album-card[data-key="${CSS.escape(String(reopenAlbumKey))}"]`);
        if (card && !card.classList.contains('inline-expanded')) {
          const tracks = tracksForCurrentContext();
          const album = buildAlbums(tracks).find(a => String(a?.key || '') === String(reopenAlbumKey));
          if (album) toggleInlineAlbum(card, album);
        }
      }
      getActiveViewport().scrollTop = savedScrollTop;
      saveActiveTabState();
      updateActiveTabLabel();
    });
  }

  function searchForArtist(value, sourceTrack = null) {
    const artist = String(value || '').trim();
    if (!artist) return;
    const tab = getActiveTab();
    // Artist search is another independent browser context. Do not carry a
    // collection's automatic visual shuffle into the artist result.
    const sourceNav = currentSidebarContextNav();
    if (sourceNav) visualShuffleOrders.delete(visualShuffleKeyForSidebar(sourceNav));
    if (specialView === 'playlist' && activePlaylistId) {
      const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
      if (pl) visualShuffleOrders.delete(visualShuffleKeyForPlaylist(pl));
    }

    // Do NOT build a second artist-specific viewer. Artist search is simply the
    // main Albums viewer filtered by artist metadata. Snapshot the existing
    // browser first so Back can restore its exact state and any expanded album.
    if (!artistSearchReturnState && tab) {
      saveActiveTabState();
      const state = tab.state || currentTabState(tab);
      artistSearchReturnState = {
        searchTerm: String(state.searchTerm || ''),
        artistSearchTerm: String(state.artistSearchTerm || ''),
        albumYearDividers: state.albumYearDividers !== false,
        viewMode: state.viewMode || 'albums',
        specialView: state.specialView || null,
        activeFolderPath: state.activeFolderPath || '',
        activePlaylistId: state.activePlaylistId ?? null,
        openAlbumKey: state.openAlbumKey || null,
        highlightedAlbumKey: state.highlightedAlbumKey || null,
        scrollTop: Number(state.scrollTop || 0),
      };
    }

    // Right-click -> Search artist is a navigation/filter action, not an album
    // expansion action. Only an explicit left-click on an album card may expand
    // an album. Keep this null so the artist-filtered Albums view opens collapsed.
    artistSearchFocusAlbumKey = null;
    artistSearchTerm = artist;
    searchTerm = '';
    el.search.value = artist;
    updateSearchClearButton();
    // Years stays visible during an artist search (see setView/syncTabControls),
    // but defaults to off for it every time -- a single artist's catalog is
    // small enough that year dividers are rarely wanted there, unlike
    // browsing the full library. artistSearchReturnState above already
    // captured the pre-search value, so the Back button still restores
    // whatever the user had before searching.
    albumYearDividers = false;

    // Real bug, confirmed: keeping specialView === 'playlist' active here
    // (previously conditional on a "keep the playlist context" flag) made
    // setView('albums')
    // take its early-return branch for a playlist/Favorites specialView,
    // which just re-renders that SAME playlist's tracks and never reaches
    // the renderAlbums() call that actually applies artistSearchTerm -- so
    // searching an artist from within a playlist silently did nothing,
    // leaving whatever was already showing. artistSearchReturnState above
    // already remembers this playlist (and specialView) so the Back button
    // can restore it; specialView must always be cleared here for the
    // artist-filtered album view to actually render.
    specialView = null;
    el.main.classList.add('searching');
    setView('albums');
  }

  let autoTagAlbumModal = null;
  function ensureAutoTagAlbumModal() {
    if (autoTagAlbumModal && document.body.contains(autoTagAlbumModal)) return autoTagAlbumModal;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay hidden';
    modal.id = 'auto-tag-album-modal';
    modal.innerHTML = `<div class="modal glass auto-tag-album-modal" role="dialog" aria-modal="true" aria-labelledby="auto-tag-title">
      <div class="modal-header"><div><h3 id="auto-tag-title">Auto-tag album</h3><div id="auto-tag-summary" class="settings-hint"></div></div><button class="modal-close" data-close type="button">✕</button></div>
      <div class="modal-body auto-tag-body">
        <div class="auto-tag-search-row"><label>Album<input id="auto-tag-album" autocomplete="off"></label><label>Artist<input id="auto-tag-artist" autocomplete="off"></label><button id="auto-tag-search" class="sidebar-add settings-save-primary" type="button">Search MusicBrainz</button></div>
        <div class="auto-tag-status" id="auto-tag-status">Search for the correct release, then review the track mapping before writing tags.</div>
        <div id="auto-tag-results" class="auto-tag-results"></div>
        <div id="auto-tag-preview" class="auto-tag-preview hidden"></div>
        <div class="tag-actions"><button class="sidebar-add" data-close type="button">Cancel</button><button id="auto-tag-apply" class="sidebar-add settings-save-primary" type="button" disabled>Apply tags</button></div>
      </div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal); });
    modal.querySelector('[data-close]')?.addEventListener('click', () => closeModal(modal));
    modal.querySelector('#auto-tag-search')?.addEventListener('click', () => runAutoTagSearch(modal));
    modal.querySelector('#auto-tag-album')?.addEventListener('keydown', e => { if (e.key === 'Enter') runAutoTagSearch(modal); });
    modal.querySelector('#auto-tag-artist')?.addEventListener('keydown', e => { if (e.key === 'Enter') runAutoTagSearch(modal); });
    modal.querySelector('#auto-tag-apply')?.addEventListener('click', () => applyAutoTagRelease(modal));
    autoTagAlbumModal = modal;
    return modal;
  }

  function autoTagCandidateHtml(item, index) {
    const score = Math.max(0, Math.round(Number(item.score || 0)));
    return `<button type="button" class="auto-tag-result" data-result-index="${index}">
      <span class="auto-tag-result-main"><strong>${escapeHtml(item.collectionName || 'Unknown release')}</strong><small>${escapeHtml(item.artistName || 'Unknown artist')} · ${escapeHtml(item.releaseYear || 'Year unknown')} · ${escapeHtml(item.releaseCountry || 'Country unknown')}</small></span>
      <span class="auto-tag-result-score">${score}%</span>
    </button>`;
  }

  async function runAutoTagSearch(modal, options = {}) {
    const album = modal.querySelector('#auto-tag-album')?.value.trim() || '';
    const artist = modal.querySelector('#auto-tag-artist')?.value.trim() || '';
    const status = modal.querySelector('#auto-tag-status');
    const results = modal.querySelector('#auto-tag-results');
    const preview = modal.querySelector('#auto-tag-preview');
    const apply = modal.querySelector('#auto-tag-apply');
    if (!album) { status.textContent = 'Enter an album name first.'; return; }
    status.textContent = 'Searching MusicBrainz…';
    results.innerHTML = '';
    preview.classList.add('hidden');
    apply.disabled = true;
    modal._autoTagResults = [];
    modal._autoTagRelease = null;
    try {
      const found = await window.beehive.musicBrainzSearchReleases({ album, artist, limit: 12 });
      modal._autoTagResults = Array.isArray(found) ? found : [];
      if (!modal._autoTagResults.length) { status.textContent = 'No matching releases found. Try adjusting the album or artist name.'; return; }
      status.textContent = `${modal._autoTagResults.length} release${modal._autoTagResults.length === 1 ? '' : 's'} found. Choose the release that matches your files.`;
      results.innerHTML = modal._autoTagResults.map(autoTagCandidateHtml).join('');
      results.querySelectorAll('.auto-tag-result').forEach(btn => btn.addEventListener('click', () => selectAutoTagRelease(modal, Number(btn.dataset.resultIndex))));
      const best = modal._autoTagResults[0];
      const bestAlbum = normalizeForSearch(best?.collectionName || '') === normalizeForSearch(album);
      const bestArtist = !artist || normalizeForSearch(best?.artistName || '') === normalizeForSearch(artist);
      if (options.autoSelect && best?.releaseId && bestAlbum && bestArtist && Number(best.score || 0) >= 180) {
        await selectAutoTagRelease(modal, 0);
      }
    } catch (err) {
      status.textContent = err?.message || 'MusicBrainz search failed.';
    }
  }

  function autoTagNeedsMetadata(track) {
    const title = String(track?.title || '').trim();
    const artist = String(track?.artist || '').trim();
    const album = String(track?.album || '').trim();
    const albumArtist = String(track?.albumArtist || '').trim();
    return !title || !artist || !album || !albumArtist;
  }

  function autoTagChangedFields(local, remote, release) {
    if (!local?.path || !remote) return {};
    const desired = {
      album: String(release?.title || '').trim(),
      albumArtist: String(release?.artist || '').trim(),
      artist: String(remote?.artist || release?.artist || '').trim(),
      title: String(remote?.title || '').trim(),
      track: String(remote?.position || '').trim(),
      disk: String(remote?.disc || '').trim(),
      year: String(release?.year || '').trim(),
      publisher: String(release?.label || '').trim()
    };
    const fields = {};
    const comparable = value => normalizeForSearch(value);
    for (const [key, value] of Object.entries(desired)) {
      if (!value) continue;
      const current = String(local?.[key] ?? '').trim();
      if (comparable(current) !== comparable(value)) fields[key] = value;
    }
    return fields;
  }

  function autoTagFilenameStem(track) {
    const raw = String(track?.path || '').split(/[\\/]/).pop() || '';
    return normalizeForSearch(raw.replace(/\.[^.]+$/, '').replace(/^\s*\d{1,3}[\s._-]+/, ''));
  }

  function autoTagTrackNumber(value) {
    const n = Number.parseInt(String(value ?? '').split('/')[0], 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function autoTagMatchScore(local, remote) {
    const localTitle = normalizeForSearch(local?.title || '');
    const remoteTitle = normalizeForSearch(remote?.title || '');
    const fileStem = autoTagFilenameStem(local);
    const remoteStem = normalizeForSearch(remote?.title || '');
    let score = 0;
    if (localTitle && remoteTitle && localTitle === remoteTitle) score += 100;
    else if (fileStem && remoteStem && (fileStem === remoteStem || fileStem.includes(remoteStem) || remoteStem.includes(fileStem))) score += 80;
    const lt = autoTagTrackNumber(local?.track), rt = autoTagTrackNumber(remote?.position);
    const ld = autoTagTrackNumber(local?.disk), rd = autoTagTrackNumber(remote?.disc);
    if (lt && rt && lt === rt) score += 45;
    if (ld && rd && ld === rd) score += 10;
    const la = normalizeForSearch(local?.artist || '');
    const ra = normalizeForSearch(remote?.artist || '');
    if (la && ra && (la === ra || la.includes(ra) || ra.includes(la))) score += 12;
    const durationLocal = Number(local?.duration || 0), durationRemote = Number(remote?.duration || 0);
    if (durationLocal > 0 && durationRemote > 0 && Math.abs(durationLocal - durationRemote) <= 2.5) score += 25;
    return score;
  }

  function buildAutoTagMapping(localTracks, remoteTracks) {
    const locals = (localTracks || []).map((track, index) => ({ track, index, needs: autoTagNeedsMetadata(track) }));
    const remotes = (remoteTracks || []).map((track, index) => ({ track, index }));
    const candidates = [];
    for (const remote of remotes) {
      for (const local of locals) {
        const score = autoTagMatchScore(local.track, remote.track);
        if (score > 0) candidates.push({ localIndex:local.index, remoteIndex:remote.index, score });
      }
    }
    candidates.sort((a,b) => b.score - a.score || a.localIndex - b.localIndex || a.remoteIndex - b.remoteIndex);
    const usedLocal = new Set(), usedRemote = new Set(), mapping = [];
    for (const candidate of candidates) {
      if (usedLocal.has(candidate.localIndex) || usedRemote.has(candidate.remoteIndex)) continue;
      // Do not use a weak positional guess when multiple possible files exist.
      if (candidate.score < 45) continue;
      usedLocal.add(candidate.localIndex); usedRemote.add(candidate.remoteIndex);
      mapping.push({ ...candidate, local:locals[candidate.localIndex].track, remote:remotes[candidate.remoteIndex].track });
    }
    const remainingLocals = locals.filter(x => !usedLocal.has(x.index));
    const remainingRemotes = remotes.filter(x => !usedRemote.has(x.index));
    // If the album has exactly one incomplete local file and exactly one remote
    // track left, elimination is safe and avoids position-based corruption.
    if (remainingLocals.length === 1 && remainingRemotes.length === 1) {
      mapping.push({ localIndex:remainingLocals[0].index, remoteIndex:remainingRemotes[0].index, score:50, local:remainingLocals[0].track, remote:remainingRemotes[0].track, byElimination:true });
    }
    return mapping;
  }

  async function selectAutoTagRelease(modal, index) {
    const item = modal._autoTagResults?.[index];
    if (!item?.releaseId) return;
    const status = modal.querySelector('#auto-tag-status');
    const preview = modal.querySelector('#auto-tag-preview');
    const apply = modal.querySelector('#auto-tag-apply');
    status.textContent = `Loading track list for “${item.collectionName}”…`;
    preview.classList.remove('hidden');
    preview.textContent = 'Loading release details…';
    apply.disabled = true;
    try {
      const release = await window.beehive.musicBrainzGetReleaseDetails(item.releaseId);
      if (!release?.tracks?.length) throw new Error('This MusicBrainz release has no track list.');
      modal._autoTagRelease = release;
      modal.querySelectorAll('.auto-tag-result').forEach((node, i) => node.classList.toggle('selected', i === index));
      const albumTracks = modal._autoTagAlbumTracks || [];
      const mapping = buildAutoTagMapping(albumTracks, release.tracks);
      modal._autoTagMapping = mapping;
      const mappedByRemote = new Map(mapping.map(m => [m.remoteIndex, m]));
      const rows = release.tracks.map((remote, i) => {
        const m = mappedByRemote.get(i);
        const localTitle = String(m?.local?.title || '').trim();
        const needs = !!m?.local && autoTagNeedsMetadata(m.local);
        const state = !m ? 'warning' : needs ? 'match' : 'preserved';
        const label = !m ? 'No safe match' : needs ? (m.byElimination ? '✓ Safe match' : '✓ Match') : 'Preserve';
        const localText = m?.local ? ` · local: ${escapeHtml(localTitle || autoTagFilenameStem(m.local) || 'untitled')}` : '';
        return `<div class="auto-tag-track-row ${state}"><span>${remote.disc}.${remote.position}</span><span>${escapeHtml(remote.title)}</span><small>${escapeHtml(remote.artist || release.artist || '')}${localText}</small><b>${label}</b></div>`;
      }).join('');
      const mapped = mapping.filter(m => m.local?.path && m.remote);
      const changed = mapped.filter(m => Object.keys(autoTagChangedFields(m.local, m.remote, release)).length);
      const coverUrl = String(release.artworkUrl || '').trim();
      preview.innerHTML = `<div class="auto-tag-preview-head"><strong>${escapeHtml(release.artist)} — ${escapeHtml(release.title)}</strong><span>${mapped.length}/${albumTracks.length} tracks mapped · ${changed.length} tag changes · ${coverUrl ? 'shared cover ready' : 'no cover found'}</span></div>${coverUrl ? `<div class="auto-tag-cover-preview"><img src="${escapeHtml(coverUrl)}" alt=""><span>One front cover will be embedded in every mapped track.</span></div>` : ''}${rows}`;
      status.textContent = mapped.length === albumTracks.length
        ? `${mapped.length} tracks mapped from filenames, existing tags, track numbers, and duration. Review the release, then apply tags + one shared cover.`
        : `${mapped.length} of ${albumTracks.length} tracks mapped safely. Unmatched files will not be guessed.`;
      apply.disabled = mapped.length !== albumTracks.length || (!changed.length && !coverUrl);
    } catch (err) {
      preview.textContent = err?.message || 'Could not load release details.';
    }
  }

  function normalizeForSearch(value) {
    return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  async function applyAutoTagRelease(modal) {
    const release = modal._autoTagRelease;
    const albumTracks = modal._autoTagAlbumTracks || [];
    const apply = modal.querySelector('#auto-tag-apply');
    const status = modal.querySelector('#auto-tag-status');
    if (!release || !albumTracks.length) return;
    const mapping = Array.isArray(modal._autoTagMapping) ? modal._autoTagMapping : buildAutoTagMapping(albumTracks, release.tracks);
    const mapped = mapping.filter(m => m.local?.path && m.remote);
    if (mapped.length !== albumTracks.length) {
      await themedAlert(`Hive could only map ${mapped.length} of ${albumTracks.length} tracks safely. Unmatched files were not guessed.`, 'Auto-tag album');
      return;
    }
    const changed = mapped.map(m => ({ ...m, tags: autoTagChangedFields(m.local, m.remote, release) })).filter(m => Object.keys(m.tags).length);
    if (!changed.length) {
      await themedAlert('All mapped metadata already matches this MusicBrainz release.', 'Auto-tag album');
      return;
    }
    const confirmed = await themedDialog({ title:'Apply album tags + cover', message:`Apply the MusicBrainz mapping to all ${mapped.length} tracks in “${release.title}” by ${release.artist}? Only fields that differ will be changed, and the selected front cover will be embedded in every mapped track. Love, rating, lyrics, and other untouched tags will be preserved.`, mode:'confirm' });
    if (!confirmed) return;
    apply.disabled = true;
    status.textContent = 'Preparing the shared album cover…';
    let coverPath = '';
    let coverDataUrl = '';
    try {
      if (release.artworkUrl) {
        const chosen = await window.beehive.downloadSearchCover(release.artworkUrl);
        coverPath = String(chosen?.path || '');
        coverDataUrl = String(chosen?.dataUrl || '');
      }
    } catch (err) {
      console.warn('[Beehive] Auto-tag cover download failed:', err);
      status.textContent = `Tags will be saved, but the shared cover could not be downloaded: ${err?.message || err}`;
    }

    const jobs = mapped.map(({ local, remote }) => {
      const tags = autoTagChangedFields(local, remote, release);
      return {
        kind:'metadata', path:local.path, tags, operation:coverPath ? 'artwork' : 'metadata',
        artwork: coverPath ? { action:'write', slotType:'Cover (Front)', occurrence:1, imagePath:coverPath, pictureType:'Cover (Front)', comment:'' } : null
      };
    }).filter(job => Object.keys(job.tags || {}).length || job.artwork);
    // Queue the entire album as one durable metadata batch. The canonical main-
    // process worker supplies staging, backup, verification, retry, and recovery.
    window.beehive.queueMetadataSave(jobs);

    for (const { local, remote } of mapped) {
      const tags = autoTagChangedFields(local, remote, release);
      Object.assign(local, {
        album: tags.album ?? local.album,
        albumArtist: tags.albumArtist ?? local.albumArtist,
        artist: tags.artist ?? local.artist,
        title: tags.title ?? local.title,
        track: tags.track ? mediaPositionNumber(tags.track) : local.track,
        disk: tags.disk ? mediaPositionNumber(tags.disk) : local.disk,
        year: tags.year || local.year,
        publisher: tags.publisher || local.publisher,
        _searchText:''
      });
      // coverSrc() only resolves bare paths through mbcover://, which is scoped
      // to Hive's own persistent covers cache directory -- not an arbitrary
      // absolute path. Pointing the optimistic preview at the raw OS temp
      // download path (coverPath) resolved to a nonexistent file under the
      // covers directory and rendered as a genuine broken image, not Hive's
      // placeholder. coverSrc() already special-cases data: URLs for exactly
      // this "optimistic preview before the background write lands" case.
      if (coverDataUrl) local.cover = coverDataUrl;
    }
    albums = buildAlbums(library.tracks);
    applyLibrary(library);
    renderCurrentView();
    status.textContent = `Queued ${jobs.length} track${jobs.length === 1 ? '' : 's'} with ${coverPath ? 'shared cover + ' : ''}metadata. Saving in the background…`;
    setTimeout(() => closeModal(modal), 900);
  }

  async function openAutoTagAlbum(album) {
    // Auto-tag is deliberately an album-scoped, single-target operation. The
    // context action passes the one album that was right-clicked; never derive
    // this target from the current multi-selection or a collection view.
    if (!album || Array.isArray(album) || !Array.isArray(album.tracks) || !album.tracks.length) return;
    const modal = ensureAutoTagAlbumModal();
    modal._autoTagAlbumTracks = album.tracks.slice();
    modal._autoTagRelease = null;
    modal.querySelector('#auto-tag-album').value = album.title || '';
    modal.querySelector('#auto-tag-artist').value = album.artist || '';
    modal.querySelector('#auto-tag-results').innerHTML = '';
    modal.querySelector('#auto-tag-preview').classList.add('hidden');
    modal.querySelector('#auto-tag-apply').disabled = true;
    modal.querySelector('#auto-tag-summary').textContent = `${album.tracks.length} local tracks · Hive will match each filename, tag, track number, and duration to individual MusicBrainz recordings.`;
    modal.querySelector('#auto-tag-status').textContent = `${album.tracks.length} local tracks selected. Searching for the best matching release…`;
    openModal(modal);
    setTimeout(() => { runAutoTagSearch(modal, { autoSelect:true }).catch(err => { modal.querySelector('#auto-tag-status').textContent = err?.message || 'MusicBrainz search failed.'; }); }, 0);
  }

  async function showAlbumContextMenu(e, album) {
    if (!album || !album.tracks?.length) return;
    // See showTrackContextMenu: don't block menu display on the Android
    // discovery round-trip (`gio mount -li`, up to 5s). Fire-and-forget.
    if (!androidDevices.length && window.beehive.listDevices) void refreshAndroidDevices();
    // If the right-clicked album is part of an existing multi-selection,
    // operate on every selected album's tracks -- same precedent as
    // beginAlbumDrag, which already treats a selected album this way for
    // drag-and-drop. Right-clicking an album that is NOT part of the current
    // selection still replaces the selection with just that one album (same
    // rule showTrackContextMenu/prepareTrackContextSelection uses for rows).
    const bulk = selectedAlbumKeys.has(String(album.key));
    const albums = bulk ? selectedAlbumModelsInOrder() : [album];
    const countLabel = bulk && albums.length > 1 ? ` (${albums.length} albums)` : '';
    const albumTracks = [];
    {
      const seen = new Set();
      for (const a of albums) for (const track of (a?.tracks || [])) {
        const p = String(track?.path || '');
        if (p && !seen.has(p)) { seen.add(p); albumTracks.push(track); }
      }
    }
    if (!bulk) {
      // Right-clicking a single, not-currently-selected album is an album
      // selection operation: it replaces any previous song selection with
      // exactly this album's files, so Edit Tags / artwork actions cannot
      // accidentally include another album.
      activeSelectionScope = 'songs';
      activeSelectionTracks = albumTracks.slice();
      clearSongSelection();
      for (const track of albumTracks) selectSongPath(track?.path);
      songSelectionAnchor = String(albumTracks[0]?.path || '');
      applySongSelectionClasses();
    } else {
      // Bulk: the selection is already the set of selected albums
      // (activeSelectionScope === 'albums'); just make sure the flattened
      // track list is what other consumers (Edit Tags, etc.) will see.
      activeSelectionTracks = albumTracks.slice();
    }
    const playlistContext = specialView === 'playlist' && !!activePlaylistId;
    const allLoved = albumTracks.every(track => !!track.loved);
    const ratingIs = value => albumTracks.every(track => {
      const r = Number(track.ratingRaw) === 255 ? 5 : Number(track.rating) || 0;
      return r === value;
    });
    const applyLove = value => applyBulkTrackAction(albumTracks, t => setTrackLove(t, value, false));
    const applyRating = value => applyBulkRating(albumTracks.map(t => t.path), value);
    const editLabel = bulk && albums.length > 1 ? `Edit tags… (${albums.length} albums)` : 'Edit album tags & cover…';
    showContextMenu(e.clientX, e.clientY, [
      ...(bulk && albums.length > 1 ? [] : [
        {label:'Auto-tag album…', icon:'tag', action:()=>openAutoTagAlbum(album)},
      ]),
      {label:editLabel, icon:'edit', action:()=>openTagEditor(albumTracks[0], albumTracks)},
      ...(bulk && albums.length > 1 ? [] : [
        {label:`Search album: ${contextAlbumLabel(album.title)}`, icon:'search', action:()=>showAlbumFromTrack(album.tracks[0])},
        {label:`Search artist: ${album.artist || 'Unknown Artist'}`, icon:'search', action:()=>searchForArtist(album.artist, album.tracks?.[0] || null)},
        {label:'Play album', icon:'play', action:()=>playAlbum(album)},
      ]),
      {label:'Rating',icon:'star',submenu:[
        {label:'Love', icon:allLoved ? '♥' : '♡', loved:true, active:allLoved, ratingSymbol:true, help:`Set all tracks${countLabel} to Loved`, action:()=>applyLove(true)},
        {label:'Remove Love', icon:'♡', loved:true, active:false, ratingSymbol:true, help:`Remove Love from all tracks${countLabel}`, action:()=>applyLove(false)},
        {label:'5 stars', icon:'★★★★★', active:ratingIs(5), ratingSymbol:true, help:`Set all tracks${countLabel} to 5 stars`, action:()=>applyRating(5)},
        {label:'4 stars', icon:'★★★★☆', active:ratingIs(4), ratingSymbol:true, help:`Set all tracks${countLabel} to 4 stars`, action:()=>applyRating(4)},
        {label:'3 stars', icon:'★★★☆☆', active:ratingIs(3), ratingSymbol:true, help:`Set all tracks${countLabel} to 3 stars`, action:()=>applyRating(3)},
        {label:'2 stars', icon:'★★☆☆☆', active:ratingIs(2), ratingSymbol:true, help:`Set all tracks${countLabel} to 2 stars`, action:()=>applyRating(2)},
        {label:'1 star', icon:'★☆☆☆☆', active:ratingIs(1), ratingSymbol:true, help:`Set all tracks${countLabel} to 1 star`, action:()=>applyRating(1)},
        {label:'Clear', icon:'×', active:ratingIs(0), ratingSymbol:true, help:`Clear ratings from all tracks${countLabel}`, action:()=>applyRating(0)}
      ]},
      ...(androidDevices.length ? [{label:'Send to', icon:'plus', submenu:androidDevices.map(device => ({label:`${device.name || 'Android device'}${device.mounted ? '' : ' (not mounted)'}`, active:false, action:()=>sendTracksToAndroidDevice(device, albumTracks)}))}] : []),
      {label:`Add to queue${countLabel}`, icon:'queue', action:()=>addTracksToQueue(albumTracks)},
      {label:'Add to', icon:'plus', submenu:buildAddToPlaylistSubmenu(albumTracks)},
      ...(playlistContext ? [{label:`Remove tracks from playlist${countLabel}`, playlistRemove:true, action:()=>removeTracksFromActivePlaylist(albumTracks)}] : []),
      ...(playlistContext ? [{label:`Delete files from disk… (${albumTracks.length} selected)`, icon:'trash', danger:true, action:()=>deleteTracksFromDisk(albumTracks)}] : [])
    ]);
  }

  // click = preview panel, double-click = full-size cover art lightbox.
  // A short delay on the single click lets a fast second click cancel it
  // and open the lightbox instead, so the two don't fire on top of each other.
  // `model` can be the object itself, or a function that lazily builds it
  // (used for artist cards, where the track list is only worth computing on demand).
  function setAlbumHighlight(card, model = null) {
    if (!card?.dataset?.key) return;
    const key = String(card.dataset.key);
    highlightedAlbumKey = key;
    const tab = getActiveTab();
    const grid = tab?.dom?.albumsGrid || el.albumsGrid;
    // Only one album in the active Music browser can carry the highlight.
    grid?.querySelectorAll('.album-card.album-highlighted').forEach(node => {
      if (node !== card) node.classList.remove('album-highlighted');
    });
    card.classList.add('album-highlighted');

    // The album-selection ring and the playbar scrubber intentionally share the
    // same dynamic accent. Selecting an album therefore immediately changes the
    // highlight color to that album's artwork palette, even when playback is
    // still on a different album.
    const album = typeof model === 'function' ? model() : model;
    const paletteCover = album?.cover || distinctCovers(album)[0]?.file;
    if (paletteCover) applyPaletteFromCover(coverSrc(paletteCover));

    saveActiveTabState();
  }

  function attachCoverInteractions(card, model) {
    const resolve = () => (typeof model === 'function' ? model() : model);
    let clickTimer = null;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.inline-album-dropdown') || e.target.closest('.inline-track-row')) return;
      const album = resolve();
      const key = String(card.dataset.key || '');
      if (viewMode !== 'albums') {
        setAlbumHighlight(card, album);
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => toggleInlineAlbum(card, album), 180);
        return;
      }
      if (e.shiftKey && selectedAlbumKeys.size && albumSelectionAnchor) {
        clearTimeout(clickTimer);
        activeSelectionScope = 'albums';
        selectAlbumRangeTo(card);
        setAlbumHighlight(card, album);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        clearTimeout(clickTimer);
        activeSelectionScope = 'albums';
        if (selectedAlbumKeys.has(key)) deselectAlbumKey(key);
        else selectAlbumKey(key);
        albumSelectionAnchor = key;
        setAlbumHighlight(card, album);
        applyAlbumSelectionClasses();
        return;
      }
      activeSelectionScope = 'albums';
      clearAlbumSelection();
      selectAlbumKey(key);
      albumSelectionAnchor = key;
      setAlbumHighlight(card, album);
      applyAlbumSelectionClasses();
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => toggleInlineAlbum(card, album), 180);
    });
    card.addEventListener('dblclick', (e) => {
      e.preventDefault(); clearTimeout(clickTimer);
      const m = resolve();
      setAlbumHighlight(card, m);
      // Double-clicking the original album card always means "play album".
      // If its inline viewer is already open, leave that viewer open.
      if (m?.tracks?.length) playAlbum(m);
    });
    card.draggable = viewMode === 'albums';
    card.addEventListener('dragstart', e => beginAlbumDrag(e, resolve()));
    card.addEventListener('dragend', () => { if (songDragState?.preview?.isConnected) songDragState.preview.remove(); songDragState = null; clearQueueDropTarget(); });
    const badge=card.querySelector('.play-badge');
    badge?.addEventListener('click',e=>{e.stopPropagation();clearTimeout(clickTimer);const m=resolve();if(m?.tracks?.length)playAlbum(m);});
  }

  // ---------------- cover art session cache ----------------
  // Keep the session cache deliberately demand-driven. Native lazy-loading is
  // important for large libraries: creating a second Image for every album
  // would eagerly fetch/decode thousands of covers and can stall scrolling.
  // Once a real DOM image has loaded, remember only its source/status. Never retain
  // DOM Image objects here: decoded image surfaces are large native allocations,
  // and retaining them caused the Build 14 startup log to climb past 600 MB after
  // only ~80-120 covers. Chromium's own image/network cache remains authoritative.
  const coverMemoryCache = new Map(); // source URL -> { status, loadedAt }

  function isCacheableCoverSource(src) {
    return !!src && !/^https?:\/\//i.test(src) && !/^data:image\/svg\+xml/i.test(src);
  }

  function rememberLoadedCover(img) {
    const src = String(img?.currentSrc || img?.src || '');
    if (!isCacheableCoverSource(src)) return;
    const existing = coverMemoryCache.get(src);
    if (existing?.status === 'loaded') return;
    coverMemoryCache.set(src, { status: 'loaded', loadedAt: performance.now() });
    if (performanceDebugEnabled) {
      startupMark('COVER CACHE LOAD', { source: src, cacheSize: coverMemoryCache.size });
    }
  }

  function primeCoverCache(src) {
    // Compatibility shim for older callers. Do not create a detached Image:
    // that defeats native lazy-loading and was the source of the large-library
    // startup/scroll pressure measured by --scroll-debug.
    return coverMemoryCache.get(src) || null;
  }

  function lazyCoverImg(src) {
    // Native lazy-loading remains authoritative. The cache is populated only
    // after an actual DOM image loads; this prevents thousands of off-screen
    // covers from being fetched/decoded merely because they exist in the grid.
    return `<img src="${src}" alt="" loading="lazy"/>`;
  }

  function observeLazyImages(root) {
    if (!root) return;
    const images = root.querySelectorAll?.('img[loading="lazy"]');
    if (!images) return;
    for (const img of images) {
      if (img.dataset.hiveCoverCacheObserved === '1') continue;
      img.dataset.hiveCoverCacheObserved = '1';
      if (img.complete && img.naturalWidth > 0) rememberLoadedCover(img);
      img.addEventListener('load', () => rememberLoadedCover(img), { once: true });
    }
  }


  // ---------------- rendering: inline album/artist browsers ----------------
  // Album navigation stays in the main grid. Clicking an album opens a compact
  // dropdown anchored to that card; clicking a track starts playback. This
  // avoids the large modal/popup and keeps the browsing context visible.
  function inlineTrackFeaturedArtists(track, albumArtist) {
    const trackArtist = String(track?.artist || '').trim();
    const primaryAlbumArtist = String(albumArtist || '').trim();
    if (!trackArtist || !primaryAlbumArtist) return trackArtist && primaryAlbumArtist ? trackArtist : '';

    const normalize = value => value.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalize(trackArtist) === normalize(primaryAlbumArtist)) return '';

    // Keep the album artist in the album header. Only show a track-artist tag
    // when the track has artist information beyond the album artist. When the
    // track artist is exactly the album artist, the row stays clean. When it
    // differs (for example “ISOxo, Ninajirachi”), show the complete track-artist
    // value so every artist credited on that song remains visible.
    const albumKey = normalize(primaryAlbumArtist);
    if (normalize(trackArtist) === albumKey) return '';
    return trackArtist;
  }

  function makeInlineTrackDropdown(album, host) {
    const panel = document.createElement('div');
    panel.className = 'inline-album-dropdown';
    const tracks = (album.tracks || []).slice().sort(albumTrackCompare);
    // The expanded album track list is its own selection scope.
    activeSelectionTracks = tracks;
    const totalRuntime = tracks.reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
    panel.innerHTML = `
      <div class="inline-album-content">
        <div class="inline-album-cover"><img src="${coverSrc(album.cover)}" alt=""></div>
        <div class="inline-album-main">
          <div class="inline-album-head"><strong>${escapeHtml(album.title || 'Unknown Album')}</strong><span>${escapeHtml(album.artist || '')}${album.year ? ` · ${escapeHtml(album.year)}` : ''} · ${tracks.length} track${tracks.length===1?'':'s'} · ${fmtTime(totalRuntime)} total</span></div>
          <div class="inline-track-list"></div>
        </div>
      </div>`;
    const expandedCover = panel.querySelector('.inline-album-cover');
    expandedCover?.addEventListener('dblclick', e => {
      e.preventDefault();
      e.stopPropagation();
      if (album?.cover || album?.covers?.length) openCoverLightbox(album);
    });
    // The expanded album cover is the same artwork surface as the album/player
    // artwork: expose the exact same cover context menu used by Now Playing.
    expandedCover?.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const first = distinctCovers(album)[0]?.file || album?.cover;
      if (first) showCoverContextMenu(e, first, album);
    });
    const list = panel.querySelector('.inline-track-list');
    tracks.forEach((t,i) => {
      const row = document.createElement('button');
      row.className = 'inline-track-row';
      row.dataset.path = String(t.path || '');
      // The playing marker represents the queue's current/Now Playing slot,
      // not whether audio is actively running. This is important on startup:
      // the restored track is intentionally paused, but it is still the song
      // occupying Now Playing and must show its marker when an album is opened.
      const isCurrentQueueTrack = !!currentQueue[currentIndex]?.path && String(currentQueue[currentIndex].path) === String(t.path || '');
      row.classList.toggle('playing', isCurrentQueueTrack);
      const featuredArtists = inlineTrackFeaturedArtists(t, album.artist);
      row.innerHTML = `<span class="inline-track-num">${escapeHtml(t.track || i+1)}</span><span class="inline-track-playing" aria-hidden="true"></span><span class="inline-track-title">${escapeHtml(t.title || 'Untitled')}${featuredArtists ? `<span class="inline-track-featured" aria-label="${escapeHtml(featuredArtists)}"><span class="inline-track-featured-paren">(</span><span class="inline-track-featured-name">${escapeHtml(featuredArtists)}</span><span class="inline-track-featured-paren">)</span></span>` : ''}</span><span class="inline-track-dur">${fmtTime(t.duration)}</span>`;
      row.draggable = true;
      row.classList.toggle('selected', selectedSongPaths.has(String(t.path || '')));
      row.addEventListener('click', e => {
        e.stopPropagation();
        activeSelectionScope = 'songs';
        activeSelectionTracks = tracks;
        const path = String(t.path || '');
        if (e.shiftKey && songSelectionAnchor != null) {
          const anchorIndex = tracks.findIndex(x => String(x?.path || '') === songSelectionAnchor);
          const from = anchorIndex >= 0 ? Math.min(anchorIndex, i) : i;
          const to = anchorIndex >= 0 ? Math.max(anchorIndex, i) : i;
          for (let n = from; n <= to; n++) {
            const p = String(tracks[n]?.path || '');
            if (p) selectSongPath(p);
          }
        } else if (e.ctrlKey || e.metaKey) {
          if (path) {
            if (selectedSongPaths.has(path)) deselectSongPath(path);
            else selectSongPath(path);
            songSelectionAnchor = path;
          }
        } else {
          clearSongSelection();
          if (path) selectSongPath(path);
          songSelectionAnchor = path || null;
        }
        if (path) songSelectionAnchor = path;
        list.querySelectorAll('.inline-track-row').forEach(r => r.classList.toggle('selected', selectedSongPaths.has(r.dataset.path || '')));
      });
      row.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); playQueue(tracks, i); });
      row.addEventListener('dragstart', e => beginSongDrag(e, t));
      row.addEventListener('dragend', () => { if (songDragState?.preview?.isConnected) songDragState.preview.remove(); songDragState = null; clearQueueDropTarget(); });
      row.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); prepareTrackContextSelection(t, tracks); showTrackContextMenu(e.clientX,e.clientY,t); });
      list.appendChild(row);
    });
    return panel;
  }

  function refreshInlineTrackPlayingState() {
    const playingPath = String(currentQueue[currentIndex]?.path || '');
    document.querySelectorAll('.inline-track-row').forEach(row => {
      const active = !!playingPath && String(row.dataset.path || '') === playingPath;
      row.classList.toggle('playing', active);
      const marker = row.querySelector('.inline-track-playing');
      if (marker) marker.setAttribute('aria-hidden', 'true');
    });
  }

  function closeAllInlineAlbums(exceptCard = null) {
    // Album expansion belongs to the individual Music tab. A tab may have at
    // most one expanded album, but different tabs are intentionally allowed to
    // keep their own album expanded while hidden. Never touch another tab's
    // DOM/state here.
    const tab = getActiveTab?.();
    const grid = tab?.dom?.albumsGrid || el.albumsGrid;
    if (!grid) return;

    // Expansion panels are inserted after the LAST card in the clicked card's
    // row, not directly after the expanded card. Therefore previousElementSibling
    // cannot be used to decide which panel belongs to exceptCard. Always remove
    // every existing panel first; the caller will create the one current panel.
    // This is especially important when clicking the rightmost card after the
    // second-to-last card: the old panel may sit immediately after the rightmost
    // card and would otherwise be incorrectly preserved.
    grid.querySelectorAll('.inline-album-dropdown').forEach(node => node.remove());
    grid.querySelectorAll('.album-card.inline-expanded').forEach(node => {
      if (node !== exceptCard) node.classList.remove('inline-expanded');
    });

    if (tab?.state) {
      const stillOpen = grid.querySelector('.album-card.inline-expanded')?.dataset.key || null;
      tab.state.openAlbumKey = stillOpen ? String(stillOpen) : null;
    }
  }

  function toggleInlineAlbum(card, album) {
    const container = card.parentElement;
    if (album?.cover) applyPaletteFromCover(coverSrc(album.cover));

    if (!container) return;

    const key = String(card.dataset.key || '');

    // Check the whole active Albums browser (including every year section) for
    // the clicked album. A single expanded album is the only allowed state.
    const browser = getActiveTab()?.dom?.albumsGrid || el.albumsGrid;
    const existing = browser
      ? Array.from(browser.querySelectorAll('.inline-album-dropdown')).find(node => String(node.dataset.albumKey || '') === key)
      : null;
    if (existing) {
      closeAllInlineAlbums();
      if (openAlbumKey === key) openAlbumKey = null;
      updateActiveTabLabel();
      saveActiveTabState();
      return;
    }

    // Close every other expansion first. This deliberately spans year sections
    // and hidden Music-tab DOMs so two albums can never remain expanded together.
    closeAllInlineAlbums(card);

    // Keep every album card in its original row. The expansion is inserted AFTER
    // the row containing the clicked album, rather than immediately after the card.
    // That prevents the remaining covers from being pushed around when an album
    // opens, while still giving the expanded panel a full-width row of its own.

    const panel = makeInlineTrackDropdown(album, card);
    panel.dataset.albumKey = key;

    const cards = Array.from(container.children).filter(node => node.classList?.contains('album-card'));
    const clickedTop = card.offsetTop;
    const rowCards = cards.filter(node => Math.abs(node.offsetTop - clickedTop) <= 2);
    const lastCardInRow = rowCards[rowCards.length - 1] || card;
    lastCardInRow.after(panel);
    card.classList.add('inline-expanded');
    // The panel must be connected before the shared rotator paints it. This
    // preserves the existing artwork index/timer instead of starting a second
    // rotation clock for the expanded view.
    const current = currentQueue[currentIndex];
    if (current && albumKey(current) === key) {
      const expandedImg = panel.querySelector('.inline-album-cover img');
      if (expandedImg) nowPlayingRotator.retarget([expandedImg]);
    }
    openAlbumKey = key;
    updateActiveTabLabel(album?.title || '');
    saveActiveTabState();
  }

  function makeAlbumCard(a, playingKey) {
    const card = document.createElement('div');
    card.className = 'album-card' + (a.key === playingKey ? ' now-playing' : '') + (String(a.key) === String(highlightedAlbumKey) ? ' album-highlighted' : '') + (selectedAlbumKeys.has(String(a.key)) ? ' album-selected' : '');
    card.dataset.key = a.key;
    card.dataset.tooltip = 'Click to show tracks';
    card.innerHTML = `<div class="art-wrap">${lazyCoverImg(coverSrc(a.cover))}</div><div class="title">${escapeHtml(a.title)}</div><div class="artist">${escapeHtml(a.artist)}</div>`;
    attachCoverInteractions(card, a);
    card.addEventListener('contextmenu', e => { e.preventDefault(); showAlbumContextMenu(e, a); });
    return card;
  }

  function albumReleaseYear(album) {
    const raw = album?.year ?? album?.releaseDate ?? '';
    const match = String(raw).match(/\d{4}/);
    return match ? Number(match[0]) : 0;
  }

  // Album rendering is intentionally progressive. A large library can contain
  // thousands of albums, and constructing every card plus its event handlers in
  // one renderer task can freeze Chromium for several seconds. Keep the full
  // album model in memory, but hand DOM construction back to the browser every
  // small batch so input, resize, playback controls, and painting remain alive.
  let albumRenderGeneration = 0;
  async function renderAlbums() {
    const generation = ++albumRenderGeneration;
    el.albumsGrid.classList.add('album-browse-grid');

    // Re-rendering the album grid can happen for reasons unrelated to tabs
    // (library hydration, rating refresh, Love refresh, view changes, etc.).
    // Preserve the album that is physically open in THIS browser before
    // replacing the grid, otherwise the inline panel disappears and the next
    // tab switch would save a null openAlbumKey.
    const preservedOpenAlbumKey = el.albumsGrid.querySelector('.album-card.inline-expanded')?.dataset.key || null;
    const sourceTracks = tracksForCurrentContext();
    const filtered = artistSearchTerm
      ? buildAlbums(sourceTracks.filter(trackMatchesArtistSearch))
      : searchTerm
        ? buildAlbums(sourceTracks.filter(trackMatchesSearch))
        : (specialView === 'playlist' ? buildAlbums(sourceTracks) : albums);

    const playingKey = currentQueue[currentIndex] ? albumKey(currentQueue[currentIndex]) : null;
    if (!highlightedAlbumKey && playingKey) highlightedAlbumKey = String(playingKey);
    el.albumsGrid.innerHTML = '';

    const isArtistSearch = !!artistSearchTerm;

    const groupByYear = albumYearDividers;
    // Year mode uses a block-flow section stack so each release-year divider
    // owns the full Music viewport width. The nested year grids still retain
    // the established card sizing/layout rules.
    el.albumsGrid.classList.toggle('album-years-grouped', groupByYear);

    const sections = [];
    if (groupByYear) {
      const years = new Map();
      for (const album of filtered) {
        const year = albumReleaseYear(album);
        if (!years.has(year)) years.set(year, []);
        years.get(year).push(album);
      }
      const orderedYears = Array.from(years.keys()).sort((a,b) => {
        if (a === 0) return 1;
        if (b === 0) return -1;
        return b - a;
      });

      for (const year of orderedYears) {
        const section = document.createElement('section');
        section.className = 'album-year-section';
        const heading = document.createElement('div');
        heading.className = 'album-year-heading';
        heading.innerHTML = `<span>${year || 'Unknown release year'}</span><div class="album-year-rule"></div>`;
        section.appendChild(heading);
        const grid = document.createElement('div');
        grid.className = 'album-year-grid';
        section.appendChild(grid);
        el.albumsGrid.appendChild(section);

        const yearAlbums = years.get(year).slice().sort((a,b) => {
          const ay = albumReleaseYear(a), by = albumReleaseYear(b);
          if (ay !== by) return by - ay;
          return songCollator.compare(a.title || '', b.title || '') || songCollator.compare(a.artist || '', b.artist || '');
        });
        sections.push({ grid, albums: yearAlbums });
      }
    } else {
      const ordered = filtered.slice().sort((a,b) => {
        const ay = albumReleaseYear(a), by = albumReleaseYear(b);
        if (ay !== by) {
          if (ay === 0) return 1;
          if (by === 0) return -1;
          return by - ay;
        }
        return songCollator.compare(a.title || '', b.title || '') || songCollator.compare(a.artist || '', b.artist || '');
      });
      const grid = el.albumsGrid;
      sections.push({ grid, albums: ordered });
    }

    // Do not let album-card construction become the first large renderer task.
    // Give Chromium a frame after the lightweight grouping/sorting work above,
    // then construct a small screenful at a time. Album cards bind several
    // handlers and can trigger style/layout work, so 12 is intentionally small.
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (generation !== albumRenderGeneration) return;
    const CHUNK_SIZE = 12;
    let firstChunk = true;
    for (const section of sections) {
      for (let i = 0; i < section.albums.length; i += CHUNK_SIZE) {
        if (generation !== albumRenderGeneration) return;
        const chunk = section.albums.slice(i, i + CHUNK_SIZE);
        const fragment = document.createDocumentFragment();
        for (const album of chunk) fragment.appendChild(makeAlbumCard(album, playingKey));
        section.grid.appendChild(fragment);

        // Native lazy images do the actual artwork loading. The key thing here
        // is yielding between DOM/event-handler construction batches.
        if (firstChunk) {
          firstChunk = false;
          observeLazyImages(el.albumsGrid);
          applyAlbumSelectionClasses(el.albumsGrid);
          // Let Chromium paint the initial cards and process input before the
          // remaining thousands of album cards are constructed.
          await new Promise(resolve => requestAnimationFrame(resolve));
        } else {
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
      }
    }

    if (generation !== albumRenderGeneration) return;
    observeLazyImages(el.albumsGrid);
    applyAlbumSelectionClasses(el.albumsGrid);

    // Restore the exact inline album panel after the grid is rebuilt.
    if (preservedOpenAlbumKey) {
      const preservedAlbum = filtered.find(a => String(a?.key || '') === String(preservedOpenAlbumKey));
      const preservedCard = el.albumsGrid.querySelector(`.album-card[data-key="${CSS.escape(String(preservedOpenAlbumKey))}"]`);
      if (preservedAlbum && preservedCard && generation === albumRenderGeneration) {
        toggleInlineAlbum(preservedCard, preservedAlbum);
      }
    }

    refreshCoverRotationTargets();
    // Do not eagerly warm the entire library. Covers enter the session cache
    // only when native lazy-loading actually brings them into view.
  }

  // When the right Now Playing panel is resized, the album grid can reflow into
  // different rows. Re-anchor the in-flow expansion after the clicked card's
  // current row so it never becomes stranded halfway through the new layout.
  let inlineAlbumReflowRaf = 0;
  function reflowOpenInlineAlbum() {
    if (inlineAlbumReflowRaf) return;
    inlineAlbumReflowRaf = requestAnimationFrame(() => {
      inlineAlbumReflowRaf = 0;
      const browser = getActiveTab?.()?.dom?.albumsGrid || el.albumsGrid;
      const panel = browser?.querySelector('.inline-album-dropdown');
      const card = browser?.querySelector('.album-card.inline-expanded');
      if (!panel || !card || !card.parentElement) return;
      const parent = card.parentElement;
      const cards = Array.from(parent.children).filter(node => node.classList?.contains('album-card'));
      if (!cards.includes(card)) return;
      const clickedTop = card.offsetTop;
      const rowCards = cards.filter(node => Math.abs(node.offsetTop - clickedTop) <= 2);
      const lastCardInRow = rowCards[rowCards.length - 1] || card;
      if (panel.previousElementSibling !== lastCardInRow) lastCardInRow.after(panel);
    });
  }
  if (typeof ResizeObserver !== 'undefined') {
    const albumGridResizeObserver = new ResizeObserver(() => reflowOpenInlineAlbum());
    albumGridResizeObserver.observe(el.albumsGrid);
  }
  window.addEventListener('resize', reflowOpenInlineAlbum, { passive: true });

  function renderSongsTable() {
    const sourceTracks = tracksForCurrentContext();
    // Artist search is shared by the Albums and Tracks views. When the user
    // right-clicks a track/album, chooses "Search artist", and then switches
    // to Tracks, keep the same exact artist filter instead of falling back to
    // the entire library. trackMatchesSearch() already gives artist searches
    // their metadata-only matching rules.
    const filtered = (searchTerm || artistSearchTerm)
      ? sourceTracks.filter(trackMatchesSearch)
      : sourceTracks;

    // Normal playlists store tracks in insertion order (oldest -> newest).
    // The Tracks view presents that playlist context newest-first by default,
    // so #1 is the most recently added track. Sorting by # toggles that same
    // playlist order without changing playback/queue order elsewhere.
    const ordered = (specialView === 'playlist' && activePlaylistId)
      ? filtered.slice().reverse()
      : filtered;
    let sorted;
    if (specialView === 'playlist' && activePlaylistId) {
      const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
      const manualSort = manualSongSortActive();
      sorted = (playlistVisualShuffleEnabled(pl) && !manualSort)
        ? visualShuffleTracks(visualShuffleKeyForPlaylist(pl), ordered, true)
        : sortTracks(ordered);
    } else {
      const nav = currentSidebarContextNav();
      const manualSort = manualSongSortActive();
      sorted = (nav && sidebarVisualShuffleEnabled(nav) && !manualSort)
        ? visualShuffleTracks(visualShuffleKeyForSidebar(nav), ordered, true)
        : sortTracks(ordered);
    }
    songVirtualState.tracks = sorted;
    songVirtualState.lastStart = -1;
    songVirtualState.lastEnd = -1;
    el.songsTable.innerHTML = songHeader() + '<div class="song-virtual-spacer"></div><div class="song-virtual-window"></div>';
    el.songsTable.style.position = 'relative';
    bindSongHeader();
    bindSongContextMenu(el.songsTable);
    updateVirtualSongRows(true);
  }

  function songRowHtml(t, i) {
    const cells = songColumns.keys.map(key => {
      if (key === 'position') return `<span class="s-position dim">${i + 1}</span>`;
      const value = songColumnDef(key)?.get?.(t) ?? '';
      if (key === 'title') return `<span class="s-title song-title-cell"><img class="song-thumb" src="${coverSrc(visualCoverForTrack(t))}" alt="" loading="lazy" /> <span>${escapeHtml(value)}</span></span>`;
      if (key === 'rating') return `<span class="s-rating">${ratingStars(t)}</span>`;
      return `<span class="s-${escapeHtml(key)} dim">${escapeHtml(value)}</span>`;
    }).join('');
    return `<div class="song-row" draggable="true" data-idx="${i}" data-path="${escapeHtml(t.path || '')}">${cells}</div>`;
  }

  function updateVirtualSongRows(force = false) {
    if (!el.songsTable || el.songsTable.classList.contains('hidden')) return;
    const tracks = songVirtualState.tracks || [];
    const spacer = el.songsTable.querySelector('.song-virtual-spacer');
    const win = el.songsTable.querySelector('.song-virtual-window');
    if (!spacer || !win) return;
    const rowHeight = songVirtualState.rowHeight;
    const header = el.songsTable.querySelector('.song-header');
    const headerHeight = header ? header.offsetHeight : songVirtualState.headerHeight;
    songVirtualState.headerHeight = headerHeight;
    const tableTop = el.songsTable.offsetTop;
    const scrollTop = Math.max(0, getActiveViewport().scrollTop - tableTop - headerHeight);
    const viewport = getActiveViewport().clientHeight || 700;
    const overscan = 12;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const end = Math.min(tracks.length, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
    if (!force && start === songVirtualState.lastStart && end === songVirtualState.lastEnd) return;
    songVirtualState.lastStart = start;
    songVirtualState.lastEnd = end;
    spacer.style.height = `${Math.max(0, tracks.length * rowHeight)}px`;
    win.style.transform = `translateY(${headerHeight + start * rowHeight}px)`;
    win.innerHTML = tracks.slice(start, end).map((t, local) => songRowHtml(t, start + local)).join('');
    // Interaction is delegated from the persistent table; no per-row listener
    // installation is necessary after each virtual window repaint.
    win.querySelectorAll('.song-row').forEach(row => {
      const i = Number(row.dataset.idx);
      row.classList.toggle('selected', selectedSongPaths.has(row.dataset.path || ''));
    });
  }

  function buildArtistPickerEntries(sourceTracks = library.tracks) {
    const map = new Map();
    for (const t of sourceTracks) {
      const key = String(t.albumArtist || t.artist || '').trim();
      if (!key) continue;
      const visual = visualCoverForTrack(t);
      if (!map.has(key)) map.set(key, { name: key, cover: visual, artworkUrl: spotifyArtworkUrl(t), covers: t.covers, tracks: [] });
      const entry = map.get(key);
      entry.tracks.push(t);
      if (!entry.cover && visual) { entry.cover = visual; entry.artworkUrl = spotifyArtworkUrl(t); entry.covers = t.covers; }
    }
    return Array.from(map.values()).sort((a,b) => songCollator.compare(a.name,b.name));
  }

  // Build the Artists-page version of the Years view. An artist is intentionally
  // allowed to appear in more than one year section: each section represents
  // the releases from that year, so an artist with releases in 2018, 2020 and
  // 2024 appears under all three years. The card's track collection is scoped
  // to that year, rather than silently assigning the artist to one year.
  function buildArtistYearGroups(entries) {
    const years = new Map();
    for (const artist of (entries || [])) {
      const byYear = new Map();
      for (const t of (artist.tracks || [])) {
        const raw = t?.year ?? t?.releaseDate ?? '';
        const match = String(raw).match(/\d{4}/);
        const year = match ? Number(match[0]) : 0;
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year).push(t);
      }
      for (const [year, tracks] of byYear) {
        if (!years.has(year)) years.set(year, new Map());
        const yearArtists = years.get(year);
        const existing = yearArtists.get(artist.name);
        if (existing) {
          existing.tracks.push(...tracks);
        } else {
          yearArtists.set(artist.name, {
            name: artist.name,
            cover: artist.cover,
            covers: artist.covers,
            tracks: tracks.slice()
          });
        }
      }
    }
    return Array.from(years.entries()).sort((a,b) => {
      if (a[0] === 0) return 1;
      if (b[0] === 0) return -1;
      return b[0] - a[0];
    });
  }

  function makeArtistCard(a) {
    const card = document.createElement('div');
    card.className = 'album-card artist-card';
    card.title = `Open ${a.name}`;
    card.innerHTML = `<div class="art-wrap">${lazyCoverImg(coverSrc(a.cover))}</div><div class="title">${escapeHtml(a.name)}</div><div class="artist">${a.tracks.length} track${a.tracks.length===1?'':'s'}</div>`;
    card.dataset.artist = a.name;
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        {label:`Search artist: ${a.name}`, action:()=>searchForArtist(a.name)},
        {label:'Play artist', action:()=>playQueue(a.tracks,0)}
      ]);
    });
    card.addEventListener('click', e => {
      if (e.button !== undefined && e.button !== 0) return;
      searchForArtist(a.name);
    });
    card.addEventListener('dblclick', e => {
      e.preventDefault(); e.stopPropagation();
      if (a.tracks.length) playQueue(a.tracks, 0);
    });
    return card;
  }

  // Legacy album-art scaling is the established natural/default Hive layout.
  // The toggle is intentionally inverted from the previous release's mistaken
  // semantics: checked = fixed 178px legacy layout, unchecked = responsive grid.
  let legacyArtScaling = false;
  const LEGACY_ART_SCALING_KEY = 'beehive:legacy-art-scaling';
  const LEGACY_ART_SCALING_MIGRATION_KEY = 'beehive:legacy-art-scaling-semantics-v2';
  function loadLegacyArtScaling() {
    try {
      const migrated = localStorage.getItem(LEGACY_ART_SCALING_MIGRATION_KEY) === 'true';
      const stored = localStorage.getItem(LEGACY_ART_SCALING_KEY);
      if (!migrated) {
        // Build 54 stored the opposite meaning. Invert once so an existing
        // user's visible mode remains stable while the setting semantics are
        // corrected for all future writes.
        const migratedValue = stored == null ? false : stored !== 'true';
        localStorage.setItem(LEGACY_ART_SCALING_KEY, String(migratedValue));
        localStorage.setItem(LEGACY_ART_SCALING_MIGRATION_KEY, 'true');
        return migratedValue;
      }
      return stored == null ? true : stored === 'true';
    } catch { return false; }
  }
  function applyLegacyArtScaling(enabled, rerender = true) {
    legacyArtScaling = !!enabled;
    document.body.classList.toggle('legacy-art-scaling', legacyArtScaling);
    if (el.legacyArtScalingToggle) el.legacyArtScalingToggle.checked = legacyArtScaling;
    try { localStorage.setItem(LEGACY_ART_SCALING_KEY, String(legacyArtScaling)); } catch {}
    if (rerender && typeof renderCurrentView === 'function') renderCurrentView();
  }

  function renderArtists(sourceTracks = library.tracks) {
    const isPicker = sourceTracks === library.tracks && !artistSearchTerm && !legacyArtScaling;
    if (isPicker && !artistPickerEntriesReady) {
      artistPickerEntries = buildArtistPickerEntries(library.tracks);
      artistPickerEntriesReady = true;
    }
    const list = isPicker ? artistPickerEntries : buildArtistPickerEntries(sourceTracks);
    const filtered = searchTerm
      ? list.filter(a => a.name.toLowerCase().includes(searchTerm))
      : list;

    el.artistsGrid.classList.add('artist-browse-grid');
    // The Artists tab is a flat artist picker. Release-year sections belong to
    // the Albums viewer; applying them here made the artist grid visually split
    // and caused the virtual artist browser to fight the year layout.
    const groupByYear = false;
    el.artistsGrid.classList.remove('artist-years-grouped');

    if (groupByYear) {
      // Years on Artists means: show every artist in every release year in
      // which that artist has music. This is deliberately a grouped,
      // non-virtual layout so each year section can flow independently.
      el.artistsGrid.innerHTML = '';
      const yearGroups = buildArtistYearGroups(filtered);
      for (const [year, yearArtists] of yearGroups) {
        const section = document.createElement('div');
        section.className = 'album-year-section artist-year-section';
        const heading = document.createElement('div');
        heading.className = 'album-year-heading';
        heading.innerHTML = `<span>${year || 'Unknown release year'}</span><div class="album-year-rule"></div>`;
        section.appendChild(heading);
        const grid = document.createElement('div');
        grid.className = 'album-year-grid artist-year-grid';
        const artists = Array.from(yearArtists.values()).sort((a,b) => songCollator.compare(a.name,b.name));
        for (const artist of artists) grid.appendChild(makeArtistCard(artist));
        section.appendChild(grid);
        el.artistsGrid.appendChild(section);
      }
      observeLazyImages(el.artistsGrid);
      refreshCoverRotationTargets();
      return;
    }

    el.artistsGrid.classList.remove('artist-years-grouped');
    if (!isPicker) {
      el.artistsGrid.innerHTML = '';
      for (const a of filtered) el.artistsGrid.appendChild(makeArtistCard(a));
      observeLazyImages(el.artistsGrid);
      refreshCoverRotationTargets();
      return;
    }

    artistPickerFiltered = filtered;
    el.artistsGrid.innerHTML = '<div class="artist-virtual-spacer" aria-hidden="true"></div><div class="artist-virtual-window"></div>';
    const spacer = el.artistsGrid.querySelector('.artist-virtual-spacer');
    const win = el.artistsGrid.querySelector('.artist-virtual-window');
    artistVirtualState.spacer = spacer;
    artistVirtualState.window = win;
    artistVirtualState.lastStart = -1;
    artistVirtualState.lastEnd = -1;

    const update = (force = false) => {
      const width = Math.max(178, el.artistsGrid.clientWidth || 700);
      const columns = Math.max(1, Math.floor((width + artistVirtualState.gap) / (artistVirtualState.cardWidth + artistVirtualState.gap)));
      const rows = Math.ceil(artistPickerFiltered.length / columns);
      const rowHeight = artistVirtualState.rowHeight;
      const scrollTop = Math.max(0, getActiveViewport().scrollTop - el.artistsGrid.offsetTop);
      const viewportHeight = getActiveViewport().clientHeight || 700;
      const overscanRows = 2;
      const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
      const endRow = Math.min(rows, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscanRows);
      const start = startRow * columns;
      const end = Math.min(artistPickerFiltered.length, endRow * columns);
      const signature = `${columns}:${start}:${end}`;
      if (!force && signature === artistVirtualState.signature) return;
      artistVirtualState.signature = signature;
      spacer.style.height = `${rows * rowHeight}px`;
      win.innerHTML = '';
      win.style.height = `${Math.max(0, (endRow-startRow) * rowHeight)}px`;
      win.style.transform = `translateY(${startRow * rowHeight}px)`;
      for (let i=start;i<end;i++) {
        const card = makeArtistCard(artistPickerFiltered[i]);
        card.style.position = 'absolute';
        card.style.left = `${(i % columns) * (artistVirtualState.cardWidth + artistVirtualState.gap)}px`;
        card.style.top = `${(Math.floor(i / columns) - startRow) * rowHeight}px`;
        win.appendChild(card);
      }
      observeLazyImages(win);
      refreshCoverRotationTargets();
    };
    artistVirtualState.viewport = el.main;
    artistVirtualState.update = update;
    if (!artistVirtualState.resizeObserver) {
      artistVirtualState.resizeObserver = new ResizeObserver(() => {
        if (viewMode !== 'artists' || artistSearchTerm || !artistVirtualState.update) return;
        if (!artistVirtualState.raf) {
          artistVirtualState.raf = requestAnimationFrame(() => {
            artistVirtualState.raf = 0;
            artistVirtualState.update(true);
          });
        }
      });
    }
    artistVirtualState.resizeObserver.disconnect();
    artistVirtualState.resizeObserver.observe(el.artistsGrid);
    update(true);
  }

  const RICH_TEXT_TAGS = new Set(['span','b','strong','i','em','u','small','code','br']);
  const RICH_TEXT_CLASSES = new Set(['hive-pulse','hive-rainbow','hive-glow']);
  const RICH_TEXT_STYLES = new Set(['color','background-color','font-weight','font-style','text-decoration','text-shadow','letter-spacing','opacity','font-size']);
  function sanitizeRichText(value) {
    const raw = String(value ?? '');
    if (!/[<][a-z]/i.test(raw)) return escapeHtml(raw);
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${raw}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) return escapeHtml(raw);
    const clean = doc.createElement('div');
    const walk = (node, parent) => {
      if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(doc.createTextNode(node.nodeValue || '')); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (!RICH_TEXT_TAGS.has(tag)) { [...node.childNodes].forEach(child => walk(child, parent)); return; }
      const out = doc.createElement(tag);
      if (tag === 'span') {
        const classes = String(node.getAttribute('class') || '').split(/\s+/).filter(c => RICH_TEXT_CLASSES.has(c));
        if (classes.length) out.setAttribute('class', classes.join(' '));
        const styleParts = [];
        const rawStyle = String(node.getAttribute('style') || '');
        for (const declaration of rawStyle.split(';')) {
          const colon = declaration.indexOf(':'); if (colon < 1) continue;
          const prop = declaration.slice(0, colon).trim().toLowerCase();
          const val = declaration.slice(colon + 1).trim();
          if (!RICH_TEXT_STYLES.has(prop) || !val || /url\s*\(|expression\s*\(|javascript:|var\s*\(/i.test(val)) continue;
          if (!/^[#a-z0-9 .,%()_+\-/'"\s]+$/i.test(val)) continue;
          styleParts.push(`${prop}:${val}`);
        }
        if (styleParts.length) out.setAttribute('style', styleParts.join(';'));
      }
      [...node.childNodes].forEach(child => walk(child, out));
      parent.appendChild(out);
    };
    [...root.childNodes].forEach(child => walk(child, clean));
    return clean.innerHTML;
  }
  function setRichLabel(element, value) {
    if (!element) return;
    element.innerHTML = sanitizeRichText(value);
  }

  function richLabelText(value) {
    const raw = String(value ?? '');
    if (!/<[a-z]/i.test(raw)) return raw;
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${raw}</div>`, 'text/html');
    return doc.body.firstElementChild?.textContent || raw.replace(/<[^>]*>/g, '');
  }

  function playlistLabel(pl) {
    return String(pl?.label || pl?.name || 'Untitled Playlist');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setView(mode) {
    viewMode = mode;
    if (el.yearsToggle) {
      // Years stays visible for an artist search too -- it's still the
      // Albums tab, just filtered by artist -- but only for Albums; Tracks
      // and Artists must never show it, artist search or not.
      const yearsVisible = mode === 'albums' && specialView !== 'yearly-wrap' && specialView !== 'podcasts' && specialView !== 'sandbox';
      el.yearsToggle.classList.toggle('hidden', !yearsVisible);
    }
    el.viewBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    if (el.artistBackBtn) el.artistBackBtn.classList.toggle('hidden', !(((artistSearchTerm && mode === 'albums') || (albumSearchReturnState && specialView === 'album-focus' && mode === 'albums'))));
    if (el.sectionTitleText) el.sectionTitleText.textContent = artistSearchTerm ? artistSearchTerm : (mode === 'artists' ? 'Artists' : mode === 'songs' ? 'Tracks' : 'Albums');
    if(specialView){
      if(specialView==='playlist' && activePlaylistId){
        const pl=playlists.find(p=>String(p.id)===String(activePlaylistId));
        if(pl) renderMusicViewer(playlistLabel(pl), tracksForPlaylist(pl), 'playlist');
        saveActiveTabState();
        updateActiveTabLabel();
        return;
      }
      if(specialView==='history'){
        window.beehive.getHistory().then(h=>{const t=historyTracks(h||[]);renderMusicViewer('History',t,'history');});
      } else if(specialView==='recent'){
        renderMusicViewer('Recently Added',getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100),'recent');
      } else if(specialView==='top'){
        renderMusicViewer('Top 25 Most Played',[...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25),'top');
      } else if(specialView==='folder' && activeFolderPath){
        const folderName = activeFolderPath.split(/[\\/]/).filter(Boolean).pop() || activeFolderPath;
        renderMusicViewer(folderName, tracksForFolder(activeFolderPath), 'folder');
      } else if(specialView==='album-focus' && albumFocusTitle){
        hideContentViews();
        el.albumsToolbar.classList.remove('hidden');
        el.albumsGrid.classList.remove('hidden');
        const tracks = library.tracks.filter(track => String(track?.album || '').trim() === albumFocusTitle);
        if (el.sectionTitleText) el.sectionTitleText.textContent = tracks[0]?.album || 'Album';
        renderSpecialAlbums(tracks);
        const album = buildAlbums(tracks)[0];
        const card = el.albumsGrid.querySelector('.album-card[data-key]');
        if (album && card) toggleInlineAlbum(card, album);
      }
      return;
    }
    el.albumsGrid.classList.toggle('hidden', mode !== 'albums');
    el.songsTable.classList.toggle('hidden', mode !== 'songs');
    el.artistsGrid.classList.toggle('hidden', mode !== 'artists');
    if (mode === 'albums') renderAlbums();
    if (mode === 'songs') renderSongsTable();
    if (mode === 'artists') renderArtists(tracksForCurrentContext());
    saveActiveTabState();
    updateActiveTabLabel();
  }

  // ---------------- queue / playback ----------------
  function albumTracksForPlayback(album) {
    return (album?.tracks || []).slice().sort((a,b) =>
      (Number(a?.disk) || 0) - (Number(b?.disk) || 0) ||
      (Number(a?.track) || 0) - (Number(b?.track) || 0) ||
      songCollator.compare(String(a?.title || ''), String(b?.title || ''))
    );
  }

  function playAlbum(album) {
    const tracks = albumTracksForPlayback(album);
    if (!tracks.length) return false;
    // Album playback is deliberately independent of the collection that led
    // here. The album's canonical track order is used unless the actual player
    // Shuffle switch is enabled, in which case playQueue() performs the normal
    // transport shuffle. A sidebar/playlist shuffle-on-enter flag is never read.
    playQueue(tracks, 0, true);
    return true;
  }

  // Gathers every local library track by this exact artist and shuffle-plays
  // them -- the context-menu equivalent of MusicBee's "Play Artist 'X'".
  function playArtistShuffled(artistName) {
    const name = String(artistName || '').trim().toLowerCase();
    if (!name) return false;
    const tracks = library.tracks.filter(t => String(t?.artist || '').trim().toLowerCase() === name);
    if (!tracks.length) return false;
    playQueue(shuffleForPlayback(tracks), 0, false);
    return true;
  }

  // MusicBee's "Play Similar 'X'" using Last.fm's artist.getsimilar (a public
  // method that only needs the API key already entered in Settings >
  // Community, not full scrobble authorization). Hive has no local artist
  // similarity data of its own, so only artists Last.fm actually returns --
  // and that also exist in the local library -- can ever be queued.
  async function playSimilarArtist(artistName) {
    const name = String(artistName || '').trim();
    if (!name) return;
    let similar;
    try {
      similar = await window.beehive.getSimilarArtists(name);
    } catch (err) {
      themedAlert?.(err?.message || 'Could not fetch similar artists from Last.fm.', 'Play Similar');
      return;
    }
    const wanted = new Set((similar || []).map(a => String(a).trim().toLowerCase()));
    if (!wanted.size) {
      themedAlert?.(`Last.fm did not return any similar artists for ${name}.`, 'Play Similar');
      return;
    }
    const matches = library.tracks.filter(t => wanted.has(String(t?.artist || '').trim().toLowerCase()));
    if (!matches.length) {
      themedAlert?.(`None of Last.fm's similar artists for ${name} were found in your library.`, 'Play Similar');
      return;
    }
    playQueue(shuffleForPlayback(matches), 0, false);
  }

  // A Music-tab click commonly reuses the exact same 30k-track collection as
  // the current queue. Comparing stable file identities lets us distinguish a
  // transport-only jump from a real queue mutation without serializing the whole
  // queue on every click.
  function sameQueueIdentity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (String(a[i]?.path || '') !== String(b[i]?.path || '')) return false;
    }
    return true;
  }

  function playQueue(tracks, startIndex=0, respectShuffle=true) {
    // An explicit queue/album/track play action is a user-initiated transport
    // command. It must be allowed to start playback even when startup restored
    // a previous session in the deliberately-paused state.
    startupPlaybackLocked = false;
    finishPlayCountSession({ countIfQualified: true });
    queueUndoStack.length = 0;
    queueRedoStack.length = 0;
    let queue = tracks.slice();
    let index = Math.max(0, Math.min(Number(startIndex)||0, queue.length - 1));
    if (respectShuffle && shuffle) {
      shuffleRestoreQueue = queue.slice();
    }
    if (respectShuffle && shuffle && queue.length > 1) {
      const chosen = queue[index];
      queue = shuffleForPlayback(queue);
      const chosenIndex = queue.indexOf(chosen);
      index = chosenIndex >= 0 ? chosenIndex : Math.floor(Math.random() * queue.length);
    }
    const queuePersistenceNeeded = !sameQueueIdentity(currentQueue, queue);
    const selectedTrackForFreshPlay = queue[index];
    if (selectedTrackForFreshPlay) clearAutomaticCoverVisual(selectedTrackForFreshPlay);
    currentQueue = queue;
    currentIndex = index;
    // Starting a new explicit queue is a fresh playback session for the
    // selected track. Never carry a previously-playing track's transport
    // position into this new queue. The only position that is persisted is
    // the position belonging to the queue that is currently active, so a song
    // revisited later always starts from 0:00. Startup restoration is the one
    // exception: loadCurrentPausedAt() sets pendingRestoredOffset explicitly
    // before the user presses Play.
    activeOffset = 0;
    activeDuration = 0;
    pendingRestoredOffset = null;
    // GStreamer keeps the previous track's last reported position until LOAD
    // replaces the URI. Do not let the pre-LOAD session save attribute that
    // stale position to the newly selected track. This is especially important
    // for sidebar double-click playback: the click handler can persist the new
    // queue before the native LOAD command has reached the helper.
    gstPosition = 0;
    gstPositionUpdatedAt = performance.now();
    selectedQueueIndex = currentIndex;
    selectedQueueIndices.clear();
    if (currentIndex >= 0) selectedQueueIndices.add(currentIndex);
    activeSelectionScope = 'queue';
    playbackHistory = [];
    renderQueue();
    // Switching tracks within the same large Music-tab collection is a transport
    // jump, not a queue mutation. Avoid rewriting thousands of queue entries on
    // every click; the compact transport snapshot still records the new track.
    if (queuePersistenceNeeded) saveQueueSession();
    else savePlaybackSession();
    if (isSpotifyTrack(selectedTrackForFreshPlay)) { void spotifyPlayCurrent(); return; }
    if (isPodcastTrack(selectedTrackForFreshPlay)) { void podcastLoad(selectedTrackForFreshPlay, 0, true); return; }
    activateLocalProvider();
    requestLoadAndPlayCurrent(true);
  }

  function queueRowHtml(t, i) {
    const isCurrent = i === currentIndex;
    return `<li class="queue-row${isCurrent ? ' playing' : ''}${selectedQueueIndices.has(i) ? ' selected' : ''}" data-idx="${i}" draggable="true">
      <img class="q-thumb" src="${coverSrc(visualCoverForTrack(t))}" alt="" loading="${isCurrent ? 'eager' : 'lazy'}" decoding="async" />
      <span class="q-dot"></span>
      <div class="q-meta">
        <div class="q-title">${escapeHtml(t.title)}</div>
        <div class="q-artist">${escapeHtml(t.artist)}</div>
      </div>
      <span class="q-dur">${fmtTime(t.duration)}</span>
    </li>`;
  }

  function beginQueueRowDrag(e, rowIndex) {
    if (!e.dataTransfer || !Number.isInteger(rowIndex) || !currentQueue[rowIndex]) return;
    activeSelectionScope = 'queue';
    const selected = selectedQueueIndices.has(rowIndex) && selectedQueueIndices.size
      ? [...selectedQueueIndices].filter(i => Number.isInteger(i) && i >= 0 && i < currentQueue.length).sort((a, b) => a - b)
      : [rowIndex];
    if (!selected.length) return;
    if (!selectedQueueIndices.has(rowIndex)) {
      selectedQueueIndices.clear();
      selectedQueueIndices.add(rowIndex);
      selectedQueueIndex = rowIndex;
      applyQueueSelectionClasses();
    }
    queueDragState = { indices: selected, paths: selected.map(i => currentQueue[i]?.path).filter(Boolean) };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `beehive-queue-move:${selected.length}`);
    e.stopPropagation();
  }

  function moveSelectedQueueItems(dropIndex) {
    if (!queueDragState?.indices?.length || !currentQueue.length) return false;
    const selected = [...queueDragState.indices].filter(i => Number.isInteger(i) && i >= 0 && i < currentQueue.length).sort((a, b) => a - b);
    if (!selected.length) return false;
    const selectedSet = new Set(selected);
    const originalCurrentPath = currentQueue[currentIndex]?.path || '';
    const moving = selected.map(i => currentQueue[i]);
    const raw = Math.max(0, Math.min(currentQueue.length, Number(dropIndex) || 0));
    const before = captureQueueState();
    const remaining = currentQueue.filter((_, i) => !selectedSet.has(i));
    const insertion = Math.max(0, Math.min(remaining.length, raw - selected.filter(i => i < raw).length));
    const unchanged = moving.every((t, n) => remaining[insertion + n] === t);
    if (unchanged) return false;
    currentQueue = remaining.slice(0, insertion).concat(moving, remaining.slice(insertion));

    if (originalCurrentPath) {
      const ni = currentQueue.findIndex(t => String(t?.path || '') === String(originalCurrentPath));
      if (ni >= 0) currentIndex = ni;
    }
    selectedQueueIndices.clear();
    const used = new Set();
    for (const track of moving) {
      const ni = currentQueue.findIndex((t, i) => !used.has(i) && t === track);
      if (ni >= 0) { used.add(ni); selectedQueueIndices.add(ni); }
    }
    selectedQueueIndex = currentQueue.findIndex((t, i) => selectedQueueIndices.has(i));
    if (shuffle) syncShuffleRestoreQueue();

    renderQueue();
    pushQueueUndo(before);
    saveQueueSession();
    savePlaybackSession();

    // Queue reordering is a UI/session mutation, not a playback command.
    // NEVER STOP/LOAD the currently playing GStreamer track here: doing so
    // tears down the native stream/clock and creates an audible stutter. The
    // persistent playbin already owns the current stream, so only refresh its
    // pending NEXT URI. The current track remains exactly where it is.
    if (gstActive) {
      gstTrackIndex = currentIndex;
      gstSendNext();
    }

    // Web Audio also keeps the active source alive. If the reorder changes the
    // identity of the gapless successor, replace only the *future* scheduled
    // source; never touch the source that is currently audible. If the same
    // track remains next, simply update its logical queue index.
    if (!gstActive && !podcastActive && !spotifyActive && !enginePaused && activeSource) {
      const nextIndex = getNextPlaybackIndex();
      const desiredNext = nextIndex >= 0 ? currentQueue[nextIndex] : null;
      const scheduledTrack = scheduledNextIndex >= 0 ? currentQueue[scheduledNextIndex] : null;
      const sameNext = desiredNext && scheduledTrack && desiredNext === scheduledTrack;
      if (sameNext) {
        scheduledNextIndex = nextIndex;
      } else if (scheduledNext) {
        cancelScheduledNext();
        void armGaplessNext(engineGeneration);
      } else if (desiredNext) {
        void armGaplessNext(engineGeneration);
      }
    }
    return true;
  }

  function updateQueueDropIndex(row, e) {
    const i = Number(row.dataset.idx);
    if (!Number.isInteger(i)) return;
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    clearQueueDropTarget();
    queueDropIndex = before ? i : i + 1;
    row.classList.add('queue-drop-target');
    row.dataset.dropSide = before ? 'before' : 'after';
  }

  function bindQueueInteractions() {
    if (!el.queueList || el.queueList.__beehiveQueueInteractionsBound) return;
    el.queueList.__beehiveQueueInteractionsBound = true;

    el.queueList.addEventListener('click', e => {
      const row = e.target?.closest?.('.queue-row');
      if (!row || !el.queueList.contains(row)) return;
      const i = Number(row.dataset.idx);
      if (!Number.isInteger(i) || !currentQueue[i]) return;
      activeSelectionScope = 'queue';
      if (e.shiftKey && selectedQueueIndex >= 0) {
        const from = Math.min(selectedQueueIndex, i);
        const to = Math.max(selectedQueueIndex, i);
        selectedQueueIndices.clear();
        for (let n = from; n <= to; n++) selectedQueueIndices.add(n);
      } else if (e.ctrlKey || e.metaKey) {
        if (selectedQueueIndices.has(i)) selectedQueueIndices.delete(i);
        else selectedQueueIndices.add(i);
        selectedQueueIndex = i;
      } else {
        selectedQueueIndices.clear();
        selectedQueueIndices.add(i);
        selectedQueueIndex = i;
      }
      selectedQueueIndex = i;
      applyQueueSelectionClasses();
    });

    el.queueList.addEventListener('dblclick', e => {
      const row = e.target?.closest?.('.queue-row');
      if (!row || !el.queueList.contains(row)) return;
      const i = Number(row.dataset.idx);
      if (!Number.isInteger(i) || !currentQueue[i]) return;
      // Queue-row double-click is an explicit user playback command. It always
      // means "play this song from the beginning" — including when this is
      // the track restored from the previous session with a saved position.
      startupPlaybackLocked = false;
      gstTrackIndex = -1;
      gstPositionUpdatesEnabled = false;
      gstPosition = 0;
      gstPositionUpdatedAt = performance.now();
      try {
        el.pbSeek.value = '0';
        el.pbSeek.style.setProperty('--seek-progress', '0%');
        el.pbSeek.setAttribute('aria-valuenow', '0');
        el.pbElapsed.textContent = fmtTime(0);
      } catch {}
      if (currentQueue[currentIndex] && currentQueue[currentIndex] !== currentQueue[i]) playbackHistory.push(currentQueue[currentIndex]);
      currentIndex = i;
      selectedQueueIndex = i;
      activeOffset = 0;
      activeDuration = 0;
      pendingRestoredOffset = null;
      requestLoadAndPlayCurrent(true);
    });

    el.queueList.addEventListener('contextmenu', e => {
      const row = e.target?.closest?.('.queue-row');
      if (!row || !el.queueList.contains(row)) return;
      const i = Number(row.dataset.idx);
      const t = Number.isInteger(i) ? currentQueue[i] : null;
      if (!t) return;
      e.preventDefault();
      showTrackContextMenu(e.clientX, e.clientY, t);
    });

    el.queueList.addEventListener('dragstart', e => {
      const row = e.target?.closest?.('.queue-row');
      if (!row || !el.queueList.contains(row)) return;
      const i = Number(row.dataset.idx);
      if (Number.isInteger(i)) beginQueueRowDrag(e, i);
    });
    el.queueList.addEventListener('dragend', () => {
      queueDragState = null;
      clearQueueDropTarget();
      queueDropIndex = -1;
    });
    el.queueList.addEventListener('dragover', e => {
      const row = e.target?.closest?.('.queue-row');
      if (!row || !el.queueList.contains(row)) return;
      const i = Number(row.dataset.idx);
      if (!Number.isInteger(i)) return;
      if (queueDragState?.indices?.length) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        updateQueueDropIndex(row, e);
        return;
      }
      if (!songDragState?.tracks?.length) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      clearQueueDropTarget();
      queueDropIndex = before ? i : i + 1;
      row.classList.add('queue-drop-target');
      row.dataset.dropSide = before ? 'before' : 'after';
    });
    el.queueList.addEventListener('dragleave', e => {
      const row = e.target?.closest?.('.queue-row');
      if (!row || !el.queueList.contains(row)) return;
      if (!e.relatedTarget || !row.contains(e.relatedTarget)) {
        row.classList.remove('queue-drop-target');
        delete row.dataset.dropSide;
      }
    });
    el.queueList.addEventListener('drop', e => {
      const row = e.target?.closest?.('.queue-row');
      if (!row || !el.queueList.contains(row)) return;
      const i = Number(row.dataset.idx);
      if (!Number.isInteger(i)) return;
      if (queueDragState?.indices?.length) {
        e.preventDefault();
        e.stopPropagation();
        const at = queueDropIndex >= 0 ? queueDropIndex : i;
        moveSelectedQueueItems(at);
        queueDragState = null;
        clearQueueDropTarget();
        return;
      }
      if (!songDragState?.tracks?.length) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = row.getBoundingClientRect();
      const at = e.clientY < rect.top + rect.height / 2 ? i : i + 1;
      clearQueueDropTarget();
      insertDraggedSongsIntoQueue(at);
      songDragState = null;
    });
  }

  function applyQueueSelectionClasses(container = el.queueList) {
    container.querySelectorAll('.queue-row').forEach(row => {
      row.classList.toggle('selected', selectedQueueIndices.has(Number(row.dataset.idx)));
    });
    updateSelectionStatus();
  }

  function selectAllActiveSection() {
    // Ctrl+A is deliberately scoped to the section whose row was last clicked.
    // Use the same selection sets/classes as ordinary click selection; the
    // virtualized lists will paint every selected row as it enters the window.
    if (activeSelectionScope === 'queue') {
      selectedQueueIndices.clear();
      for (let i = 0; i < currentQueue.length; i++) selectedQueueIndices.add(i);
      selectedQueueIndex = currentQueue.length ? 0 : -1;
      updateQueueVirtualRows(true);
      applyQueueSelectionClasses();
      return true;
    }
    if (activeSelectionScope === 'albums') {
      const cards = getDisplayedAlbumCards();
      if (!cards.length) return false;
      clearAlbumSelection();
      for (const card of cards) selectAlbumKey(card.dataset.key);
      albumSelectionAnchor = cards[0]?.dataset.key || null;
      applyAlbumSelectionClasses();
      return true;
    }
    if (activeSelectionScope === 'songs') {
      const tracks = Array.isArray(activeSelectionTracks)
        ? activeSelectionTracks
        : (viewMode === 'songs' && !el.songsTable.classList.contains('hidden') ? (songVirtualState.tracks || []) : []);
      if (!tracks.length) return false;
      clearSongSelection();
      for (const t of tracks) {
        const path = String(t?.path || '');
        if (path) selectSongPath(path);
      }
      songSelectionAnchor = tracks.length ? String(tracks[0]?.path || '') : null;
      updateVirtualSongRows(true);
      applySongSelectionClasses();
      // Repaint any currently open inline album viewer so Ctrl+A is visibly
      // reflected there immediately instead of waiting for another render.
      document.querySelectorAll('.inline-track-list').forEach(list => {
        list.querySelectorAll('.inline-track-row').forEach(row => {
          row.classList.toggle('selected', selectedSongPaths.has(row.dataset.path || ''));
        });
      });
      return true;
    }
    return false;
  }

  function removeSelectedQueueItems() {
    if (activeSelectionScope !== 'queue' || !selectedQueueIndices.size || !currentQueue.length) return false;
    const before = captureQueueState();
    const removed = new Set(selectedQueueIndices);
    const oldCurrentIndex = currentIndex;
    const currentWasRemoved = removed.has(oldCurrentIndex);
    const newQueue = [];
    let newCurrentIndex = oldCurrentIndex;
    for (let i = 0; i < currentQueue.length; i++) {
      if (removed.has(i)) {
        if (i < oldCurrentIndex) newCurrentIndex--;
        continue;
      }
      newQueue.push(currentQueue[i]);
    }
    currentQueue = newQueue;
    if (shuffle) syncShuffleRestoreQueue();
    selectedQueueIndices.clear();
    selectedQueueIndex = -1;

    if (!currentQueue.length) {
      currentIndex = -1;
      audio.pause();
      audio.removeAttribute('src');
      activeBuffer = null; activeDuration = 0; activeOffset = 0; engineSrc = ''; cancelScheduledNext(); stopActiveSource();
    } else if (currentWasRemoved) {
      // Removing the currently playing row removes it from playback as well;
      // keep the queue positioned at the nearest surviving row without
      // automatically starting another song.
      currentIndex = Math.max(0, Math.min(newCurrentIndex, currentQueue.length - 1));
      audio.pause();
      audio.removeAttribute('src');
      activeBuffer = null; activeDuration = 0; activeOffset = 0; engineSrc = ''; cancelScheduledNext(); stopActiveSource();
    } else {
      currentIndex = Math.max(0, Math.min(newCurrentIndex, currentQueue.length - 1));
    }
    renderQueue();
    pushQueueUndo(before);
    saveQueueSession();
    savePlaybackSession();
    return true;
  }

  function restoreQueueState(snapshot) {
    if (!snapshot) return false;
    currentQueue = snapshot.queue.slice();
    if (shuffle) syncShuffleRestoreQueue();

    // Undo/redo must never seek, pause, load, or start playback. Preserve the
    // currently playing track by path when it still exists in the restored
    // queue; otherwise keep the prior index only as a harmless queue cursor.
    const currentPath = String(snapshot.currentPath || '');
    const preservedIndex = currentPath
      ? currentQueue.findIndex(t => String(t?.path || '') === currentPath)
      : -1;
    if (preservedIndex >= 0) {
      currentIndex = preservedIndex;
    } else if (currentQueue.length) {
      currentIndex = Math.max(0, Math.min(Number(snapshot.currentIndex) || 0, currentQueue.length - 1));
    } else {
      currentIndex = -1;
    }

    selectedQueueIndex = Number.isInteger(snapshot.selectedQueueIndex)
      ? snapshot.selectedQueueIndex
      : -1;
    selectedQueueIndices.clear();
    for (const i of (snapshot.selectedIndices || [])) {
      if (Number.isInteger(i) && i >= 0 && i < currentQueue.length) selectedQueueIndices.add(i);
    }
    if (selectedQueueIndex >= currentQueue.length) selectedQueueIndex = currentQueue.length ? currentQueue.length - 1 : -1;
    activeSelectionScope = 'queue';
    renderQueue();
    saveQueueSession();
    return true;
  }

  function undoQueueChange() {
    if (!queueUndoStack.length) return false;
    const action = queueUndoStack.pop();
    queueRedoStack.push(action);
    if (queueRedoStack.length > MAX_QUEUE_UNDO) queueRedoStack.shift();
    return restoreQueueState(action.before);
  }

  function redoQueueChange() {
    if (!queueRedoStack.length) return false;
    const action = queueRedoStack.pop();
    queueUndoStack.push(action);
    if (queueUndoStack.length > MAX_QUEUE_UNDO) queueUndoStack.shift();
    return restoreQueueState(action.after);
  }

  function handleSelectionKeyboard(e) {
    if (e.defaultPrevented || e.altKey) return;
    const target = e.target;
    if (target && (target.closest?.('input, textarea, select, [contenteditable=\"true\"]'))) return;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key.toLowerCase() === 'z' || e.code === 'KeyZ')) {
      if (redoQueueChange()) e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'z' || e.code === 'KeyZ')) {
      if (undoQueueChange()) e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'a' || e.code === 'KeyA')) {
      if (selectAllActiveSection()) e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (activeSelectionScope === 'queue') {
        e.preventDefault();
        removeSelectedQueueItems();
      }
    }
  }

  function populateQueueVirtualRow(row, track, index) {
    if (!row || !track) return;
    // Queue entries can outlive a full scan's renderer library replacement.
    // Resolve the row through the authoritative path index before painting it so
    // refreshed embedded artwork/metadata is reflected immediately without
    // rebuilding or replacing the queue itself.
    const authoritative = track?.path ? (libraryTrackByPath.get(String(track.path)) || track) : track;
    track = authoritative;
    row.dataset.idx = String(index);
    row.draggable = true;
    row.className = `queue-row${index === currentIndex ? ' playing' : ''}${selectedQueueIndices.has(index) ? ' selected' : ''}`;
    const thumb = row.querySelector('.q-thumb');
    const title = row.querySelector('.q-title');
    const artist = row.querySelector('.q-artist');
    const duration = row.querySelector('.q-dur');
    const cover = coverSrc(visualCoverForTrack(track));
    if (thumb && thumb.src !== cover) thumb.src = cover;
    if (thumb) {
      thumb.loading = index === currentIndex ? 'eager' : 'lazy';
      thumb.decoding = 'async';
    }
    if (title) title.textContent = track.title || '';
    if (artist) artist.textContent = track.artist || '';
    if (duration) duration.textContent = fmtTime(track.duration);
    row.__queueAssignedIndex = index;
  }

  function createQueueVirtualRow() {
    const row = document.createElement('li');
    row.innerHTML = queueRowHtml({ title: '', artist: '', duration: 0 }, 0)
      .replace(/^<li[^>]*>|<\/li>$/g, '');
    row.dataset.queueSlot = String(queueVirtualState.pool.length);
    row.style.position = 'absolute';
    row.style.left = '0';
    row.style.right = '0';
    row.style.willChange = 'transform';
    return row;
  }

  function updateQueueVirtualRows(force = false) {
    if (!el.queueList) return;
    const tracks = currentQueue || [];
    const spacer = queueVirtualState.spacer || el.queueList.querySelector('.queue-virtual-spacer');
    if (!spacer) return;
    queueVirtualState.spacer = spacer;
    const rowHeight = queueVirtualState.rowHeight;
    const scrollTop = el.queueList.scrollTop;
    const viewport = el.queueList.clientHeight || 220;
    const overscan = 8;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const end = Math.min(tracks.length, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
    if (!force && start === queueVirtualState.lastStart && end === queueVirtualState.lastEnd) return;
    queueVirtualState.lastStart = start;
    queueVirtualState.lastEnd = end;
    spacer.style.height = `${Math.max(0, tracks.length * rowHeight)}px`;
    // The virtual window is promoted once by renderQueue(); scrolling only moves
    // its pooled children, avoiding repeated style writes on the parent layer.

    // Keep a small fixed pool of row nodes. A 40k-track queue therefore has the
    // same DOM cost as a 400-track queue: only the viewport plus overscan exists.
    // Rows stay in the same parent while scrolling and are reassigned to indices;
    // this avoids repeated append/remove/layout work at every virtualization step.
    const needed = Math.min(64, Math.max(1, (end - start) + 2));
    while (queueVirtualState.pool.length < needed) {
      const row = createQueueVirtualRow();
      queueVirtualState.pool.push(row);
      el.queueList.appendChild(row);
    }
    queueVirtualState.poolSize = needed;

    for (let slot = 0; slot < queueVirtualState.pool.length; slot++) {
      const row = queueVirtualState.pool[slot];
      const index = slot < needed ? start + slot : -1;
      if (index < 0 || index >= end) {
        row.style.display = 'none';
        continue;
      }
      row.style.display = '';
      // Use the absolute row's actual top offset rather than relying on a
      // transformed list item. The queue list itself is the scroll container;
      // explicit top positioning keeps pooled rows in the scroll layer when a
      // large Favorites queue is created or the list is rebuilt.
      row.style.top = `${index * rowHeight}px`;
      if (row.__queueAssignedIndex !== index || force) populateQueueVirtualRow(row, tracks[index], index);
    }

    // Artwork rotation is only relevant to the currently visible queue row. Do
    // not query the queue or touch the large player artwork on unrelated scrolls.
    if (start <= currentIndex && currentIndex < end) {
      const slot = currentIndex - start;
      retargetCurrentCoverRotationTargets(queueVirtualState.pool[slot] || null);
    }
  }

  // Warm artwork for coverless albums in the active queue in the background.
  // IMPORTANT: never launch one native metadata lookup per queue row. A large
  // album can contain many tracks, and doing per-track checks/searches at queue
  // startup can create a burst of helper processes and destabilize playback.
  // Search once per album, then reuse the successful visual for every coverless
  // queue row from that album. Only the currently playing row participates in
  // the multi-image rotator.
  const automaticAlbumLookups = new Map();
  const automaticAlbumNoResults = new Set();

  async function warmAlbumAutomaticArtwork(album, artist, tracks) {
    const albumName = String(album || '').trim();
    const artistName = String(artist || '').trim();
    if (!albumName || !tracks?.length) return null;
    const albumKey = `${albumName.toLowerCase()}|${artistName.toLowerCase()}`;
    if (automaticAlbumNoResults.has(albumKey)) return null;
    if (automaticAlbumLookups.has(albumKey)) return automaticAlbumLookups.get(albumKey);

    const lookup = (async () => {
      try {
        // If any queue track from this album already has embedded artwork in the
        // current model, do not replace that real artwork. Coverless peers can
        // still use the album visual discovered below only when the album has no
        // embedded artwork in the queue model.
        if (tracks.some(t => embeddedCoverExists(t))) return null;
        if (isPlaceholderAlbum(albumName)) return null;
        const results = await window.beehive.searchInternetCover({ album: albumName, artist: artistName });
        for (const item of Array.isArray(results) ? results : []) {
          const remoteUrl = String(item?.artworkUrl || '').trim();
          if (!/^https?:\/\//i.test(remoteUrl)) continue;
          const loaded = await new Promise(resolve => {
            const img = new Image();
            img.decoding = 'async';
            let settled = false;
            const finish = value => { if (!settled) { settled = true; resolve(value); } };
            img.onload = async () => { try { if (img.decode) await img.decode(); } catch {} finish(true); };
            img.onerror = () => finish(false);
            img.src = remoteUrl;
          });
          if (!loaded) continue;

          for (const track of tracks) {
            const path = String(track?.path || '');
            if (!path || embeddedCoverExists(track)) continue;
            automaticCoverVisuals.set(path, remoteUrl);
            const idx = currentQueue.indexOf(track);
            if (idx < 0) continue;
            const row = el.queueList?.querySelector(`.queue-row[data-idx="${idx}"]`);
            // Do not force a second immediate decode by assigning src here. The
            // queue renderer reads visualCoverForTrack() and will display this
            // already-selected URL on its normal render/virtualization pass.
            if (row) row.dataset.visualArtworkReady = '1';
          }
          return remoteUrl;
        }
      } catch (err) {
        console.warn('[Beehive] queue album artwork lookup failed:', err?.message || err);
      }
      automaticAlbumNoResults.add(albumKey);
      return null;
    })();
    automaticAlbumLookups.set(albumKey, lookup);
    try { return await lookup; } finally { automaticAlbumLookups.delete(albumKey); }
  }

  function warmQueueAutomaticArtwork() {
    if (queueArtworkWarmupScheduled || !currentQueue.length) return;
    queueArtworkWarmupScheduled = true;
    const snapshot = currentQueue.slice();
    const groups = new Map();
    for (const track of snapshot) {
      if (!track || embeddedCoverExists(track)) continue;
      const album = String(track.album || '').trim();
      const artist = String(track.albumArtist || track.artist || '').trim();
      if (isPlaceholderAlbum(album)) continue;
      const key = `${album.toLowerCase()}|${artist.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { album, artist, tracks: [] });
      groups.get(key).tracks.push(track);
    }

    // One album lookup at a time. The current track has already started its
    // guarded lookup from updateNowPlayingUI; this queue warmup is intentionally
    // conservative and never competes with playback startup.
    const run = async () => {
      for (const group of groups.values()) {
        if (currentQueue !== snapshot) break;
        await warmAlbumAutomaticArtwork(group.album, group.artist, group.tracks);
      }
    };
    run().finally(() => {
      queueArtworkWarmupScheduled = false;
      if (currentQueue !== snapshot && currentQueue.length) warmQueueAutomaticArtwork();
    });
  }

  function renderQueue() {
    queueVirtualState.lastStart = -1;
    queueVirtualState.lastEnd = -1;
    // renderQueue replaces the virtual DOM. The pooled rows belong to the old
    // window, so discard that pool before creating the new window; otherwise
    // updateQueueVirtualRows sees an already-sized pool and never appends rows
    // to the new window, leaving the queue visibly empty.
    queueVirtualState.pool = [];
    queueVirtualState.poolSize = 0;
    queueVirtualState.spacer = null;
    el.queueList.innerHTML = '<li class="queue-virtual-spacer" aria-hidden="true"></li>';
    el.queueList.style.position = 'relative';
    queueVirtualState.spacer = el.queueList.querySelector('.queue-virtual-spacer');
    updateQueueVirtualRows(true);
    // When playback changes, put the current track into view without creating
    // thousands of DOM nodes for the rest of the queue.
    const target = Math.max(0, currentIndex) * queueVirtualState.rowHeight;
    if (target < el.queueList.scrollTop || target > el.queueList.scrollTop + el.queueList.clientHeight - queueVirtualState.rowHeight) {
      el.queueList.scrollTop = Math.max(0, target - Math.floor(el.queueList.clientHeight / queueVirtualState.rowHeight / 2) * queueVirtualState.rowHeight);
      updateQueueVirtualRows(true);
    }
    // Queue artwork warmup is intentionally disabled here. The current-track lookup
    // already propagates a successful album result to its coverless peers. Starting
    // searches for every album when a queue is rendered caused repeated large-image
    // decodes and could take down Chromium during playback startup.
    console.info('[Beehive Debug] queue artwork warmup disabled; current-album propagation remains active');
    if (specialView === 'sandbox' && viewMode === 'songs') renderSpecialSongs(currentQueue.slice());
  }

  if (el.queueList) {
    bindQueueInteractions();
    el.queueList.addEventListener('dragover', (e) => {
      if (queueDragState?.indices?.length) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (!e.target.closest?.('.queue-row')) {
          clearQueueDropTarget();
          queueDropIndex = currentQueue.length;
        }
        return;
      }
      if (!songDragState?.tracks?.length) return;
      // Allow dropping into empty space in the queue to append. Row dragover
      // handlers override this with the precise before/after insertion index.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (e.target.closest?.('.queue-row')) return;
      clearQueueDropTarget();
      queueDropIndex = currentQueue.length;
    });
    el.queueList.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !el.queueList.contains(e.relatedTarget)) clearQueueDropTarget();
    });
    el.queueList.addEventListener('drop', (e) => {
      if (queueDragState?.indices?.length) {
        if (e.target.closest?.('.queue-row')) return;
        e.preventDefault();
        const at = queueDropIndex >= 0 ? queueDropIndex : currentQueue.length;
        moveSelectedQueueItems(at);
        queueDragState = null;
        clearQueueDropTarget();
        return;
      }
      if (!songDragState?.tracks?.length) return;
      if (e.target.closest?.('.queue-row')) return;
      e.preventDefault();
      const at = queueDropIndex >= 0 ? queueDropIndex : currentQueue.length;
      clearQueueDropTarget();
      insertDraggedSongsIntoQueue(at);
      songDragState = null;
    });
  }

  if (el.queueList) {
    el.queueList.addEventListener('scroll', () => {
      if (queueVirtualState.raf) return;
      queueVirtualState.raf = requestAnimationFrame(() => {
        queueVirtualState.raf = 0;
        updateQueueVirtualRows(false);
      });
    }, { passive: true });
  }

  function readRememberedTrackPosition(track) {
    if (!track?.path || !playbackSettingEnabled(track, 'BEEHIVE_REMEMBER_POSITION')) return 0;
    try {
      const map = JSON.parse(localStorage.getItem(TRACK_REMEMBER_POSITIONS_KEY) || '{}');
      const value = Number(map[String(track.path)]);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch { return 0; }
  }
  function saveRememberedTrackPosition(track, position) {
    if (!track?.path || !playbackSettingEnabled(track, 'BEEHIVE_REMEMBER_POSITION')) return;
    try {
      const map = JSON.parse(localStorage.getItem(TRACK_REMEMBER_POSITIONS_KEY) || '{}');
      const key = String(track.path);
      const value = Math.max(0, Number(position) || 0);
      if (value > 0) map[key] = value; else delete map[key];
      localStorage.setItem(TRACK_REMEMBER_POSITIONS_KEY, JSON.stringify(map));
    } catch {}
  }

  let corruptTrackHandling = false;
  async function preflightLocalAudio(track) {
    if (!track?.path || !window.beehive.validateAudioForPlayback) return { status:'unavailable' };
    // The main process owns the cache and keys it by path + size + mtime so a
    // repaired/replaced file is automatically revalidated without requiring a
    // renderer reload.
    return await window.beehive.validateAudioForPlayback(String(track.path))
      .catch(error => ({ status:'unavailable', error:String(error?.message || error) }));
  }
  async function rejectCorruptTrack(track, result) {
    if (!track?.path || corruptTrackHandling) return false;
    corruptTrackHandling = true;
    try {
      gstStop();
      enginePaused = true;
      engineEnded = true;
      dispatchAudio('pause');
      track.audioIntegrity = { status:'corrupt', error:String(result?.error || 'The audio decoder rejected this file.') };
      console.warn('Hive skipped corrupted audio:', track.path, result?.error || 'decoder rejected file');
      await themedAlert(
        `Hive found corrupted audio and will not play this song.\n\nFile location:\n${track.path}\n\nDecoder error:\n${String(result?.error || 'The audio decoder rejected this file.')}`,
        'Corrupted audio file'
      );
      // Acknowledge is the explicit recovery boundary. Do not automatically
      // advance while the dialog is open, and do not try the bad file again.
      if (currentQueue[currentIndex] === track) goNext();
      return true;
    } finally {
      corruptTrackHandling = false;
    }
  }

  function requestLoadAndPlayCurrent(freshPlayback = false) {
    const requestGeneration = ++playbackLoadRequestGeneration;
    return loadAndPlayCurrent(requestGeneration, !!freshPlayback);
  }

  async function loadAndPlayCurrent(requestGeneration = playbackLoadRequestGeneration, freshPlayback = false) {
    const t = currentQueue[currentIndex];
    if (!t?.path && !isSpotifyTrack(t)) return;
    if (isSpotifyTrack(t)) { await spotifyPlayCurrent(); return true; }
    if (isPodcastTrack(t)) { return podcastLoad(t, Number(pendingRestoredOffset)||0, true); }
    if (podcastActive) { audioElement.pause(); audioElement.removeAttribute('src'); podcastActive=false; }
    if (gstFatalError && t?.path) {
      // Real bug, confirmed: this used to just latch here permanently,
      // silently refusing every future playback attempt -- including
      // switching to a completely different, healthy track -- until the
      // user restarted Hive. loadAndPlayCurrent() only ever runs in
      // response to a genuine user action (never on an automatic retry
      // loop: EOS-driven auto-advance requires gstActive, which a fatal
      // error always clears first), so picking a different track is just as
      // much "an explicit fresh user action" as pressing Play again -- the
      // same recovery audioEngine.play() already performs must apply here too.
      if (!window.beehive.gstreamerRestart || !(await recoverFromGstFatalError())) {
        enginePaused = true;
        engineEnded = true;
        dispatchAudio('pause');
        return false;
      }
    }
    activateLocalProvider();
    const integrity = await preflightLocalAudio(t);
    if (requestGeneration !== playbackLoadRequestGeneration) return false;
    if (integrity?.status === 'corrupt') {
      await rejectCorruptTrack(t, integrity);
      return false;
    }
    if (!gstAvailabilityKnown && !gstAvailabilityPromise && window.beehive.gstreamerStatus) {
      gstAvailabilityPromise = window.beehive.gstreamerStatus().then(v => { gstAvailable = !!v; gstAvailabilityKnown = true; return gstAvailable; }).catch(() => { gstAvailable = false; gstAvailabilityKnown = true; return false; });
    }
    if (gstAvailabilityPromise) await gstAvailabilityPromise;
    if (requestGeneration !== playbackLoadRequestGeneration) return false;
    if (gstAvailable && gstCompatibleTrack(t)) {
      const gstNativeSelected = true;
      // ReplayGain is optional metadata work. Do not make a queue jump wait for
      // a native tag read before handing the file to GStreamer; resolve it in
      // parallel and apply the result once it is available.
      const gainPromise = resolveReplayGainForTrack(t);
      if (requestGeneration !== playbackLoadRequestGeneration) return false;
      // GStreamer is the sole playback owner on this path. If the previous
      // track was being rendered by the fallback Web Audio transport, stop its
      // live source before handing the queue to GStreamer. Otherwise an album
      // double-click can briefly leave both transports audible at once, making
      // the perceived volume higher than the volume meter indicates.
      cancelScheduledNext();
      stopActiveSource();
      // gstLoadCurrent's LOAD command already moves the persistent playbin to
      // READY and then PAUSED. An extra STOP here only adds a command/state
      // transition to every manual queue jump, so leave the persistent pipeline
      // in place and let LOAD replace its URI directly.
      const desired = freshPlayback ? 0 : (Number.isFinite(Number(pendingRestoredOffset)) ? Number(pendingRestoredOffset) : readRememberedTrackPosition(t));
      pendingRestoredOffset = null;
      const gstLoaded = await gstLoadCurrent(desired, requestGeneration);
      await gainPromise;
      if (requestGeneration !== playbackLoadRequestGeneration) return false;
      if (gstLoaded) { applyOutputGain(); return true; }
      if (gstNativeSelected) {
        // GStreamer is the authoritative local playback engine. Never fall
        // through to the legacy Web Audio decoder after a native load failure:
        // doing so can replay a file through a second audio path while the
        // native sink is faulting, which is precisely the unsafe failure mode
        // this release must avoid. Silence and latch the transport instead.
        gstFatalError = true;
        gstSend('MUTE\t1');
        gstSend('STOP');
        window.beehive.setPlaybackProtectedPath?.('');
        gstActive = false;
        enginePaused = true;
        engineEnded = true;
        dispatchAudio('pause');
        console.error('Beehive audio safety shutdown: native GStreamer load failed; Web Audio fallback disabled.');
        return false;
      }
    }

    if (requestGeneration !== playbackLoadRequestGeneration) return false;
    if (gstFatalError && t?.path) {
      enginePaused = true;
      engineEnded = true;
      return false;
    }
    // Local files have one transport authority: the persistent native GStreamer
    // player. The historical Web Audio decoder remains legacy code during this
    // cleanup pass, but it must never become a second local playback engine.
    if (t?.path && !isSpotifyTrack(t) && !isPodcastTrack(t)) {
      enginePaused = true;
      engineEnded = true;
      console.error('Beehive local playback unavailable: GStreamer is the sole local transport.');
      return false;
    }
    await resolveReplayGainForTrack(t);
    if (requestGeneration !== playbackLoadRequestGeneration) return false;
    const generation = ++engineGeneration;
    const ctx = ensureAudioContext();
    await ctx.resume();
    cancelScheduledNext();
    stopActiveSource();
    enginePaused = false;
    engineEnded = false;
    try {
      const buffer = await decodeTrack(t);
      if (generation !== engineGeneration || requestGeneration !== playbackLoadRequestGeneration) return;
      const start = Math.max(0, parseTimeValue(t.startTime));
      const end = Math.max(0, parseTimeValue(t.endTime));
      const available = Math.max(0, buffer.duration - start);
      const duration = end > start ? Math.min(end - start, available) : available;
      if (duration <= 0) throw new Error('Track has no playable duration');
      const restoredCandidate = freshPlayback ? 0 : (Number.isFinite(Number(pendingRestoredOffset)) ? Number(pendingRestoredOffset) : readRememberedTrackPosition(t));
      const restoredOffset = Math.max(0, Math.min(duration, restoredCandidate));
      pendingRestoredOffset = null;
      activeBuffer = buffer;
      activeOffset = restoredOffset;
      activeDuration = duration;
      engineSrc = t.streamUrl ? t.streamUrl : window.beehive.fileUrl(t.path);
      const absoluteStart = start + restoredOffset;
      const remaining = end > start
        ? Math.min(end - absoluteStart, Math.max(0, buffer.duration - absoluteStart))
        : Math.max(0, buffer.duration - absoluteStart);
      if (remaining <= 0) throw new Error('Track has no playable duration at restored position');
      scheduleBufferSource(buffer, ctx.currentTime + 0.015, absoluteStart, remaining, 'current', currentIndex, restoredOffset, duration);
      dispatchAudio('loadedmetadata');
      dispatchAudio('durationchange');
      dispatchAudio('play');
      updateNowPlayingUI(t);
        renderQueue();
      // Decode and arm the next track before this one reaches its boundary.
      await armGaplessNext(generation);
      prepareNextBuffer();
    } catch (e) {
      enginePaused = true;
      engineEnded = true;
      dispatchAudio('pause');
      console.error('Beehive playback error:', e);
    }
  }

  // Restore the last queue/current track and exact position without starting
  // playback. IMPORTANT: do not create a BufferSource here. A BufferSource
  // scheduled against a suspended AudioContext will begin as soon as the
  // context is resumed by Play(), which used to cause the restored song to
  // start immediately on startup. We only decode/cache the buffer and retain
  // the logical offset; the first real BufferSource is created by play().
  async function loadCurrentPausedAt(seconds) {
    const t = currentQueue[currentIndex];
    if (!t?.path && !isSpotifyTrack(t)) return;
    if (isSpotifyTrack(t)) { await spotifyLoadPaused(t, seconds); return; }
    if (isPodcastTrack(t)) { await podcastLoad(t, seconds, false); return; }
    activateLocalProvider();
    engineTrackGain = 1;
    ++engineGeneration;
    cancelScheduledNext();
    stopActiveSource();
    enginePaused = true;
    engineEnded = false;
    try {
      // Do NOT decode the FLAC/MP3/etc. during startup. The library scanner already
      // has duration metadata, so the UI can restore the exact scrubber position
      // immediately. The real AudioBuffer is decoded lazily only when Play is pressed.
      const metadataDuration = Number(t.duration);
      const start = Math.max(0, parseTimeValue(t.startTime));
      const end = Math.max(0, parseTimeValue(t.endTime));
      const available = Number.isFinite(metadataDuration) && metadataDuration > start
        ? Math.max(0, metadataDuration - start)
        : 0;
      const duration = end > start ? Math.min(end - start, available) : available;
      const desired = Math.max(0, Number(seconds) || 0);
      activeBuffer = null;
      activeOffset = duration > 0 ? Math.min(duration, desired) : desired;
      activeDuration = duration;
      pendingRestoredOffset = activeOffset;
      engineSrc = t.streamUrl ? t.streamUrl : window.beehive.fileUrl(t.path);
      activeSource = null;
      activeStartedAt = 0;
      // No AudioContext is created or resumed here. Startup remains completely
      // silent and avoids decoding a potentially very large first track.
      dispatchAudio('loadedmetadata');
      dispatchAudio('durationchange');
      // The startup session is intentionally paused, so the normal animation
      // clock does not run yet. Paint the restored logical position explicitly
      // now; otherwise the range input can remain visually at its HTML default
      // (0:00) even though Play will correctly resume from activeOffset.
      updateSeekUI();
      dispatchAudio('timeupdate');
      updateNowPlayingUI(t);
      // updateNowPlayingUI is async; paint once more after it yields so the
      // restored scrubber remains authoritative even if other UI work touched it.
      requestAnimationFrame(() => {
        if (enginePaused && currentQueue[currentIndex] === t) updateSeekUI();
      });
      renderQueue();
    } catch (e) {
      enginePaused = true;
      engineEnded = true;
      dispatchAudio('pause');
      console.error('Beehive restore error:', e);
    }
  }

  // Change the player artwork without ever leaving the previous bitmap
  // visible while Chromium decodes the new source. Assigning img.src alone
  // does not clear the already-painted bitmap, so a large Sandbox image
  // could visibly lag behind the queue thumbnails by a frame or two. Hide the
  // old bitmap immediately, then reveal only after the new image has decoded.
  // A generation guard prevents an older decode from revealing stale artwork
  // after another track becomes current.
  function paintNowPlayingCoverImmediately(img, src, generation) {
    if (!img) return;
    const nextSrc = String(src || placeholderCover());
    img.style.opacity = '0';
    img.style.transition = 'none';
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      if (generation !== nowPlayingUiGeneration) return;
      if (img.src !== nextSrc) return;
      img.style.opacity = '1';
    };
    img.onload = async () => {
      try { if (typeof img.decode === 'function') await img.decode(); } catch {}
      reveal();
    };
    img.onerror = () => {
      // Never leave the player permanently hidden because a cover failed to
      // decode. The normal placeholder is safe and does not expose stale art.
      if (generation !== nowPlayingUiGeneration) return;
      img.src = placeholderCover();
      img.style.opacity = '1';
    };
    img.src = nextSrc;
    // A cached resource may already be complete when the handler is attached.
    if (img.complete && img.naturalWidth > 0) void Promise.resolve().then(reveal);
  }

  // Queue thumbnails are targets of the same current-track rotator as the
  // player and album surfaces. Never create a second timer for the queue.
  function retargetCurrentCoverRotationTargets(row = null) {
    const t = currentQueue[currentIndex];
    if (!t) return;
    const queueThumb = row?.querySelector?.('.q-thumb') || el.queueList?.querySelector(`.queue-row[data-idx="${currentIndex}"] .q-thumb`);
    if (queueThumb) nowPlayingRotator.retarget([queueThumb]);
  }

  // ---------------- Sandbox spectrum ----------------
  // Native GStreamer delivers new FFT data at 20 Hz. Render only when data
  // changes instead of running a perpetual 60 Hz canvas loop.
  let nowPlayingSpectrum = [];
  let nowPlayingSpectrumRaf = 0;
  let nowPlayingSpectrumVisible = false;
  let nowPlayingSpectrumResizeObserver = null;
  let nowPlayingSpectrumLayout = null;

  function drawNowPlayingSpectrum() {
    nowPlayingSpectrumRaf = 0;
    if (!nowPlayingSpectrumVisible) return;
    const canvas = document.getElementById('now-playing-spectrum');
    const wrap = document.querySelector('.now-playing-spectrum-wrap');
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      nowPlayingSpectrumLayout = null;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const count = Math.min(64, nowPlayingSpectrum.length || 64);
    if (!nowPlayingSpectrumLayout || nowPlayingSpectrumLayout.w !== w || nowPlayingSpectrumLayout.h !== h || nowPlayingSpectrumLayout.count !== count) {
      const gap = Math.max(1, Math.floor(dpr * 2));
      const barW = Math.max(1, (w - gap * (count - 1)) / count);
      nowPlayingSpectrumLayout = { w, h, count, gap, barW };
    }
    const layout = nowPlayingSpectrumLayout;
    const root = document.documentElement;
    const accent = getComputedStyle(root).getPropertyValue('--accent').trim() || '#aaa';
    const soft = getComputedStyle(root).getPropertyValue('--accent-soft').trim() || accent;
    if (!layout.gradient || layout.accent !== accent || layout.soft !== soft) {
      layout.gradient = ctx.createLinearGradient(0, h, 0, 0);
      layout.gradient.addColorStop(0, accent); layout.gradient.addColorStop(1, soft);
      layout.accent = accent; layout.soft = soft;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = layout.gradient;
    for (let i = 0; i < layout.count; i++) {
      const level = Math.max(0, Math.min(1, Number(nowPlayingSpectrum[i]) || 0));
      const eased = Math.pow(level, 0.72);
      const bh = Math.max(level > 0.015 ? 2 * dpr : 0, eased * h * 0.96);
      const x = i * (layout.barW + layout.gap);
      ctx.fillRect(x, h - bh, Math.max(1, layout.barW), bh);
    }
  }

  function scheduleNowPlayingSpectrumDraw() {
    if (!nowPlayingSpectrumVisible || nowPlayingSpectrumRaf) return;
    nowPlayingSpectrumRaf = requestAnimationFrame(drawNowPlayingSpectrum);
  }

  function stopNowPlayingSpectrum() {
    nowPlayingSpectrumVisible = false;
    if (nowPlayingSpectrumRaf) cancelAnimationFrame(nowPlayingSpectrumRaf);
    nowPlayingSpectrumRaf = 0;
    nowPlayingSpectrumResizeObserver?.disconnect();
    nowPlayingSpectrumResizeObserver = null;
    nowPlayingSpectrumLayout = null;
  }

  function startNowPlayingSpectrum() {
    nowPlayingSpectrumVisible = true;
    const canvas = document.getElementById('now-playing-spectrum');
    if (canvas && typeof ResizeObserver !== 'undefined') {
      nowPlayingSpectrumResizeObserver?.disconnect();
      nowPlayingSpectrumResizeObserver = new ResizeObserver(() => { nowPlayingSpectrumLayout = null; scheduleNowPlayingSpectrumDraw(); });
      nowPlayingSpectrumResizeObserver.observe(canvas);
    }
    scheduleNowPlayingSpectrumDraw();
  }

  async function updateNowPlayingUI(t) {
    const generation = ++nowPlayingUiGeneration;
    window.__beehiveNowPlayingTrack = t;
    pluginEmit('track-change', t || null);

    // Paint the identity of the new track synchronously. Everything below may
    // await disk/IPC work, but the visible player must never remain on the
    // previous song while that work is in flight. The old cover bitmap is hidden
    // immediately; the new one is revealed as soon as Chromium has decoded it.
    const visualCover = visualCoverForTrack(t);
    const cover = coverSrc(visualCover);
    // The queue thumbnail is deliberately independent of the large artwork decode.
    // Paint it immediately from the same small source used by queueRowHtml().
    const currentQueueRow = el.queueList?.querySelector(`.queue-row[data-idx="${currentIndex}"]`);
    const currentQueueThumb = currentQueueRow?.querySelector('.q-thumb');
    if (currentQueueThumb) {
      currentQueueThumb.style.opacity = '1';
      currentQueueThumb.style.transition = 'none';
      currentQueueThumb.src = cover;
    }
    paintNowPlayingCoverImmediately(el.pbCover, cover, generation);
    paintNowPlayingCoverImmediately(el.npCover, cover, generation);
    const transitionBackdrop = document.querySelector('.np-cover-stage');
    if (transitionBackdrop) transitionBackdrop.style.setProperty('--cover-backdrop', `url(\"${cover.replace(/\"/g, '\\\"')}\")`);

    el.pbCover.title = 'Double-click for cover art';
    el.pbCover.ondblclick = () => openCoverLightbox(t);
    el.pbCover.oncontextmenu = e => { e.preventDefault(); showCoverContextMenu(e, t.covers?.[0]?.file || t.cover, t); };
    el.pbTitle.textContent = t.title || 'Unknown title';
    el.pbArtist.textContent = t.artist || 'Unknown artist';

    el.npCover.title = 'Double-click for cover art';
    el.npCover.ondblclick = () => openCoverLightbox(t);
    el.npCover.oncontextmenu = e => { e.preventDefault(); showCoverContextMenu(e, t.covers?.[0]?.file || t.cover, t); };
    const visualizerArtist = document.getElementById('sandbox-visualizer-artist');
    const visualizerTitle = document.getElementById('sandbox-visualizer-title');
    const visualizerAlbum = document.getElementById('sandbox-visualizer-album');
    const visualizerArt = document.getElementById('sandbox-visualizer-art');
    if (visualizerArtist) visualizerArtist.textContent = t.artist || 'Unknown artist';
    if (visualizerTitle) visualizerTitle.textContent = t.title || 'Unknown title';
    if (visualizerAlbum) visualizerAlbum.textContent = t.album || '';
    if (visualizerArt && cover) {
      visualizerArt.src = cover;
      visualizerArt.alt = t.album ? `${t.album} artwork` : '';
    }
    // The large Sandbox area carries the full useful track metadata.
    // Keep the compact queue intentionally simple: title + artist only.
    el.npTitle.textContent = t.title || 'Unknown title';
    el.npArtist.textContent = t.artist || 'Unknown artist';
    el.npAlbum.textContent = t.album || 'Unknown album';
    const release = String(t.releaseDate || t.year || '').trim();
    el.npYear.textContent = release ? release.slice(0, 4) : '';
    const disc = t.disk != null && t.disk !== '' ? String(t.disk) : '';
    const trackNo = t.track != null && t.track !== '' ? String(t.track) : '';
    el.npTrack.textContent = (disc || trackNo) ? `Disc ${disc || '—'}  ·  Track ${trackNo || '—'}` : '';
    const ext = String(t.path || '').split('.').pop().toUpperCase();
    const formatLabel = ext || String(t.codec || '').toUpperCase();
    el.npFormat.textContent = formatLabel;
    el.npFormat.classList.toggle('hidden', !formatLabel);
    const codecLower = String(t.codec || ext || '').toLowerCase();
    const isFlac = codecLower === 'flac' || ext === 'FLAC';
    const bitDepthValue = Number(t.bitDepth);
    const sampleRateValue = Number(t.sampleRate);
    const flacLabel = isFlac && Number.isFinite(bitDepthValue) && bitDepthValue > 0 &&
      Number.isFinite(sampleRateValue) && sampleRateValue > 0
      ? `${bitDepthValue} bit · ${(sampleRateValue / 1000).toFixed(sampleRateValue % 1000 ? 1 : 0)} kHz`
      : '';
    const bitrateValue = Number(t.bitrate);
    const bitrateLabel = !isFlac && Number.isFinite(bitrateValue) && bitrateValue > 0
      ? (bitrateValue >= 1000000 ? `${(bitrateValue / 1000000).toFixed(1).replace(/\.0$/, '')} Mbps` : `${Math.round(bitrateValue / 1000)} kbps`)
      : '';
    if (el.npBitrate) {
      el.npBitrate.textContent = isFlac ? flacLabel : bitrateLabel;
      el.npBitrate.classList.toggle('hidden', !(isFlac ? flacLabel : bitrateLabel));
      el.npBitrate.classList.toggle('np-flac-specs', isFlac);
    }
    el.npCard.classList.remove('hidden');
    el.npTitle.oncontextmenu = e => { e.preventDefault(); showTrackContextMenu(e.clientX,e.clientY,t); };
    el.pbTitle.oncontextmenu = e => { e.preventDefault(); showTrackContextMenu(e.clientX,e.clientY,t); };

    // Paint the best currently-known Love state immediately. The authoritative
    // disk read below may correct it, but only if this update is still current.
    const initialLoved = !!t.loved;
    el.btnLove.innerHTML = (initialLoved ? ic.heartFilled : ic.heartOutline) || '';
    el.btnLove.classList.toggle('loved', initialLoved);
    el.btnLove.dataset.path = t.path || '';

    // The expanded album viewer is shared UI state. Update its playing marker
    // in place so playback changes never close/rebuild the open album panel.
    refreshInlineTrackPlayingState();

    // Now that the new track is visibly painted, verify the authoritative Love
    // state without allowing a slow read to hold up the rest of the Sandbox UI.
    if (t?.path) {
      try {
        // A Love toggle writes the embedded tag in the background
        // (queueLoveFileWrite/loveWriteQueue) after optimistically updating
        // t.loved. If this same track reloads before that write lands --
        // most commonly repeat-one restarting the track that was just loved
        // -- a disk read here would race the pending write and read the
        // stale pre-write value, stomping the optimistic heart back off.
        // Wait for any in-flight write on this exact path first so the read
        // is actually authoritative instead of stale.
        const pendingLoveWrite = loveWriteQueue.get(t.path);
        if (pendingLoveWrite) { try { await pendingLoveWrite; } catch {} }
        if (generation !== nowPlayingUiGeneration || currentQueue[currentIndex] !== t) return;
        const actualLoved = !!(await window.beehive.readLove(t.path));
        if (generation !== nowPlayingUiGeneration || currentQueue[currentIndex] !== t) return;
        syncLoveStateForPath(t.path, actualLoved);
        t.loved = actualLoved;
        const libTrack = libraryTrackByPath.get(String(t.path || ''));
        if (libTrack) libTrack.loved = actualLoved;
      } catch {}
    }
    if (generation !== nowPlayingUiGeneration || currentQueue[currentIndex] !== t) return;

    // Playback must update the dynamic accent too. Album single-clicks already
    // do this when opening their inline panel, but double-click playback goes
    // straight through playQueue(), so the playing album needs to refresh the
    // palette here as the single source of truth.
    const paletteCover = visualCoverForTrack(t);
    if (paletteCover) applyPaletteFromCover(coverSrc(paletteCover));

    const coverBackdrop = document.querySelector('.np-cover-stage');
    if (coverBackdrop) coverBackdrop.style.setProperty('--cover-backdrop', `url(\"${coverSrc(paletteCover || visualCover).replace(/\"/g, '\\\"')}\")`);

    // Never overwrite embedded lyrics -- see refreshTrackLyricsForDisplay's
    // own doc comment for why an online lookup still runs for display when
    // the track already has embedded (always-plain) lyrics.
    const embeddedLyrics = String(t.lyrics || '').trim();
    const trackAlign = String(t.customTags?.LYRICS_ALIGNMENT || localStorage.getItem('beehive:lyrics-alignment') || 'center').toLowerCase();
    applyLyricsAlignment(trackAlign);
    renderLyrics(embeddedLyrics, t);
    if (el.lyricsRail) {
      el.lyricsRail.onscroll = handleLyricsScroll;
      el.lyricsRail.oncontextmenu = e => { e.preventDefault(); showLyricsContextMenu(e, t); };
    }
    refreshTrackLyricsForDisplay(t);

    refreshCoverRotationTargets();
    retargetCurrentCoverRotationTargets();

    // Do not rely on a particular GStreamer state transition to kick off the
    // temporary-artwork fallback. Playback startup can legitimately reach
    // updateNowPlayingUI before the PLAYING notification is observed by this
    // renderer. Starting the same guarded lookup here makes the rule
    // deterministic: the actual file is checked first, and only a genuinely
    // coverless current track is searched. The lookup is intentionally
    // fire-and-forget so it can never delay playback/UI startup.
    if (currentQueue[currentIndex] === t && !embeddedCoverExists(t)) {
      void ensureAutomaticCoverVisual(t);
    }
  }

  // ---------------- rotating cover art ----------------
  // A track/album can carry multiple embedded images (front + back, etc.).
  // Cover changes are intentionally prepared ahead of time: changing the
  // source of the large Sandbox image can otherwise force Chromium to
  // decode a new frame on the UI thread exactly when Discord is rendering a
  // video stream. Pre-decode the next covers and switch instantly rather than
  // doing a 420ms opacity animation over a large image.
  function createCoverRotator() {
    let timer = null;
    let items = [];
    let idx = 0;
    let imgs = [];
    let generation = 0;
    const decoded = new Map(); // source -> decoded Image

    function sourceFor(item) {
      return item && item.file ? coverSrc(item.file) : placeholderCover();
    }

    function preload(src, token) {
      if (!src) return Promise.resolve(null);
      const existing = decoded.get(src);
      if (existing) return Promise.resolve(existing);
      const img = new Image();
      img.decoding = 'async';
      const promise = new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          if (value) decoded.set(src, img);
          resolve(value ? img : null);
        };
        img.onload = async () => {
          try { if (typeof img.decode === 'function') await img.decode(); } catch {}
          finish(true);
        };
        img.onerror = () => finish(false);
      });
      img.src = src;
      img.__beehiveDecodePromise = promise;
      return promise;
    }

    function apply() {
      const item = items[idx];
      const src = sourceFor(item);
      imgs.forEach(img => {
        if (!img || !img.isConnected) return;
        img.style.transition = 'none';
        img.style.opacity = '1';
        img.src = src;
      });
      if (items.length > 1) preload(sourceFor(items[(idx + 1) % items.length]), generation);
    }

    function stop() {
      clearInterval(timer);
      timer = null;
      generation++;
      imgs = [];
      items = [];
      idx = 0;
    }

    async function start(coverItems, imgEls) {
      // A single rotator owns the artwork index and timer for every synchronized
      // surface. This prevents the player, queue, album card and expanded album
      // from drifting apart by even one 4-second tick.
      const nextItems = (coverItems && coverItems.length) ? coverItems.slice() : [{ file: null }];
      const nextImgs = Array.from(new Set((imgEls || []).filter(Boolean)));
      clearInterval(timer);
      timer = null;
      generation++;
      const token = generation;
      items = nextItems;
      imgs = nextImgs;
      idx = 0;
      await preload(sourceFor(items[0]), token);
      if (token !== generation) return;
      apply();
      if (items.length > 1) {
        timer = setInterval(async () => {
          const nextIndex = (idx + 1) % items.length;
          await preload(sourceFor(items[nextIndex]), token);
          if (token !== generation) return;
          idx = nextIndex;
          apply();
        }, 4000);
      }
    }

    function retarget(imgEls) {
      const additions = (imgEls || []).filter(Boolean).filter(img => {
        if (!img || img.dataset?.beehiveRotatorAttached === '1') return false;
        if (img.dataset) img.dataset.beehiveRotatorAttached = '1';
        return true;
      });
      if (!additions.length) return;
      imgs = Array.from(new Set([...(imgs || []), ...additions]));
      if (!items.length) return;
      const src = sourceFor(items[idx]);
      additions.forEach(img => {
        if (!img || !img.isConnected) return;
        img.style.transition = 'none';
        img.style.opacity = '1';
        if (img.src !== src) img.src = src;
      });
    }

    return { start, stop, retarget };
  }

  const nowPlayingRotator = createCoverRotator();

  // Re-collects which on-screen <img> elements should be showing/rotating
  // the current track's cover(s): playbar, now-playing card, its grid card
  // (if rendered), and the album panel (if it's open on this same album).
  function refreshCoverRotationTargets() {
    const t = currentQueue[currentIndex];
    if (!t) { nowPlayingRotator.stop(); return; }

    const items = distinctCovers(t);
    artworkDebug('refreshing synchronized current-track cover rotation targets', {
      path: t?.path || '', queueIndex: currentIndex, embeddedCoverCount: items.length
    });
    if (items.length) clearAutomaticCoverVisual(t);
    if (!items.length) {
      const temporary = automaticCoverVisuals.get(String(t.path || ''));
      if (temporary) items.push({ file: temporary, type: 'Automatic visual artwork' });
    }

    const targets = [el.pbCover, el.npCover];
    // The active queue row and currently-playing album card/panel are added to
    // this same rotator. They therefore share the exact same index and 4-second
    // clock instead of each running an independent rotation.
    const queueThumb = el.queueList?.querySelector(`.queue-row[data-idx="${currentIndex}"] .q-thumb`);
    if (queueThumb) targets.push(queueThumb);
    const playingAlbum = albumKey(t);
    if (playingAlbum) {
      document.querySelectorAll('.album-card').forEach(card => {
        if (String(card.dataset.key || '') !== String(playingAlbum)) return;
        const img = card.querySelector('.art-wrap img');
        if (img) targets.push(img);
      });
      document.querySelectorAll('.inline-album-dropdown').forEach(panel => {
        if (String(panel.dataset.albumKey || '') !== String(playingAlbum)) return;
        const img = panel.querySelector('.inline-album-cover img');
        if (img) targets.push(img);
      });
    }
    nowPlayingRotator.start(items, targets);
  }

  let hiveLogoSourceDataUrl = '';
  let hiveLogoImage = null;
  let hiveLogoTintRequest = 0;

  function setHiveLogoTone(palette) {
    const root = document.documentElement.style;
    const tone = String(palette?.logoTone || 'color');
    if (tone === 'dark') {
      root.setProperty('--hive-logo-grayscale', '1');
      root.setProperty('--hive-logo-brightness', '0.72');
      root.setProperty('--hive-logo-saturation', '0');
      root.setProperty('--hive-logo-hue-rotate', '0deg');
      return;
    }
    if (tone === 'light') {
      root.setProperty('--hive-logo-grayscale', '1');
      root.setProperty('--hive-logo-brightness', '1.75');
      root.setProperty('--hive-logo-saturation', '0');
      root.setProperty('--hive-logo-hue-rotate', '0deg');
      return;
    }
    // The Hive brand mark follows the currently playing track's accent color,
    // matching every other frosted-glass surface in the app. Recoloring is
    // done pixel-by-pixel in applyHiveLogoAccent() (preserving the glass
    // highlights/alpha), so the CSS filter itself must not grayscale the
    // result back out.
    root.setProperty('--hive-logo-grayscale', '0');
    root.setProperty('--hive-logo-brightness', '1');
    root.setProperty('--hive-logo-saturation', '1');
    root.setProperty('--hive-logo-hue-rotate', '0deg');
    applyHiveLogoAccent(palette?.accent);
  }

  function accentRgbFromColor(color) {
    const raw = String(color || '');
    const rgb = raw.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map(v => Math.max(0, Math.min(255, v)));
    const hsl = raw.match(/hsla?\(\s*([\d.]+)[,\s]+([\d.]+)%?[,\s]+([\d.]+)%?/i);
    if (!hsl) return null;
    let h = ((Number(hsl[1]) % 360) + 360) % 360;
    const s = Math.max(0, Math.min(100, Number(hsl[2]))) / 100;
    const l = Math.max(0, Math.min(100, Number(hsl[3]))) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let rp = 0, gp = 0, bp = 0;
    if (h < 60) [rp, gp, bp] = [c, x, 0];
    else if (h < 120) [rp, gp, bp] = [x, c, 0];
    else if (h < 180) [rp, gp, bp] = [0, c, x];
    else if (h < 240) [rp, gp, bp] = [0, x, c];
    else if (h < 300) [rp, gp, bp] = [x, 0, c];
    else [rp, gp, bp] = [c, 0, x];
    return [(rp + m) * 255, (gp + m) * 255, (bp + m) * 255];
  }

  function applyHiveLogoAccent(color) {
    if (!hiveLogoImage || !color) return;
    const target = accentRgbFromColor(color);
    if (!target) return;
    const requestId = ++hiveLogoTintRequest;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(hiveLogoImage, 0, 0, size, size);
    const image = ctx.getImageData(0, 0, size, size);
    const data = image.data;
    // The source logo is a blue glass render. Recolor its luminance while
    // retaining its alpha and internal highlights, so the glass character is
    // preserved while its actual RGB follows the current UI accent.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      const intensity = Math.max(0.18, Math.min(1.15, lum / 0.42));
      data[i] = Math.min(255, target[0] * intensity);
      data[i + 1] = Math.min(255, target[1] * intensity);
      data[i + 2] = Math.min(255, target[2] * intensity);
    }
    ctx.putImageData(image, 0, 0);
    if (requestId !== hiveLogoTintRequest) return;
    const tinted = canvas.toDataURL('image/png');
    document.querySelectorAll('.brand-logo, .about-brand-logo').forEach(elm => { elm.src = tinted; });
  }

  function setHiveLogoHueFromColor(color, fallbackHue = 286) {
    const raw = String(color || '');
    let r = null, g = null, b = null;
    const rgb = raw.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    const hsl = raw.match(/hsla?\(\s*([\d.]+)/i);
    if (rgb) {
      r = Math.max(0, Math.min(255, Number(rgb[1])));
      g = Math.max(0, Math.min(255, Number(rgb[2])));
      b = Math.max(0, Math.min(255, Number(rgb[3])));
    }
    let hue = hsl ? Number(hsl[1]) : NaN;
    if (!Number.isFinite(hue) && r != null) {
      const rr=r/255, gg=g/255, bb=b/255, max=Math.max(rr,gg,bb), min=Math.min(rr,gg,bb), d=max-min;
      if (d > 0) {
        if (max === rr) hue = 60 * (((gg-bb)/d) % 6);
        else if (max === gg) hue = 60 * (((bb-rr)/d) + 2);
        else hue = 60 * (((rr-gg)/d) + 4);
        if (hue < 0) hue += 360;
      }
    }
    if (!Number.isFinite(hue)) hue = fallbackHue;
    document.documentElement.style.setProperty('--hive-logo-hue', `${hue}deg`);
  }
  function resetPaletteToNeutral() {
    const root = document.documentElement.style;
    root.setProperty('--hive-logo-hue', '0deg');
    setHiveLogoTone({ logoTone: 'dark' });
    root.setProperty('--accent', 'hsla(220, 6%, 62%, 1)');
    root.setProperty('--accent-soft', 'hsla(220, 6%, 72%, 0.38)');
    root.setProperty('--accent-glow', 'hsla(220, 6%, 55%, 0.28)');
    root.setProperty('--ambient-a', 'hsla(220, 5%, 28%, 0.22)');
    root.setProperty('--ambient-b', 'hsla(220, 5%, 22%, 0.18)');
  }

  const paletteCache = new Map();
  let paletteRequestId = 0;

  // Yearly Wrap opens as its own BrowserWindow/process, so it cannot read
  // this window's --accent CSS var directly. Convert to "r,g,b" and hand it
  // over via IPC, both at open time and whenever the accent changes again
  // afterward, so an already-open Wrap window follows the current track too.
  function pushYearlyWrapTheme(palette) {
    if (!window.beehive?.pushYearlyWrapTheme) return;
    const accent = accentRgbFromColor(palette?.accent);
    if (!accent) return;
    const glow = accentRgbFromColor(palette?.accentGlow) || accent;
    const rgbStr = v => v.map(n => Math.round(n)).join(',');
    window.beehive.pushYearlyWrapTheme({ accent: rgbStr(accent), accent2: rgbStr(glow) }).catch(() => {});
  }

  function applyPaletteFromCover(src) {
    if (!src) return;
    const isLightTheme = document.documentElement.dataset.hiveTheme === 'light';
    const cacheKey = `${src}|${isLightTheme ? 'light' : 'dark'}`;
    const cached = paletteCache.get(cacheKey);
    const root = document.documentElement.style;
    if (cached) {
      root.setProperty('--accent', cached.accent);
      setHiveLogoHueFromColor(cached.accent);
      setHiveLogoTone(cached);
      root.setProperty('--accent-soft', cached.accentSoft);
      root.setProperty('--accent-glow', cached.accentGlow);
      root.setProperty('--ambient-a', cached.ambientA);
      root.setProperty('--ambient-b', cached.ambientB);
      pushYearlyWrapTheme(cached);
      return;
    }
    const requestId = ++paletteRequestId;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      const palette = await window.BeehiveColor.extractPaletteFromImage(img, { light: isLightTheme });
      paletteCache.set(cacheKey, palette);
      if (requestId !== paletteRequestId) return;
      const root = document.documentElement.style;
      root.setProperty('--accent', palette.accent);
      setHiveLogoHueFromColor(palette.accent);
      setHiveLogoTone(palette);
      root.setProperty('--accent-soft', palette.accentSoft);
      root.setProperty('--accent-glow', palette.accentGlow);
      root.setProperty('--ambient-a', palette.ambientA);
      root.setProperty('--ambient-b', palette.ambientB);
      pushYearlyWrapTheme(palette);
    };
    img.onerror = () => {};
    img.src = src;
  }

  // ---------------- icons (SVG, no emoji) ----------------
  const ic = window.BeehiveIcons || {};
  el.btnPrev.innerHTML = ic.prev || '';
  el.btnNext.innerHTML = ic.next || '';
  el.btnPlay.innerHTML = ic.play || '';
  el.btnLove.innerHTML = ic.heartOutline || '';
  let lastLocalShuffleChangeAt = 0;
  let lastLocalShuffleValue = false;
  function renderShuffleButton() {
    const enabled = !!shuffle;
    el.btnShuffle.innerHTML = (enabled ? ic.shuffle : ic.shuffleOff) || ic.shuffle || '';
    el.btnShuffle.title = enabled ? 'Shuffle on' : 'Shuffle off';
    el.btnShuffle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    el.btnShuffle.dataset.mode = enabled ? 'on' : 'off';
    el.btnShuffle.classList.toggle('active', enabled);
  }
  renderShuffleButton();
  function renderRepeatButton() {
    const keys = ['repeatOff', 'repeatAll', 'repeatOne'];
    const titles = ['Play through and stop', 'Repeat queue', 'Repeat single song'];
    const key = keys[repeat] || keys[0];
    el.btnRepeat.innerHTML = ic[key] || ic.repeatAll || '';
    el.btnRepeat.title = titles[repeat] || titles[0];
    el.btnRepeat.classList.toggle('active', repeat !== 0);
    el.btnRepeat.dataset.mode = String(repeat);
  }
  renderRepeatButton();

  function renderVolumeIcon() {
    const v = Number(el.pbVolume.value);
    let key = 'volHigh';
    if (v === 0 || audio.muted) key = 'volMute';
    else if (v < 45) key = 'volLow';
    el.pbVolIcon.innerHTML = ic[key] || '';
  }

  window.beehive.onMprisCommand?.((command) => {
    const raw = String(command || '');
    const [op, ...rest] = raw.split('\t');
    if (op === 'PLAY') { audioEngine.play(true); return; }
    if (op === 'PAUSE') { audioEngine.pause(); return; }
    if (op === 'PLAYPAUSE') { if (audioEngine.paused) audioEngine.play(true); else audioEngine.pause(); return; }
    if (op === 'STOP') { audioEngine.pause(); return; }
    if (op === 'NEXT') { goNext(); return; }
    if (op === 'PREVIOUS') { goPrev(); return; }
    if (op === 'SEEK') { audioEngine.currentTime = Number(rest[0]) || 0; return; }
    if (op === 'SEEKREL') { audioEngine.currentTime = Math.max(0, Number(audioEngine.currentTime) + (Number(rest[0]) || 0)); return; }
    if (op === 'VOLUME') { audioEngine.volume = Number(rest[0]); renderVolumeSliderFromEngine(audioEngine.volume); saveLastPlayback(); return; }
    if (op === 'SHUFFLE') {
      const wanted = rest[0] === 'true';
      // Some MPRIS clients can write their cached Shuffle value back immediately
      // after Hive changes it locally. Ignore that stale inverse for a short
      // window so the first click cannot appear to do nothing. A real later
      // external command still works normally.
      if (Date.now() - lastLocalShuffleChangeAt < 750 && wanted !== lastLocalShuffleValue) return;
      if (wanted !== shuffle) el.btnShuffle.click();
      return;
    }
    if (op === 'REPEAT') {
      const wanted = Math.max(0, Math.min(2, Number(rest[0]) || 0));
      while (repeat !== wanted) el.btnRepeat.click();
      return;
    }
  });

  // ---------------- transport controls ----------------
  el.btnPlay.addEventListener('click', () => {
    // If playback has not been started yet, the Play button starts the
    // existing queue instead of doing nothing. Do not rebuild or reshuffle
    // the queue here; play it in its current order from the current queue
    // position, or from the first item when no position exists yet.
    if (!audio.src) {
      if (!currentQueue.length) return;
      if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= currentQueue.length) {
        currentIndex = 0;
      }
      selectedQueueIndex = currentIndex;
      selectedQueueIndices.clear();
      selectedQueueIndices.add(currentIndex);
      activeSelectionScope = 'queue';
      renderQueue();
      startupPlaybackLocked = false;
      requestLoadAndPlayCurrent();
      return;
    }
    if (audio.paused) audio.play(true); else audio.pause();
  });
  audio.addEventListener('play', () => { el.btnPlay.innerHTML = ic.pause || ''; });
  audio.addEventListener('pause', () => { el.btnPlay.innerHTML = ic.play || ''; });

  el.btnNext.addEventListener('click', () => goNext());
  el.btnPrev.addEventListener('click', () => goPrev());

  function stopPodcastTransport() {
    if (!podcastActive) return;
    try { audioElement.pause(); audioElement.removeAttribute('src'); audioElement.load(); } catch {}
    podcastActive = false;
    engineEnded = false;
    if (activePlaybackProvider === 'podcast') setActivePlaybackProvider('none');
  }

  function goNext() {
    if (!currentQueue.length) return;
    // An explicit user skip is an intentional recovery boundary after a native
    // audio-path fault. Keep the fail-silent latch for the faulting track, but
    // allow the next requested track to perform a fresh GStreamer READY/LOAD
    // handshake. This never falls back to a second local decoder.
    if (gstFatalError) {
      gstFatalError = false;
      gstAvailabilityKnown = false;
      gstAvailable = false;
      gstAvailabilityPromise = null;
    }
    finishPlayCountSession({ countIfQualified: true });
    const current = currentQueue[currentIndex];
    if (current) playbackHistory.push(current);
    // A queue transition out of a podcast is a transport handoff, not an
    // additional playback source. Stop the HTML media element before the next
    // local/Spotify track is allowed to start.
    stopPodcastTransport();

    if (repeat === 2) {
      audio.currentTime = 0;
      requestLoadAndPlayCurrent();
      return;
    }
    clearAutomaticCoverVisual(current);
    const nextIndex = getNextPlaybackIndex();
    if (nextIndex < 0) {
      audio.pause();
      renderQueue();
      return;
    }
    currentIndex = nextIndex;
    activeOffset = 0;
    activeDuration = 0;
    pendingRestoredOffset = null;
    requestLoadAndPlayCurrent(true);
  }
  function goPrev() {
    if (!currentQueue.length) return;
    // Previous is another explicit user-directed recovery boundary after a
    // native audio fault; the newly selected track still must pass the native
    // GStreamer startup gate before any audio is opened.
    if (gstFatalError) {
      gstFatalError = false;
      gstAvailabilityKnown = false;
      gstAvailable = false;
      gstAvailabilityPromise = null;
    }
    finishPlayCountSession({ countIfQualified: true });
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }

    // Previous follows actual playback history, never the shuffled queue order.
    // This makes Back behave like a music player's listening history.
    while (playbackHistory.length) {
      const previous = playbackHistory.pop();
      const previousIndex = currentQueue.indexOf(previous);
      if (previousIndex >= 0) {
        currentIndex = previousIndex;
        activeOffset = 0;
        activeDuration = 0;
        pendingRestoredOffset = null;
        requestLoadAndPlayCurrent(true);
        return;
      }
    }

    // Non-shuffle queues retain their normal sequential Previous behavior.
    if (!shuffle) {
      currentIndex = Math.max(0, currentIndex - 1);
      activeOffset = 0;
      activeDuration = 0;
      pendingRestoredOffset = null;
      requestLoadAndPlayCurrent(true);
    }
  }

  audio.addEventListener('ended', () => { if (engineEnded && scheduledNextIndex < 0) goNext(); });

  // Seek bar: own the pointer gesture ourselves, like Strawberry's TrackSlider.
  // The browser's native range dragging is deliberately NOT allowed to compete
  // with us.  While the mouse is down, the thumb follows the mouse only.  When
  // the mouse is released, we seek the Web Audio engine exactly once to the
  // position where the thumb ended.  This prevents the audio clock from
  // fighting the user's hand during a drag.
  let isScrubbing = false;
  let scrubPointerId = null;
  let scrubWasPlaying = false;

  function updateSeekUI() {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const duration = audio.duration;
    const shown = isScrubbing ? Number(el.pbSeek.value) : audio.currentTime;
    const safe = Math.max(0, Math.min(duration, Number(shown) || 0));
    const progress = duration > 0 ? (safe / duration) * 100 : 0;
    el.pbSeek.style.setProperty('--seek-progress', `${progress}%`);
    el.pbSeek.max = String(duration);
    if (!isScrubbing) el.pbSeek.value = String(safe);
    el.pbSeek.setAttribute('aria-valuemax', String(duration));
    el.pbSeek.setAttribute('aria-valuenow', String(safe));
    el.pbElapsed.textContent = fmtTime(safe);
    el.pbDuration.textContent = fmtTime(duration);
  }

  // Web Audio does not emit HTMLMediaElement-style `timeupdate` events while
  // a BufferSource is playing.  The transport clock is continuous, so the
  // scrubber must sample that clock continuously as well.  Keep this as a UI
  // animation loop rather than manufacturing `timeupdate` events, because the
  // existing timeupdate handler also saves playback state and should not run
  // 60 times per second.  While the user is dragging, updateSeekUI deliberately
  // leaves the thumb under the user's control.
  let seekUiRaf = 0;
  let seekUiNextPaintAt = 0;
  function runSeekUiClock(now = performance.now()) {
    seekUiRaf = 0;
    // Both transports use a lightweight UI clock while actually playing.
    // GStreamer reports authoritative positions every 100 ms; its currentTime
    // getter interpolates between those reports so the scrubber does not visibly
    // crawl in 100 ms steps after a user seek. Keep the repaint rate capped at
    // about 30 FPS and never run it while paused/idle to avoid unnecessary CPU.
    if (isScrubbing || audio.paused) return;
    if (now >= seekUiNextPaintAt) {
      updateSeekUI();
      updateSyncedLyrics(audio.currentTime, false);
      seekUiNextPaintAt = now + 33;
    }
    seekUiRaf = requestAnimationFrame(runSeekUiClock);
  }
  function startSeekUiClock() {
    if (audio.paused || seekUiRaf) return;
    seekUiNextPaintAt = 0;
    seekUiRaf = requestAnimationFrame(runSeekUiClock);
  }
  function stopSeekUiClock() {
    if (seekUiRaf) cancelAnimationFrame(seekUiRaf);
    seekUiRaf = 0;
  }
  audio.addEventListener('play', startSeekUiClock);
  audio.addEventListener('pause', stopSeekUiClock);

  audio.addEventListener('loadedmetadata', updateSeekUI);
  audio.addEventListener('durationchange', updateSeekUI);
  audio.addEventListener('timeupdate', () => {
    if (!isScrubbing) updateSeekUI();
    updateSyncedLyrics(audio.currentTime, false);
    const t = currentQueue[currentIndex];
    if (!t || !t.path) return;
    saveLastPlayback();
    void scrobbleProgress(t, audio.currentTime, audio.duration);
  });

  function saveLastPlayback() { savePlaybackSession(false); }

  function restoreLastPlayback() {
    return restoreSavedQueue();
  }
  // Shutdown must write the FULL queue snapshot (paths/version), not just the
  // throttled transport-only merge. savePlaybackSession() alone only patches
  // position/currentIndex/currentPath into whatever `paths` already happen to
  // be on disk from the last explicit queue mutation -- if the queue hadn't
  // mutated recently before close, that leaves a stale or (on a fresh profile)
  // entirely absent `paths` array for the next launch to restore from.
  window.addEventListener('beforeunload', () => { saveQueueSession(); savePlaybackSession(true); void wrapFinishListening(); });
  window.addEventListener('pagehide', () => { saveQueueSession(); savePlaybackSession(true); });
  setInterval(saveLastPlayback, 500);

  function scrubValueFromPointer(e) {
    const duration = Number(audio.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const rect = el.pbSeek.getBoundingClientRect();
    if (!rect.width) return null;

    // Match the visual thumb's center to the mouse position. Keeping the half
    // thumb inset makes the first/last positions line up with the actual dot.
    const thumbHalf = 6;
    const usable = Math.max(1, rect.width - thumbHalf * 2);
    const x = Math.max(thumbHalf, Math.min(rect.width - thumbHalf, e.clientX - rect.left));
    const ratio = (x - thumbHalf) / usable;
    return Math.max(0, Math.min(duration, ratio * duration));
  }

  function setScrubValueFromPointer(e) {
    const next = scrubValueFromPointer(e);
    if (next == null) return;
    el.pbSeek.value = String(next);
    el.pbSeek.setAttribute('aria-valuenow', String(next));
    el.pbElapsed.textContent = fmtTime(next);
    el.pbSeek.style.setProperty('--seek-progress', `${(next / audio.duration) * 100}%`);
  }

  function finishScrub(cancelled = false) {
    if (!isScrubbing) return;
    const finalValue = Number(el.pbSeek.value);
    const pointerId = scrubPointerId;
    isScrubbing = false;
    if (activePlaybackProvider === 'spotify') spotifySeekUserInteracting = false;
    scrubPointerId = null;

    if (!cancelled && Number.isFinite(audio.duration) && audio.duration > 0 && Number.isFinite(finalValue)) {
      // One and only one transport seek: the position where the user's mouse
      // actually left the scrubber.
      try { seekEngine(Math.max(0, Math.min(audio.duration, finalValue)), scrubWasPlaying); } catch {}
    }

    if (pointerId != null) {
      try { el.pbSeek.releasePointerCapture(pointerId); } catch {}
    }
    scrubWasPlaying = false;
    updateSeekUI();
    // If playback is still active, immediately hand the scrubber back to the
    // transport clock. This is important after a seek because the visual thumb
    // must never remain in the temporary user-drag state.
    if (!audio.paused) startSeekUiClock();
    saveLastPlayback();
  }

  // Chromium can occasionally deliver the native range pointer release outside
  // the control after a click/seek. Keep a window-level fallback so a completed
  // click can never leave isScrubbing=true and freeze the visual thumb at the
  // last user-selected position.
  window.addEventListener('pointerup', (e) => {
    if (!isScrubbing) return;
    if (scrubPointerId != null && e.pointerId !== scrubPointerId) return;
    finishScrub(false);
  });
  window.addEventListener('pointercancel', (e) => {
    if (!isScrubbing) return;
    if (scrubPointerId != null && e.pointerId !== scrubPointerId) return;
    finishScrub(true);
  });
  window.addEventListener('blur', () => {
    if (isScrubbing) finishScrub(false);
  });

  el.pbSeek.addEventListener('pointerdown', (e) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    e.preventDefault();
    isScrubbing = true;
    if (activePlaybackProvider === 'spotify') spotifySeekUserInteracting = true;
    scrubPointerId = e.pointerId;
    scrubWasPlaying = !audio.paused;
    try { el.pbSeek.setPointerCapture(e.pointerId); } catch {}
    // Clicking anywhere on the bar puts the dot directly under the mouse;
    // starting from the old thumb position is never necessary.
    setScrubValueFromPointer(e);
  });

  el.pbSeek.addEventListener('pointermove', (e) => {
    if (!isScrubbing || scrubPointerId !== e.pointerId) return;
    e.preventDefault();
    setScrubValueFromPointer(e);
  });

  el.pbSeek.addEventListener('pointerup', (e) => {
    if (!isScrubbing || scrubPointerId !== e.pointerId) return;
    e.preventDefault();
    setScrubValueFromPointer(e);
    finishScrub(false);
  });

  el.pbSeek.addEventListener('pointercancel', () => finishScrub(true));
  el.pbSeek.addEventListener('lostpointercapture', () => {
    // pointerup normally finishes first. If the browser takes the capture away,
    // commit the last position rather than snapping the dot back.
    if (isScrubbing) finishScrub(false);
  });

  // Final click fallback: a simple range click must never leave the temporary
  // scrub state active if Chromium fails to deliver pointerup to either target.
  el.pbSeek.addEventListener('click', () => {
    diagnosticMark('SCRUBBER CLICK', { value: Number(el.pbSeek.value) || 0, scrubbing: isScrubbing });
    if (isScrubbing) finishScrub(false);
  });

  // Keyboard changes are not pointer drags, so they commit immediately.
  el.pbSeek.addEventListener('input', () => {
    if (isScrubbing) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const next = Math.max(0, Math.min(audio.duration, Number(el.pbSeek.value) || 0));
    el.pbSeek.setAttribute('aria-valuenow', String(next));
    el.pbElapsed.textContent = fmtTime(next);
    el.pbSeek.style.setProperty('--seek-progress', `${(next / audio.duration) * 100}%`);
    try { audio.currentTime = next; } catch {}
  });

  el.pbSeek.addEventListener('change', () => {
    diagnosticMark('SCRUBBER COMMIT', { value: Number(el.pbSeek.value) || 0 });
    if (isScrubbing) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const next = Math.max(0, Math.min(audio.duration, Number(el.pbSeek.value) || 0));
    try { audio.currentTime = next; } catch {}
    updateSeekUI();
    saveLastPlayback();
  });

  // Build 253: ordinary volume remains a linear 0-100 UI mapped to canonical 0-1
  // engine volume. Local slider input is written immediately to Hive's dedicated
  // GStreamer volume element; ReplayGain and transport remain separate paths.
  el.pbVolume.addEventListener('pointerdown', (e) => {
    try { el.pbVolume.setPointerCapture(e.pointerId); } catch {}
    if (activePlaybackProvider === 'spotify') spotifyVolumeUserInteracting = true;
  });
  const finishVolumePointer = () => {
    if (activePlaybackProvider === 'spotify') {
      spotifyVolumeUserInteracting = false;
      spotifyVolumeInteractionUntil = Date.now() + 900;
    }
    flushVolumePersistence();
  };
  el.pbVolume.addEventListener('pointerup', finishVolumePointer);
  el.pbVolume.addEventListener('pointercancel', finishVolumePointer);
  window.addEventListener('pointerup', () => {
    if (spotifyVolumeUserInteracting) {
      spotifyVolumeUserInteracting = false;
      spotifyVolumeInteractionUntil = Date.now() + 900;
    }
  });
  window.addEventListener('blur', () => {
    if (spotifyVolumeUserInteracting) {
      spotifyVolumeUserInteracting = false;
      spotifyVolumeInteractionUntil = Date.now() + 900;
    }
    flushVolumePersistence();
  });
  el.pbVolume.addEventListener('input', () => {
    const value = Math.max(0, Math.min(1, (Number(el.pbVolume.value) || 0) / 100));
    diagnosticMark('VOLUME INPUT', { value: Number(el.pbVolume.value) || 0, provider: activePlaybackProvider, gstActive });
    if (activePlaybackProvider === 'spotify' && !spotifyVolumeUserInteracting) spotifyVolumeInteractionUntil = Date.now() + 900;
    audioEngine.volume = value;
    el.pbVolume.style.setProperty('--volume-progress', `${Math.max(0, Math.min(100, Number(el.pbVolume.value) || 0))}%`);
    renderVolumeIcon();
    scheduleVolumePersistence();
  });

  // Allow the mouse wheel to adjust volume while hovering the volume slider.
  // Scroll up increases volume; scroll down decreases it. Keep the page from
  // scrolling while the pointer is over the control.
  el.pbVolume.addEventListener('wheel', (e) => {
    e.preventDefault();
    const current = Number(el.pbVolume.value) || 0;
    const direction = e.deltaY < 0 ? 1 : -1;
    const next = Math.max(0, Math.min(100, current + (direction * 5)));
    if (next === current) return;
    el.pbVolume.value = String(next);
    el.pbVolume.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
  el.pbVolume.style.setProperty('--volume-progress', `${Math.max(0, Math.min(100, Number(el.pbVolume.value) || 0))}%`);
  audio.volume = audioEngine.volume;

  let volBeforeMute = Number(el.pbVolume.value) || 80;
  el.pbVolIcon.addEventListener('click', () => {
    if (!audio.muted && Number(el.pbVolume.value) > 0) {
      volBeforeMute = Number(el.pbVolume.value);
      audio.muted = true;
      el.pbVolume.value = '0';
    } else {
      audio.muted = false;
      el.pbVolume.value = String(volBeforeMute || 80);
      audio.volume = audioEngine.volume;
    }
    el.pbVolume.style.setProperty('--volume-progress', `${Math.max(0, Math.min(100, Number(el.pbVolume.value) || 0))}%`);
    renderVolumeIcon();
    saveLastPlayback();
  });
  el.pbVolume.style.setProperty('--volume-progress', `${Math.max(0, Math.min(100, Number(el.pbVolume.value) || 0))}%`);
  renderVolumeIcon();

  el.btnShuffle.addEventListener('click', () => {
    const wasShuffle = shuffle;
    const currentPath = String(currentQueue[currentIndex]?.path || '');
    shuffle = !shuffle;
    lastLocalShuffleChangeAt = Date.now();
    lastLocalShuffleValue = shuffle;

    // Paint the button state immediately. Queue rebuilding/persistence can be
    // comparatively expensive on a large queue; delaying this visual update
    // made a legitimate first click look like it had been ignored.
    renderShuffleButton();

    if (shuffle) {
      // Capture the exact order that existed before this shuffle operation.
      // This snapshot is intentionally recreated every time shuffle is turned
      // back on, so each new shuffle produces a fresh random order.
      shuffleRestoreQueue = currentQueue.slice();
      if (currentQueue.length > 1) {
        const current = currentQueue[currentIndex];
        const rest = currentQueue.filter((_, i) => i !== currentIndex);
        currentQueue = [current, ...shuffleForPlayback(rest)];
        currentIndex = 0;
      } else if (currentQueue.length) {
        currentIndex = 0;
      }
      selectedQueueIndex = currentIndex;
      selectedQueueIndices.clear();
      if (currentIndex >= 0) selectedQueueIndices.add(currentIndex);
      renderQueue();
    } else {
      // Restore the exact pre-shuffle ordering, keeping the currently playing
      // track selected/active rather than treating unshuffle as a new queue.
      const restore = Array.isArray(shuffleRestoreQueue) ? shuffleRestoreQueue.slice() : null;
      if (restore?.length) {
        currentQueue = restore;
        const restoredIndex = currentPath
          ? currentQueue.findIndex(t => String(t?.path || '') === currentPath)
          : -1;
        currentIndex = restoredIndex >= 0
          ? restoredIndex
          : Math.max(0, Math.min(currentIndex, currentQueue.length - 1));
        selectedQueueIndex = currentIndex;
        selectedQueueIndices.clear();
        if (currentIndex >= 0) selectedQueueIndices.add(currentIndex);
        renderQueue();
      }
      shuffleRestoreQueue = null;
    }

    // Shuffle is a queue-order operation, not a transport operation. Never
    // stop/reload the currently playing GStreamer pipeline just because the
    // queue order changed: doing so interrupts the audio clock and produces a
    // noticeable stutter. The current track continues uninterrupted; only the
    // native NEXT target is refreshed for the next transition.
    if (wasShuffle !== shuffle && gstActive) {
      gstSendNext();
    }

    // Persist shuffle even when it is being turned off; repeat/shuffle are part
    // of the same playback-session snapshot as the queue and position.
    saveQueueSession();
    savePlaybackSession();
    syncMpris();
  });
  el.btnRepeat.addEventListener('click', () => {
    repeat = (repeat + 1) % 3;
    renderRepeatButton();
    saveQueueSession();
    savePlaybackSession();
    syncMpris();
  });

  el.btnLove.addEventListener('click', () => {
    const t = currentQueue[currentIndex];
    if (!t?.path) return;
    // Do not block the heart on a disk read or metadata write. The current
    // Beehive Love state is toggled immediately; the embedded file tag is
    // persisted by the background Love writer.
    setTrackLove(t, !t.loved, false);
    if (!el.songsTable.classList.contains('hidden')) renderCurrentView();
  });

  // ---------------- library loading / scanning ----------------
  function applyLibrary(lib, options = {}) {
    library = lib || library || { tracks: [] };
    libraryTrackByPath = new Map();
    libraryTrackByNormalizedPath = new Map();
    libraryTrackByTitleArtist = new Map();
    libraryTrackByBasename = new Map();
    for (const t of (library.tracks || [])) {
      const p = String(t?.path || '');
      if (!p) continue;
      if (!libraryTrackByPath.has(p)) libraryTrackByPath.set(p, t);
      const np = normalizePlaylistPath(p);
      if (np && !libraryTrackByNormalizedPath.has(np)) libraryTrackByNormalizedPath.set(np, t);
      const title = normalizeMusicText(t.title);
      const artist = normalizeMusicText(t.artist);
      if (title) {
        const key = `${title}||${artist}`;
        if (!libraryTrackByTitleArtist.has(key)) libraryTrackByTitleArtist.set(key, t);
        const titleOnly = `${title}||`;
        if (!libraryTrackByTitleArtist.has(titleOnly)) libraryTrackByTitleArtist.set(titleOnly, t);
      }
      const base = np.split('/').pop();
      if (base && !libraryTrackByBasename.has(base)) libraryTrackByBasename.set(base, t);
    }
    // Preserve Love state returned by the scan/cache. The embedded file is the
    // durable source of truth; there is intentionally no 30k-file Love reread
    // here because that would recreate the post-scan hitch.

    // The audio file is the source of truth for ratings. Never trust a rating
    // carried forward by library.json: it can be stale after the file was
    // changed in Beehive or on another machine. Start cached tracks unrated and
    // hydrate their real embedded ratings immediately in the background.
    for (const t of (library.tracks || [])) {
      // Older library.json snapshots can contain music-metadata lyric objects.
      // Normalize them at the cache boundary so no renderer surface can coerce
      // a lyric object to the literal string "[object Object]".
      t.comment = normalizeMetadataText(t.comment);
      t.lyrics = normalizeLyricsText(t.lyrics);
      // Keep the cached rating visible immediately. It is only a display
      // fallback until the actual file tag is hydrated below. The file remains
      // authoritative, so a background refresh will replace this value.
      t.rating = Math.max(0, Math.min(5, Number(t.rating) || 0));
      t.ratingRaw = Number(t.ratingRaw) || 0;
      t.ratingHydrated = false;
      // Search text is built lazily by trackMatchesSearch(). Building a large
      // Object.entries() string for every track during startup was unnecessary
      // work on 20k-30k libraries and contributed to the launch hitch.
      t._searchText = '';
    }
    albums = buildAlbums(library.tracks);
    // Artists are not needed to paint the default Albums view. Build this index
    // only when Artists is actually opened.
    artistPickerEntries = [];
    artistPickerEntriesReady = false;
    if (!options.deferView) {
      const activeTab = tabs.find(t => t.id === activeTabId);
      applyTabView(activeTab ? activeTab.kind : 'music');
    }
  }


  // Startup-only variant: build the large lookup maps in small time-sliced
  // batches. The synchronous applyLibrary() remains unchanged for normal
  // edits/actions, while startup and full-scan replacement can yield to
  // Chromium between batches instead of monopolizing the renderer for ~1.5s.
  async function applyLibraryProgressive(lib, options = {}) {
    library = lib || { tracks: [] };
    const tracks = library.tracks || [];
    libraryTrackByPath = new Map();
    libraryTrackByNormalizedPath = new Map();
    libraryTrackByTitleArtist = new Map();
    libraryTrackByBasename = new Map();

    const CHUNK = 500;
    for (let i = 0; i < tracks.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, tracks.length);
      for (let j = i; j < end; j++) {
        const t = tracks[j];
        const p = String(t?.path || '');
        if (!p) continue;
        if (!libraryTrackByPath.has(p)) libraryTrackByPath.set(p, t);
        const np = normalizePlaylistPath(p);
        if (np && !libraryTrackByNormalizedPath.has(np)) libraryTrackByNormalizedPath.set(np, t);
        const title = normalizeMusicText(t.title);
        const artist = normalizeMusicText(t.artist);
        if (title) {
          const key = `${title}||${artist}`;
          if (!libraryTrackByTitleArtist.has(key)) libraryTrackByTitleArtist.set(key, t);
          const titleOnly = `${title}||`;
          if (!libraryTrackByTitleArtist.has(titleOnly)) libraryTrackByTitleArtist.set(titleOnly, t);
        }
        const base = np.split('/').pop();
        if (base && !libraryTrackByBasename.has(base)) libraryTrackByBasename.set(base, t);
        t.comment = normalizeMetadataText(t.comment);
        t.lyrics = normalizeLyricsText(t.lyrics);
        t.rating = Math.max(0, Math.min(5, Number(t.rating) || 0));
        t.ratingRaw = Number(t.ratingRaw) || 0;
        t.ratingHydrated = false;
        t._searchText = '';
      }
      if (end < tracks.length) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    }

    // Album construction is relatively cheap compared with the 30k-track
    // lookup pass, but let the browser paint once before sorting/assembling it.
    await new Promise(resolve => requestAnimationFrame(resolve));
    albums = buildAlbums(tracks);
    // The cache warmup is deliberately deferred until after the first album view
    // paint; renderAlbums() will schedule it from the established UI path.
    artistPickerEntries = [];
    artistPickerEntriesReady = false;
    const activeTab = tabs.find(t => t.id === activeTabId);
    applyTabView(activeTab ? activeTab.kind : 'music');
    if (options.status !== false) startupStatusUpdate('Library ready · checking for changes…', !tracks.length);
  }

  let loveRefreshRunning = false;
  async function refreshCachedLovesInBackground() {
    if (loveRefreshRunning) return null;
    if (!window.beehive.refreshLovedLibrary) return null;
    loveRefreshRunning = true;
    try {
      // Love is authoritative on the audio files themselves. Use the dedicated
      // main-process refresh so startup has one canonical reader, visible
      // progress, and a persisted cache result. This deliberately happens after
      // the normal incremental scan so unchanged files are still fast to scan.
      const result = await window.beehive.refreshLovedLibrary();
      if (result && Array.isArray(result.tracks)) {
        library.tracks = result.tracks;
        albums = buildAlbums(library.tracks);
        const lovedCount = library.tracks.reduce((n, t) => n + (t?.loved ? 1 : 0), 0);
        console.info('[Beehive] FAVORITES LOVE HYDRATION RESULT', {
          total: library.tracks.length,
          lovedCount
        });
        renderCurrentView();
        return result;
      }
      return result || null;
    } catch (err) {
      console.warn('[Beehive] Love hydration failed:', err);
      return null;
    } finally {
      loveRefreshRunning = false;
    }
  }

  let ratingRefreshRunning = false;
  async function refreshCachedRatingsInBackground() {
    if (ratingRefreshRunning) return;
    const stale = library.tracks.filter(t => t?.path);
    if (!stale.length) return;
    ratingRefreshRunning = true;
    try {
      // Read all cached ratings through one concurrent main-process operation.
      // The old 40-track/IPC-loop approach could issue ~500 IPC calls for a
      // 20k-track library and make startup look frozen.
      const ratings = await window.beehive.readRatings(stale.map(t => t.path));
      const hydratedRatings = {};
      for (const t of stale) {
        if (!Object.prototype.hasOwnProperty.call(ratings || {}, t.path)) continue;
        const result = ratings[t.path];
        t.rating = typeof result === 'object' ? Number(result.stars || 0) : Number(result || 0);
        t.ratingRaw = typeof result === 'object' ? Number(result.raw || 0) : (t.rating >= 5 ? 255 : 0);
        if (t.ratingRaw === 255) t.rating = 5;
        t.ratingHydrated = true;
        hydratedRatings[t.path] = t.rating;
      }
      if (Object.keys(hydratedRatings).length) {
        await window.beehive.updateCachedRatings(hydratedRatings);
      }
      // The user may switch views while the background read is running.
      // Always refresh the current view when hydration completes so ratings
      // cannot remain visually stuck at the cached/unrated state.
      renderCurrentView();
    } catch (err) {
      console.warn('Rating hydration failed:', err);
    } finally {
      ratingRefreshRunning = false;
    }
  }


  window.addEventListener('resize', () => {
    if (viewMode === 'artists' && !artistSearchTerm && artistVirtualState.update) artistVirtualState.update(true);
  });

  // Recently Added is intentionally empty immediately after the first
  // authoritative library scan. Its baseline is the moment that scan finishes,
  // not app launch: files discovered during that first scan were not "recently"
  // added from Beehive's point of view. Anything discovered later can appear.
  const RECENTLY_ADDED_SCAN_BASELINE_KEY = 'beehive:recently-added-scan-baseline';
  function getRecentlyAddedScanBaseline() {
    try {
      const value = Number(localStorage.getItem(RECENTLY_ADDED_SCAN_BASELINE_KEY) || 0);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  function establishRecentlyAddedScanBaseline() {
    try {
      const existing = getRecentlyAddedScanBaseline();
      const addedTimes = (library.tracks || [])
        .map(t => Number(t?.addedAt || 0))
        .filter(v => Number.isFinite(v) && v > 0);

      // The baseline represents the end of the first authoritative scan.
      // Older builds could create the baseline before that scan, which made
      // every track discovered by the initial scan look Recently Added. If
      // that legacy state is detected (every known track is newer than the
      // stored cutoff), repair it once by moving the cutoff to the newest
      // track currently in the authoritative library. This leaves genuinely
      // new files discovered by later scans untouched.
      if (existing > 0) {
        const minAdded = addedTimes.length ? Math.min(...addedTimes) : 0;
        if (minAdded > existing && addedTimes.length) {
          const repaired = Math.max(...addedTimes);
          localStorage.setItem(RECENTLY_ADDED_SCAN_BASELINE_KEY, String(repaired));
        }
        return;
      }

      // On a new library, use the newest authoritative addedAt timestamp
      // rather than Date.now(). All files found during that first scan are
      // therefore excluded, while files discovered by a later scan can qualify.
      const baseline = addedTimes.length ? Math.max(...addedTimes) : Date.now();
      localStorage.setItem(RECENTLY_ADDED_SCAN_BASELINE_KEY, String(baseline));
    } catch {}
  }

  function getRecentlyAddedTracks() {
    const cutoff = getRecentlyAddedScanBaseline();
    return (library.tracks || []).filter(t => {
      const addedAt = Number(t?.addedAt || 0);
      // Before the first scan has completed there is deliberately no Recently
      // Added content. Once the baseline exists, only files added afterwards
      // qualify; files present during that first scan stay out permanently.
      return cutoff > 0 && addedAt > cutoff;
    });
  }

  async function decodeStartupLibrarySnapshot(snapshot) {
    if (!snapshot || snapshot.compressed !== 'gzip' || !snapshot.data) return snapshot;
    const started = performance.now();
    try {
      // DecompressionStream is provided by Chromium/Electron and runs through
      // the browser's async stream machinery, avoiding a giant synchronous
      // decompression task on the renderer's startup turn.
      const bytes = snapshot.data instanceof Uint8Array
        ? snapshot.data
        : new Uint8Array(snapshot.data);
      if (typeof DecompressionStream === 'function') {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        const text = await new Response(stream).text();
        const parsed = JSON.parse(text);
        if (Array.isArray(snapshot.lovedPaths) && Array.isArray(parsed?.tracks)) {
          const lovedSet = new Set(snapshot.lovedPaths.map(p => String(p || '').toLowerCase()));
          for (const track of parsed.tracks) {
            const key = String(track?.path || '').toLowerCase();
            if (!key) continue;
            track.loved = lovedSet.has(key);
            track.loveHydrated = true;
          }
        }
        startupMark('LIBRARY CACHE GZIP DECODED', {
          bytes: bytes.byteLength,
          tracks: parsed?.tracks?.length || 0,
          elapsedMs: Number((performance.now() - started).toFixed(1))
        });
        return parsed;
      }
      startupMark('LIBRARY CACHE GZIP UNSUPPORTED', { bytes: bytes.byteLength });
    } catch (err) {
      startupMark('LIBRARY CACHE GZIP DECODE FAILED', { message: err?.message || String(err) });
    }
    return null;
  }

  async function initialLoad() {
    startupMark('INITIAL LOAD START');
    startupStatusUpdate('Preparing Hive…');
    // Do not establish the Recently Added baseline here. It must be created only
    // after the first authoritative library scan completes, so the initial scan
    // itself never populates Recently Added.

    // Startup is deliberately staged. The shell gets two paint opportunities
    // before we hand a 20k-30k-track object graph to the renderer. This keeps the
    // window interactive immediately (including native maximize/fullscreen) while
    // the library snapshot, folders and playlists arrive in the background.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    startupMark('INITIAL LOAD FIRST PAINT YIELD', { elapsedMs:Number((performance.now()-startupPerfStart).toFixed(1)) });
    startupStatusUpdate('Restoring session…');

    const playbackPromise = window.beehive.getPlaybackState().catch(() => null);
    const cachedPromise = window.beehive.getCachedLibrary().catch(err => {
      console.warn('Startup cached-library load failed:', err);
      return null;
    });
    const playlistsPromise = window.beehive.getPlaylists().catch(err => {
      console.warn('Startup playlist load failed:', err);
      return [];
    });
    const foldersPromise = refreshFolders().catch(err => {
      console.warn('Startup folder refresh failed:', err);
    });

    // Restore the tiny playback snapshot first. It does not require decoding
    // audio, building albums, or rendering the library, so the player can become
    // usable while the large cached library is still arriving.
    backendPlaybackState = await playbackPromise;
    startupMark('PLAYBACK SNAPSHOT READY', { elapsedMs:Number((performance.now()-startupPerfStart).toFixed(1)) });
    restoreLastPlayback();
    playbackPersistenceReady = true;

    // The playback snapshot is the critical startup path. Do not make the
    // renderer await the multi-megabyte cached library response: Electron can
    // keep processing that response in the background while the window is
    // already interactive.
    await new Promise(resolve => setTimeout(resolve, 0));
    startupMark('STARTUP EVENT LOOP YIELD AFTER PLAYBACK');
    startupStatusUpdate('Loading library cache in background…');
    void foldersPromise;

    // Keep cache retrieval off the critical path. Once it arrives, apply it and
    // begin the normal quiet reconciliation. This preserves the existing cache
    // and scan behavior without making first interaction wait for the cache.
    Promise.all([cachedPromise, playlistsPromise]).then(async ([cachedSnapshot, playlistList]) => {
      const cached = await decodeStartupLibrarySnapshot(cachedSnapshot);
      startupMark('CACHE AND PLAYLIST SNAPSHOTS READY', { cachedTracks:cached?.tracks?.length || 0, playlists:Array.isArray(playlistList)?playlistList.length:0, elapsedMs:Number((performance.now()-startupPerfStart).toFixed(1)) });
      playlists = (Array.isArray(playlistList) ? playlistList : []).map(normalizeSpotifyPlaylistRecord);
      migrateFavoritesSidebarToCanonicalPlaylist();
      if (syncPlaylistSidebarPresentation()) saveNavigationPrefs();
      // Playlist-backed pinned navigation cannot be materialized until the
      // persisted playlist list has arrived. Rebuild the top-bar projection now
      // so custom playlist locks survive a cold restart as well as live edits.
      syncPinnedTabs();
      renderTabs();
      startupStatusUpdate(cached?.tracks?.length ? 'Painting cached library…' : 'Preparing library…');
      startupMark('APPLY LIBRARY START', { tracks:cached?.tracks?.length || 0 });
      await applyLibraryProgressive(cached || { tracks: [] }, { status: false });
      startupMark('APPLY LIBRARY COMPLETE', { tracks:library?.tracks?.length || 0, elapsedMs:Number((performance.now()-startupPerfStart).toFixed(1)) });
      startupStatusUpdate('Library ready · checking for changes…', !cached?.tracks?.length);

      // The cache paints immediately, then a quiet incremental reconciliation runs
      // automatically. This means startup never depends on the context-menu Refresh
      // action, while unchanged files are retained from the cache.
      const startupScanDelay = cached?.tracks?.length ? 2500 : 900;
      console.info('[Beehive] INITIAL RECONCILIATION SCHEDULED', { delayMs: startupScanDelay, cachedTracks: cached?.tracks?.length || 0 });
      startupMark('INITIAL RECONCILIATION SCHEDULED', { delayMs:startupScanDelay, cachedTracks:cached?.tracks?.length || 0 });
      setTimeout(() => {
        console.info('[Beehive] INITIAL RECONCILIATION STARTED');
        startupStatusUpdate('Checking library in background…');
        startupMark('INITIAL RECONCILIATION STARTED');
        runScan(false)
          .then(async () => {
            console.info('[Beehive] INITIAL RECONCILIATION FINISHED');
            startupMark('INITIAL RECONCILIATION FINISHED', { elapsedMs:Number((performance.now()-startupPerfStart).toFixed(1)), tracks:library?.tracks?.length || 0 });
            startupStatusUpdate('Startup complete', false);
            setTimeout(() => startupStatusUpdate('', true), 700);
            // The normal scan already reads Love for every changed file and
            // performs the bounded compatibility reconciliation for stale
            // cached records. Do not launch a second full-library Love pass
            // here after the scan has completed; that made a finished scan
            // appear to stall at 100% on large libraries. The explicit manual
            // Favorites refresh remains available for repair/verification.
            console.info('[Beehive] FAVORITES LOVE STATE INCLUDED IN SCAN');
          })
          .catch(err => { startupMark('INITIAL RECONCILIATION FAILED', { message:err?.message || String(err) }); startupStatusUpdate('Library check failed — using cache', false); console.warn('[Beehive] INITIAL RECONCILIATION FAILED:', err); });
      }, startupScanDelay);
    }).catch(err => {
      startupMark('CACHE/PLAYLIST SNAPSHOTS FAILED', { message:err?.message || String(err) });
      startupStatusUpdate('Library cache unavailable — checking files…', false);
      console.warn('[Beehive] CACHE/PLAYLIST SNAPSHOTS FAILED:', err);
      setTimeout(() => runScan(false).catch(scanErr => {
        startupMark('INITIAL RECONCILIATION FAILED', { message:scanErr?.message || String(scanErr) });
        startupStatusUpdate('Library check failed', false);
      }), 900);
    });
  }

  el.addFolderBtn.addEventListener('click', async () => {
    const config = await window.beehive.addFolder();
    if (!config) return;
    await refreshFolders();
    await runScan(false);
  });

  // A manual Rescan is authoritative: reread every audio file so newly added
  // tracks are discovered and embedded tags override stale cached values.
  el.rescanBtn.addEventListener('click', () => runScan(true));

  let tagOperationActive = false;
  let tagOperationOff = null;
  let lastTagFailures = [];
  async function copyTagErrorText(text) {
    const value = String(text || 'Unknown metadata write error.');
    try {
      await navigator.clipboard.writeText(value);
      if (el.tagFailuresCopyStatus) {
        el.tagFailuresCopyStatus.textContent = 'Copied';
        clearTimeout(copyTagErrorText._statusTimer);
        copyTagErrorText._statusTimer = setTimeout(() => { if (el.tagFailuresCopyStatus) el.tagFailuresCopyStatus.textContent = ''; }, 1600);
      }
      return true;
    } catch (err) {
      console.warn('Could not copy metadata error:', err);
      if (el.tagFailuresCopyStatus) el.tagFailuresCopyStatus.textContent = 'Copy failed';
      return false;
    }
  }

  function formatAllTagErrorsForClipboard() {
    return lastTagFailures.map((failure, index) => {
      const name = String(failure.path || '').split(/[\\/]/).pop() || String(failure.path || 'Unknown file');
      const error = String(failure.error || 'Unknown metadata write error.');
      return `#${index + 1}\nFile: ${name}\nPath: ${String(failure.path || '')}\nError: ${error}`;
    }).join('\n\n');
  }

  function renderTagFailures(errors) {
    lastTagFailures = Array.isArray(errors) ? errors.filter(e => e && e.path) : [];
    if (!el.scanFailuresBtn) return;
    el.scanFailuresBtn.classList.toggle('hidden', lastTagFailures.length === 0);
    if (el.tagFailuresSummary) el.tagFailuresSummary.textContent = `${lastTagFailures.length} file${lastTagFailures.length === 1 ? '' : 's'} failed. No files are deleted or removed from your library by this report.`;
    if (el.copyAllTagErrorsBtn) el.copyAllTagErrorsBtn.disabled = lastTagFailures.length === 0;
    if (el.tagFailuresList) {
      el.tagFailuresList.innerHTML = '';
      for (const failure of lastTagFailures) {
        const item = document.createElement('div'); item.className = 'tag-failure-item';
        const name = document.createElement('div'); name.className = 'tag-failure-name'; name.textContent = String(failure.path).split(/[\\/]/).pop() || String(failure.path);
        const pathEl = document.createElement('div'); pathEl.className = 'tag-failure-path'; pathEl.textContent = String(failure.path);
        const err = document.createElement('div'); err.className = 'tag-failure-error'; err.textContent = String(failure.error || 'Unknown metadata write error.');
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'tag-failure-copy';
        copyBtn.textContent = 'Copy error code';
        copyBtn.addEventListener('click', () => copyTagErrorText(failure.error));
        item.append(name, pathEl, err, copyBtn); el.tagFailuresList.appendChild(item);
      }
    }
  }
  el.copyAllTagErrorsBtn?.addEventListener('click', () => copyTagErrorText(formatAllTagErrorsForClipboard()));
  el.scanFailuresBtn?.addEventListener('click', () => el.tagFailuresModal?.classList.remove('hidden'));

  function showTagOperationProgress(payload) {
    if (!payload) return;
    if (Array.isArray(payload.errors)) renderTagFailures(payload.errors);
    if (!payload.active && Number(payload.failed || 0) > 0) {
      const prefix = payload.recovered ? `Beehive resumed ${Number(payload.done || 0)} interrupted metadata operation${Number(payload.done || 0) === 1 ? '' : 's'}, but ` : '';
      showAppNotice(`${prefix}${Number(payload.failed || 0)} file${Number(payload.failed || 0) === 1 ? '' : 's'} failed after 3 attempts. The original files were not intentionally deleted. Check the failed-files report.`, payload.recovered ? 'Metadata recovery warning' : 'Metadata write warning');
    }
    tagOperationActive = !!payload.active;
    const box = el.metadataEmbedStatus;
    const text = el.metadataEmbedStatusText;
    if (!box) return;
    // Artwork writes are deliberately represented as a tiny top-bar activity
    // indicator. The cover itself is painted optimistically before this event
    // arrives, so the user never waits for the container rewrite to see it.
    const isArtwork = payload.operation === 'artwork';
    if (isArtwork && tagOperationActive) {
      box.classList.remove('hidden');
      if (text) text.textContent = 'Embedding…';
      return;
    }
    if (isArtwork && !tagOperationActive) {
      if (text) text.textContent = Number(payload.failed || 0) ? 'Embedding failed' : 'Embedded';
      setTimeout(() => {
        if (!tagOperationActive) box.classList.add('hidden');
      }, Number(payload.failed || 0) ? 1800 : 700);
      return;
    }
    // Non-artwork metadata operations no longer occupy either the old sidebar
    // scan surface or the artwork indicator.
  }

  tagOperationOff = window.beehive.onTagProgress?.(showTagOperationProgress) || null;

  let scanTrackRenderQueued = false;
  let scanTrackRenderNeeded = false;
  const offScanTrack = window.beehive.onScanTrack?.((incoming) => {
    const incomingTracks = Array.isArray(incoming) ? incoming : [incoming];
    let applied = 0;
    let needsViewRefresh = false;
    for (const raw of incomingTracks) {
      const track = raw && typeof raw === 'object' ? raw : null;
      const filePath = String(track?.path || '');
      if (!filePath) continue;
      // Scan events are batched by the main process so a large first scan does not
      // flood Electron with tens of thousands of individual IPC messages.
      const existing = libraryTrackByPath.get(filePath) || null;
      const wasLoved = !!existing?.loved;
      track.comment = normalizeMetadataText(track.comment);
      track.lyrics = normalizeLyricsText(track.lyrics);
      if (existing) Object.assign(existing, track);
      else library.tracks.push(track);
      libraryTrackByPath.set(filePath, existing || track);
      applied++;
      if (specialView === 'playlist' && activePlaylistId && wasLoved !== !!track.loved) needsViewRefresh = true;
    }
    if (!applied) return;
    if (needsViewRefresh) scanTrackRenderNeeded = true;
    // If the cache was empty, paint the first received batch so the user can
    // start listening before a large first scan completes. Later batches only
    // update the in-memory index unless a view actually needs refreshing.
    if (!scanTrackRenderQueued && (scanTrackRenderNeeded || library.tracks.length === applied)) {
      scanTrackRenderQueued = true;
      requestAnimationFrame(() => {
        scanTrackRenderQueued = false;
        if (!scanTrackRenderNeeded && library.tracks.length !== applied) return;
        scanTrackRenderNeeded = false;
        renderCurrentView();
      });
    }
  });

  let scanRunning = false;
  let offFirstScanIntegrityComplete = null;
  if (window.beehive.onFirstScanIntegrityComplete) {
    offFirstScanIntegrityComplete = window.beehive.onFirstScanIntegrityComplete(payload => {
      const corrupt = Number(payload?.corrupt || 0);
      const unavailable = Number(payload?.unavailable || 0);
      const metadataIssues = Number(payload?.metadataIssues || 0);
      const loveConflicts = Number(payload?.loveConflicts || 0);
      const problems = corrupt + unavailable + metadataIssues + loveConflicts;
      const reportPath = String(payload?.reportPath || '').trim();
      const summary = problems
        ? `Hive finished the one-time first-library integrity audit.\n\n${corrupt.toLocaleString()} corrupted, ${unavailable.toLocaleString()} could not be scanned, ${metadataIssues.toLocaleString()} metadata inspection issue${metadataIssues === 1 ? '' : 's'}, and ${loveConflicts.toLocaleString()} Love metadata conflict${loveConflicts === 1 ? '' : 's'}.\n\nA full TXT report was automatically created${reportPath ? ` at:\n${reportPath}` : '.'}`
        : `Hive finished the one-time first-library integrity audit.\n\nNo corruption or metadata problems were found. A full TXT report was automatically created${reportPath ? ` at:\n${reportPath}` : '.'}`;
      showAppNotice(summary, 'First library integrity audit');
    });
  }

  async function runScan(forceFull = false, changedPaths = null) {
    startupMark('SCAN ENTER', { forceFull, changedCount:Array.isArray(changedPaths)?changedPaths.length:0 });
    if (scanRunning) return;
    scanRunning = true;
    el.scanProgress.classList.remove('hidden');
    if (el.scanTitle) el.scanTitle.textContent = 'Library scan';
    el.scanFill.style.width = '0%';
    el.scanProgress.classList.add('busy');
    el.scanLabel.textContent = forceFull ? 'Reading tags from library…' : 'Starting scan…';
    const off = window.beehive.onScanProgress(({ done, total, tracksFound, skipped, current, phase, enumerating, statPhase }) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      el.scanFill.style.width = pct + '%';
      el.scanProgress.classList.add('busy');
      const found = Number.isFinite(Number(tracksFound)) ? ` · ${tracksFound.toLocaleString()} tracks` : '';
      const skippedText = Number.isFinite(Number(skipped)) && Number(skipped) > 0 ? ` · ${skipped.toLocaleString()} skipped` : '';
      const name = current ? ` · ${current}` : '';
      if (enumerating || phase?.startsWith('Finding music files')) {
        el.scanLabel.textContent = `${phase || 'Finding music files'} · ${total.toLocaleString()} files discovered${name}`;
      } else if (statPhase) {
        el.scanLabel.textContent = `${phase || 'Checking files for changes'} · ${done.toLocaleString()} / ${total.toLocaleString()} files${name}`;
      } else {
        el.scanLabel.textContent = `${phase || 'Scanning changes'} · ${done.toLocaleString()} / ${total.toLocaleString()} files${found}${skippedText}${name}`;
      }
    });
    try {
      if (!library.tracks.length) {
        el.emptyState.classList.remove('hidden');
        el.emptyState.textContent = 'Scanning library…';
      }
      startupMark('SCAN WORK BEGIN', { forceFull, changedCount:Array.isArray(changedPaths)?changedPaths.length:0 });
      const lib = changedPaths?.length && !forceFull
        ? await window.beehive.scanChangedLibrary(changedPaths)
        : await window.beehive.scanLibrary({ forceFull });
      startupMark('SCAN RESULT RECEIVED', {
        incremental: !!lib?.incremental,
        tracks: lib?.tracks?.length || 0,
        changed: Array.isArray(lib?.changed) ? lib.changed.length : 0,
        removed: Array.isArray(lib?.removedPaths) ? lib.removedPaths.length : 0
      });
      if (lib?.incremental) {
        // A normal reconciliation does not need to send the renderer another
        // copy of the entire 30k-track library. The renderer already owns the
        // cached snapshot; apply only changed/new records and removals received
        // from the main process. This avoids a ~93 MB IPC payload and the
        // resulting ~1.5 s renderer event-loop stall seen in the performance audit.
        const removedPaths = Array.isArray(lib.removedPaths) ? lib.removedPaths : [];
        for (const removedPath of removedPaths) {
          const removedKey = String(removedPath);
          const existing = libraryTrackByPath.get(removedKey);
          if (!existing) continue;
          const oldNormalized = normalizePlaylistPath(removedKey);
          const oldTitle = normalizeMusicText(existing.title);
          const oldArtist = normalizeMusicText(existing.artist);
          const oldTitleKeys = oldTitle ? [`${oldTitle}||${oldArtist}`, `${oldTitle}||`] : [];
          const oldBase = oldNormalized.split('/').pop();
          const index = library.tracks.indexOf(existing);
          if (index >= 0) library.tracks.splice(index, 1);
          libraryTrackByPath.delete(removedKey);
          if (oldNormalized && libraryTrackByNormalizedPath.get(oldNormalized) === existing) libraryTrackByNormalizedPath.delete(oldNormalized);
          for (const key of oldTitleKeys) if (libraryTrackByTitleArtist.get(key) === existing) libraryTrackByTitleArtist.delete(key);
          if (oldBase && libraryTrackByBasename.get(oldBase) === existing) libraryTrackByBasename.delete(oldBase);
          // If another track shared one of those secondary keys, restore that
          // representative without rebuilding the whole index.
          for (const candidate of library.tracks) {
            const np = normalizePlaylistPath(String(candidate?.path || ''));
            if (oldNormalized && np === oldNormalized && !libraryTrackByNormalizedPath.has(oldNormalized)) libraryTrackByNormalizedPath.set(oldNormalized, candidate);
            const title = normalizeMusicText(candidate.title);
            const artist = normalizeMusicText(candidate.artist);
            if (oldTitle && title === oldTitle) {
              const key = `${title}||${artist}`;
              if (oldTitleKeys.includes(key) && !libraryTrackByTitleArtist.has(key)) libraryTrackByTitleArtist.set(key, candidate);
              const titleOnly = `${title}||`;
              if (oldTitleKeys.includes(titleOnly) && !libraryTrackByTitleArtist.has(titleOnly)) libraryTrackByTitleArtist.set(titleOnly, candidate);
            }
            const base = np.split('/').pop();
            if (oldBase && base === oldBase && !libraryTrackByBasename.has(oldBase)) libraryTrackByBasename.set(oldBase, candidate);
            if ((oldNormalized && libraryTrackByNormalizedPath.has(oldNormalized)) || (!oldNormalized && !oldBase && !oldTitle)) break;
          }
        }
        const changedTracks = Array.isArray(lib.changed) ? lib.changed : [];
        const indexKeysToRefresh = new Set();
        for (const track of changedTracks) {
          track.comment = normalizeMetadataText(track.comment);
          track.lyrics = normalizeLyricsText(track.lyrics);
          const filePath = String(track?.path || '');
          if (!filePath) continue;
          const existing = libraryTrackByPath.get(filePath);
          if (existing) Object.assign(existing, track);
          else library.tracks.push(track);
          const current = existing || track;
          libraryTrackByPath.set(filePath, current);
          indexKeysToRefresh.add(current);
        }
        // Keep the secondary lookup indexes coherent without rebuilding the
        // entire 30k-track graph. Remove stale entries only when they point at
        // the affected object; then add the object's current keys.
        for (const track of indexKeysToRefresh) {
          for (const [key, value] of libraryTrackByNormalizedPath) if (value === track) libraryTrackByNormalizedPath.delete(key);
          for (const [key, value] of libraryTrackByTitleArtist) if (value === track) libraryTrackByTitleArtist.delete(key);
          for (const [key, value] of libraryTrackByBasename) if (value === track) libraryTrackByBasename.delete(key);
          const p = String(track?.path || '');
          const np = normalizePlaylistPath(p);
          if (np && !libraryTrackByNormalizedPath.has(np)) libraryTrackByNormalizedPath.set(np, track);
          const title = normalizeMusicText(track.title);
          const artist = normalizeMusicText(track.artist);
          if (title) {
            const key = `${title}||${artist}`;
            if (!libraryTrackByTitleArtist.has(key)) libraryTrackByTitleArtist.set(key, track);
            const titleOnly = `${title}||`;
            if (!libraryTrackByTitleArtist.has(titleOnly)) libraryTrackByTitleArtist.set(titleOnly, track);
          }
          const base = np.split('/').pop();
          if (base && !libraryTrackByBasename.has(base)) libraryTrackByBasename.set(base, track);
        }
        albums = buildAlbums(library.tracks);
        artistPickerEntries = [];
        artistPickerEntriesReady = false;
        applyTabView((tabs.find(t => t.id === activeTabId) || {}).kind || 'music');
      } else {
        await applyLibraryProgressive(lib, { status: false });
      }
      startupMark('SCAN RESULT APPLIED', { tracks:library?.tracks?.length || 0 });
      // Build 213: emit the Favorites pipeline diagnostic after every successful
      // scan, including manual scans. Build 212 only hooked the startup-only
      // reconciliation, so the manual Scan entire library path produced no
      // diagnostic report. This remains read-only and does not alter membership.
      await logFavoritesPipelineDiagnostics(forceFull ? 'full-scan-complete' : (changedPaths?.length ? 'changed-scan-complete' : 'scan-complete'));
      // Establish the baseline only after the first successful authoritative scan
      // has actually completed. This guarantees the initial library contents are
      // not shown as Recently Added. Future files discovered after this moment can
      // still appear there using their normal addedAt timestamp.
      establishRecentlyAddedScanBaseline();
      // The scan already contains authoritative ratings/favorites for changed files,
      // while unchanged files retain their cached values. Do not launch a second
      // full-library metadata pass after SCAN DONE; it competes with playback and
      // makes the player hitch even though the scan itself has finished.
      el.scanFill.style.width = '100%';
      el.scanProgress.classList.remove('busy');
      el.scanLabel.textContent = `${lib?.tracks?.length || 0} tracks found`;
      await new Promise(resolve => setTimeout(resolve, 500));
    } finally {
      off();
      scanRunning = false;
      startupMark('SCAN EXIT', { forceFull, tracks:library?.tracks?.length || 0 });
      if (!tagOperationActive) el.scanProgress.classList.add('hidden');
    }
  }

  // Album hover hints use an app-themed tooltip instead of Chromium's native
  // title bubble. Show only after a short dwell and anchor it at the mouse,
  // so it behaves like an intentional Beehive tooltip rather than a native hint.
  let albumTooltip = null;
  let albumTooltipTimer = null;
  let albumTooltipCard = null;
  let albumTooltipPointer = { x: 0, y: 0 };
  function showAlbumTooltip(card, x, y) {
    if (!card?.dataset.tooltip) return;
    if (!albumTooltip) {
      albumTooltip = document.createElement('div');
      albumTooltip.className = 'beehive-tooltip';
      document.body.appendChild(albumTooltip);
    }
    albumTooltip.textContent = card.dataset.tooltip;
    albumTooltip.classList.add('visible');
    const tr = albumTooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, x + 14));
    const top = Math.max(8, Math.min(window.innerHeight - tr.height - 8, y + 16));
    albumTooltip.style.left = `${left}px`;
    albumTooltip.style.top = `${top}px`;
  }
  function hideAlbumTooltip() {
    if (albumTooltipTimer) { clearTimeout(albumTooltipTimer); albumTooltipTimer = null; }
    albumTooltipCard = null;
    albumTooltip?.classList.remove('visible');
  }
  document.addEventListener('mousemove', e => {
    const card = e.target?.closest?.('.album-card[data-tooltip]');
    if (!card) {
      if (albumTooltipCard) hideAlbumTooltip();
      return;
    }
    albumTooltipPointer = { x: e.clientX, y: e.clientY };
    if (albumTooltipCard !== card) {
      if (albumTooltipTimer) clearTimeout(albumTooltipTimer);
      albumTooltip?.classList.remove('visible');
      albumTooltipCard = card;
      albumTooltipTimer = setTimeout(() => {
        if (albumTooltipCard === card) {
          albumTooltipTimer = null;
          showAlbumTooltip(card, albumTooltipPointer.x, albumTooltipPointer.y);
        }
      }, 1500);
    } else if (albumTooltip?.classList.contains('visible')) {
      showAlbumTooltip(card, e.clientX, e.clientY);
    }
  });
  document.addEventListener('mouseout', e => {
    const card = e.target?.closest?.('.album-card[data-tooltip]');
    if (card && !card.contains(e.relatedTarget)) hideAlbumTooltip();
  });

  // ---------------- misc UI wiring ----------------
  el.lyricsSection.classList.remove('collapsed');
  // Per-tab toolbar controls are bound when each tab DOM is created.

  function updateSearchClearButton() {
    if (!el.searchClear) return;
    el.searchClear.classList.toggle('visible', !!String(el.search.value || '').trim());
  }
  el.searchClear?.addEventListener('click', () => {
    el.search.value = '';
    el.search.dispatchEvent(new Event('input', { bubbles: true }));
    el.search.focus();
  });

  el.search.addEventListener('focus',()=>{});
  el.search.addEventListener('input', () => {
    artistSearchTerm = '';
    searchTerm = el.search.value.trim().toLowerCase();
    if(specialView){
      if(specialView==='recent'){const t=getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100);return viewMode==='albums'?renderSpecialAlbums(t):renderSpecialSongs(t);}
      if(specialView==='top'){const t=[...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25);return viewMode==='albums'?renderSpecialAlbums(t):renderSpecialSongs(t);}
      if(specialView==='folder' && activeFolderPath){return setView(viewMode);}
      if(specialView==='playlist' && activePlaylistId){const pl=playlists.find(p=>String(p.id)===String(activePlaylistId));if(pl)return setView(viewMode);}
      if(specialView==='history')return window.beehive.getHistory().then(h=>{const t=historyTracks(h||[]);return viewMode==='albums'?renderSpecialAlbums(t):renderSpecialSongs(t);});
      if(specialView==='sandbox') return showSandboxView();
      if(specialView==='yearly-wrap') return renderYearlyWrap();
    }
    setView(viewMode);
    updateSearchClearButton();
  });
  el.search.addEventListener('blur',()=>{if(!searchTerm)el.main.classList.remove('searching');});
  updateSearchClearButton();

  async function getSidebarCollectionTracks(nav){
    if(nav==='music' || nav==='explorer'){
      return library.tracks.slice();
    }
    if(nav==='history'){
      const h=await window.beehive.getHistory();
      return historyTracks(h||[]);
    }
    if(nav==='yearly-wrap'){
      const year=new Date().getFullYear();
      const h=await window.beehive.getHistory();
      return historyTracks((h||[]).filter(x=>{const ts=Number(x?.playedAt||0);return ts>0&&new Date(ts).getFullYear()===year;}));
    }
    if(nav==='pl-recent'){
      return getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100);
    }
    if(nav==='pl-top'){
      return [...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25);
    }
    if(nav==='pl-favorites'){
      return favoritesTracks();
    }
    if(nav==='pl-explorer'){
      const all=[];
      const seen=new Set();
      for(const pl of playlists){
        for(const t of tracksForPlaylist(pl)){
          if(t?.path && !seen.has(t.path)){
            seen.add(t.path);
            all.push(t);
          }
        }
      }
      return all;
    }
    if(nav==='podcasts'){
      const favorites = await loadPodcastFavorites();
      return (favorites || []).map(show => ({
        path:`podcast-show:${String(show?.feedUrl || show?.title || '')}`,
        title:String(show?.title || 'Podcast'),
        artist:String(show?.author || ''),
        album:'Podcasts', duration:0, source:'podcast'
      }));
    }
    return [];
  }

  function beginFreshSidebarPlayback() {
    // Sidebar collection playback is asynchronous because some destinations
    // (History/Sandbox/etc.) resolve their tracks through IPC. In the time
    // between the double-click and that resolution, the previous GStreamer
    // track used to remain the active transport and its live scrubber position
    // could be painted/carried into the next selection. Invalidate the old
    // transport request immediately, before awaiting the collection.
    ++playbackLoadRequestGeneration;
    ++gstLoadGeneration;
    ++engineGeneration;
    cancelScheduledNext();
    stopActiveSource();
    if (gstActive) gstSend('PAUSE');
    gstActive = false;
    gstTrackIndex = -1;
    gstPositionUpdatesEnabled = false;
    gstWaitingNextStream = false;
    gstExpectInitialStream = false;
    gstResumeAfterSeek = false;
    enginePaused = true;
    engineEnded = false;
    activeOffset = 0;
    activeDuration = 0;
    pendingRestoredOffset = null;
    gstPosition = 0;
    gstDuration = 0;
    gstPositionUpdatedAt = performance.now();
    try {
      el.pbSeek.value = '0';
      el.pbSeek.style.setProperty('--seek-progress', '0%');
      el.pbSeek.setAttribute('aria-valuenow', '0');
      el.pbElapsed.textContent = fmtTime(0);
    } catch {}
  }

  async function playSidebarCollection(nav){
    beginFreshSidebarPlayback();
    const baseTracks=await getSidebarCollectionTracks(nav);
    const tracks=visualShuffleTracks(visualShuffleKeyForSidebar(nav), baseTracks, sidebarVisualShuffleEnabled(nav));
    if(tracks.length) {
      // The collection's automatic-shuffle preference is visual only. With
      // player Shuffle off, playback follows the randomized list exactly. With
      // player Shuffle on, playQueue() shuffles that randomized list again.
      const startIndex = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
      playQueue(tracks,startIndex);
    }
    return true;
  }

  function sidebarContextMenuItems(nav, tracks, description, options = {}) {
    const canPlay = options.play !== false;
    const canQueue = options.queue !== false;
    const items = [];
    if (canPlay) items.push({label:'Play',action:()=>playSidebarCollection(nav)});
    if (canQueue) items.push({label:'Queue',action:()=>{
      if(!tracks.length){ showAppNotice('This collection has no tracks.'); return; }
      addTracksToQueue(tracks);
    }});
    items.push({label:'Info',action:()=>showSidebarListInfo({key:sidebarMetaKey(nav),name:sidebarLabel(nav),description,tracks})});
    items.push({label:'Export as M3U',action:()=>exportSidebarCollection(nav)});
    return items;
  }

  async function exportSidebarCollection(nav){
    const names={
      music:'Music',
      explorer:'Music Explorer',
      history:'History',
      'pl-explorer':'Playlists',
      'pl-favorites':'Favorites',
      'pl-recent':'Recently Added',
      'pl-top':'Top 25 Most Played',
      sandbox:'Sandbox',
      'yearly-wrap':'Yearly Wrap'
    };
    const tracks=await getSidebarCollectionTracks(nav);
    return exportPlaylist(names[nav] || 'Beehive',tracks);
  }

  // ---------------- top bar tabs (Playlists / Music / +) ----------------
  // Each tab owns its own actual content DOM. The library data is shared, but
  // album expansion, rendered cards, scroll position, and view state are not.
  // This is intentionally a DOM-level separation rather than a snapshot of one
  // shared Music browser.
  const SIDEBAR_NAV_KEY = 'beehive:sidebar-navigation';
  const TOP_TAB_PREFS_KEY = 'beehive:pinned-navigation';
  const PINNED_NAV_KEY = 'beehive:pinned-navigation';
  const SIDEBAR_NAV_DEFS = [
    { id:'music', label:'Music', description:'Your main library', icon:'♫' },
    { id:'pl-explorer', label:'Playlists', description:'Playlist manager', icon:'☷' },
    { id:'history', label:'History', description:'Recently played tracks', icon:'' },
    { id:'yearly-wrap', label:'Yearly Wrap', description:'A quiet annual listening retrospective', icon:'' },
    { id:'sandbox', label:'Sandbox', description:'Plugin sandbox launcher', icon:'' },
    { id:'podcasts', label:'Podcasts', description:'Podcast search and episodes', icon:'' },
    { id:'pl-recent', label:'Recently Added', description:'Tracks added after your first library scan', icon:'' },
    { id:'pl-top', label:'Top 25 Most Played', description:'Most played tracks', icon:'' },
  ];
  function makeSidebarCustomId(prefix='divider') {
    try { return `${prefix}-${crypto.randomUUID()}`; } catch { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }
  }
  function loadNavigationPrefs() {
    const defaults = SIDEBAR_NAV_DEFS.map(d => d.id);
    let order = defaults.slice();
    let hidden = new Set();
    let labels = {};
    let custom = [];
    let meta = {};
    let pinned = new Set(['music']);
    let pinnedOrder = ['music'];
    let hasSavedNavigation = false;
    try {
      hasSavedNavigation = localStorage.getItem(SIDEBAR_NAV_KEY) !== null;
      const saved = JSON.parse(localStorage.getItem(SIDEBAR_NAV_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        if (Array.isArray(saved.order)) saved.order = saved.order.map(id => id === 'nowplaying' ? 'sandbox' : id);
        if (Array.isArray(saved.hidden)) saved.hidden = saved.hidden.map(id => id === 'nowplaying' ? 'sandbox' : id);
        if (Array.isArray(saved.pinned)) saved.pinned = saved.pinned.map(id => id === 'nowplaying' ? 'sandbox' : id);
        if (Array.isArray(saved.pinnedOrder)) saved.pinnedOrder = saved.pinnedOrder.map(id => id === 'nowplaying' ? 'sandbox' : id);
        if (saved.labels && typeof saved.labels === 'object' && saved.labels.nowplaying && !saved.labels.sandbox) saved.labels.sandbox = saved.labels.nowplaying;
        if (saved.meta && typeof saved.meta === 'object' && saved.meta.nowplaying && !saved.meta.sandbox) saved.meta.sandbox = saved.meta.nowplaying;
      }
      if (Array.isArray(saved?.custom)) {
        custom = saved.custom.filter(x => x && (x.type === 'divider' || x.type === 'playlist') && typeof x.id === 'string' && !defaults.includes(x.id)).map(x => x.type === 'playlist'
          ? ({ id:x.id, type:'playlist', playlistId:String(x.playlistId || ''), label:typeof x.label==='string' ? x.label : 'Playlist', icon:typeof x.icon==='string' ? x.icon : '', description:typeof x.description==='string' ? x.description : 'Playlist' })
          : ({ id:x.id, type:'divider', label:typeof x.label==='string' ? x.label : '' }));
        custom = custom.filter(x => x.type !== 'playlist' || x.playlistId);
      }
      const validIds = [...defaults, ...custom.map(x => x.id)];
      if (Array.isArray(saved?.order)) {
        order = saved.order.filter(id => validIds.includes(id));
        [...defaults, ...custom.map(x => x.id)].forEach(id => { if (!order.includes(id)) order.push(id); });
      } else {
        order = [...defaults, ...custom.map(x => x.id)];
      }
      if (Array.isArray(saved?.hidden)) hidden = new Set(saved.hidden.filter(id => defaults.includes(id)));
      if (saved?.meta && typeof saved.meta === 'object') {
        for (const [key,value] of Object.entries(saved.meta)) {
          if (!value || typeof value !== 'object') continue;
          const icon = typeof value.icon === 'string' ? value.icon : '';
          const shuffleOnEnter = value.shuffleOnEnter === true;
          const displayView = ['albums','songs','artists'].includes(value.displayView) ? value.displayView : '';
          if (icon || shuffleOnEnter || displayView) meta[key] = { icon, shuffleOnEnter, ...(displayView ? { displayView } : {}) };
        }
      }
      if (Array.isArray(saved?.pinned)) pinned = new Set(saved.pinned.filter(id => validIds.includes(id)));
      if (Array.isArray(saved?.pinnedOrder)) pinnedOrder = saved.pinnedOrder.filter(id => validIds.includes(id));
      else pinnedOrder = [...pinned];
      for (const id of [...pinned]) if (!pinnedOrder.includes(id)) pinnedOrder.push(id);
      pinnedOrder = pinnedOrder.filter(id => pinned.has(id));
      if (!pinnedOrder.includes('music')) pinnedOrder.unshift('music');
      pinned.add('music');
      if (saved?.labels && typeof saved.labels === 'object') {
        for (const id of defaults) if (typeof saved.labels[id] === 'string' && saved.labels[id].trim()) labels[id] = saved.labels[id].trim();
      }
    } catch {}

    // Brand-new profiles start with the compact sidebar layout shown in the
    // reference UI. The dividers are persisted as ordinary custom divider entries
    // after the first preference save, so existing users are never rewritten.
    if (!hasSavedNavigation) {
      const dividerOne = { id:'divider-top', type:'divider', label:'' };
      const dividerTwo = { id:'divider-bottom', type:'divider', label:'' };
      custom = [dividerOne, dividerTwo];
      order = ['music', 'pl-explorer', dividerOne.id, 'pl-top', 'podcasts', 'history', 'pl-recent', dividerTwo.id, 'sandbox', 'yearly-wrap'];
    }
    order = order.filter(id => id !== 'explorer');
    hidden.delete('explorer');
    // One-time migration: older navigation builds could leave Podcasts in the
    // pinned set. Podcasts is a normal sidebar destination by default; users can
    // explicitly pin it again later, and the migration marker prevents a future
    // launch from undoing that choice.
    try {
      const migrationKey = 'beehive:navigation-podcast-unpin-v1';
      if (localStorage.getItem(migrationKey) !== '1') {
        pinned.delete('podcasts');
        pinnedOrder = pinnedOrder.filter(id => id !== 'podcasts');
        localStorage.setItem(migrationKey, '1');
      }
    } catch {}
    // Build 200: migrate the former Now Playing destination to the generic Sandbox launcher.
    // Keep the user's order/pinning intact and avoid creating a duplicate destination.
    if (order.includes('nowplaying')) order = order.map(id => id === 'nowplaying' ? 'sandbox' : id);
    if (hidden.has('nowplaying')) { hidden.delete('nowplaying'); hidden.add('sandbox'); }
    if (pinned.has('nowplaying')) { pinned.delete('nowplaying'); pinned.add('sandbox'); }
    pinnedOrder = pinnedOrder.map(id => id === 'nowplaying' ? 'sandbox' : id);
    return { order, hidden, labels, custom, meta, pinned, pinnedOrder };
  }
  let sidebarNavigation = loadNavigationPrefs();
  // Playlists is a permanent top-bar destination. Keep it immediately after Music,
  // and keep an already-pinned Favorites projection immediately after it. Other
  // pinned destinations retain their relative order after these fixed entries.
  function enforceLockedTopbarPins() {
    if (!(sidebarNavigation.pinned instanceof Set)) sidebarNavigation.pinned = new Set(sidebarNavigation.pinned || []);
    if (!Array.isArray(sidebarNavigation.pinnedOrder)) sidebarNavigation.pinnedOrder = [];
    sidebarNavigation.pinned.add('music');
    sidebarNavigation.pinned.add('pl-explorer');
    const order = sidebarNavigation.pinnedOrder.filter(id => sidebarNavigation.pinned.has(id) && sidebarEntry(id)?.type !== 'divider' && id !== 'music' && id !== 'pl-explorer');
    const favoritesId = sidebarNavigation.pinnedOrder.find(id => id !== 'music' && id !== 'pl-explorer' && id === 'pl-favorites') || null;
    sidebarNavigation.pinnedOrder = ['music', 'pl-explorer'];
    if (favoritesId && sidebarNavigation.pinned.has(favoritesId)) sidebarNavigation.pinnedOrder.push(favoritesId);
    for (const id of order) if (!sidebarNavigation.pinnedOrder.includes(id)) sidebarNavigation.pinnedOrder.push(id);
    // A canonical/custom Favorites playlist uses a generated sidebar id, so if
    // it is pinned, place that projection directly after the locked Playlists tab.
    const favoritePlaylist = playlists.find(p => p?.systemKey === 'star-favorites' || p?.id === 'hive-star-favorites');
    const favoritePlaylistId = String(favoritePlaylist?.id || 'hive-star-favorites');
    const favoriteEntry = sidebarNavigation.custom.find(x => x?.type === 'playlist' && String(x.playlistId || '') === favoritePlaylistId);
    if (favoriteEntry?.id && sidebarNavigation.pinned.has(favoriteEntry.id)) {
      sidebarNavigation.pinnedOrder = sidebarNavigation.pinnedOrder.filter(id => id !== favoriteEntry.id);
      sidebarNavigation.pinnedOrder.splice(2, 0, favoriteEntry.id);
    }
    return sidebarNavigation.pinnedOrder;
  }
  enforceLockedTopbarPins();
  // Music is the non-removable primary destination. If an older/corrupt preference
  // set hid every destination, recover a usable sidebar before first paint.
  if (sidebarNavigation.hidden.size >= SIDEBAR_NAV_DEFS.length) sidebarNavigation.hidden.delete('music');
  function saveNavigationPrefs() {
    try {
      localStorage.setItem(SIDEBAR_NAV_KEY, JSON.stringify({
        order:sidebarNavigation.order,
        hidden:[...sidebarNavigation.hidden],
        labels:sidebarNavigation.labels,
        custom:sidebarNavigation.custom,
        meta:sidebarNavigation.meta || {},
        pinned:[...sidebarNavigation.pinned],
        pinnedOrder:[...sidebarNavigation.pinnedOrder]
      }));
    } catch {}
    persistUiStateSoon();
  }
  const FAVORITES_SIDEBAR_MIGRATION_KEY = 'beehive:favorites-sidebar-canonical-v1';
  function migrateFavoritesSidebarToCanonicalPlaylist() {
    const favorites = playlists.find(p => p?.systemKey === 'star-favorites' || p?.id === 'hive-star-favorites');
    if (!favorites) return false;
    const canonicalId = String(favorites.id);
    let changed = false;
    const legacyDefaultPresent = sidebarNavigation.order.includes('pl-favorites');
    const legacyDefaultPinned = sidebarNavigation.pinned.has('pl-favorites') || sidebarNavigation.pinnedOrder.includes('pl-favorites');
    const legacyDefaultPinnedOrderIndex = sidebarNavigation.pinnedOrder.indexOf('pl-favorites');
    const customMatches = sidebarNavigation.custom.filter(x => x?.type === 'playlist' && String(x.playlistId) === canonicalId);
    let canonicalEntry = customMatches[0] || null;

    // Remove the old special/default sidebar destination and every duplicate
    // custom entry. The sidebar must point at the same persisted playlist object.
    sidebarNavigation.order = sidebarNavigation.order.filter(id => id !== 'pl-favorites');
    sidebarNavigation.hidden.delete('pl-favorites');
    sidebarNavigation.pinned.delete('pl-favorites');
    sidebarNavigation.pinnedOrder = sidebarNavigation.pinnedOrder.filter(id => id !== 'pl-favorites');
    if (legacyDefaultPresent) changed = true;

    const customIds = new Set(customMatches.map(x => String(x.id)));
    const canonicalWasInOrder = customMatches.some(x => sidebarNavigation.order.includes(x.id));
    if (customMatches.length > 1) {
      const keepId = canonicalEntry.id;
      sidebarNavigation.custom = sidebarNavigation.custom.filter(x =>
        !(x?.type === 'playlist' && String(x.playlistId) === canonicalId && x.id !== keepId)
      );
      changed = true;
    }
    if (customIds.size) {
      const nextOrder = sidebarNavigation.order.filter(id => !customIds.has(String(id)));
      if (nextOrder.length !== sidebarNavigation.order.length) changed = true;
      sidebarNavigation.order = nextOrder;
    }

    let initialized = false;
    try { initialized = localStorage.getItem(FAVORITES_SIDEBAR_MIGRATION_KEY) === '1'; } catch {}
    if (!canonicalEntry) {
      const id = playlistSidebarEntryId(favorites);
      canonicalEntry = {
        id,
        type: 'playlist',
        playlistId: canonicalId,
        label: typeof favorites.label === 'string' && favorites.label.trim() ? favorites.label : 'Favorites',
        icon: typeof favorites.icon === 'string' && favorites.icon ? favorites.icon : '★',
        description: 'Auto Playlist'
      };
      sidebarNavigation.custom.push(canonicalEntry);
      changed = true;
    } else {
      // The playlist owns presentation, but older builds could persist a rich
      // Favorites label only in the sidebar projection. If the canonical
      // playlist record still has the untouched plain default, recover that
      // user-selected rich label before normalizing the projection. This makes
      // Favorites as durable as Music/Playlists, whose label styles live in
      // sidebarNavigation.labels.
      const playlistLabel = typeof favorites.label === 'string' ? favorites.label.trim() : '';
      const projectedLabel = typeof canonicalEntry.label === 'string' ? canonicalEntry.label.trim() : '';
      const playlistIsDefault = !playlistLabel || playlistLabel === 'Favorites';
      const projectionIsRich = /<span\b[^>]*class=[\"']?[^>]*hive-(?:glow|pulse|rainbow)/i.test(projectedLabel);
      if (playlistIsDefault && projectionIsRich) {
        favorites.label = projectedLabel;
        try {
          // Persist the recovered presentation through the same canonical
          // playlist store used by Playlist Info rather than leaving it as a
          // renderer-only fix.
          window.beehive.savePlaylist({ ...favorites, label: projectedLabel }).then(saved => {
            if (!saved) return;
            playlists = playlists.map(item => String(item.id) === String(saved.id) ? saved : item);
          }).catch(() => {});
        } catch {}
      }
      const nextLabel = (typeof favorites.label === 'string' && favorites.label.trim()) ? favorites.label : 'Favorites';
      const nextIcon = (typeof favorites.icon === 'string' && favorites.icon) ? favorites.icon : '★';
      const nextDescription = typeof canonicalEntry.description === 'string' && canonicalEntry.description.trim()
        ? canonicalEntry.description
        : 'Auto Playlist';
      if (canonicalEntry.label !== nextLabel || canonicalEntry.icon !== nextIcon || canonicalEntry.description !== nextDescription) {
        canonicalEntry.label = nextLabel;
        canonicalEntry.icon = nextIcon;
        canonicalEntry.description = nextDescription;
        changed = true;
      }
    }

    if (!sidebarNavigation.order.includes(canonicalEntry.id)) {
      // On the first creation/legacy migration, Favorites is automatically
      // pinned. Thereafter a user can remove it and that choice persists.
      const shouldAutoPin = !initialized || legacyDefaultPresent || canonicalWasInOrder;
      if (shouldAutoPin) {
        const insertAt = sidebarNavigation.order.indexOf('pl-explorer');
        sidebarNavigation.order.splice(insertAt >= 0 ? insertAt + 1 : sidebarNavigation.order.length, 0, canonicalEntry.id);
        if (!sidebarNavigation.pinned.has(canonicalEntry.id)) sidebarNavigation.pinned.add(canonicalEntry.id);
        if (!sidebarNavigation.pinnedOrder.includes(canonicalEntry.id)) {
          const pinAt = legacyDefaultPinnedOrderIndex >= 0 ? legacyDefaultPinnedOrderIndex : sidebarNavigation.pinnedOrder.length;
          sidebarNavigation.pinnedOrder.splice(Math.max(0, Math.min(pinAt, sidebarNavigation.pinnedOrder.length)), 0, canonicalEntry.id);
        }
        changed = true;
      }
    }

    // The legacy Favorites destination was pinned by older navigation schemas.
    // Transfer that pin to the canonical playlist entry rather than silently
    // dropping the user's Favorites tab during the migration. Once migrated,
    // later launches preserve an explicit user unpin.
    if (legacyDefaultPinned) {
      if (!sidebarNavigation.pinned.has(canonicalEntry.id)) {
        sidebarNavigation.pinned.add(canonicalEntry.id);
        changed = true;
      }
      if (!sidebarNavigation.pinnedOrder.includes(canonicalEntry.id)) {
        const insertAt = legacyDefaultPinnedOrderIndex >= 0 ? legacyDefaultPinnedOrderIndex : sidebarNavigation.pinnedOrder.length;
        sidebarNavigation.pinnedOrder.splice(insertAt, 0, canonicalEntry.id);
        changed = true;
      }
    }
    sidebarNavigation.pinnedOrder = sidebarNavigation.pinnedOrder.filter(id => id !== 'pl-favorites');
    sidebarNavigation.pinned.delete('pl-favorites');

    try { localStorage.setItem(FAVORITES_SIDEBAR_MIGRATION_KEY, '1'); } catch {}
    if (changed) {
      saveNavigationPrefs();
      renderSidebarNavigation();
      renderNavigationEditors();
    }
    return changed;
  }

  function sidebarMetaKey(id) { return `nav:${String(id || '')}`; }
  function sidebarIcon(id) {
    const custom = sidebarCustom(id);
    if (custom?.type === 'playlist') {
      const pl = sidebarPlaylistForEntry(id);
      return String(pl?.icon || custom.icon || '');
    }
    return String(sidebarNavigation?.meta?.[sidebarMetaKey(id)]?.icon || custom?.icon || '');
  }
  function applySidebarAutoShuffle(key) {
    // Historical name retained for callers, but this is no longer allowed to
    // mutate the player's transport Shuffle state. Every time the user enters
    // a collection, start a fresh visual permutation when the preference is on.
    visualShuffleOrders.delete(visualShuffleKeyForSidebar(key));
    // A previous manual header sort belongs to the collection that was just
    // left. Clear that one-shot override so its configured opening shuffle can
    // apply again the next time it is rendered/opened.
    songSortOverrideContext = '';
  }
  let uiStateSaveTimer = 0;
  function serializeUiState() {
    // label/icon are saved alongside baseLabel/baseIcon: baseLabel is the
    // tab's generic default ("Music"), while label is what updateActiveTabLabel()
    // keeps in sync with the tab's actual live context (a search term, an
    // expanded album's title, a playlist name). Saving only baseLabel meant
    // every restored tab showed its default instead of where it actually was.
    return { sidebarNavigation:{order:sidebarNavigation.order,hidden:[...sidebarNavigation.hidden],labels:sidebarNavigation.labels,custom:sidebarNavigation.custom,meta:sidebarNavigation.meta||{},pinned:[...sidebarNavigation.pinned],pinnedOrder:[...sidebarNavigation.pinnedOrder]}, layout: { ...layout }, activeTabId, tabs:tabs.map(t=>({id:t.id,kind:t.kind,label:t.label||t.baseLabel||'',icon:t.icon||t.baseIcon||'',baseLabel:t.baseLabel||'',baseIcon:t.baseIcon||'',hidden:!!t.hidden,closable:!!t.closable,state:t.state||null})) };
  }
  function persistUiStateSoon() { clearTimeout(uiStateSaveTimer); uiStateSaveTimer=setTimeout(()=>{window.beehive.saveUiState?.(serializeUiState()).catch?.(()=>{});},250); }
  async function hydrateUiStateFromConfig() {
    try {
      const config=await window.beehive.getConfig(), ui=config?.uiState; if(!ui||typeof ui!=='object') return;
      if (ui.layout && typeof ui.layout === 'object') { layout = { ...layout, ...ui.layout }; isLocked = !!layout.lockResize; applySavedSizes(); updateLockUI(); }
      if(ui.sidebarNavigation&&typeof ui.sidebarNavigation==='object') { const saved=ui.sidebarNavigation; if(Array.isArray(saved.custom)) sidebarNavigation.custom=saved.custom.filter(x=>x&&(x.type==='divider'||x.type==='playlist')&&typeof x.id==='string'&& (x.type!=='playlist'||x.playlistId)); const valid=new Set(SIDEBAR_NAV_DEFS.map(d=>d.id).concat(sidebarNavigation.custom.map(x=>x.id))); if(Array.isArray(saved.order)) sidebarNavigation.order=saved.order.filter(id=>valid.has(id)); if(Array.isArray(saved.hidden)) sidebarNavigation.hidden=new Set(saved.hidden.filter(id=>valid.has(id))); if(saved.labels&&typeof saved.labels==='object') sidebarNavigation.labels={...sidebarNavigation.labels,...saved.labels}; if(saved.meta&&typeof saved.meta==='object') sidebarNavigation.meta=saved.meta; if(Array.isArray(saved.pinned)) sidebarNavigation.pinned=new Set(saved.pinned.filter(id=>valid.has(id))); if(Array.isArray(saved.pinnedOrder)) sidebarNavigation.pinnedOrder=saved.pinnedOrder.filter(id=>valid.has(id)); else sidebarNavigation.pinnedOrder=sidebarNavigation.order.filter(id=>sidebarNavigation.pinned.has(id)); for(const id of sidebarNavigation.pinned) if(!sidebarNavigation.pinnedOrder.includes(id)) sidebarNavigation.pinnedOrder.push(id); sidebarNavigation.pinnedOrder=sidebarNavigation.pinnedOrder.filter(id=>sidebarNavigation.pinned.has(id)); if(!sidebarNavigation.pinned.has('music')) sidebarNavigation.pinned.add('music'); if(!sidebarNavigation.pinnedOrder.includes('music')) sidebarNavigation.pinnedOrder.unshift('music'); if(!sidebarNavigation.order.includes('music')) sidebarNavigation.order.unshift('music'); }
      if(Array.isArray(ui.tabs)) {
        const byId=new Map(ui.tabs.map(x=>[x.id,x]));
        for(const t of tabs){
          const legacyId = t.navId === 'music' ? 'tab-music' : t.navId === 'pl-explorer' ? 'tab-playlists' : t.navId === 'podcasts' ? 'tab-podcasts' : null;
          const saved=byId.get(t.id) || (legacyId ? byId.get(legacyId) : null);
          if(saved?.state)t.state=saved.state;
          if(saved?.baseLabel && t.navId !== 'music')t.baseLabel=saved.baseLabel;
          if(saved?.baseIcon!=null && t.navId !== 'music')t.baseIcon=saved.baseIcon;
          // The live label (what the tab actually showed -- a search term, an
          // expanded album's title) is restored here too, not just the
          // generic base label. The active tab's own restoreTabState() call
          // below recomputes this correctly regardless; this only matters
          // for tabs that stay inactive/background after restore.
          if(saved?.label)t.label=saved.label;
          if(saved?.icon!=null)t.icon=saved.icon;
        }
        // The loop above only patches state onto tabs that already exist
        // (the canonical/pinned sidebar tabs, rebuilt fresh every launch by
        // syncCanonicalNavigationTabs() below). A closable "extra" tab --
        // opened via the + button or by entering a Favorites/playlist from
        // the sidebar, tracked only in this saved array -- was never
        // recreated, so it silently vanished on every restart even though
        // its state (including which album was expanded and scroll
        // position) was already being saved correctly. Recreate any of
        // those that don't correspond to a tab that already exists; adding
        // them to `tabs` now, before syncCanonicalNavigationTabs() runs,
        // lets its own extras-preservation filter pick them up naturally.
        const existingIds = new Set(tabs.map(t => t.id));
        for (const saved of ui.tabs) {
          if (!saved?.id || !saved.closable || saved.kind !== 'music' || existingIds.has(saved.id)) continue;
          if (!saved.state || typeof saved.state !== 'object') continue;
          tabs.push({
            id: saved.id,
            label: saved.label || saved.baseLabel || 'Untitled',
            icon: saved.icon || saved.baseIcon || '',
            kind: 'music',
            closable: true,
            baseLabel: saved.baseLabel || 'Untitled',
            baseIcon: saved.baseIcon || '',
            state: saved.state,
            dom: null
          });
          const seqMatch = /^tab-extra-(\d+)$/.exec(saved.id);
          if (seqMatch) tabSeq = Math.max(tabSeq, Number(seqMatch[1]));
        }
      }
      const savedActiveRaw=String(ui.activeTabId||'');
      const savedActive = savedActiveRaw === 'tab-music' ? 'navtab-music' : savedActiveRaw === 'tab-playlists' ? 'navtab-pl-explorer' : savedActiveRaw === 'tab-podcasts' ? 'navtab-podcasts' : savedActiveRaw;
      // A canonical sidebar context remains addressable even when it is unpinned.
      // Pinning only controls top-bar projection; it must never make the last
      // selected sidebar destination non-restorable.
      enforceLockedTopbarPins();
      syncCanonicalNavigationTabs();
      if(savedActive&&tabs.some(t=>t.id===savedActive)) activeTabId=savedActive;
      renderSidebarNavigation();renderTabs();const active=getActiveTab();if(active)restoreTabState(active);
    } catch {}
  }
  function sidebarDef(id) { return SIDEBAR_NAV_DEFS.find(d => d.id === id) || null; }
  function sidebarCustom(id) { return sidebarNavigation.custom.find(x => x.id === id) || null; }
  function sidebarEntry(id) { return sidebarDef(id) || sidebarCustom(id); }
  function sidebarPlaylistForEntry(id) {
    const entry = sidebarCustom(id);
    if (!entry || entry.type !== 'playlist') return null;
    return playlists.find(p => String(p.id) === String(entry.playlistId)) || null;
  }
  function syncPlaylistSidebarPresentation() {
    let changed = false;
    sidebarNavigation.custom = sidebarNavigation.custom.map(entry => {
      if (entry?.type !== 'playlist') return entry;
      const pl = playlists.find(p => String(p.id) === String(entry.playlistId));
      if (!pl) return entry;
      const label = playlistLabel(pl) || entry.label || 'Playlist';
      const icon = String(pl.icon || '');
      if (entry.label === label && String(entry.icon || '') === icon) return entry;
      changed = true;
      return {...entry, label, icon};
    });
    return changed;
  }
  function refreshPlaylistTabPresentation(pl) {
    if (!pl) return;
    const label = playlistLabel(pl) || pl.name || 'Playlist';
    const icon = String(pl.icon || '');
    for (const tab of tabs) {
      if (tab?.kind !== 'music') continue;
      const tabPlaylistId = tab.state?.activePlaylistId;
      if (tabPlaylistId == null || String(tabPlaylistId) !== String(pl.id)) continue;
      tab.baseLabel = label;
      tab.label = label;
      tab.baseIcon = icon;
      tab.icon = icon;
      tab.state = {...(tab.state || {}), specialView:'playlist', activePlaylistId:pl.id,
        viewMode:['albums','songs','artists'].includes(pl.displayView) ? pl.displayView : (tab.state?.viewMode || 'albums')};
    }
  }

  function sidebarSize(id) { return 34; }
  function sidebarLabel(id) {
    const custom = sidebarCustom(id);
    if (custom?.type === 'playlist') return playlistLabel(sidebarPlaylistForEntry(id)) || custom.label || 'Playlist';
    const def = sidebarDef(id);
    if (!def) return custom?.label || '';
    if (id === 'pl-favorites') return 'Favorites';
    return sidebarNavigation.labels[id] || def.label;
  }
  function visibleSidebarEntries() {
    return sidebarNavigation.order.map(sidebarEntry).filter(Boolean).filter(entry => entry.type === 'divider' || !sidebarNavigation.hidden.has(entry.id));
  }
  function renderSidebarNavigation() {
    const host = document.getElementById('sidebar-nav-list');
    if (!host) return;
    host.innerHTML = '';
    for (const def of visibleSidebarEntries()) {
      if (def.type === 'divider') {
        const divider = document.createElement('div');
        divider.className = `sidebar-visual-divider${def.label ? '' : ' is-blank'}`;
        divider.dataset.nav = def.id;
        divider.draggable = true;
        divider.innerHTML = def.label ? `<span class="sidebar-divider-label"></span>` : '';
        if (def.label) setRichLabel(divider.querySelector('.sidebar-divider-label'), def.label);
        divider.title = def.label ? `${def.label} divider` : 'Divider';
        divider.addEventListener('dragstart', e => { divider.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', `sidebar:${def.id}`); });
        divider.addEventListener('dragover', e => {
          const raw=e.dataTransfer.types?.includes?.('text/plain'); if(!raw) return; const text=e.dataTransfer.getData('text/plain')||''; if(!text.startsWith('sidebar:')) return;
          e.preventDefault(); const r=divider.getBoundingClientRect(); const after=e.clientY>=r.top+r.height/2;
          host.querySelectorAll('.drop-before,.drop-after').forEach(x=>x.classList.remove('drop-before','drop-after'));
          divider.classList.add(after?'drop-after':'drop-before'); divider.dataset.dropAfter=after?'1':'0';
        });
        divider.addEventListener('drop', e => {
          const text=e.dataTransfer.getData('text/plain')||''; if(!text.startsWith('sidebar:')) return; e.preventDefault();
          const dragged=text.slice(8), target=def.id; if(dragged===target) return;
          const from=sidebarNavigation.order.indexOf(dragged), oldTo=sidebarNavigation.order.indexOf(target); if(from<0||oldTo<0) return;
          const after=divider.dataset.dropAfter==='1'; sidebarNavigation.order.splice(from,1); let to=sidebarNavigation.order.indexOf(target); if(after)to++;
          sidebarNavigation.order.splice(Math.max(0,Math.min(sidebarNavigation.order.length,to)),0,dragged); saveNavigationPrefs(); renderSidebarNavigation(); renderNavigationEditors();
        });
        divider.addEventListener('dragend',()=>{host.querySelectorAll('.dragging,.drop-before,.drop-after').forEach(x=>x.classList.remove('dragging','drop-before','drop-after')); host.querySelectorAll('[data-drop-after]').forEach(x=>delete x.dataset.dropAfter);});
        divider.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e.clientX,e.clientY,[
          {label:'Rename divider',action:()=>renameSidebarEntry(def.id)},
          {label:'Remove divider',action:()=>removeSidebarDivider(def.id)}
        ]); });
        host.appendChild(divider);
        continue;
      }
      const item = document.createElement('div');
      item.className = 'sidebar-item';
      item.dataset.nav = def.id;
      item.style.setProperty('--sidebar-nav-size', `${sidebarSize(def.id)}px`);
      item.draggable = true;
      const navIcon = sidebarIcon(def.id) || def.icon || def.icon || '';
      item.innerHTML = `${navIcon ? `<span class="sidebar-nav-icon">${escapeHtml(navIcon)}</span>` : ''}<span class="sidebar-nav-label"></span>`;
      setRichLabel(item.querySelector('.sidebar-nav-label'), sidebarLabel(def.id));
      item.addEventListener('click', async () => {
        const nav = item.dataset.nav;
        if (def.type === 'playlist') {
          const pl = sidebarPlaylistForEntry(nav);
          if (!pl) { showAppNotice('That playlist no longer exists. Remove it from Settings → Navigation.'); return; }
          return openPlaylistFromSidebar(pl, nav);
        }
        if (nav === 'podcasts') { await showSpecialNavigation('podcasts'); return; }
        if (nav === 'sandbox') { await showSpecialNavigation(nav); return; }
        if (nav === 'explorer') return;
        if (nav === 'music') {
          await showSpecialNavigation('music');
          return;
        }
        await showSpecialNavigation(nav);
      });
      item.addEventListener('dblclick', async e => {
        e.preventDefault();
        const nav = item.dataset.nav;
        if (def.type === 'playlist') {
          const pl = sidebarPlaylistForEntry(nav);
          if (!pl) { showAppNotice('That playlist no longer exists. Remove it from Settings → Navigation.'); return; }
          item.classList.add('active');
          await playPlaylist(pl);
          return;
        }
        if (['music','explorer','history','pl-recent','pl-top','pl-favorites','pl-explorer'].includes(nav)) await playSidebarCollection(nav);
      });
      item.addEventListener('contextmenu', async e => {
        const nav=item.dataset.nav;
        if(nav==='podcasts') {
          e.preventDefault();
          const tracks = await getSidebarCollectionTracks(nav);
          showContextMenu(e.clientX,e.clientY,sidebarContextMenuItems(nav, tracks, 'Podcast search and saved shows', { play: false, queue: false }));
          return;
        }
        if(def.type === 'playlist') {
          e.preventDefault();
          const pl = playlists.find(p => String(p.id) === String(def.playlistId));
          if (!pl) { showContextMenu(e.clientX,e.clientY,[{label:'Remove from sidebar',action:()=>removePlaylistFromSidebar(def.id)}]); return; }
          showContextMenu(e.clientX,e.clientY,[
            {label:'Play playlist',action:()=>playPlaylist(pl)},
            {label:'Queue playlist',action:()=>{const tracks=tracksForPlaylist(pl); if(!tracks.length){showAppNotice('This playlist has no tracks.');return;} addTracksToQueue(tracks);}},
            {label:'Info',action:()=>showPlaylistInfo(pl)},
            {label:'Remove from sidebar',action:()=>removePlaylistFromSidebar(def.id)}
          ]);
          return;
        }
        const sidebarNames={
          music:'Music',
          explorer:'Music Explorer',
          history:'History',
          'yearly-wrap':'Yearly Wrap',
          'pl-explorer':'Playlists',
          'pl-favorites':'Favorites',
          'pl-recent':'Recently Added',
          'pl-top':'Top 25 Most Played',
          sandbox:'Sandbox'
        };
        if(!sidebarNames[nav]) return;
        e.preventDefault();
        const tracks = await getSidebarCollectionTracks(nav);
        showContextMenu(e.clientX,e.clientY,sidebarContextMenuItems(nav, tracks, sidebarNames[nav]));
      });
      item.addEventListener('dragstart', e => {
        item.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', `sidebar:${def.id}`);
      });
      item.addEventListener('dragover', e => {
        const raw=e.dataTransfer.types?.includes?.('text/plain'); if(!raw) return; e.preventDefault();
        const r=item.getBoundingClientRect(); const after=e.clientY >= r.top+r.height/2;
        host.querySelectorAll('.drop-before,.drop-after').forEach(x=>x.classList.remove('drop-before','drop-after'));
        item.classList.add(after?'drop-after':'drop-before'); item.dataset.dropAfter=after?'1':'0';
      });
      item.addEventListener('drop', e => {
        const text=e.dataTransfer.getData('text/plain') || ''; if(!text.startsWith('sidebar:')) return; e.preventDefault();
        const dragged=text.slice(8), target=def.id; if(dragged===target) return;
        const from=sidebarNavigation.order.indexOf(dragged), oldTo=sidebarNavigation.order.indexOf(target); if(from<0||oldTo<0) return;
        const after=item.dataset.dropAfter==='1'; sidebarNavigation.order.splice(from,1); let to=sidebarNavigation.order.indexOf(target); if(after) to++;
        sidebarNavigation.order.splice(Math.max(0,Math.min(sidebarNavigation.order.length,to)),0,dragged); saveNavigationPrefs(); renderSidebarNavigation(); renderNavigationEditors();
        document.querySelector(`.sidebar-item[data-nav="${CSS.escape(dragged)}"]`)?.classList.add('active');
      });
      item.addEventListener('dragend', () => {
        host.querySelectorAll('.dragging,.drop-before,.drop-after').forEach(x=>x.classList.remove('dragging','drop-before','drop-after'));
        host.querySelectorAll('[data-drop-after]').forEach(x=>delete x.dataset.dropAfter);
      });
      host.appendChild(item);
    }
    el.sidebarItems = Array.from(host.querySelectorAll('.sidebar-item'));
  }
  async function renameSidebarEntry(id) {
    const entry=sidebarEntry(id); if(!entry || entry.type==='divider' && id==='') return;
    const current=sidebarLabel(id);
    const value=await themedPrompt(`Choose the label. Safe rich text is supported. Example: <span class="hive-glow" style="color:#ffd84a">MUSIC</span>`, current, entry.type==='divider' ? 'Rename divider' : 'Rename sidebar destination');
    if(value == null) return;
    const label=String(value).trim();
    if(entry.type !== 'divider' && !label) { showAppNotice('A sidebar label cannot be empty.'); return; }
    if(entry.type==='divider' || entry.type==='playlist') entry.label=label;
    else sidebarNavigation.labels[id]=label;
    saveNavigationPrefs(); renderSidebarNavigation(); renderNavigationEditors();
  }
  async function addSidebarDivider() {
    const label=await themedPrompt('Optional label for this divider. Leave it blank for a simple line.', '', 'Add divider');
    if(label == null) return;
    const id=makeSidebarCustomId();
    const entry={id,type:'divider',label:String(label).trim()};
    sidebarNavigation.custom.push(entry);
    const musicIndex=sidebarNavigation.order.indexOf('music');
    const insertAt=musicIndex>=0 ? musicIndex+1 : sidebarNavigation.order.length;
    sidebarNavigation.order.splice(insertAt,0,id);
    saveNavigationPrefs(); renderSidebarNavigation(); renderNavigationEditors();
  }
  async function removeSidebarDivider(id) {
    const entry=sidebarCustom(id); if(!entry) return;
    const isPlaylist=entry.type==='playlist';
    const ok=await themedDialog({title:isPlaylist?'Remove playlist from sidebar?':'Remove divider?',message:entry.label?`Remove the “${entry.label}” ${isPlaylist?'playlist':'divider'} from the sidebar?`:`Remove this ${isPlaylist?'playlist':'divider'} from the sidebar?`,mode:'confirm'});
    if(!ok) return;
    sidebarNavigation.custom=sidebarNavigation.custom.filter(x=>x.id!==id);
    sidebarNavigation.order=sidebarNavigation.order.filter(x=>x!==id);
    saveNavigationPrefs(); renderSidebarNavigation(); renderNavigationEditors();
  }
  // ---------------- pinned navigation tabs ----------------
  // The top bar is a projection of the Navigation layout. There is deliberately
  // no second top-tab configuration model: pinning a sidebar destination is the
  // single source of truth for whether it appears in the top bar.
  function saveTopTabPrefs() {
    saveNavigationPrefs();
  }
  function loadTopTabPrefs() { return {}; }
  let tabs = [];
  let activeTabId = 'navtab-music';
  let tabSeq = 0;
  let restoringTabState = false;

  function pinnedTabId(nav){ return `navtab-${String(nav)}`; }
  function navigationTabKind(nav){
    const entry = sidebarEntry(nav);
    if (entry?.type === 'playlist') return 'music';
    if (nav === 'music' || nav === 'history' || nav === 'pl-recent' || nav === 'pl-top' || nav === 'pl-favorites') return 'music';
    if (nav === 'pl-explorer') return 'playlists';
    if (nav === 'podcasts') return 'podcasts';
    if (nav === 'sandbox') return 'navigation';
    return 'navigation';
  }
  function navigationSpecialView(nav){
    const entry = sidebarEntry(nav);
    if (entry?.type === 'playlist') return 'playlist';
    if (nav === 'music') return null;
    if (nav === 'history') return 'history';
    if (nav === 'pl-recent') return 'recent';
    if (nav === 'pl-top') return 'top';
    if (nav === 'pl-favorites') return 'playlist';
    if (nav === 'sandbox') return 'sandbox';
    if (nav === 'yearly-wrap') return 'yearly-wrap';
    if (nav === 'podcasts') return 'podcasts';
    return null;
  }

  function navigationContextState(nav, existing = null){
    const entry = sidebarEntry(nav);
    const playlist = entry?.type === 'playlist' ? sidebarPlaylistForEntry(nav) : null;
    const old = existing?.state || {};
    const viewMode = ['albums','songs','artists'].includes(old.viewMode)
      ? old.viewMode
      : playlist && ['albums','songs','artists'].includes(playlist.displayView)
        ? playlist.displayView
        : nav === 'history' ? 'songs' : 'albums';
    const fixedSpecialView = navigationSpecialView(nav);
    // Music is itself a canonical browser context and can contain legitimate
    // sub-contexts (album focus, folder, search, etc.). Re-syncing the sidebar
    // projection must never erase that state merely because pinning changed or
    // playlists finished loading.
    const specialView = nav === 'music' ? (old.specialView || null) : fixedSpecialView;
    return {
      searchTerm: String(old.searchTerm || ''),
      artistSearchTerm: String(old.artistSearchTerm || ''),
      albumYearDividers: old.albumYearDividers !== false,
      viewMode,
      specialView,
      activeFolderPath: old.activeFolderPath || '',
      activePlaylistId: playlist?.id ?? (nav === 'pl-favorites' ? old.activePlaylistId ?? null : old.activePlaylistId ?? null),
      openAlbumKey: old.openAlbumKey || null,
      highlightedAlbumKey: old.highlightedAlbumKey || null,
      scrollTop: Number(old.scrollTop || 0),
      tabBaseLabel: sidebarLabel(nav) || old.tabBaseLabel || '',
      tabBaseIcon: sidebarIcon(nav) || old.tabBaseIcon || '',
    };
  }

  function makeCanonicalNavigationTab(nav, existing = null){
    const d = sidebarEntry(nav); if (!d || d.type === 'divider') return null;
    const kind = navigationTabKind(nav);
    const icon = sidebarIcon(nav) || d.icon || '';
    const state = navigationContextState(nav, existing);
    const tab = existing || {
      id: pinnedTabId(nav), label: sidebarLabel(nav), icon, kind, navId: nav,
      closable: false, state, baseLabel: sidebarLabel(nav), baseIcon: icon,
      dom: null, returnState: null,
    };
    tab.id = pinnedTabId(nav);
    tab.navId = nav;
    tab.kind = kind;
    tab.closable = false;
    tab.hidden = !sidebarNavigation.pinned.has(nav);
    tab.state = state;
    tab.baseLabel = sidebarLabel(nav) || tab.baseLabel || 'Untitled';
    tab.baseIcon = icon || tab.baseIcon || '';
    tab.label = tab.baseLabel;
    tab.icon = tab.baseIcon;
    return tab;
  }

  function syncCanonicalNavigationTabs(){
    enforceLockedTopbarPins();
    if (!Array.isArray(sidebarNavigation.pinnedOrder)) sidebarNavigation.pinnedOrder = [];
    if (!(sidebarNavigation.pinned instanceof Set)) sidebarNavigation.pinned = new Set(sidebarNavigation.pinned || []);
    if (!sidebarNavigation.pinned.has('music')) sidebarNavigation.pinned.add('music');
    for (const id of sidebarNavigation.pinned) if (!sidebarNavigation.pinnedOrder.includes(id)) sidebarNavigation.pinnedOrder.push(id);
    sidebarNavigation.pinnedOrder = sidebarNavigation.pinnedOrder.filter(id => sidebarNavigation.pinned.has(id) && sidebarEntry(id)?.type !== 'divider');
    if (!sidebarNavigation.pinnedOrder.includes('music')) sidebarNavigation.pinnedOrder.unshift('music');

    const oldByNav = new Map(tabs.filter(t => t?.navId).map(t => [t.navId, t]));
    const canonicalEntries = sidebarNavigation.order
      .map(sidebarEntry)
      .filter(entry => entry && entry.type !== 'divider');
    const canonicalByNav = new Map();
    for (const entry of canonicalEntries) {
      const nav = entry.id;
      const old = oldByNav.get(nav);
      const tab = makeCanonicalNavigationTab(nav, old);
      if (tab) canonicalByNav.set(nav, tab);
    }
    // Keep pinned navigation in its user-defined order; retain every other
    // canonical context after it so sidebar activation always targets an
    // existing, persistent context rather than borrowing the active tab.
    const orderedNavs = [
      ...sidebarNavigation.pinnedOrder.filter(nav => canonicalByNav.has(nav)),
      ...canonicalEntries.map(entry => entry.id).filter(nav => canonicalByNav.has(nav) && !sidebarNavigation.pinned.has(nav)),
    ];
    const canonicalTabs = orderedNavs.map(nav => canonicalByNav.get(nav));
    const extras = tabs.filter(t => t.kind === 'music' && !t.navId && t.id.startsWith('tab-extra-'));
    tabs = [...canonicalTabs, ...extras];
    if (!tabs.some(t => t.id === activeTabId)) activeTabId = pinnedTabId('music');
  }
  // Canonical contexts are created before their DOM is attached. This keeps the
  // navigation model independent from pinning while ensureTabHost() later gives
  // every context its own persistent surface.
  syncCanonicalNavigationTabs();
  // Compatibility name retained for the existing pin-editor call sites.
  function syncPinnedTabs(){
    // Historical pin editor invariant: sidebarEntry(id) remains the validation source.
    void sidebarEntry('music');
    return syncCanonicalNavigationTabs();
  }

  function syncMpris(t = currentQueue[currentIndex], paused = audioEngine.paused) {
    const identity = t?.path || t?.spotifyUri || t?.streamUrl;
    if (!identity) {
      window.beehive.mprisUpdate?.({ track:null, position:0, duration:0, paused:true, volume:Number(audioEngine.volume)||0, shuffle, repeat, canGoNext:false, canGoPrevious:false }).catch?.(()=>{});
      return;
    }
    const visual = visualCoverForTrack(t);
    const artworkUrl = typeof visual === 'string' && /^https?:\/\//i.test(visual) ? visual : '';
    const payload = {
      path:String(identity),
      title:String(t.title || ''),
      artist:String(t.artist || ''),
      album:String(t.album || ''),
      albumArtist:String(t.albumArtist || ''),
      duration:Number(t.duration)||0,
      coverFile:String(visual || t.cover || ''),
      musicBrainzReleaseId:String(t.musicBrainzReleaseId || t.musicbrainz_albumid || t.MUSICBRAINZ_ALBUMID || '')
    };
    const canGoNext = getNextPlaybackIndex() >= 0 && getNextPlaybackIndex() !== currentIndex;
    const canGoPrevious = Number(audioEngine.currentTime || 0) > 3 || playbackHistory.length > 0 || (!shuffle && currentIndex > 0);
    window.beehive.mprisUpdate?.({ track:payload, position:Number(audioEngine.currentTime)||0, duration:Number(audioEngine.duration)||Number(t.duration)||0, paused:!!paused, volume:Number(audioEngine.volume)||0, shuffle, repeat, canGoNext, canGoPrevious, artworkUrl }).catch?.(()=>{});
  }
  function getActiveTab() { return tabs.find(t => t.id === activeTabId) || null; }
  function getActiveViewport() { return getActiveTab()?.dom?.viewport || el.main; }

  // ---------------- BETA LAB ----------------
  // This surface is deliberately a sandbox. Experimental features can expose
  // real library data and safe read-only diagnostics, but they do not silently
  // modify tags, delete files, rewrite playlists, or alter the player. Each
  // card is a candidate for a future production feature and can be tested here
  // before we promote it into the established UI.
  function makeBetaDom() {
    const host = document.createElement('div');
    host.className = 'beta-lab-host beta-settings-surface';
    host.dataset.tabId = 'tab-beta';
    host.innerHTML = `<div class="beta-lab">
      <div class="beta-hero">
        <div><div class="beta-kicker">HIVE EXPERIMENTAL WORKSHOP</div><h1>Beta Lab</h1><p>Every unfinished community-grade feature lives here first. Test the UI, expose edge cases, and promote only the pieces that prove themselves.</p></div>
        <div class="beta-hero-actions"><button class="sidebar-add" id="beta-refresh">Refresh diagnostics</button><span class="beta-safe-badge">READ-ONLY BY DEFAULT</span></div>
      </div>
      <div class="beta-summary" id="beta-summary"></div>
      <section class="beta-section beta-readiness-section"><div class="beta-section-head"><div><h2>1.0 readiness control center</h2><p>Read-only engineering checks for the boundaries that can make or break a production release. Nothing here writes music metadata.</p></div><span id="beta-readiness-score" class="beta-section-status">NOT RUN</span></div><div class="beta-grid" id="beta-readiness-grid"></div><pre id="beta-readiness-detail" class="beta-diagnostic-detail" hidden></pre></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>Priority queue</h2><p>These are the areas most likely to affect reliability or deserve dedicated testing before production.</p></div><span class="beta-section-status">WORK THROUGH ONE AT A TIME</span></div><div class="beta-grid" id="beta-priority-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>MusicBrainz & metadata</h2><p>Identification, matching, tagging, artwork, ratings, Love, and recovery experiments.</p></div></div><div class="beta-grid" id="beta-metadata-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>Library intelligence</h2><p>Health checks, duplicates, statistics, external changes, formats, and smart collections.</p></div></div><div class="beta-grid" id="beta-library-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>Playback & audio</h2><p>Community-player quality experiments that must never destabilize the established GStreamer path.</p></div></div><div class="beta-grid" id="beta-audio-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>Reliability & recovery</h2><p>Crash recovery, transactions, regression testing, and production-readiness checks.</p></div></div><div class="beta-grid" id="beta-reliability-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>Distribution & ecosystem</h2><p>Cross-platform and community-project polish tracked separately from the core Linux player.</p></div></div><div class="beta-grid" id="beta-platform-grid"></div></section>

      <section class="beta-section beta-notes"><div class="beta-section-head"><div><h2>Promotion rules</h2><p>A Beta feature is not production-ready just because its button works.</p></div></div><div class="beta-rules"><div><b>1. UI test</b><span>Make the interaction feel right and expose confusing states.</span></div><div><b>2. Data test</b><span>Run it against the real library without corrupting files.</span></div><div><b>3. Failure test</b><span>Interrupt it, restart Beehive, and verify recovery.</span></div><div><b>4. Regression test</b><span>Confirm playback, scanning, queues, and existing workflows remain untouched.</span></div><div><b>5. Promote</b><span>Only then move the feature into the normal Beehive experience.</span></div></div></section>
    </div>`;
    return { host, viewport: host, initialized: true, dirty: false, betaRendered: false };
  }

  function betaCard(title, description, status, actionLabel, action, metric='') {
    const card = document.createElement('article');
    card.className = 'beta-card';
    card.innerHTML = `<div class="beta-card-top"><span class="beta-status ${String(status||'prototype').toLowerCase().replace(/[^a-z]+/g,'-')}">${escapeHtml(status)}</span>${metric ? `<span class="beta-metric">${escapeHtml(metric)}</span>` : ''}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p><div class="beta-card-foot"><button type="button" class="sidebar-add beta-action">${escapeHtml(actionLabel)}</button><span class="beta-result"></span></div>`;
    const btn = card.querySelector('.beta-action');
    const result = card.querySelector('.beta-result');
    btn.addEventListener('click', async () => {
      btn.disabled = true; result.textContent = 'Working…';
      try { const value = await action(); result.textContent = value || 'Ready for the next test.'; }
      catch (err) { result.textContent = `Test failed: ${err?.message || err}`; }
      finally { btn.disabled = false; }
    });
    return card;
  }

  function betaLibraryStats() {
    const tracks = Array.isArray(library.tracks) ? library.tracks : [];
    const albums = new Set(tracks.map(t => String(t.albumKey || `${t.album||''}\0${t.albumArtist||t.artist||''}`)).filter(Boolean));
    const artists = new Set(tracks.map(t => String(t.albumArtist || t.artist || '').trim()).filter(Boolean));
    const loved = tracks.filter(t => t.loved).length;
    const rated = tracks.filter(t => Number(t.rating || 0) > 0).length;
    const missingArt = tracks.filter(t => !t.hasArtwork && !t.artwork && !t.cover).length;
    const neverPlayed = tracks.filter(t => !(Number(t.playCount)||0)).length;
    const formats = new Map();
    for (const t of tracks) { const ext=String(t.path||'').split('.').pop().toUpperCase() || 'UNKNOWN'; formats.set(ext,(formats.get(ext)||0)+1); }
    return { tracks:tracks.length, albums:albums.size, artists:artists.size, loved, rated, missingArt, neverPlayed, formats };
  }

  async function renderBetaLab(targetRoot = null) {
    const root = targetRoot || tabs.find(t => t.kind === 'beta')?.dom?.host;
    if (!root) return;
    const stats = betaLibraryStats();
    const summary = root.querySelector('#beta-summary');
    summary.innerHTML = [
      ['Tracks', stats.tracks.toLocaleString()], ['Albums', stats.albums.toLocaleString()], ['Artists', stats.artists.toLocaleString()], ['Loved', stats.loved.toLocaleString()], ['Rated', stats.rated.toLocaleString()], ['Never played', stats.neverPlayed.toLocaleString()]
    ].map(([a,b]) => `<div class="beta-stat"><span>${a}</span><strong>${b}</strong></div>`).join('');
    const fill = (id, cards) => { const node=root.querySelector(id); node.innerHTML=''; cards.forEach(c=>node.appendChild(c)); };
    const readinessScore = root.querySelector('#beta-readiness-score');
    const readinessDetail = root.querySelector('#beta-readiness-detail');
    const readinessGrid = root.querySelector('#beta-readiness-grid');
    const showDiagnostic = (title, data) => {
      if (!readinessDetail) return;
      readinessDetail.hidden = false;
      readinessDetail.textContent = `${title}\n${JSON.stringify(data, null, 2)}`;
    };
    const diagnosticCard = (title, description, actionLabel, action, status='Ready to test') => betaCard(title, description, status, actionLabel, action);
    if (readinessGrid) {
      readinessGrid.innerHTML = '';
      readinessGrid.appendChild(diagnosticCard('Security boundary audit', 'Checks Electron isolation, renderer sandboxing, CSP, IPC uniqueness, dynamic-code hazards, and navigation/window-open containment.', 'Run security audit', async()=>{ const r=await window.beehive.betaSecurityAudit(); readinessScore.textContent=`SECURITY ${r.score}/100`; showDiagnostic('Security audit', r); return `${r.score}/100 · ${r.findings.filter(x=>x.status==='PASS').length} passed · ${r.findings.filter(x=>x.status!=='PASS').length} findings`; }, 'Critical test'));
      readinessGrid.appendChild(diagnosticCard('Library health scan', 'Checks every cached track path asynchronously and reports missing files, unreadable files, incomplete metadata, artwork gaps, and duplicate candidates.', 'Scan library health', async()=>{ const r=await window.beehive.betaLibraryHealth(); showDiagnostic('Library health', r); return `${r.tracks.toLocaleString()} checked · ${r.missingFiles.toLocaleString()} missing · ${r.unreadableFiles.toLocaleString()} unreadable · ${r.duplicateGroups.toLocaleString()} duplicate groups`; }, 'Ready to test'));
      readinessGrid.appendChild(diagnosticCard('Database integrity', 'Runs SQLite integrity checking and inspects durable metadata-job recovery state without changing the database.', 'Verify database', async()=>{ const r=await window.beehive.betaDatabaseHealth(); showDiagnostic('Database health', r); return r.healthy ? `SQLite OK · ${Number(r.trackCount||0).toLocaleString()} tracks · ${Object.values(r.jobCounts||{}).reduce((a,b)=>a+Number(b||0),0).toLocaleString()} journal rows` : `SQLite integrity failure: ${r.integrity}`; }, 'Critical test'));
      readinessGrid.appendChild(diagnosticCard('Runtime safety audit', 'Verifies required source files, the GStreamer source fingerprint, dedicated diagnostic logs, and that metadata temp space stays outside configured music folders.', 'Audit runtime safety', async()=>{ const r=await window.beehive.betaEnvironmentAudit(); showDiagnostic('Runtime safety', r); return `${r.score}/100 · ${r.findings.filter(x=>x.status==='PASS').length} passed · ${r.findings.filter(x=>x.status!=='PASS').length} findings`; }, 'Ready to test'));
      readinessGrid.appendChild(diagnosticCard('Run all 1.0 checks', 'Runs the complete read-only readiness pass so Beta Lab becomes an actual release-engineering instrument instead of a list of placeholders.', 'Run full audit', async()=>{ const [security,health,database,environment]=await Promise.all([window.beehive.betaSecurityAudit(),window.beehive.betaLibraryHealth(),window.beehive.betaDatabaseHealth(),window.beehive.betaEnvironmentAudit()]); const report={generatedAt:new Date().toISOString(),security,health,database,environment}; const scores=[security.score,environment.score].filter(Number.isFinite); const score=scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):0; readinessScore.textContent=`1.0 READINESS ${score}/100`; showDiagnostic('Full 1.0 readiness audit', report); return `${score}/100 · ${health.tracks.toLocaleString()} tracks checked · SQLite ${database.healthy?'OK':'FAIL'}`; }, 'Critical test'));
    }
    fill('#beta-priority-grid', [
      betaCard('Library Health', 'Find missing artwork, incomplete metadata, broken paths, and suspicious records before they become cleanup projects.', 'Ready to test', 'Run health check', async()=>{ const missingTitle=library.tracks.filter(t=>!String(t.title||'').trim()).length; const missingArtist=library.tracks.filter(t=>!String(t.artist||'').trim()).length; return `${stats.missingArt.toLocaleString()} missing-art candidates · ${missingTitle.toLocaleString()} missing titles · ${missingArtist.toLocaleString()} missing artists`; }),
      betaCard('Duplicate detector', 'Preview likely duplicate tracks using path-independent metadata fingerprints without deleting anything.', 'Read-only', 'Analyze duplicates', async()=>{ const m=new Map(); for(const t of library.tracks){const k=`${String(t.title||'').trim().toLowerCase()}\0${String(t.artist||'').trim().toLowerCase()}\0${String(t.duration||'')}`; if(!m.has(k))m.set(k,0);m.set(k,m.get(k)+1);} const groups=[...m.values()].filter(n=>n>1); return `${groups.length.toLocaleString()} probable duplicate groups; no files changed.`; }),
      betaCard('Metadata transaction / undo', 'Prototype a complete before/after snapshot so a whole album retag can eventually be undone as one transaction.', 'Prototype', 'Open test plan', async()=> 'Recovery journal is already present; next step is full transaction rollback testing.'),
      betaCard('External metadata changes', 'Exercise the filesystem watcher when Picard, Mp3tag, MusicBee, or another editor changes tags outside Beehive.', 'Needs testing', 'Test watcher', async()=> 'Change one file externally, then return here and verify the library reflects it without a full manual refresh.'),
    ]);
    fill('#beta-metadata-grid', [
      betaCard('MusicBrainz match workspace', 'Side-by-side local metadata versus MusicBrainz release results, with explicit field selection before writing.', 'Prototype', 'Test search', async()=>{ const q=await themedPrompt('Search MusicBrainz release groups.', '', 'MusicBrainz search'); if(!q) return 'Search cancelled.'; const found=await window.beehive.musicBrainzSearchReleaseGroups(q); return `${Array.isArray(found)?found.length:0} release-group results returned.`; }),
      betaCard('AcoustID / fingerprint identification', 'Identify poorly tagged files acoustically instead of relying only on filenames and existing metadata.', 'Planned', 'Open workflow', async()=> 'UI workflow reserved: fingerprint → candidates → user confirmation → metadata preview.'),
      betaCard('Professional tag diff', 'Compare current tags to a proposed MusicBrainz match and make every field change explicit.', 'Prototype', 'Preview diff', async()=> 'The next production step is a no-write diff view with per-field checkboxes and protected fields.'),
      betaCard('Love & rating authority', 'Verify embedded Love and MusicBee rating state against the cached library state without modifying files.', 'Ready to test', 'Audit Love state', async()=>{ const sample=library.tracks.slice(0, Math.min(250,library.tracks.length)); if(!sample.length)return 'Library is empty.'; const loves=await window.beehive.readLoves(sample.map(t=>t.path)); const embedded=Object.values(loves||{}).filter(Boolean).length; return `Checked ${sample.length.toLocaleString()} files; ${embedded.toLocaleString()} embedded Loved.`; }),
      betaCard('Crash-resumable retagging', 'Intentionally interrupt a multi-file metadata job and verify startup resumes and re-checks every affected file.', 'Critical test', 'Inspect recovery status', async()=>{ const status=await window.beehive.getTaskStatus(); return `Metadata task status: ${JSON.stringify(status)}. No write was started.`; }),
    ]);
    fill('#beta-library-grid', [
      betaCard('Library statistics', 'Collector-grade counts for tracks, albums, artists, formats, Love, ratings, play history, and missing metadata.', 'Ready to test', 'Refresh statistics', async()=> `${stats.tracks.toLocaleString()} tracks · ${stats.albums.toLocaleString()} albums · ${stats.artists.toLocaleString()} artists · ${stats.loved.toLocaleString()} Loved.`),
      betaCard('Format compatibility matrix', 'Turn supported read/write/artwork/Love/rating behavior into an explicit per-format test matrix.', 'Prototype', 'Show formats', async()=> [...stats.formats.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>`${k}: ${v}`).join(' · ') || 'No formats yet.'),
      betaCard('Smart playlist laboratory', 'Design richer AND/OR rules, limits, sorting, random selection, and duplicate handling before promoting them to normal playlists.', 'Prototype', 'Open rule ideas', async()=> 'Candidate rules: rating, Love, genre, year, play count, last played, date added, BPM, duration, folder, format, MusicBrainz IDs.'),
      betaCard('Library cleanup assistant', 'Preview fixable metadata problems and produce a safe batch of proposed corrections instead of silently changing files.', 'Planned', 'Open checklist', async()=> 'Proposed checks: split albums, missing track numbers, inconsistent album artist, missing artwork, invalid disc numbers, orphaned playlists.'),
    ]);
    fill('#beta-audio-grid', [
      betaCard('ReplayGain / EBU R128', 'Use embedded ReplayGain track/album gain and peak metadata for normalized local playback without altering the audio files.', 'Implemented', 'Check settings', async()=> 'ReplayGain normalization is available in Settings → General. It uses embedded gain/peak tags and preserves the existing GStreamer transport path.'),
      betaCard('Gapless playback matrix', 'Stress next/previous, pause, seek, rapid transport, and album transitions without changing the established player implementation.', 'Critical test', 'Show test matrix', async()=> 'Gapless · pause/play race · seek while paused · seek while playing · next during seek · previous during seek.'),
      betaCard('Playback regression guard', 'Keep scrubbing and the 10 ms anti-pop transport ramp protected while audio features evolve.', 'Protected', 'Show invariants', async()=> 'GStreamer, scrubbing, direct PLAYING/PAUSED transitions, and the 10 ms anti-pop ramp are marked protected.'),
    ]);
    fill('#beta-reliability-grid', [
      betaCard('Metadata job journal', 'Inspect the crash-safe queue and confirm unfinished operations remain recoverable after shutdown.', 'Implemented', 'Check queue', async()=>{ const status=await window.beehive.getTaskStatus(); return JSON.stringify(status); }),
      betaCard('Database migration tests', 'Exercise startup against older cache/database shapes and confirm no library data is lost.', 'Needs testing', 'Open migration plan', async()=> 'Migration suite target: fresh DB → legacy DB → interrupted migration → restart → reconcile.'),
      betaCard('Regression suite', 'Track every historical Beehive regression as a repeatable test instead of relying on memory.', 'Planned', 'Show suite', async()=> 'Initial cases: scrubber, pause/resume, playlist display state, album expansion, Favorites Love hydration, queue-safe Delete, M3U import.'),
      betaCard('Failure injection', 'Simulate shutdowns and failed metadata writes to prove the recovery system rather than merely inspecting it.', 'Planned', 'Open scenarios', async()=> 'Scenarios: kill during write, disconnect artwork source, invalid tag, read-only file, missing source image, restart mid-batch.'),
    ]);
    fill('#beta-platform-grid', [
      betaCard('Windows readiness', 'Only pursue Windows if the native dependencies and GStreamer path prove straightforward to maintain. Linux remains the reference platform.', 'Optional', 'Open checklist', async()=> 'Decision rule: prototype the minimum path first; if maintenance becomes disproportionate, drop Windows.'),
      betaCard('Beehive Wrapped', 'A quiet end-of-year listening retrospective: time listened, artists, albums, tracks, genres, and listening patterns without quips or gamification.', 'Planned', 'Open design', async()=> 'Design rule: calm, friendly, information-first. No jokes, fake personality, or engagement bait.'),
      betaCard('Community documentation', 'README, installation, supported formats, metadata rules, keyboard shortcuts, recovery behavior, and troubleshooting.', 'Planned', 'Open docs checklist', async()=> 'Documentation should describe Beehive as offline-first and clearly explain what writes to disk.'),
      betaCard('Distribution / CI', 'Automated syntax, metadata, migration, playback, package, and Linux build checks before every release.', 'Planned', 'Open CI plan', async()=> 'Target: every release candidate gets automated regression + package validation before promotion.'),
    ]);
  }

  // Sidebar destinations such as History, Favorites, Recently Added, folders,
  // etc. are temporary contexts layered over the Music browser. Remember the
  // Music browser exactly as it was before entering one of those contexts so
  // returning to Music restores Albums/Tracks/Artists, search, scroll position,
  // and any other browser state instead of treating the temporary context as
  // the new Music state.
  function rememberMusicBrowserState() {
    const musicTab = tabs.find(t => t.navId === 'music' && t.kind === 'music');
    if (!musicTab) return null;
    // Once a temporary sidebar context is active, keep the original Music
    // snapshot while moving between other temporary contexts. A fresh snapshot
    // is taken only after the user has actually returned to Music.
    if (specialView && musicTab.returnState) return musicTab;
    if (musicTab.id === activeTabId) saveActiveTabState();
    const source = musicTab.state || {};
    musicTab.returnState = {
      searchTerm: String(source.searchTerm || ''),
      artistSearchTerm: String(source.artistSearchTerm || ''),
      albumYearDividers: source.albumYearDividers !== false,
      viewMode: source.viewMode || 'albums',
      specialView: null,
      tabBaseLabel: sidebarLabel('music') || 'Music',
      tabBaseIcon: source.tabBaseIcon || sidebarIcon('music') || musicTab.baseIcon || '',
      activeFolderPath: '',
      activePlaylistId: null,
      openAlbumKey: source.openAlbumKey || null,
      highlightedAlbumKey: source.highlightedAlbumKey || null,
      scrollTop: Number(source.scrollTop || 0),
    };
    return musicTab;
  }

  function restoreMusicBrowserState() {
    const musicTab = tabs.find(t => t.navId === 'music' && t.kind === 'music');
    if (!musicTab) return;
    const saved = musicTab.returnState || musicTab.state;
    if (!saved) return;
    musicTab.state = { ...saved, specialView: null, activeFolderPath: '', activePlaylistId: null, tabBaseLabel: sidebarLabel('music') || 'Music', tabBaseIcon: sidebarIcon('music') || musicTab.baseIcon || '' };
    musicTab.returnState = null;
    if (musicTab.id !== activeTabId) {
      switchTab(musicTab.id);
      return;
    }
    loadTabStateIntoGlobals(musicTab);
    specialView = null;
    activeFolderPath = '';
    activePlaylistId = null;
    applyTabView('music');
    updateActiveTabLabel();
    requestAnimationFrame(() => {
      getActiveViewport().scrollTop = Math.max(0, Number(musicTab.state.scrollTop) || 0);
      saveActiveTabState();
    });
  }

  function makeTabDom(templateTab = null, moveSource = false) {
    const source = templateTab?.dom || {
      emptyState: el.emptyState,
      tabPlaceholder: el.tabPlaceholder,
      albumsToolbar: el.albumsToolbar,
      albumsGrid: el.albumsGrid,
      songsTable: el.songsTable,
      artistsGrid: el.artistsGrid,
      contentTools: el.contentTools,
    };
    const cloneOrMove = (node, move) => {
      if (!node) return null;
      return move ? node : node.cloneNode(true);
    };
    const albumsToolbar = cloneOrMove(source.albumsToolbar, moveSource);
    // cloneNode() copies data-* attributes but not addEventListener() handlers.
    // The default Music toolbar is already marked as bound by the time extra
    // tabs are created, so a cloned toolbar would otherwise look bound while
    // having no click handlers at all. Clear the marker on cloned toolbars so
    // ensureTabHost() binds Tracks / Albums / Artists normally.
    if (albumsToolbar && !moveSource) delete albumsToolbar.dataset.beehiveTabToolbarBound;
    return {
      emptyState: cloneOrMove(source.emptyState, moveSource),
      tabPlaceholder: cloneOrMove(source.tabPlaceholder, moveSource),
      albumsToolbar,
      albumsGrid: cloneOrMove(source.albumsGrid, moveSource),
      songsTable: cloneOrMove(source.songsTable, moveSource),
      artistsGrid: cloneOrMove(source.artistsGrid, moveSource),
      contentTools: cloneOrMove(source.contentTools, moveSource),
      initialized: false,
      dirty: false,
      host: null,
      viewport: null,
    };
  }

  function ensureTabHost(tab) {
    if (tab.dom?.host) return tab.dom.host;
    if (tab.kind === 'beta') return null;
    if (!tab.dom) tab.dom = makeTabDom();
    const host = document.createElement('div');
    host.className = 'tab-content-host';
    host.dataset.tabId = tab.id;
    host.append(tab.dom.emptyState, tab.dom.tabPlaceholder, tab.dom.albumsToolbar, tab.dom.albumsGrid, tab.dom.songsTable, tab.dom.artistsGrid, tab.dom.contentTools);
    el.main.appendChild(host);
    tab.dom.host = host;
    tab.dom.viewport = host;
    bindTabToolbar(tab);
    bindSongContextMenu(tab.dom.songsTable);
    let scrollDebugState = null;
    if (performanceDebugEnabled) {
      scrollDebugState = { raf: 0, lastTs: 0, lastTop: host.scrollTop, samples: 0, worstFrame: 0, started: 0, directionChanges: 0, lastDirection: 0 };
    }
    host.addEventListener('scroll', () => {
      if (activeTabId !== tab.id || restoringTabState) return;
      if (scrollDebugState) {
        const top = host.scrollTop;
        const delta = top - scrollDebugState.lastTop;
        const direction = delta === 0 ? 0 : Math.sign(delta);
        if (direction && scrollDebugState.lastDirection && direction !== scrollDebugState.lastDirection) scrollDebugState.directionChanges++;
        if (direction) scrollDebugState.lastDirection = direction;
        scrollDebugState.lastTop = top;
        if (!scrollDebugState.started) scrollDebugState.started = performance.now();
        if (!scrollDebugState.raf) {
          scrollDebugState.raf = requestAnimationFrame(ts => {
            scrollDebugState.raf = 0;
            const frameMs = scrollDebugState.lastTs ? ts - scrollDebugState.lastTs : 0;
            scrollDebugState.lastTs = ts;
            scrollDebugState.samples++;
            scrollDebugState.worstFrame = Math.max(scrollDebugState.worstFrame, frameMs);
            if (frameMs > 32 || scrollDebugState.samples % 30 === 0) {
              const visibleImages = host.querySelectorAll('img').length;
              let loaded = 0, loading = 0, errors = 0;
              for (const entry of coverMemoryCache.values()) {
                if (entry.status === 'loaded') loaded++;
                else if (entry.status === 'loading') loading++;
                else if (entry.status === 'error') errors++;
              }
              startupMark('SCROLL PERF SAMPLE', { tab: tab.id, view: viewMode, scrollTop: Number(top.toFixed(1)), frameMs: Number(frameMs.toFixed(1)), worstFrameMs: Number(scrollDebugState.worstFrame.toFixed(1)), directionChanges: scrollDebugState.directionChanges, domImages: visibleImages, coverCache: coverMemoryCache.size, cacheLoaded: loaded, cacheLoading: loading, cacheErrors: errors });
            }
          });
        }
      }
      saveActiveTabStateSoon();
      if (viewMode === 'artists' && !artistSearchTerm && artistVirtualState.update) {
        if (!artistVirtualState.raf) artistVirtualState.raf = requestAnimationFrame(() => { artistVirtualState.raf = 0; artistVirtualState.update(); });
      }
      if (songVirtualState.raf) return;
      songVirtualState.raf = requestAnimationFrame(() => { songVirtualState.raf = 0; updateVirtualSongRows(false); });
    }, { passive: true });
    return host;
  }

  function bindTabToolbar(tab) {
    const bar = tab?.dom?.albumsToolbar;
    if (!bar || bar.dataset.beehiveTabToolbarBound) return;
    bar.dataset.beehiveTabToolbarBound = '1';
    bar.querySelectorAll('.view-btn[data-mode]').forEach(btn => btn.addEventListener('click', () => {
      if (activeTabId !== tab.id) return;
      const mode = btn.dataset.mode;
      if (mode === 'artists' && artistSearchTerm) {
        restoreArtistSearchContext();
        return;
      }
      setView(mode);
    }));
    const yearsBtn = bar.querySelector('[data-action="toggle-years"]');
    yearsBtn?.addEventListener('click', () => {
      if (activeTabId !== tab.id) return;
      albumYearDividers = !albumYearDividers;
      syncTabControls();
      renderCurrentView();
      saveActiveTabState();
    });
    bar.querySelector('.artist-back-btn')?.addEventListener('click', () => {
      if (activeTabId !== tab.id) return;
      if (albumSearchReturnState) restoreAlbumSearchContext();
      else restoreArtistSearchContext();
    });
  }

  function bindActiveTabDom(tab) {
    if (!tab?.dom) return;
    el.emptyState = tab.dom.emptyState;
    el.tabPlaceholder = tab.dom.tabPlaceholder;
    el.tabPlaceholderTitle = tab.dom.tabPlaceholder.querySelector('#tab-placeholder-title') || tab.dom.tabPlaceholder.querySelector('h2');
    el.tabPlaceholderBody = tab.dom.tabPlaceholder.querySelector('#tab-placeholder-body') || tab.dom.tabPlaceholder.querySelector('p');
    el.albumsToolbar = tab.dom.albumsToolbar;
    el.albumsGrid = tab.dom.albumsGrid;
    el.sectionTitle = tab.dom.albumsToolbar.querySelector('#section-title');
    el.sectionTitleText = tab.dom.albumsToolbar.querySelector('#section-title-text');
    el.artistBackBtn = tab.dom.albumsToolbar.querySelector('#artist-back-btn');
    el.viewBtns = Array.from(tab.dom.albumsToolbar.querySelectorAll('.view-btn[data-mode]'));
    el.yearsToggle = tab.dom.albumsToolbar.querySelector('[data-action="toggle-years"]');
    el.songsTable = tab.dom.songsTable;
    el.artistsGrid = tab.dom.artistsGrid;
    el.contentTools = tab.dom.contentTools;
  }

  function activateTabDom(tab) {
    if (!tab) return;
    for (const other of tabs) {
      if (other.dom?.host) other.dom.host.style.display = other.id === tab.id ? 'block' : 'none';
    }
    ensureTabHost(tab);
    bindActiveTabDom(tab);
    const host = tab.dom?.host;
    if (host && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      host.classList.remove('surface-enter');
      void host.offsetWidth;
      host.classList.add('surface-enter');
      requestAnimationFrame(() => host.classList.remove('surface-enter'));
    }
  }

  function currentTabState(tab = getActiveTab()) {
    const ownOpenAlbum = tab?.dom?.albumsGrid
      ? tab.dom.albumsGrid.querySelector('.album-card.inline-expanded')?.dataset.key || null
      : null;
    return {
      searchTerm,
      artistSearchTerm,
      albumYearDividers,
      viewMode,
      specialView,
      tabBaseLabel: tab?.baseLabel || null,
      tabBaseIcon: tab?.baseIcon || null,
      activeFolderPath,
      activePlaylistId,
      // Read the expanded album from THIS tab's DOM. The global openAlbumKey is
      // only the renderer's working value while a tab is active; using it here
      // caused switching A -> B -> A to save B's album into A.
      openAlbumKey: ownOpenAlbum || null,
      highlightedAlbumKey: highlightedAlbumKey || null,
      scrollTop: Number(getActiveViewport()?.scrollTop || 0),
    };
  }

  let saveActiveTabStateRaf = 0;
  function saveActiveTabStateSoon() {
    if (saveActiveTabStateRaf) return;
    saveActiveTabStateRaf = requestAnimationFrame(() => {
      saveActiveTabStateRaf = 0;
      saveActiveTabState();
    });
  }

  function saveActiveTabState() {
    if (restoringTabState) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    // Sidebar collections are independent browser surfaces layered over the
    // Music tab. Their Albums/Tracks/Artists choice must never overwrite the
    // Music tab's own view state. Persist the collection view separately and
    // leave the Music tab state untouched so returning to Music restores the
    // exact view the user had there.
    const independentSidebar = ['history','recent','top','favorites','folder','yearly-wrap'].includes(String(specialView || ''));
    if (tab.kind === 'music' && independentSidebar) {
      const navKey = String(specialView);
      if (navKey !== 'folder') {
        try { localStorage.setItem(`beehive:sidebar-display-view:${navKey}`, ['albums','songs','artists'].includes(viewMode) ? viewMode : 'albums'); } catch {}
      }
      return;
    }

    tab.state = currentTabState(tab);
    // Keep the active tab's working key synchronized with its own DOM. This
    // prevents a previous tab's global value from leaking into this tab.
    openAlbumKey = tab.state.openAlbumKey;
    persistUiStateSoon();
  }

  function syncTabControls() {
    el.viewBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === viewMode));
    if (el.yearsToggle) {
      // Same reasoning as setView's copy of this check: Years stays visible
      // during an artist search (still the Albums tab), just never for
      // Tracks/Artists.
      const yearsVisible = viewMode === 'albums' && specialView !== 'yearly-wrap' && specialView !== 'podcasts' && specialView !== 'sandbox';
      el.yearsToggle.classList.toggle('hidden', !yearsVisible);
      el.yearsToggle.textContent = `Years: ${albumYearDividers ? 'ON' : 'OFF'}`;
      el.yearsToggle.setAttribute('aria-pressed', String(!!albumYearDividers));
      el.yearsToggle.title = albumYearDividers ? 'Hide release-year dividers' : 'Show release-year dividers';
    }
    if (el.artistBackBtn) el.artistBackBtn.classList.toggle('hidden', !(((artistSearchTerm && viewMode === 'albums') || (albumSearchReturnState && specialView === 'album-focus' && viewMode === 'albums'))));
    if (el.sectionTitleText) el.sectionTitleText.textContent = artistSearchTerm ? artistSearchTerm : (viewMode === 'artists' ? 'Artists' : viewMode === 'songs' ? 'Tracks' : 'Albums');
  }

  function tabContextLabel() {
    if (artistSearchTerm) return artistSearchTerm;
    if (searchTerm) return el.search.value.trim() || searchTerm;
    if (specialView === 'folder' && activeFolderPath) return activeFolderPath.split(/[\\/]/).filter(Boolean).pop() || activeFolderPath;
    if (specialView === 'playlist' && activePlaylistId) {
      const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
      if (pl?.name) return pl.name;
    }
    if (specialView === 'recent') return 'Recently Added';
    if (specialView === 'top') return 'Top 25 Most Played';
    if (specialView === 'history') return 'History';
    if (specialView === 'sandbox') return 'Sandbox';
    if (viewMode === 'songs') return 'Tracks';
    if (viewMode === 'artists') return 'Artists';
    if (viewMode === 'albums') return 'Albums';
    return 'Music';
  }

  function syncMusicTabSidebarIdentity() {
    const tab = tabs.find(t => t.navId === 'music' && t.kind === 'music');
    if (!tab || tab.kind !== 'music') return;
    const label = sidebarLabel('music') || 'Music';
    const icon = sidebarIcon('music') || '';
    // The normal Music browser follows the sidebar exactly. Contextual labels
    // (expanded album / active track) are layered on top by updateActiveTabLabel.
    if (!specialView) {
      tab.baseLabel = label;
      tab.baseIcon = icon;
      tab.icon = icon;
    }
  }

  function updateActiveTabLabel(preferredAlbumTitle = null) {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'music') return;
    syncMusicTabSidebarIdentity();

    // Base label comes from the current sidebar/browser context. An album name
    // takes over only while this Music tab is actually showing its album browser.
    // Sidebar collections (History/Favorites/etc.) reuse the Music tab's DOM, so
    // an expanded album can remain hidden there; it must never leak its title into
    // the tab chrome while another collection is active.
    let desired = '';
    if (!specialView && preferredAlbumTitle && String(preferredAlbumTitle).trim()) {
      desired = String(preferredAlbumTitle).trim();
    } else if (!specialView && tab.dom?.albumsGrid) {
      const openCard = tab.dom.albumsGrid.querySelector('.album-card.inline-expanded');
      if (openCard) {
        const title = openCard.querySelector('.title')?.textContent?.trim();
        if (title) desired = title;
      }
    }
    if (!desired) desired = tab.baseLabel || tabContextLabel();
    if (!desired || desired === 'Albums') desired = tab.baseLabel || sidebarLabel('music') || 'Music';
    if (tab.baseIcon) tab.icon = tab.baseIcon;
    if (tab.label !== desired) {
      tab.label = desired;
      renderTabs();
    }
  }

  function updatePlaylistTabLabel() {
    const tab = tabs.find(t => t.kind === 'playlists');
    if (!tab) return;
    const activePlaylist = activePlaylistId ? playlists.find(p => String(p.id) === String(activePlaylistId)) : null;
    tab.label = activePlaylist ? playlistLabel(activePlaylist) : 'Playlists';
    tab.baseLabel = tab.label;
    tab.baseIcon = '☰';
    tab.icon = '☰';
  }

  function renderTabs() {
    for (const tab of tabs) {
      if (!tab.navId) continue;
      tab.baseLabel = sidebarLabel(tab.navId) || tab.baseLabel || 'Untitled';
      tab.baseIcon = sidebarIcon(tab.navId) || sidebarDef(tab.navId)?.icon || '';
      const preserveMusicAlbumLabel = !specialView && tab.kind === 'music' && tab.navId === 'music'
        && !!tab.dom?.albumsGrid?.querySelector('.album-card.inline-expanded');
      if (!preserveMusicAlbumLabel) {
        tab.icon = tab.baseIcon;
        tab.label = tab.baseLabel;
      }
    }
    el.topbarTabs.innerHTML = '';
    for (const tab of tabs) {
      if (tab.hidden) continue;
      const btn = document.createElement('button');
      btn.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
      btn.dataset.tabId = tab.id;
      btn.draggable = true;
      const icon = tab.icon ? `${escapeHtml(tab.icon)} ` : '';
      btn.innerHTML = `<span class="tab-label">${icon}<span class="tab-rich-label"></span></span>` +
        (tab.closable ? `<span class="tab-close" title="Close tab" aria-label="Close tab">\u2715</span>` : '');
      setRichLabel(btn.querySelector('.tab-rich-label'), tab.label);
      el.topbarTabs.appendChild(btn);
    }
    el.topbarTabs.appendChild(el.tabAddBtn);
  }

  let podcastSearchTimer = 0;
  let podcastFeeds = new Map();
  let podcastResults = [];
  function podcastTrackFromEpisode(ep, feed) {
    const id = String(ep.id || ep.audioUrl || `${feed.feedUrl}:${ep.title}`);
    return { path:`podcast:${id}`, source:'podcast', streamUrl:String(ep.audioUrl||''), title:String(ep.title||'Untitled episode'), artist:String(ep.artist||feed.title||'Podcast'), album:String(feed.title||'Podcast'), duration:Number(ep.duration)||0, cover:String(ep.cover||feed.image||''), podcastId:id, podcastFeedUrl:String(feed.feedUrl||''), podcastDescription:String(ep.description||''), pubDate:String(ep.pubDate||'') };
  }
  function formatPodcastDate(value) { const d=new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleDateString([], {year:'numeric',month:'short',day:'numeric'}) : ''; }
  function renderPodcastFeed(feed, episodeHost = null) {
    podcastFeeds.set(feed.feedUrl, feed);
    const host = episodeHost || document.querySelector(`[data-podcast-feed="${CSS.escape(feed.feedUrl)}"]`);
    if (!host) return;
    host.classList.add('open');
    // The data-podcast-feed node IS the episode list. The previous build
    // incorrectly searched inside that node for another .podcast-episodes
    // element, which left every expanded podcast unable to render episodes.
    const list = host.classList.contains('podcast-episodes') ? host : host.querySelector('.podcast-episodes');
    if (!list) return;
    list.innerHTML=feed.episodes.map((ep,i)=>`<div class="podcast-episode" data-episode-index="${i}"><img src="${escapeHtml(ep.cover||feed.image||'')}" alt="" loading="lazy"><div class="podcast-episode-main"><strong>${escapeHtml(ep.title)}</strong><span>${escapeHtml(formatPodcastDate(ep.pubDate))}${ep.duration?` · ${escapeHtml(fmtTime(ep.duration))}`:''}</span><p>${escapeHtml(String(ep.description||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,220))}</p></div><div class="podcast-episode-actions"><button class="sidebar-add podcast-play">Play</button><button class="sidebar-add podcast-queue">Queue</button></div></div>`).join('') || '<div class="dim">No playable episodes were found in this feed.</div>';
    list.querySelectorAll('.podcast-episode').forEach(row=>{ const ep=feed.episodes[Number(row.dataset.episodeIndex)]; const track=podcastTrackFromEpisode(ep,feed); row.querySelector('.podcast-play')?.addEventListener('click',()=>playQueue([track],0,false)); row.querySelector('.podcast-queue')?.addEventListener('click',()=>{addTracksToQueue([track]);}); });
  }
  async function loadPodcastFeed(feedUrl, card) {
    const list = card?.querySelector('.podcast-episodes');
    if (!list) return;
    list.innerHTML='<div class="dim">Loading episodes…</div>'; card.classList.add('open');
    try { const feed=await window.beehive.podcastFeed(feedUrl); renderPodcastFeed(feed, list); } catch (err) { list.innerHTML=`<div class="dim">Could not load this feed: ${escapeHtml(err?.message||String(err))}</div>`; }
  }
  let podcastFavorites = [];
  let podcastFavoritesLoaded = false;
  async function loadPodcastFavorites() {
    if (podcastFavoritesLoaded) return podcastFavorites;
    try { podcastFavorites = await window.beehive.getPodcastFavorites?.() || []; } catch { podcastFavorites = []; }
    podcastFavoritesLoaded = true;
    return podcastFavorites;
  }
  function isPodcastFavorite(feedUrl) { return podcastFavorites.some(x => String(x?.feedUrl || '') === String(feedUrl || '')); }
  async function togglePodcastFavorite(show) {
    try {
      const result = await window.beehive.togglePodcastFavorite?.(show);
      podcastFavorites = Array.isArray(result?.favorites) ? result.favorites : podcastFavorites;
      renderPodcastFavorites(document.querySelector('.podcast-favorites')); 
      document.querySelectorAll('.podcast-favorite-toggle').forEach(button => {
        button.classList.toggle('active', isPodcastFavorite(button.dataset.feedUrl));
        button.textContent = isPodcastFavorite(button.dataset.feedUrl) ? '★ Favorited' : '☆ Favorite';
      });
    } catch (err) { showAppNotice(err?.message || 'Could not update podcast favorite.'); }
  }
  function podcastFavoriteButton(show) {
    const active = isPodcastFavorite(show.feedUrl);
    return `<button type="button" class="podcast-favorite-toggle${active ? ' active' : ''}" data-feed-url="${escapeHtml(show.feedUrl)}">${active ? '★ Favorited' : '☆ Favorite'}</button>`;
  }
  function renderPodcastFavorites(host) {
    if (!host) return;
    if (!podcastFavorites.length) { host.innerHTML = '<div class="podcast-favorites-empty">Favorite a show to keep it here for quick access.</div>'; return; }
    host.innerHTML = podcastFavorites.map((show,i) => `<article class="podcast-favorite-card" data-favorite-index="${i}"><img src="${escapeHtml(show.image || '')}" alt=""><div class="podcast-favorite-main"><strong>${escapeHtml(show.title || 'Podcast')}</strong><span>${escapeHtml(show.author || '')}</span></div><button type="button" class="podcast-favorite-open" title="Open show">Open</button><button type="button" class="podcast-favorite-remove" title="Remove from favorites">×</button></article>`).join('');
    host.querySelectorAll('.podcast-favorite-open').forEach(button => button.addEventListener('click', async () => {
      const card=button.closest('.podcast-favorite-card'); const show=podcastFavorites[Number(card?.dataset.favoriteIndex)]; if(!show)return;
      const results=document.querySelector('.podcast-results');
      if (!results) return;
      // Opening a favorite used to wipe out the entire results panel,
      // silently discarding any current search and any other shows the user
      // already had expanded. Reuse an already-open card for this show if
      // one exists, otherwise prepend a new one instead of replacing
      // everything -- current search results/expanded shows are preserved.
      let target = results.querySelector(`.podcast-card[data-podcast-feed="${CSS.escape(show.feedUrl)}"]`);
      if (target) {
        if (!target.classList.contains('open')) {
          target.classList.add('open');
          if (!podcastFeeds.has(show.feedUrl)) void loadPodcastFeed(show.feedUrl, target);
        }
      } else {
        if (results.querySelector('.podcast-empty-state, .podcast-error-state')) results.innerHTML = '';
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `<article class="podcast-card open" data-podcast-feed="${escapeHtml(show.feedUrl)}"><button class="podcast-card-head" type="button"><img src="${escapeHtml(show.image||'')}" alt=""><div><h3>${escapeHtml(show.title||'Podcast')}</h3><p>${escapeHtml(show.author||'')}${show.genre?` · ${escapeHtml(show.genre)}`:''}</p></div><span class="podcast-chevron">›</span></button><div class="podcast-episodes" data-podcast-feed="${escapeHtml(show.feedUrl)}"></div></article>`;
        target = wrapper.firstElementChild;
        results.prepend(target);
        target.querySelector('.podcast-card-head').addEventListener('click', () => {
          const open = target.classList.toggle('open');
          if (open && !podcastFeeds.has(show.feedUrl)) void loadPodcastFeed(show.feedUrl, target);
        });
        const episodesHost = target.querySelector('.podcast-episodes');
        try { const feed=await window.beehive.podcastFeed(show.feedUrl); renderPodcastFeed(feed,episodesHost); } catch(err){episodesHost.innerHTML=`<div class="dim">Could not load this feed: ${escapeHtml(err?.message||String(err))}</div>`;}
      }
      target.scrollIntoView({block:'start',behavior:'smooth'});
    }));
    host.querySelectorAll('.podcast-favorite-remove').forEach(button => button.addEventListener('click', () => { const card=button.closest('.podcast-favorite-card'); const show=podcastFavorites[Number(card?.dataset.favoriteIndex)]; if(show) togglePodcastFavorite(show); }));
  }
  function bindPodcastFavoriteButtons(root) {
    root?.querySelectorAll('.podcast-favorite-toggle').forEach(button => button.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const feedUrl=button.dataset.feedUrl; const source=podcastResults.find(x=>String(x.feedUrl)===String(feedUrl)) || podcastFavorites.find(x=>String(x.feedUrl)===String(feedUrl));
      if(source) togglePodcastFavorite(source);
    }));
  }
  function renderPodcasts(tab = getActiveTab()) {
    if (!tab || tab.kind !== 'podcasts' || getActiveTab()?.id !== tab.id) return false;
    const contentTools = tab.dom?.contentTools;
    if (!contentTools) return false;
    el.albumsToolbar.classList.add('hidden'); el.albumsGrid.classList.add('hidden'); el.songsTable.classList.add('hidden'); el.artistsGrid.classList.add('hidden');
    contentTools.classList.remove('hidden');
    if (tab.dom.podcastsInitialized) return true;
    tab.dom.podcastsInitialized = true;
    tab.dom.podcastResults = [];
    podcastResults = [];
    contentTools.innerHTML=`<section class="podcasts-page">
      <header class="podcasts-hero">
        <div class="podcasts-hero-copy">
          <div class="podcast-eyebrow">INTERNET AUDIO</div>
          <h1>Podcasts</h1>
          <p>Find shows, open their latest episodes, and keep your favorite channels one click away.</p>
        </div>
        <form class="podcast-search-form" role="search">
          <div class="podcast-search-shell">
            <span class="podcast-search-icon" aria-hidden="true">⌕</span>
            <input class="podcast-search-input" placeholder="Search shows, hosts, or topics…" autocomplete="off" spellcheck="false" aria-label="Search podcasts">
            <button class="podcast-search-clear" type="button" aria-label="Clear podcast search" title="Clear search">×</button>
          </div>
          <button class="podcast-search-submit" type="submit">Search</button>
        </form>
      </header>
      <section class="podcast-home-favorites">
        <div class="podcast-home-head">
          <div><div class="podcast-home-kicker">QUICK ACCESS</div><h2>Favorite shows</h2></div>
          <span class="podcast-section-note">Saved channels stay here for fast access.</span>
        </div>
        <div class="podcast-favorites"></div>
      </section>
      <section class="podcast-discovery">
        <div class="podcast-results-head">
          <div><div class="podcast-home-kicker">DISCOVER</div><h2>Search results</h2></div>
          <span class="podcast-result-count" aria-live="polite"></span>
        </div>
        <div class="podcast-results"><div class="podcast-empty-state"><strong>Search for a podcast</strong><span>Try a show name, creator, subject, or broad topic.</span></div></div>
      </section>
    </section>`;
    const input=contentTools.querySelector('.podcast-search-input'), clear=contentTools.querySelector('.podcast-search-clear'), results=contentTools.querySelector('.podcast-results'), count=contentTools.querySelector('.podcast-result-count'), favoritesHost=contentTools.querySelector('.podcast-favorites');
    void loadPodcastFavorites().then(()=>renderPodcastFavorites(favoritesHost));
    let searchGeneration=0;
    let debounceTimer=0;
    const setCount=(text='')=>{ if(count) count.textContent=text; };
    const emptyState=(title, detail)=>{ results.innerHTML=`<div class="podcast-empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`; setCount(''); };
    const updateClear=()=>{ if(clear) clear.classList.toggle('visible', !!input.value); };
    const run=async()=>{
      const q=input.value.trim();
      updateClear();
      if(!q){ searchGeneration++; emptyState('Search for a podcast','Try a show name, creator, subject, or broad topic.'); return; }
      if(q.length < 2){ emptyState('Keep typing','Use at least two characters for a useful podcast search.'); return; }
      const generation=++searchGeneration;
      results.innerHTML='<div class="podcast-loading"><span class="podcast-spinner"></span><strong>Searching podcasts…</strong><span>Looking through the public podcast directory.</span></div>';
      setCount('Searching…');
      try {
        const data=await window.beehive.podcastSearch(q);
        if(generation !== searchGeneration) return;
        podcastResults=data.results||[];
        setCount(`${podcastResults.length} ${podcastResults.length === 1 ? 'show' : 'shows'}`);
        results.innerHTML=podcastResults.map((r,i)=>`<article class="podcast-card" data-result-index="${i}">
          <button class="podcast-card-head" type="button">
            <img src="${escapeHtml(r.image||'')}" alt="" loading="lazy" decoding="async">
            <div class="podcast-card-copy"><h3>${escapeHtml(r.title)}</h3><p>${escapeHtml(r.author||'Independent creator')}${r.genre?` <span>· ${escapeHtml(r.genre)}</span>`:''}</p></div>
            <span class="podcast-chevron" aria-hidden="true">›</span>
          </button>
          <div class="podcast-card-actions">${podcastFavoriteButton(r)}</div>
          <div class="podcast-episodes" data-podcast-feed="${escapeHtml(r.feedUrl)}"></div>
        </article>`).join('') || '<div class="podcast-empty-state"><strong>No shows found</strong><span>Try a shorter title, a creator name, or a broader topic.</span></div>';
        results.querySelectorAll('.podcast-card').forEach((card,i)=>{
          const r=podcastResults[i]; const head=card.querySelector('.podcast-card-head');
          head.addEventListener('click',()=>{ const open=card.classList.toggle('open'); if(open && !podcastFeeds.has(r.feedUrl)) void loadPodcastFeed(r.feedUrl,card); });
        });
        bindPodcastFavoriteButtons(results);
      } catch(err) {
        if(generation !== searchGeneration) return;
        setCount('');
        results.innerHTML=`<div class="podcast-error-state"><strong>Podcast search failed</strong><span>${escapeHtml(err?.message||String(err))}</span><button type="button" class="podcast-retry">Try again</button></div>`;
        results.querySelector('.podcast-retry')?.addEventListener('click',()=>run());
      }
    };
    const scheduleSearch=()=>{
      clearTimeout(debounceTimer);
      updateClear();
      const q=input.value.trim();
      if(!q){ emptyState('Search for a podcast','Try a show name, creator, subject, or broad topic.'); return; }
      if(q.length < 2){ emptyState('Keep typing','Use at least two characters for a useful podcast search.'); return; }
      debounceTimer=setTimeout(()=>void run(),450);
    };
    contentTools.querySelector('.podcast-search-form').addEventListener('submit',e=>{e.preventDefault(); clearTimeout(debounceTimer); void run();});
    clear?.addEventListener('click',()=>{ clearTimeout(debounceTimer); input.value=''; try{localStorage.removeItem('beehive:podcast-search')}catch{} updateClear(); emptyState('Search for a podcast','Try a show name, creator, subject, or broad topic.'); input.focus(); });
    input.addEventListener('input',()=>{ try{localStorage.setItem('beehive:podcast-search',input.value)}catch{} scheduleSearch(); });
    input.addEventListener('keydown',e=>{ if(e.key==='Escape' && input.value){ e.preventDefault(); clear?.click(); } });
    try { const q=localStorage.getItem('beehive:podcast-search')||''; input.value=q; updateClear(); if(q.trim().length>=2) debounceTimer=setTimeout(()=>void run(),250); } catch {}
  }

  function tabPlaceholderCopy(kind) {
    if (kind === 'playlists') return ['Playlists', 'Pick a playlist from the sidebar (Favorites, Recently Added, Top 25) to view it here.'];
    if (kind === 'podcasts') return ['Podcasts', 'Search for a podcast, open its episodes, and play or queue them alongside your local music.'];
    return ['', ''];
  }

  function applyTabView(kind, tab = getActiveTab()) {
    el.tabPlaceholder.classList.add('hidden');
    el.emptyState.classList.add('hidden');
    el.albumsToolbar.classList.add('hidden');
    el.albumsGrid.classList.add('hidden');
    el.songsTable.classList.add('hidden');
    el.artistsGrid.classList.add('hidden');
    if (kind === 'playlists') {
      playlists = playlists || [];
      void renderPlaylistManager(tab);
      return;
    }
    if (kind === 'podcasts') {
      renderPodcasts(tab);
      return;
    }
    if (kind === 'music') {
      el.emptyState.classList.toggle('hidden', library.tracks.length > 0);
      el.albumsToolbar.classList.toggle('hidden', library.tracks.length === 0);
      setView(viewMode);
      return;
    }
    const [title, body] = tabPlaceholderCopy(kind);
    el.tabPlaceholderTitle.textContent = title;
    el.tabPlaceholderBody.textContent = body;
    el.tabPlaceholder.classList.remove('hidden');
  }

  function loadTabStateIntoGlobals(tab) {
    if (!tab) return;
    const state = tab.state || {};
    searchTerm = String(state.searchTerm || '');
    artistSearchTerm = String(state.artistSearchTerm || '');
    albumYearDividers = state.albumYearDividers !== false;
    viewMode = state.viewMode || 'albums';
    specialView = state.specialView || null;
    const derivedBaseLabel = specialView === 'recent' ? 'Recently Added'
      : specialView === 'top' ? 'Top 25 Most Played'
      : specialView === 'history' ? 'History'
      : specialView === 'sandbox' ? 'Sandbox'
      : specialView === 'podcasts' ? 'Podcasts'
      : specialView === 'yearly-wrap' ? 'Yearly Wrap'
      : specialView === 'folder' && state.activeFolderPath ? String(state.activeFolderPath).split(/[\\/]/).filter(Boolean).pop() || String(state.activeFolderPath)
      : specialView === 'playlist' ? null
      : (tab?.kind === 'music' ? (sidebarLabel('music') || 'Music') : null);
    if (tab?.kind === 'music') {
      tab.baseLabel = state.tabBaseLabel || derivedBaseLabel || sidebarLabel('music') || 'Music';
      if (state.tabBaseIcon) { tab.baseIcon = String(state.tabBaseIcon); tab.icon = tab.baseIcon; }
    } else if (tab?.kind === 'playlists' && state.tabBaseLabel) {
      tab.baseLabel = String(state.tabBaseLabel);
      tab.label = tab.baseLabel;
      if (state.tabBaseIcon) { tab.baseIcon = String(state.tabBaseIcon); tab.icon = tab.baseIcon; }
    }
    activeFolderPath = state.activeFolderPath || '';
    activePlaylistId = state.activePlaylistId ?? null;
    openAlbumKey = state.openAlbumKey ? String(state.openAlbumKey) : null;
    highlightedAlbumKey = state.highlightedAlbumKey ? String(state.highlightedAlbumKey) : null;
    el.search.value = artistSearchTerm || searchTerm;
    updateSearchClearButton();
    el.main.classList.toggle('searching', !!(artistSearchTerm || searchTerm));
    syncTabControls();
    syncSidebarSelectionForContext();
  }

  function restoreTabState(tab) {
    if (!tab) return;
    if (tab.state?.specialView === 'nowplaying') tab.state.specialView = 'sandbox';
    ensureTabHost(tab);
    activateTabDom(tab);
    const savedScrollTop = Math.max(0, Number(tab.state?.scrollTop) || 0);

    // A tab's DOM is its persistent browser state. Do not rebuild it when
    // switching tabs: rebuilding the album grid destroys its inline expansion.
    restoringTabState = true;
    try {
      loadTabStateIntoGlobals(tab);
      if (!tab.dom.initialized) {
        // The original Music tab can be populated by normal startup/library
        // rendering before its tab wrapper is considered initialized. If its
        // own browser surface already contains rendered content, never rebuild
        // it just because we are returning to the tab: rebuilding the album
        // grid destroys an open inline album panel. New/empty tabs still render
        // normally because their surfaces contain no browser content yet.
        const hasRenderedMusicContent = tab.kind === 'music' && (
          (tab.dom.albumsGrid?.children?.length || 0) > 0 ||
          (tab.dom.songsTable?.children?.length || 0) > 0 ||
          (tab.dom.artistsGrid?.children?.length || 0) > 0
        );
        if (hasRenderedMusicContent) {
          tab.dom.initialized = true;
          tab.dom.dirty = false;
        } else {
          tab.dom.initialized = true;
          tab.dom.dirty = false;
          applyTabView(tab.kind);
        }
      }
    } finally {
      restoringTabState = false;
    }

    updateActiveTabLabel();
    // Re-expand the album this tab had open before it was closed/restarted.
    // Nothing else reads openAlbumKey to auto-expand a card on a fresh
    // render -- the only prior consumers were the album/artist search "Back"
    // restores (restoreAlbumSearchContext/restoreArtistSearchContext), never
    // a plain tab restore. Album cards render progressively (12 per frame --
    // see renderAlbums()), so on a large, unfiltered library the target card
    // may not exist for many frames; poll (bounded, so a since-deleted album
    // can't spin forever) instead of guessing at one frame.
    const reopenKey = tab.state?.openAlbumKey ? String(tab.state.openAlbumKey) : null;
    reopenTabAlbumWhenReady(tab, reopenKey && viewMode === 'albums' ? reopenKey : null).then(reopenedCard => {
      if (activeTabId !== tab.id) return;
      if (reopenedCard) {
        // A raw saved scrollTop is only a best guess -- library changes since
        // the tab was last open (new/removed albums, a different sort) can
        // shift exactly where the album now sits. When the album actually
        // reopened, guarantee it is visible by scrolling straight to it
        // instead of trusting the old pixel offset.
        reopenedCard.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        saveActiveTabState();
        return;
      }
      getActiveViewport().scrollTop = savedScrollTop;
      requestAnimationFrame(() => {
        if (activeTabId !== tab.id) return;
        getActiveViewport().scrollTop = savedScrollTop;
        saveActiveTabState();
      });
    });
  }

  function reopenTabAlbumWhenReady(tab, reopenKey, attemptsLeft = 600) {
    if (!reopenKey || activeTabId !== tab.id) return Promise.resolve(null);
    const card = tab.dom?.albumsGrid?.querySelector(`.album-card[data-key="${CSS.escape(reopenKey)}"]`);
    if (card) {
      if (!card.classList.contains('inline-expanded')) {
        const tracks = tracksForCurrentContext();
        const album = buildAlbums(tracks).find(a => String(a?.key || '') === reopenKey);
        if (album) toggleInlineAlbum(card, album);
      }
      return Promise.resolve(card);
    }
    if (attemptsLeft <= 0) return Promise.resolve(null);
    return new Promise(resolve => requestAnimationFrame(() => resolve(reopenTabAlbumWhenReady(tab, reopenKey, attemptsLeft - 1))));
  }

  function switchTab(id) {
    const tab = tabs.find(t => t.id === id);
    if (!tab || id === activeTabId) return;
    saveActiveTabState();
    if (tab.kind === 'music' && tab.navId) {
      const entry = sidebarEntry(tab.navId);
      if (entry?.type === 'playlist') {
        const pl = playlists.find(p => String(p.id) === String(entry.playlistId));
        if (pl) preparePlaylistMusicTab(tab, pl);
      }
    }
    activeTabId = id;
    renderTabs();
    restoreTabState(tab);
    if (tab.kind === 'music' && tab.navId && sidebarEntry(tab.navId)?.type === 'playlist') renderCurrentView();
    persistUiStateSoon();
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tab = tabs[idx];
    if (!tab.closable) return;
    const wasActive = activeTabId === id;
    if (tab.dom?.host) tab.dom.host.remove();
    tabs.splice(idx, 1);
    if (wasActive) {
      const next = tabs[Math.max(0, idx - 1)] || tabs[0];
      if (next) {
        activeTabId = next.id;
        restoreTabState(next);
      }
    }
    renderTabs();
    persistUiStateSoon();
  }

  function persistTabOrder() {
    persistUiStateSoon();
  }

  let draggedTabId = null;
  let tabDropTargetId = null;
  el.topbarTabs.addEventListener('dragstart', e => {
    const btn = e.target?.closest?.('.tab');
    if (!btn || btn.id === 'tab-add-btn') return;
    const dragged = tabs.find(t => t.id === btn.dataset.tabId);
    if (!dragged || !dragged.navId || !sidebarNavigation.pinned.has(dragged.navId) || dragged.navId === 'pl-explorer') return;
    draggedTabId = btn.dataset.tabId || null;
    tabDropTargetId = null;
    btn.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', draggedTabId || ''); } catch {}
  });
  el.topbarTabs.addEventListener('dragover', e => {
    const btn = e.target?.closest?.('.tab');
    if (!draggedTabId || !btn || btn.id === 'tab-add-btn' || btn.dataset.tabId === draggedTabId) return;
    const targetTab = tabs.find(t => t.id === btn.dataset.tabId);
    const draggedTab = tabs.find(t => t.id === draggedTabId);
    if (!targetTab?.navId || !draggedTab?.navId || !sidebarNavigation.pinned.has(targetTab.navId) || !sidebarNavigation.pinned.has(draggedTab.navId) || targetTab.navId === 'pl-explorer' || draggedTab.navId === 'pl-explorer') return;
    e.preventDefault();
    document.querySelectorAll('.tab.drop-before,.tab.drop-after').forEach(x => x.classList.remove('drop-before','drop-after'));
    const r = btn.getBoundingClientRect();
    const after = e.clientX >= r.left + r.width / 2;
    btn.classList.add(after ? 'drop-after' : 'drop-before');
    tabDropTargetId = btn.dataset.tabId;
    btn.dataset.dropAfter = after ? '1' : '0';
  });
  el.topbarTabs.addEventListener('drop', e => {
    if (!draggedTabId || !tabDropTargetId) return;
    e.preventDefault();
    const dragged = tabs.find(t => t.id === draggedTabId);
    const targetTab = tabs.find(t => t.id === tabDropTargetId);
    const target = e.target?.closest?.('.tab');
    const after = target?.dataset.dropAfter === '1';
    if (dragged?.navId && targetTab?.navId && sidebarNavigation.pinned.has(dragged.navId) && sidebarNavigation.pinned.has(targetTab.navId)) {
      const from = sidebarNavigation.pinnedOrder.indexOf(dragged.navId);
      let to = sidebarNavigation.pinnedOrder.indexOf(targetTab.navId);
      if (from >= 0 && to >= 0 && from !== to) {
        const [moved] = sidebarNavigation.pinnedOrder.splice(from, 1);
        if (from < to) to--;
        sidebarNavigation.pinnedOrder.splice(Math.max(0, Math.min(sidebarNavigation.pinnedOrder.length, to + (after ? 1 : 0))), 0, moved);
        saveNavigationPrefs();
        renderTabs();
        enforceLockedTopbarPins();
        renderNavigationEditors();
      }
    }
  });
  el.topbarTabs.addEventListener('dragend', () => {
    draggedTabId = null; tabDropTargetId = null;
    document.querySelectorAll('.tab.dragging,.tab.drop-before,.tab.drop-after').forEach(x => x.classList.remove('dragging','drop-before','drop-after'));
    document.querySelectorAll('.tab').forEach(x => delete x.dataset.dropAfter);
  });

  el.topbarTabs.addEventListener('pointerdown', e => {
    const close = e.target?.closest?.('.tab-close');
    if (!close) return;
    const btn = close.closest('.tab');
    const id = btn?.dataset.tabId;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    closeTab(id);
  });
  el.topbarTabs.addEventListener('click', e => {
    const close = e.target?.closest?.('.tab-close');
    if (close) { e.preventDefault(); e.stopPropagation(); return; }
    const btn = e.target?.closest?.('.tab');
    if (!btn || btn.id === 'tab-add-btn') return;
    const id = btn.dataset.tabId;
    const tab=tabs.find(x=>x.id===id);
    if(tab?.kind==='navigation'){ void showSpecialNavigation(tab.navId); return; }
    if (tab?.kind === 'music' && tab?.navId === 'music' && activeTabId === tab.id) {
      resetMusicHomeView(tab);
      return;
    }
    if (tab?.kind === 'music' && tab?.navId) {
      const entry = sidebarEntry(tab.navId);
      if (entry?.type === 'playlist') {
        const pl = playlists.find(p => String(p.id) === String(entry.playlistId));
        if (pl) {
          // A pinned playlist tab is itself the playlist destination. Its
          // presentation must never fall through to the Playlists manager just
          // because its DOM was initialized while another top-level tab was
          // active. Reassert the canonical playlist state and render it in the
          // tab the user actually clicked.
          preparePlaylistMusicTab(tab, pl);
          if (activeTabId !== tab.id) switchTab(tab.id);
          else { restoreTabState(tab); renderCurrentView(); }
          renderTabs();
          updateActiveTabLabel();
          return;
        }
      }
    }
    if (id) switchTab(id);
  });

  el.tabAddBtn.addEventListener('click', () => {
    saveActiveTabState();
    tabSeq += 1;
    const id = 'tab-extra-' + tabSeq;
    const tab = { id, label: sidebarLabel('music') || 'Music', icon: sidebarIcon('music') || '', kind: 'music', closable: true, baseLabel: sidebarLabel('music') || 'Music', baseIcon: sidebarIcon('music') || '', state: {
      searchTerm: '', artistSearchTerm: '', albumYearDividers: true, viewMode: 'albums',
      specialView: null, activeFolderPath: '', activePlaylistId: null, openAlbumKey: null, highlightedAlbumKey: null, scrollTop: 0,
    }, dom: null };
    tab.dom = makeTabDom(defaultMusicTab);
    // A new tab gets the same shell, not a live copy of another tab's expanded
    // album. Its own first render establishes its independent browser state.
    tab.dom.albumsGrid.innerHTML = '';
    tab.dom.songsTable.innerHTML = '';
    tab.dom.artistsGrid.innerHTML = '';
    tab.dom.initialized = false;
    tabs.push(tab);
    activeTabId = id;
    renderTabs();
    restoreTabState(tab);
    persistUiStateSoon();
  });

  // The original browser surfaces become the permanent DOM owned by the
  // default Music tab. Every other tab receives independent clones. The
  // playlists tab is also isolated so switching between top-level tabs cannot
  // accidentally reuse a Music browser's DOM.
  const defaultMusicTab = tabs.find(t => t.navId === 'music' && t.kind === 'music');
  const playlistsTab = tabs.find(t => t.navId === 'pl-explorer' && t.kind === 'playlists');
  if (defaultMusicTab) {
    defaultMusicTab.dom = makeTabDom(null, true);
    defaultMusicTab.dom.initialized = false;
  }
  if (playlistsTab && defaultMusicTab?.dom) {
    playlistsTab.dom = {
      emptyState: defaultMusicTab.dom.emptyState.cloneNode(true),
      tabPlaceholder: defaultMusicTab.dom.tabPlaceholder.cloneNode(true),
      albumsToolbar: defaultMusicTab.dom.albumsToolbar.cloneNode(true),
      albumsGrid: defaultMusicTab.dom.albumsGrid.cloneNode(true),
      songsTable: defaultMusicTab.dom.songsTable.cloneNode(true),
      artistsGrid: defaultMusicTab.dom.artistsGrid.cloneNode(true),
      contentTools: defaultMusicTab.dom.contentTools.cloneNode(true),
      initialized: false, dirty: false, host: null, viewport: null,
    };
  }
  // Every canonical sidebar destination owns a persistent DOM surface, even when unpinned.
  tabs.forEach(t => ensureTabHost(t));
  activateTabDom(tabs.find(t => t.id === activeTabId) || defaultMusicTab);
  tabs.forEach(t => {
    if (t.state) return;
    t.state = {
      searchTerm: '', artistSearchTerm: '', albumYearDividers: true, viewMode: 'albums',
      specialView: null, tabBaseLabel: t.baseLabel || (t.kind === 'music' ? (sidebarLabel('music') || 'Music') : 'PLAYLISTS'),
      tabBaseIcon: t.baseIcon || (t.kind === 'music' ? (sidebarIcon('music') || '') : '☰'), activeFolderPath: '', activePlaylistId: null, openAlbumKey: null, highlightedAlbumKey: null, scrollTop: 0,
    };
  });
  // First-paint guard: navigation/tabs are core chrome. Keep failures here from
  // leaving the entire application apparently empty.
  try { renderSidebarNavigation(); } catch (err) { startupMark('NAVIGATION RENDER ERROR', { message: err?.message || String(err), stack: err?.stack }); }
  try { renderTabs(); } catch (err) { startupMark('TAB RENDER ERROR', { message: err?.message || String(err), stack: err?.stack }); }
  updateActiveTabLabel();
  void hydrateUiStateFromConfig();
  el.playlistInfoName?.addEventListener('input',()=>{
    if(playlistInfoLabelStyleGenerated && el.playlistInfoLabelHtml){
      const selected=el.playlistInfoLabelStyles?.querySelector('.playlist-label-style-choice.selected')?.dataset.style || 'plain';
      const choice=PLAYLIST_LABEL_STYLE_CHOICES.find(x=>x.id===selected)||PLAYLIST_LABEL_STYLE_CHOICES[0];
      el.playlistInfoLabelHtml.value=choice.id==='plain' ? String(el.playlistInfoName.value||'') : choice.html.replace('{text}',escapeHtml(String(el.playlistInfoName.value||'Untitled Playlist')));
    }
    applyPlaylistInfoLabelPreview();
  });
  el.playlistInfoLabelHtml?.addEventListener('input',()=>{ playlistInfoLabelStyleGenerated=false; applyPlaylistInfoLabelPreview(); });
  el.playlistInfoSave?.addEventListener('click',savePlaylistInfoChanges);
  el.playlistInfoHeroIcon?.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (el.playlistInfoIconMenu?.classList.contains('hidden')) openPlaylistInfoIconMenu();
    else closePlaylistInfoIconMenu();
  });
  document.addEventListener('click', e => {
    if (!e.target?.closest?.('.playlist-info-icon-picker')) closePlaylistInfoIconMenu();
  });
  el.playlistCancel.addEventListener('click',()=>closeModal(el.playlistModal));
  el.playlistImportCancel.addEventListener('click',()=>closeModal(el.playlistImportModal));
  el.playlistImportFile.addEventListener('click',importPlaylistFile);
  el.playlistImportSpotify.addEventListener('click',importSpotifyPlaylist);
  el.playlistName.addEventListener('input',()=>{
    if(playlistLabelStyleGenerated && el.playlistLabelHtml){
      el.playlistLabelHtml.value=generatedPlaylistLabel();
    }
    applyPlaylistLabelStyle();
  });
  el.playlistLabelHtml?.addEventListener('input',()=>{ playlistLabelStyleGenerated=false; applyPlaylistLabelStyle(); });
  el.playlistSave.addEventListener('click',async()=>{
    try {
      const name=richLabelText(el.playlistName.value).trim(); if(!name)return;
      const label=playlistLabelForSave();
      const displayView=['albums','songs','artists'].includes(el.playlistDisplayView?.value) ? el.playlistDisplayView.value : 'albums';
      const existing=editingPlaylistId ? playlists.find(p=>String(p.id)===String(editingPlaylistId)) : null;
      const pl=await window.beehive.savePlaylist({
        ...(existing || {}),
        id: editingPlaylistId || undefined,
        name,
        label,
        tracks: existing ? existing.tracks : [],
        smart: existing ? !!existing.smart : false,
        displayView
      });
      if(existing){ playlists=playlists.map(p=>String(p.id)===String(pl.id)?pl:p); }
      else playlists.push(pl);
      editingPlaylistId=null;
      closeModal(el.playlistModal); renderPlaylistManager();
    } catch (err) {
      showAppNotice(err?.message || 'Could not create playlist.');
    }
  });
  el.smartPlaylistCancel.addEventListener('click',()=>closeModal(el.smartPlaylistModal));
  el.smartPlaylistAddRule.addEventListener('click',()=>addSmartRuleRow());
  el.smartPlaylistSave.addEventListener('click',async()=>{
    try {
      const existing=editingSmartPlaylistId ? playlists.find(p=>String(p.id)===String(editingSmartPlaylistId)) : null;
      const isBuiltInFavorites = existing?.systemKey === 'star-favorites' || existing?.id === 'hive-star-favorites';
      const name=isBuiltInFavorites ? 'Favorites' : el.smartPlaylistName.value.trim(); if(!name)return;
      const rules=Array.from(el.smartPlaylistRules.querySelectorAll('.smart-rule-row')).map(row=>({field:row.querySelector('.smart-field').value,op:row.querySelector('.smart-op').value,value:row.querySelector('.smart-value').value.trim()}));
      const sourceType=document.querySelector('input[name="smart-source"]:checked')?.value||'library';
      const sourceValue=sourceType==='playlist'?document.getElementById('smart-source-playlist').value:sourceType==='folder'?document.getElementById('smart-source-folder').value:'library';
      const pl=await window.beehive.savePlaylist({
        ...(existing || {}),
        id: editingSmartPlaylistId || undefined,
        name, tracks: existing?.tracks || [], smart:true,
        match:el.smartPlaylistMatch.value,rules,limit:Number(el.smartPlaylistLimit.value) > 0 ? Math.max(1,Math.floor(Number(el.smartPlaylistLimit.value))) : 0,
        sort:el.smartPlaylistSort?.value||'addedDesc',sourceType,sourceValue,
        description:document.getElementById('smart-playlist-description').value.trim(),
        displayView:document.getElementById('smart-playlist-display').value,
        filterDuplicates:document.getElementById('smart-filter-duplicates').checked,
        selectBy:document.getElementById('smart-playlist-select-by').value,
        smartShuffle:document.getElementById('smart-playlist-shuffle').value,
        autoRefresh:document.getElementById('smart-auto-refresh').checked,
        exportStatic:document.getElementById('smart-export-static').checked
      });
      if(existing) playlists=playlists.map(item=>String(item.id)===String(pl.id)?pl:item);
      else playlists.push(pl);
      editingSmartPlaylistId=null;
      closeModal(el.smartPlaylistModal);
      refreshPlaylistTabPresentation(pl);
      renderSidebarNavigation();
      renderTabs();
      if (specialView === 'playlist' && String(activePlaylistId) === String(pl.id)) renderCurrentView();
      renderPlaylistManager();
      updateActiveTabLabel();
    } catch (err) {
      showAppNotice(err?.message || 'Could not save smart playlist.');
    }
  });

  document.querySelectorAll('input[name="tag-lyrics-align"]').forEach(r => r.addEventListener('change', () => applyLyricsAlignment(r.value)));
  el.tagCancel.addEventListener('click',()=>closeModal(el.tagModal));
  async function setPendingArtwork(chosen, statusText='New artwork selected. Save tags to apply it.') {
    if (!chosen) return;
    pendingArtworkPath = chosen.path || null;
    pendingArtworkPreviewUrl = chosen.dataUrl || chosen.url || (chosen.path ? coverSrc(chosen.path) : '');
    const url = pendingArtworkPreviewUrl;
    ['tag-art-preview','tag-artwork-preview'].forEach(id=>{const img=document.getElementById(id);if(img && url)img.src=url;});
    el.tagStatus.textContent = statusText;
  }
  async function searchEditorArtwork(manual=false, targetSlot=null) {
    if (!editingTrack) return;
    const modal = document.getElementById('cover-picker-modal');
    const status = document.getElementById('cover-picker-status');
    const results = document.getElementById('cover-picker-results');
    const query = document.getElementById('cover-picker-query');
    const title = document.getElementById('cover-picker-title');
    const scope = document.getElementById('cover-picker-scope');
    const selection = document.getElementById('cover-picker-selection');
    const searchBtn = document.getElementById('cover-picker-search');
    const previewImage = document.getElementById('cover-picker-preview-image');
    const previewTitle = document.getElementById('cover-picker-preview-title');
    const previewArtist = document.getElementById('cover-picker-preview-artist');
    const previewMeta = document.getElementById('cover-picker-preview-meta');
    const applyBtn = document.getElementById('cover-picker-apply');
    if (!modal || !status || !results) return;

    const album = String(editingTrack.album || '').trim();
    const artist = String(editingTrack.albumArtist || editingTrack.artist || '').trim();
    const albumLabel = album || 'Unknown album';
    const artistLabel = artist || 'Unknown artist';
    const albumMode = Array.isArray(editingTracks) && editingTracks.length > 1 && editingTracks.every(track => albumKey(track) === albumKey(editingTrack));
    let selectedItem = null;

    if (title) title.textContent = albumLabel;
    if (query) query.textContent = artistLabel;
    if (scope) scope.textContent = targetSlot?.blank ? 'Fill this blank artwork slot' : (targetSlot ? `Replace ${artworkEditorSlotLabel(targetSlot)} only` : (albumMode ? `All ${editingTracks.length} songs in this album` : 'This song'));
    if (selection) selection.textContent = 'No artwork selected';
    if (previewImage) { previewImage.removeAttribute('src'); previewImage.alt = ''; }
    if (previewTitle) previewTitle.textContent = 'Select artwork';
    if (previewArtist) previewArtist.textContent = '';
    if (previewMeta) previewMeta.textContent = 'No artwork selected';
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Apply selected cover'; }
    status.textContent = 'Searching MusicBrainz and iTunes…';
    results.innerHTML = '<div class="cover-picker-loading"><span class="cover-picker-spinner"></span><strong>Finding artwork</strong><small>Checking multiple releases and high-resolution artwork sources.</small></div>';
    openModal(modal);
    if (searchBtn) searchBtn.disabled = true;

    try {
      const found = await window.beehive.searchInternetCover({ album, artist, manualQuery: manual ? album : '' });
      if (!Array.isArray(found) || !found.length) {
        status.textContent = 'No matching artwork found.';
        results.innerHTML = `<div class="cover-picker-empty"><div class="cover-picker-empty-icon">⌁</div><strong>No artwork found</strong><span>Beehive could not find artwork for this album and artist.</span><button type="button" class="cover-picker-empty-retry" id="cover-picker-empty-retry">Search again</button></div>`;
        document.getElementById('cover-picker-empty-retry')?.addEventListener('click', () => searchEditorArtwork(true, targetSlot));
        return;
      }

      // Prefer conventional square album artwork first. Non-square/odd-ratio
      // artwork is still valid and remains available, but is shown after the
      // normal square covers so unusual source dimensions do not dominate the
      // picker ordering.
      found.sort((a, b) => {
        const aw = Number(a?.width || 0), ah = Number(a?.height || 0);
        const bw = Number(b?.width || 0), bh = Number(b?.height || 0);
        const aSquare = aw > 0 && ah > 0 && aw === ah;
        const bSquare = bw > 0 && bh > 0 && bw === bh;
        if (aSquare !== bSquare) return aSquare ? -1 : 1;
        if (aSquare && bSquare) {
          // Among normal square artwork, keep higher-resolution choices first.
          return Math.max(bw, bh) - Math.max(aw, ah);
        }
        // For odd dimensions, prefer the larger source while retaining the
        // server's relevance score as the final tie-breaker.
        const areaDiff = (bw * bh) - (aw * ah);
        return areaDiff || Number(b.score || 0) - Number(a.score || 0);
      });
      status.textContent = `${found.length} artwork option${found.length === 1 ? '' : 's'} found`;
      results.innerHTML = found.map((item, i) => {
        const source = String(item.source || 'Artwork');
        const sourceClass = source.toLowerCase().replace(/[^a-z0-9]+/g,'-');
        const year = item.releaseYear ? ` · ${escapeHtml(String(item.releaseYear))}` : '';
        const resolution = `${Number(item.width || 1200)} × ${Number(item.height || 1200)}`;
        const edition = item.releaseCountry ? ` · ${escapeHtml(String(item.releaseCountry))}` : '';
        return `<button type="button" class="cover-picker-result" data-cover-index="${i}" aria-label="Preview ${escapeHtml(item.collectionName || 'album artwork')}">
          <div class="cover-picker-image-wrap"><img src="${escapeHtml(item.artworkUrl || '')}" alt="" loading="eager"><span class="cover-picker-source-badge ${sourceClass}">${escapeHtml(source)}</span></div>
          <span class="cover-picker-result-info"><strong>${escapeHtml(item.collectionName || albumLabel)}</strong><small>${escapeHtml(item.artistName || artistLabel)}${year}${edition}</small><em>${resolution}${item.releaseId ? ` · ${escapeHtml(String(item.releaseId).slice(0,8))}` : ''}</em></span>
        </button>`;
      }).join('');

      const showPreview = (item, btn) => {
        selectedItem = item;
        results.querySelectorAll('.cover-picker-result').forEach(b => b.classList.toggle('selected', b === btn));
        const source = item.source || 'Artwork';
        const resolution = `${Number(item.width || 1200)} × ${Number(item.height || 1200)}`;
        const releaseInfo = [item.releaseYear, item.releaseCountry].filter(Boolean).join(' · ');
        if (previewImage) { previewImage.src = item.artworkUrl || ''; previewImage.alt = `${item.collectionName || albumLabel} artwork`; }
        if (previewTitle) previewTitle.textContent = item.collectionName || albumLabel;
        if (previewArtist) previewArtist.textContent = item.artistName || artistLabel;
        if (previewMeta) previewMeta.textContent = [source, resolution, releaseInfo].filter(Boolean).join(' · ');
        if (selection) selection.textContent = `${source} · ${resolution} · ready to apply`;
        if (applyBtn) applyBtn.disabled = !item.artworkUrl;
      };

      // The preview itself opens the same full-size cover viewer used by the
      // album/player artwork elsewhere in Beehive. Keep the picker selection
      // intact; opening the viewer is inspection only and never applies art.
      const openSelectedPreview = () => {
        if (!selectedItem?.artworkUrl) return;
        openCoverLightbox({
          title: selectedItem.collectionName || albumLabel,
          covers: [{ file: selectedItem.artworkUrl, type: 'Search Result' }],
          cover: selectedItem.artworkUrl
        });
      };
      previewImage?.addEventListener('click', openSelectedPreview);
      document.getElementById('cover-picker-preview-panel')?.addEventListener('click', (event) => {
        if (event.target.closest('#cover-picker-apply')) return;
        if (event.target.closest('.cover-picker-preview-image-wrap')) openSelectedPreview();
      });

      results.querySelectorAll('.cover-picker-result').forEach(btn => btn.addEventListener('click', () => {
        const item = found[Number(btn.dataset.coverIndex)];
        if (item) showPreview(item, btn);
      }));
      results.querySelectorAll('.cover-picker-result img').forEach(img => img.addEventListener('error', () => {
        const card = img.closest('.cover-picker-result');
        if (!card) return;
        const wasSelected = card.classList.contains('selected');
        card.remove();
        if (wasSelected) {
          selectedItem = null;
          if (selection) selection.textContent = 'No artwork selected';
          if (previewImage) { previewImage.removeAttribute('src'); previewImage.alt = ''; }
          if (previewTitle) previewTitle.textContent = 'Select artwork';
          if (previewArtist) previewArtist.textContent = '';
          if (previewMeta) previewMeta.textContent = 'No artwork selected';
          if (applyBtn) applyBtn.disabled = true;
        }
        const remaining = results.querySelectorAll('.cover-picker-result').length;
        status.textContent = remaining ? `${remaining} artwork option${remaining === 1 ? '' : 's'} found` : 'No usable artwork found.';
        if (!remaining) {
          results.innerHTML = '<div class="cover-picker-empty"><div class="cover-picker-empty-icon">⌁</div><strong>No usable artwork found</strong><span>The artwork sources returned images that could not be loaded.</span><button type="button" class="cover-picker-empty-retry" id="cover-picker-broken-retry">Search again</button></div>';
          document.getElementById('cover-picker-broken-retry')?.addEventListener('click', () => searchEditorArtwork(true, targetSlot));
        }
      }, { once: true }));

      applyBtn?.addEventListener('click', async () => {
        if (!selectedItem?.artworkUrl) return;
        results.querySelectorAll('.cover-picker-result').forEach(b => b.disabled = true);
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying cover…';
        status.textContent = 'Downloading selected full-resolution artwork…';
        try {
          const chosen = await window.beehive.downloadSearchCover(selectedItem.artworkUrl);
          if (targetSlot?.blank) {
            const blankIndex = artworkEditorBlankIndex(targetSlot.blankId);
            const blank = artworkEditorBlankSlotForIndex(blankIndex);
            if (!blank) throw new Error('That blank artwork slot is no longer available.');
            const type = normalizeArtworkType(blank.type || 'Cover (Back)');
            const comment = String(blank.description || '');
            await fillArtworkBlankSlot(blank.id, chosen, type, comment);
            closeModal(modal);
          } else if (targetSlot) {
            const index = artworkEditorIndexForSlot(artworkEditorPictures, targetSlot);
            const picture = artworkEditorPictures[index];
            if (!picture) throw new Error('That embedded artwork is no longer available.');
            const type = normalizeArtworkType(picture.type || 'Other');
            const comment = String(picture.description || '');
            pendingArtworkSlot = { ...targetSlot };
            pendingArtworkMode = 'replace';
            await setPendingArtwork(chosen, `${selectedItem.source || 'Internet'} artwork selected. Save to replace ${artworkEditorSlotLabel(targetSlot)}.`);
            // Optimistically show the selected cover in the editor; the actual
            // write is deliberately deferred until Save, then performed in the
            // background with the progress card above Lyrics.
            artworkEditorPictures[index] = { ...picture, file: chosen.path, dataUrl: chosen.dataUrl || chosen.url || '', type, description: comment };
            renderArtworkEditorList();
          } else {
            pendingArtworkSlot = null;
            pendingArtworkMode = 'front';
            await setPendingArtwork(chosen, `${selectedItem.source || 'Internet'} artwork selected. Save tags to embed it in the file.`);
            const type = document.getElementById('tag-picture-type'); if (type) type.value = 'Cover (Front)';
          }
          closeModal(modal);
        } catch (err) {
          results.querySelectorAll('.cover-picker-result').forEach(b => b.disabled = false);
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply selected cover';
          status.textContent = err.message || 'Could not download cover artwork.';
          if (selection) selection.textContent = 'Artwork could not be downloaded';
        }
      }, { once: true });
    } catch (err) {
      status.textContent = err.message || 'Artwork search failed.';
      results.innerHTML = `<div class="cover-picker-empty"><div class="cover-picker-empty-icon">!</div><strong>Search failed</strong><span>${escapeHtml(err.message || 'The artwork services could not be reached.')}</span><button type="button" class="cover-picker-empty-retry" id="cover-picker-error-retry">Try again</button></div>`;
      document.getElementById('cover-picker-error-retry')?.addEventListener('click', () => searchEditorArtwork(true, targetSlot));
    } finally {
      if (searchBtn) searchBtn.disabled = false;
    }
  }

  document.getElementById('cover-picker-close')?.addEventListener('click', () => closeModal(document.getElementById('cover-picker-modal')));
  document.getElementById('cover-picker-cancel')?.addEventListener('click', () => closeModal(document.getElementById('cover-picker-modal')));
  document.getElementById('cover-picker-search')?.addEventListener('click', () => searchEditorArtwork(true));
  document.getElementById('cover-picker-local')?.addEventListener('click', async () => {
    try { const chosen = await window.beehive.chooseCover(); if (chosen) { await setPendingArtwork(chosen); closeModal(document.getElementById('cover-picker-modal')); } }
    catch (err) { const status = document.getElementById('cover-picker-status'); if (status) status.textContent = err.message || 'Could not choose artwork.'; }
  });
  document.getElementById('cover-picker-paste')?.addEventListener('click', async () => {
    try { const chosen = await window.beehive.pasteCover(); if (chosen) { await setPendingArtwork(chosen); closeModal(document.getElementById('cover-picker-modal')); } else { const status = document.getElementById('cover-picker-status'); if (status) status.textContent = 'No image was available on the clipboard.'; } }
    catch (err) { const status = document.getElementById('cover-picker-status'); if (status) status.textContent = err.message || 'Could not paste artwork.'; }
  });

  document.getElementById('tag-cover-editor')?.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    const albumSelection = Array.isArray(editingTracks) && editingTracks.length > 1 && editingTracks.every(track => albumKey(track) === albumKey(editingTrack));
    const removePicture = async () => {
      if (albumSelection) {
        const count = editingTracks.length;
        const confirmed = await themedConfirm(`Remove ALL embedded artwork from all ${count} selected album tracks?\n\nThis will remove the front covers and any Album Cover (back) pictures, as well as every other embedded picture. The audio files themselves will not be deleted.`, 'Remove all embedded artwork');
        if (!confirmed) return;
        pendingArtworkPath = null;
        window.__beehiveRemoveFrontArtwork = false;
        window.__beehiveRemoveArtwork = true;
        ['tag-art-preview','tag-artwork-preview'].forEach(id=>{const img=document.getElementById(id);if(img)img.src=placeholderCover();});
        el.tagStatus.textContent=`All artwork from the ${count} selected album tracks is marked for removal. Save tags to apply it.`;
        return;
      }
      pendingArtworkPath=null;
      window.__beehiveRemoveFrontArtwork=true;
      window.__beehiveRemoveArtwork=false;
      ['tag-art-preview','tag-artwork-preview'].forEach(id=>{const img=document.getElementById(id);if(img)img.src=placeholderCover();});
      el.tagStatus.textContent='Front artwork marked for removal. Save tags to apply it.';
    };
    showContextMenu(e.clientX, e.clientY, [
      {label:'Choose Picture…', action:async()=>{ try { const type = document.getElementById('tag-picture-type'); if (type) type.value = 'Cover (Front)'; const chosen = await window.beehive.chooseCover(); await setPendingArtwork(chosen); } catch(err) { el.tagStatus.textContent = err.message || 'Could not choose artwork.'; } }},
      {label:'Search Internet for Cover…', action:()=>searchEditorArtwork()},
      {label:'Paste Picture', action:async()=>{ try { const type = document.getElementById('tag-picture-type'); if (type) type.value = 'Cover (Front)'; const chosen = await window.beehive.pasteCover(); if (chosen) await setPendingArtwork(chosen); else el.tagStatus.textContent='No image was available on the clipboard.'; } catch(err) { el.tagStatus.textContent = err.message || 'Could not paste artwork.'; } }},
      {label:'Remove Picture', danger:true, action:removePicture}
    ]);
  });

  document.getElementById('tag-artwork-add')?.addEventListener('click', addArtworkItem);
  document.getElementById('tag-artwork-itunes')?.addEventListener('click', () => {
    const blank = ensureArtworkEditorBlankSlot();
    searchEditorArtwork(false, { blank: true, blankId: Number(blank.id) });
  });
  document.getElementById('tag-artwork-paste')?.addEventListener('click', async()=>{
    try {
      const chosen = await window.beehive.pasteCover();
      if (!chosen) { el.tagStatus.textContent = 'No image was available on the clipboard.'; return; }
      // Paste is an ADD operation, never a replacement. Put the image into the
      // same blank slot used by Add Picture and Search MusicBrainz so the user
      // can choose Album Cover, Album Cover (back), Leaflet Page, etc. before
      // it is embedded. Existing artwork is left untouched.
      const blank = ensureArtworkEditorBlankSlot();
      const type = normalizeArtworkType(blank.type || 'Cover (Back)');
      const comment = String(blank.description || '');
      await fillArtworkBlankSlot(blank.id, chosen, type, comment);
    } catch(err) { el.tagStatus.textContent = err.message || 'Could not paste artwork.'; }
  });

  async function readTagsAfterWrite(trackPath, validator, attempts = 8) {
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const delay = 120 + attempt * 140;
        await new Promise(resolve => setTimeout(resolve, delay));
        const fresh = await window.beehive.readTags(trackPath);
        last = fresh;
        if (!validator || validator(fresh)) return fresh;
      } catch (err) {
        last = err;
      }
    }
    if (last instanceof Error) throw last;
    return last;
  }

  // Named (not an inline listener) so the "unsaved changes" confirm flow for
  // click-through track switching can await this same save logic directly,
  // instead of dispatching a synthetic click and having no way to know when
  // the async save actually finished.
  async function saveTagEdits() {
    if(!editingTrack)return;
    const v=id=>document.getElementById(id)?.value.trim()||'';
    let custom={};
    try{custom=v('tag-advanced')?JSON.parse(v('tag-advanced')):{};}catch{el.tagStatus.textContent='Advanced tags must be valid JSON.';return;}
    const bulk = editingTracks.length > 1;
    const timePattern = /^\d+(?::\d{1,2}(?::\d{1,2})?)?(?:\.\d+)?$/;
    const startText = v('tag-start-time'), endText = v('tag-end-time');
    if ((startText && !timePattern.test(startText)) || (endText && !timePattern.test(endText))) {
      el.tagStatus.textContent = 'Start/end time must be seconds or m:ss / h:mm:ss.';
      return;
    }
    const startSeconds = parseTimeValue(startText), endSeconds = parseTimeValue(endText);
    if (endText && endSeconds > 0 && startText && endSeconds <= startSeconds) {
      el.tagStatus.textContent = 'End time must be later than start time.';
      return;
    }
    for (const item of editingTagSnapshots) {
      const duration = Number(item.data?.format?.duration ?? item.track?.duration ?? 0) || 0;
      if (duration > 0 && startSeconds >= duration && startText) {
        el.tagStatus.textContent = `Start time must be before the track duration (${fmtTime(duration)}).`;
        return;
      }
    }
    el.tagStatus.textContent='Saving…';
    const backgroundTagJobs = [];
    const backgroundArtworkJobs = [];
    try{
      for(let i=0;i<editingTracks.length;i++){
        const track=editingTracks[i];
        const snapshot=editingTagSnapshots[i]?.data || {};
        const common=snapshot.common||{};
        const native=snapshot.native||{};
        const current={};
        for(const [key] of TAG_EDITOR_FIELDS){
          current[key]=editorTextValue(common,native,key);
        }
        const perTrack={};
        // In bulk mode, only fields the user actually changed are written. If a
        // field was blank because the selected files differed, leaving it blank
        // preserves each file's original value instead of erasing it.
        for(const [key] of TAG_EDITOR_FIELDS){
          const id=TAG_EDITOR_FIELDS.find(x=>x[0]===key)?.[1];
          const fieldNode = document.getElementById(id);
          // A field can live on another MusicBee-style tab. Never treat an absent
          // DOM field as an intentional blank or we would erase that tag on Save.
          if (!fieldNode) continue;
          const shownValue=fieldNode.value.trim()||'';
          const originalMerged = bulk ? mergeEditorValues(editingTagSnapshots.map(item => editorTextValue(item.data?.common||{},item.data?.native||{},key))) : current[key];
          if(!bulk || editorComparable(shownValue)!==editorComparable(originalMerged)){
            const outKey = key === 'albumartist' ? 'albumArtist' : key;
            perTrack[outKey]=shownValue;
          }
        }
        // Tags (2) fields map directly to their native/custom tag IDs. In bulk mode,
        // only write fields whose visible value differs from the common value.
        for (const [key, id] of [['pcount','tag-pcount'], ...Array.from({length:19}, (_, i) => [`custom${i+2}`, `tag-custom${i+2}`])]) {
          const shownValue = document.getElementById(id)?.value.trim() || '';
          const originalValues = editingTagSnapshots.map(item => editorTextValue(item.data?.common || {}, item.data?.native || {}, key));
          const originalMerged = mergeEditorValues(originalValues);
          if (!bulk || editorComparable(shownValue) !== editorComparable(originalMerged)) {
            perTrack[key === 'pcount' ? 'p_count' : key] = shownValue;
          }
        }
        // Compilation is a checkbox -- its real state lives in `.checked`, not
        // the `.value` the generic TAG_EDITOR_FIELDS loop reads.
        const compilationFieldNode = document.getElementById('tag-compilation');
        if (compilationFieldNode) {
          const shownCompilation = compilationFieldNode.checked ? '1' : '';
          const originalCompilation = mergeEditorValues(editingTagSnapshots.map(item => editorTextValue(item.data?.common || {}, item.data?.native || {}, 'compilation')));
          if (!bulk || editorComparable(shownCompilation) !== editorComparable(originalCompilation)) perTrack.compilation = shownCompilation;
        }
        // ReplayGain is intentionally represented by real metadata field names.
        // These writes also make the Settings tab useful for existing files without
        // inventing a Hive-only loudness format.
        const replaygainFields = [
          ['REPLAYGAIN_TRACK_GAIN','tag-replaygain-track-gain'], ['REPLAYGAIN_TRACK_PEAK','tag-replaygain-track-peak'],
          ['REPLAYGAIN_ALBUM_GAIN','tag-replaygain-album-gain'], ['REPLAYGAIN_ALBUM_PEAK','tag-replaygain-album-peak'],
          ['R128_TRACK_GAIN','tag-r128-track-gain']
        ];
        for (const [tagKey,id] of replaygainFields) {
          const shown = document.getElementById(id)?.value.trim() || '';
          const originals = editingTagSnapshots.map(item => nativeTagValue(item.data?.native, tagKey));
          const original = bulk ? mergeEditorValues(originals) : originals[0] || '';
          if (!bulk || shown !== editorComparable(original)) perTrack[tagKey] = shown;
        }

        // Custom tags and lyric alignment use the same safe rule: in bulk mode,
        // don't touch them unless the editor value differs from the common value.
        const mergedCustom={};
        const customMaps=editingTagSnapshots.map(item=>editorNativeObject(item.data?.native||{}));
        for(const key of [...new Set(customMaps.flatMap(obj=>Object.keys(obj)))]){
          const merged=mergeEditorValues(customMaps.map(obj=>obj[key] ?? ''));
          if(merged!=='') mergedCustom[key]=merged;
        }
        const visibleNativeKeys = new Set(['p_count', ...Array.from({length:19}, (_, i) => `custom${i+2}`)]);
        const advancedOnly = Object.fromEntries(Object.entries(custom).filter(([key]) => !visibleNativeKeys.has(String(key))));
        const enteredCustomJson=JSON.stringify(advancedOnly,null,2);
        const mergedCustomJson=JSON.stringify(Object.fromEntries(Object.entries(mergedCustom).filter(([key]) => !visibleNativeKeys.has(String(key)))),null,2);
        if(!bulk || enteredCustomJson!==mergedCustomJson) Object.assign(perTrack, advancedOnly);
        const noLyricsNode = document.getElementById('tag-no-lyrics');
        const noLyricsValue = noLyricsNode?.checked ? '1' : '';
        const originalNoLyrics = mergeEditorValues(editingTagSnapshots.map(item => nativeTagValue(item.data?.native, 'NO_LYRICS')));
        if (!bulk || noLyricsValue !== editorComparable(originalNoLyrics)) perTrack.NO_LYRICS = noLyricsValue;
        const shownStart=v('tag-start-time'), shownEnd=v('tag-end-time'), shownLyricsOffset=v('tag-lyrics-offset');
        const originalStart=track.startTime || nativeTagValue(native,'START_TIME');
        const originalEnd=track.endTime || nativeTagValue(native,'END_TIME');
        if(!bulk || shownStart!==editorComparable(mergeEditorValues(editingTagSnapshots.map(item=>item.track.startTime||nativeTagValue(item.data?.native,'START_TIME'))))) perTrack.START_TIME=shownStart;
        if(!bulk || shownEnd!==editorComparable(mergeEditorValues(editingTagSnapshots.map(item=>item.track.endTime||nativeTagValue(item.data?.native,'END_TIME'))))) perTrack.END_TIME=shownEnd;
        const originalLyricsOffset = mergeEditorValues(editingTagSnapshots.map(item => nativeTagValue(item.data?.native,'BEEHIVE_LYRICS_OFFSET')));
        if (shownLyricsOffset && !/^-?\d+(?:\.\d+)?$/.test(shownLyricsOffset)) {
          el.tagStatus.textContent = 'Lyrics offset must be a number of seconds, such as -0.50 or 1.25.';
          return;
        }
        if(!bulk || shownLyricsOffset!==editorComparable(originalLyricsOffset)) perTrack.BEEHIVE_LYRICS_OFFSET=shownLyricsOffset;
        const sortEnabled = document.getElementById('tag-custom-sorting')?.checked ? '1' : '';
        const originalSortEnabled = mergeEditorValues(editingTagSnapshots.map(item => nativeTagValue(item.data?.native, 'BEEHIVE_CUSTOM_SORTING')));
        if (!bulk || sortEnabled !== editorComparable(originalSortEnabled)) perTrack.BEEHIVE_CUSTOM_SORTING = sortEnabled;
        const sortFields = [
          ['TSOT','tag-sort-title-as','title'], ['TSOA','tag-sort-album-as','album'],
          ['TSO2','tag-sort-albumArtist-as','albumartist'], ['TSOP','tag-sort-artist-as','artist'], ['TSOC','tag-sort-composer-as','composer']
        ];
        for (const [tagKey, id, fieldKey] of sortFields) {
          const node = document.getElementById(id);
          const shown = node?.value.trim() || '';
          const original = editorSortValue(native, fieldKey, editorTextValue(common, native, fieldKey));
          if (!bulk || shown !== editorComparable(original)) perTrack[tagKey] = shown;
        }
        const settingFields = [
          ['BEEHIVE_EXCLUDE_PLAYBACK','tag-exclude-playback'],
          ['BEEHIVE_DO_NOT_CROSSFADE','tag-do-not-crossfade'],
          ['BEEHIVE_REMEMBER_POSITION','tag-remember-position']
        ];
        for (const [tagKey, id] of settingFields) {
          const node = document.getElementById(id);
          const shown = node?.checked ? '1' : '';
          const original = mergeEditorValues(editingTagSnapshots.map(item => nativeTagValue(item.data?.native, tagKey)));
          if (!bulk || shown !== editorComparable(original)) perTrack[tagKey] = shown;
        }
        // For a multi-selection, preserve each track's title/track/disc unless
        // the user explicitly changed that field. This matches the safe editing
        // model used by mature tag editors.
        if(Object.keys(perTrack).length) {
          // Optimistic UI: update the in-memory track immediately. The actual
          // metadata write and read-back verification happen after the modal
          // closes so disk I/O can never hold up the player's interaction.
          for (const [key, value] of Object.entries(perTrack)) {
            const modelKey = key === 'albumArtist' ? 'albumArtist' : key;
            if (modelKey === 'compilation') track.compilation = value === '1' ? '1' : '';
            else if (modelKey === 'p_count') track.p_count = value;
            else if (modelKey.startsWith('custom')) track[modelKey] = value;
            else if (['START_TIME','END_TIME'].includes(modelKey)) track[modelKey === 'START_TIME' ? 'startTime' : 'endTime'] = value;
            else if (modelKey === 'BEEHIVE_EXCLUDE_PLAYBACK') track.excludePlayback = value;
            else if (modelKey === 'BEEHIVE_DO_NOT_CROSSFADE') track.doNotCrossfade = value;
            else if (modelKey === 'BEEHIVE_REMEMBER_POSITION') track.rememberPosition = value;
            else if (modelKey === 'BEEHIVE_KEEP_SEQUENCE') track.keepSequence = value;
            else if (modelKey === 'BEEHIVE_LYRICS_OFFSET') {
              track.customTags = { ...(track.customTags || {}), BEEHIVE_LYRICS_OFFSET: value };
              track.nativeTags = { ...(track.nativeTags || {}), BEEHIVE_LYRICS_OFFSET: value };
            }
            else track[modelKey] = value;
          }
          track._searchText = '';
          backgroundTagJobs.push({ path: track.path, perTrack });
        }
        if (window.__beehiveRemoveFrontArtwork) {
          const remaining = (Array.isArray(track.covers) ? track.covers : []).filter(p => normalizeArtworkType(p?.type || 'Other') !== 'Cover (Front)');
          track.covers = remaining;
          track.cover = remaining[0]?.file || null;
          backgroundArtworkJobs.push({ path: track.path, action: 'removeFront' });
        } else if (window.__beehiveRemoveArtwork) {
          track.cover = null; track.covers = [];
          backgroundArtworkJobs.push({ path: track.path, action: 'removeAll' });
        } else if(pendingArtworkPath) {
          const pendingType = normalizeArtworkType(document.getElementById('tag-picture-type')?.value || (pendingArtworkSlot?.type || 'Cover (Front)'));
          const pendingComment = v('tag-artwork-comment');
          // Keep the exact image the user selected visible immediately while
          // the background worker embeds it into every selected file. The
          // downloaded image's data URL is self-contained and avoids exposing
          // a temporary source-file path that may be cleaned up or unavailable
          // to the mbcover:// protocol. The final background reconciliation
          // replaces this preview with the authoritative embedded artwork.
          const optimisticArtworkSource = pendingArtworkPreviewUrl || pendingArtworkPath;
          const pendingPicture = { file: optimisticArtworkSource, dataUrl: pendingArtworkPreviewUrl, type: pendingType, description: pendingComment, mime: 'image/jpeg' };
          const existingPictures = Array.isArray(track.covers) ? track.covers.slice() : [];
          let action = pendingArtworkMode === 'replace' && pendingArtworkSlot ? 'replaceSlot' : 'write';
          let slot = pendingArtworkSlot ? { ...pendingArtworkSlot } : null;
          if (action === 'replaceSlot') {
            const targetIndex = artworkEditorIndexForSlot(existingPictures, slot);
            if (targetIndex >= 0) existingPictures[targetIndex] = { ...existingPictures[targetIndex], ...pendingPicture };
            else action = 'write';
          }
          if (action === 'write') {
            if (pendingType === 'Cover (Front)') {
              const frontIndex = existingPictures.findIndex(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)');
              if (frontIndex >= 0) existingPictures[frontIndex] = { ...existingPictures[frontIndex], ...pendingPicture };
              else existingPictures.unshift(pendingPicture);
            } else {
              existingPictures.push(pendingPicture);
            }
          }
          track.covers = existingPictures;
          track.cover = existingPictures.find(p => normalizeArtworkType(p?.type || 'Other') === 'Cover (Front)')?.file || existingPictures[0]?.file || pendingArtworkPath;
          clearAutomaticCoverVisual(track);
          backgroundArtworkJobs.push({ path: track.path, action, slot, imagePath: pendingArtworkPath, pictureType: pendingType, comment: pendingComment });
        }
      }
      // Paint the optimistic state immediately. Nothing below is awaited by the
      // user's Save click: all physical file writes, verification, and the focused
      // library refresh happen in the background.
      applyLibrary(library);
      renderCurrentView();
      for (const track of editingTracks) {
        if (String(track.path || '') === String(currentQueue[currentIndex]?.path || '')) {
          // Keep the player model synchronized with the same object the editor changed.
          const current = currentQueue[currentIndex];
          Object.assign(current, track);
        }
      }
      refreshCoverRotationTargets();
      closeModal(el.tagModal);
      // Hand the complete batch to the main-process metadata worker. The renderer
      // does not perform any file writes or wait for them. This is intentionally
      // modeled after Strawberry: one background request per selected file, with
      // completion/progress events coming back asynchronously.
      // Coalesce all changes for each file into one durable metadata job. The
      // previous implementation queued tags and artwork separately, which could
      // rewrite the same album track twice when a Save changed both. A combined
      // job lets the native helper open/copy/save each audio file exactly once.
      const metadataByPath = new Map();
      for (const job of backgroundTagJobs) {
        const key = String(job.path || '');
        if (!key) continue;
        const entry = metadataByPath.get(key) || { kind:'metadata', path:key, tags:{}, artwork:null, operation:'metadata' };
        Object.assign(entry.tags, job.perTrack || {});
        metadataByPath.set(key, entry);
      }
      for (const job of backgroundArtworkJobs) {
        const key = String(job.path || '');
        if (!key) continue;
        const entry = metadataByPath.get(key) || { kind:'metadata', path:key, tags:{}, artwork:null, operation:'metadata' };
        entry.operation = 'artwork';
        entry.artwork = {
          action: job.action === 'removeFront' ? 'remove_front' :
                  job.action === 'removeAll' ? 'remove_all' :
                  job.action === 'replaceSlot' ? 'replace_slot' :
                  'write',
          slotType: job.slot?.type || '', occurrence: Number(job.slot?.occurrence || 1),
          imagePath: job.imagePath || '', pictureType: job.pictureType || 'Cover (Front)', comment: job.comment || ''
        };
        metadataByPath.set(key, entry);
      }
      const metadataJobs = [...metadataByPath.values()].filter(job => Object.keys(job.tags).length || job.artwork);
      if (metadataJobs.length) {
        window.beehive.queueMetadataSave(metadataJobs);
      }
      return true;
    }catch(err){
      console.error('Tag save failed before verification completed:', err);
      el.tagStatus.textContent=err.message||'Could not save tags.';
      return false;
    }
  }
  el.tagSave.addEventListener('click', saveTagEdits);

  const audioIntegrityScanBtn = document.querySelector('#audio-integrity-scan-btn');
  const audioIntegrityScanCancelBtn = document.querySelector('#audio-integrity-scan-cancel-btn');
  const audioIntegrityScanProgress = document.querySelector('#audio-integrity-scan-progress');
  const audioIntegrityScanProgressLabel = document.querySelector('#audio-integrity-scan-progress-label');
  const audioIntegrityScanProgressCount = document.querySelector('#audio-integrity-scan-progress-count');
  const audioIntegrityScanProgressBar = document.querySelector('#audio-integrity-scan-progress-bar');
  const audioIntegrityScanCurrent = document.querySelector('#audio-integrity-scan-current');
  const audioIntegrityScanResults = document.querySelector('#audio-integrity-scan-results');
  const audioIntegrityLoveRepair = document.querySelector('#audio-integrity-love-repair');
  const audioIntegrityLoveRepairSummary = document.querySelector('#audio-integrity-love-repair-summary');
  const audioIntegrityRepairLoveBtn = document.querySelector('#audio-integrity-repair-love-btn');
  const audioIntegrityOpenBackupsBtn = document.querySelector('#audio-integrity-open-backups-btn');
  const audioIntegrityLoveRepairResults = document.querySelector('#audio-integrity-love-repair-results');
  let audioIntegrityScanUnsubscribe = null;
  let audioIntegrityLoveConflicts = [];
  let audioIntegrityLastResult = null;
  function renderAudioIntegrityResults(result) {
    if (!audioIntegrityScanResults) return;
    const corrupt = Array.isArray(result?.corrupt) ? result.corrupt : [];
    const unavailable = Array.isArray(result?.unavailable) ? result.unavailable : [];
    audioIntegrityLastResult = result || null;
    audioIntegrityLoveConflicts = Array.isArray(result?.loveConflicts) ? result.loveConflicts : [];
    const reportBtn = document.querySelector('#audio-integrity-report-btn');
    if (reportBtn) reportBtn.disabled = !result;
    audioIntegrityScanResults.hidden = false;
    const rows = corrupt.map(item => `<div class="audio-integrity-result-row corrupt"><strong>Corrupted audio</strong><code>${escapeHtml(item.path)}</code><span>${escapeHtml(item.error || 'Decoder rejected the file.')}</span><div class="audio-integrity-result-actions"><button class="settings-inline-action audio-integrity-repair-btn" type="button" data-audio-path="${escapeHtml(encodeURIComponent(String(item.path || '')))}">Repair file</button></div></div>`).join('');
    const unavailableRows = unavailable.map(item => `<div class="audio-integrity-result-row unavailable"><strong>Could not scan</strong><code>${escapeHtml(item.path)}</code><span>${escapeHtml(item.error || 'File could not be scanned.')}</span></div>`).join('');
    audioIntegrityScanResults.innerHTML = `<strong>Scan complete: ${corrupt.length} corrupted, ${unavailable.length} could not be scanned</strong>${rows}${unavailableRows}`;
    if (audioIntegrityLoveRepair) audioIntegrityLoveRepair.hidden = !audioIntegrityLoveConflicts.length;
    if (audioIntegrityLoveRepairSummary) audioIntegrityLoveRepairSummary.textContent = audioIntegrityLoveConflicts.length
      ? `${audioIntegrityLoveConflicts.length.toLocaleString()} file(s) contain duplicate or conflicting Love metadata. Hive will keep Loved (L) when L conflicts with U/0 and will normalize each repaired file to one canonical LOVE RATING tag. A complete file backup is created first.`
      : '';
    if (audioIntegrityLoveRepairResults) { audioIntegrityLoveRepairResults.hidden = true; audioIntegrityLoveRepairResults.innerHTML = ''; }
    audioIntegrityScanResults.querySelectorAll('.audio-integrity-repair-btn').forEach(button => {
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        const filePath = decodeURIComponent(button.dataset.audioPath || '');
        if (!filePath) return;
        const confirmed = await themedConfirm(
          `Hive will attempt a non-destructive recovery of this file. The recovered output must pass a full integrity scan before it can replace the original. A complete backup of the original is created first.\n\nFile:\n${filePath}\n\nContinue?`,
          'Repair corrupt audio'
        );
        if (!confirmed) return;
        button.disabled = true;
        button.textContent = 'Repairing…';
        try {
          const repair = await window.beehive.repairCorruptAudioFile({ path:filePath });
          if (repair?.status === 'repaired') {
            button.textContent = 'Repaired';
            button.classList.add('hidden');
            const remaining = (audioIntegrityLastResult?.corrupt || []).filter(item => String(item?.path || '') !== filePath);
            audioIntegrityLastResult = { ...audioIntegrityLastResult, corrupt:remaining };
            renderAudioIntegrityResults(audioIntegrityLastResult);
          } else {
            button.disabled = false;
            button.textContent = 'Repair failed';
            await themedAlert(`Hive could not safely repair this file.\n\n${repair?.error || 'Unknown repair error.'}`, 'Repair corrupt audio');
            button.textContent = 'Repair file';
          }
        } catch (err) {
          button.disabled = false;
          button.textContent = 'Repair file';
          await themedAlert(`Hive could not start the repair.\n\n${String(err?.message || err)}`, 'Repair corrupt audio');
        }
      });
    });
  }
  function setAudioIntegrityScanRunning(running) {
    if (audioIntegrityScanBtn) {
      audioIntegrityScanBtn.disabled = running;
      audioIntegrityScanBtn.hidden = running;
    }
    if (audioIntegrityScanCancelBtn) {
      audioIntegrityScanCancelBtn.disabled = !running;
      audioIntegrityScanCancelBtn.hidden = !running;
    }
    const resumeBtn = document.getElementById('audio-integrity-resume-btn');
    const startOverBtn = document.getElementById('audio-integrity-start-over-btn');
    if (resumeBtn) { resumeBtn.hidden = true; resumeBtn.classList.add('hidden'); }
    if (startOverBtn) { startOverBtn.hidden = true; startOverBtn.classList.add('hidden'); }
    if (audioIntegrityScanProgress) audioIntegrityScanProgress.hidden = !running;
  }
  if (window.beehive.onAudioIntegrityScanProgress) {
    audioIntegrityScanUnsubscribe = window.beehive.onAudioIntegrityScanProgress(payload => {
      const total = Number(payload?.total || 0), completed = Number(payload?.completed || 0);
      if (payload?.phase === 'started') {
        setAudioIntegrityScanRunning(true);
        if (audioIntegrityScanResults) { audioIntegrityScanResults.hidden = true; audioIntegrityScanResults.innerHTML = ''; }
        if (audioIntegrityLoveRepair) audioIntegrityLoveRepair.hidden = true;
      }
      if (audioIntegrityScanProgressBar) { audioIntegrityScanProgressBar.max = Math.max(1, total); audioIntegrityScanProgressBar.value = Math.min(completed, total); }
      if (audioIntegrityScanProgressCount) audioIntegrityScanProgressCount.textContent = `${completed.toLocaleString()} / ${total.toLocaleString()}`;
      if (audioIntegrityScanProgressLabel) audioIntegrityScanProgressLabel.textContent = payload?.phase === 'complete' ? 'Complete' : payload?.phase === 'cancelled' ? 'Cancelled' : 'Scanning audio and metadata…';
      if (audioIntegrityScanCurrent && payload?.currentPath) audioIntegrityScanCurrent.textContent = payload.loveStatus === 'conflict' ? `Love metadata conflict: ${payload.currentPath}` : payload.currentStatus === 'corrupt' ? `Audio corruption found: ${payload.currentPath}` : `Checking: ${payload.currentPath}`;
      if (payload?.phase === 'complete' || payload?.phase === 'cancelled') {
        setAudioIntegrityScanRunning(false);
        renderAudioIntegrityResults(payload);
        void updateAudioIntegrityRecoveryUi();
      }
    });
  }
  async function updateAudioIntegrityRecoveryUi() {
    if (!window.beehive.getAudioIntegrityScanCheckpoint || !audioIntegrityScanBtn) return;
    try {
      const checkpoint = await window.beehive.getAudioIntegrityScanCheckpoint();
      const running = !audioIntegrityScanCancelBtn?.disabled;
      let startOverBtn = document.getElementById('audio-integrity-start-over-btn');
      if (!startOverBtn) {
        startOverBtn = document.createElement('button');
        startOverBtn.id='audio-integrity-start-over-btn';
        startOverBtn.className='settings-inline-action hidden';
        startOverBtn.type='button';
        audioIntegrityScanBtn.parentElement?.insertBefore(startOverBtn, audioIntegrityScanCancelBtn || null);
        startOverBtn.addEventListener('click', async () => {
          if (startOverBtn.disabled) return;
          const ok=await themedConfirm(
            'Discard the interrupted scan checkpoint and start a completely new scan? Completed results from the interrupted scan will no longer be used for resume.',
            'Audio integrity scan'
          );
          if(!ok)return;
          startOverBtn.disabled=true;
          try {
            await window.beehive.startOverAudioIntegrityScan();
            await updateAudioIntegrityRecoveryUi();
          } finally {
            startOverBtn.disabled=false;
          }
        });
      }
      if (running) return;
      audioIntegrityScanBtn.hidden = false;
      audioIntegrityScanBtn.disabled = false;
      if (checkpoint) {
        audioIntegrityScanBtn.textContent=`↻ Resume interrupted scan (${Number(checkpoint.completed||0).toLocaleString()} / ${Number(checkpoint.total||0).toLocaleString()})`;
        audioIntegrityScanBtn.classList.remove('hidden');
        startOverBtn.textContent='Start another scan instead';
        startOverBtn.hidden=false;
        startOverBtn.classList.remove('hidden');
      } else {
        audioIntegrityScanBtn.textContent='⌕ Scan entire library';
        audioIntegrityScanBtn.classList.remove('hidden');
        startOverBtn.hidden=true;
        startOverBtn.classList.add('hidden');
      }
    } catch {}
  }
  audioIntegrityScanBtn?.addEventListener('click', async () => {
    if (audioIntegrityScanBtn.disabled) return;
    let checkpoint = null;
    try { checkpoint = await window.beehive.getAudioIntegrityScanCheckpoint?.(); } catch {}
    const paths = (library?.tracks || []).map(t => t?.path).filter(Boolean);
    if (!checkpoint && !paths.length) {
      await themedAlert('There are no local audio files in the current library to scan.', 'Audio integrity scan');
      return;
    }
    setAudioIntegrityScanRunning(true);
    try {
      const result = checkpoint
        ? await window.beehive.resumeAudioIntegrityScan()
        : await window.beehive.scanAudioIntegrityLibrary(paths);
      if (result?.status === 'busy') await themedAlert('An audio integrity scan is already running.', 'Audio integrity scan');
      else renderAudioIntegrityResults(result);
    } catch (err) {
      await themedAlert(`The library audio scan could not start.\n\n${String(err?.message || err)}`, 'Audio integrity scan');
    } finally {
      setAudioIntegrityScanRunning(false);
      await updateAudioIntegrityRecoveryUi();
    }
  });
  updateAudioIntegrityRecoveryUi();
  audioIntegrityScanCancelBtn?.addEventListener('click', async () => {
    try { await window.beehive.cancelAudioIntegrityScan?.(); } catch {}
  });
  audioIntegrityRepairLoveBtn?.addEventListener('click', async () => {
    if (!audioIntegrityLoveConflicts.length || audioIntegrityRepairLoveBtn.disabled) return;
    const confirmed = await themedConfirm(
      `Hive found ${audioIntegrityLoveConflicts.length.toLocaleString()} file(s) with duplicate or conflicting Love tags.\n\n` +
      `Before changing each file, Hive will create a complete backup in the clearly named "Tag Backups" folder.\n\n` +
      `Repair will remove all recognized Love variants and write exactly one canonical LOVE RATING tag. If L and U/0 conflict, L is kept.\n\nProceed with the repair?`,
      'Repair Love metadata'
    );
    if (!confirmed) return;
    audioIntegrityRepairLoveBtn.disabled = true;
    audioIntegrityRepairLoveBtn.textContent = 'Repairing Love tags…';
    try {
      const result = await window.beehive.repairLoveMetadata(audioIntegrityLoveConflicts);
      if (audioIntegrityLoveRepairResults) {
        audioIntegrityLoveRepairResults.hidden = false;
        const repaired = Array.isArray(result?.repaired) ? result.repaired : [];
        const failed = Array.isArray(result?.failed) ? result.failed : [];
        const repairedRows = repaired.map(item => `<div class="audio-integrity-result-row repaired"><strong>Repaired — ${item.loved ? 'Loved (L)' : 'Unloved (0)'}</strong><code>${escapeHtml(item.path)}</code><span>Backup: ${escapeHtml(item.backupPath || result?.backupDir || 'Tag Backups')}</span></div>`).join('');
        const failedRows = failed.map(item => `<div class="audio-integrity-result-row unavailable"><strong>Repair failed</strong><code>${escapeHtml(item.path)}</code><span>${escapeHtml(item.error || 'Unknown repair error.')}</span></div>`).join('');
        audioIntegrityLoveRepairResults.innerHTML = `<strong>Repair complete: ${repaired.length} repaired, ${failed.length} failed</strong><span>Backups: ${escapeHtml(result?.backupDir || 'Tag Backups')}</span>${repairedRows}${failedRows}`;
      }
      if (result?.repaired?.length) {
        for (const done of result.repaired) {
          const track = libraryTrackByPath.get(String(done.path));
          if (track) track.loved = !!done.loved;
        }
        albums = buildAlbums(library.tracks);
        renderCurrentView();
        audioIntegrityLoveConflicts = audioIntegrityLoveConflicts.filter(item => !result.repaired.some(done => String(done.path) === String(item.path)));
      }
      if (!audioIntegrityLoveConflicts.length && audioIntegrityLoveRepair) audioIntegrityLoveRepair.hidden = true;
    } catch (err) {
      await themedAlert(`Love metadata repair could not complete.\n\n${String(err?.message || err)}`, 'Repair Love metadata');
    } finally {
      audioIntegrityRepairLoveBtn.disabled = false;
      audioIntegrityRepairLoveBtn.textContent = 'Repair Love tags';
    }
  });
  audioIntegrityOpenBackupsBtn?.addEventListener('click', async () => {
    try { await window.beehive.openAudioIntegrityBackups?.(); } catch (err) { await themedAlert(`Could not open Tag Backups.\n\n${String(err?.message || err)}`, 'Tag Backups'); }
  });
  document.querySelector('#audio-integrity-report-btn')?.addEventListener('click', async () => {
    const button = document.querySelector('#audio-integrity-report-btn');
    if (!audioIntegrityLastResult || button?.disabled) return;
    try {
      button.disabled = true;
      button.textContent = 'Generating report…';
      const report = await window.beehive.generateAudioIntegrityReport(audioIntegrityLastResult);
      button.textContent = 'Report Generated';
      await themedAlert(`Full TXT report saved inside Hive.\n\n${report?.path || 'Audio Integrity reports folder'}`, 'Audio Integrity report');
    } catch (err) {
      await themedAlert(`The Audio Integrity report could not be generated.\n\n${String(err?.message || err)}`, 'Audio Integrity report');
    } finally {
      button.disabled = false;
      button.textContent = 'Generate Full TXT Report';
    }
  });
  document.querySelector('#audio-integrity-open-reports-btn')?.addEventListener('click', async () => {
    try { await window.beehive.openAudioIntegrityReports?.(); } catch (err) { await themedAlert(`Could not open the Audio Integrity reports folder.\n\n${String(err?.message || err)}`, 'Audio Integrity reports'); }
  });

  const manualLoveRefreshBtn = document.querySelector('#refresh-favorites-btn');
  if (manualLoveRefreshBtn) {
    manualLoveRefreshBtn.addEventListener('click', async () => {
      manualLoveRefreshBtn.disabled = true;
      const original = manualLoveRefreshBtn.textContent;
      manualLoveRefreshBtn.textContent = 'Refreshing Favorites…';
      try {
        const result = await refreshCachedLovesInBackground();
        const failed = Number(result?.failed || 0);
        manualLoveRefreshBtn.textContent = failed ? `Refresh finished (${failed} failed)` : 'Favorites refreshed';
        setTimeout(() => { manualLoveRefreshBtn.textContent = original; }, 2500);
      } catch {
        manualLoveRefreshBtn.textContent = 'Refresh failed';
        setTimeout(() => { manualLoveRefreshBtn.textContent = original; }, 2500);
      } finally {
        manualLoveRefreshBtn.disabled = false;
      }
    });
  }

  const audioOutputSelect = document.getElementById('setting-audio-output');
  const audioOutputStatus = document.getElementById('audio-output-status');
  const audioOutputRefreshBtn = document.getElementById('audio-output-refresh-btn');
  const audioOutputApplyBtn = document.getElementById('audio-output-apply-btn');
  let audioOutputConfigId = '';
  async function refreshAudioOutputs() {
    if (!audioOutputSelect || !window.beehive.listAudioOutputs) return;
    audioOutputRefreshBtn && (audioOutputRefreshBtn.disabled = true);
    try {
      const [result, config] = await Promise.all([window.beehive.listAudioOutputs(), window.beehive.getConfig?.()]);
      audioOutputConfigId = String(config?.audioOutputDevice || '').trim();
      const outputs = Array.isArray(result?.outputs) ? result.outputs : [];
      audioOutputSelect.innerHTML = '<option value="">System default</option>';
      for (const output of outputs) {
        const option = document.createElement('option');
        option.value = String(output.id || '');
        option.textContent = String(output.name || output.description || output.id || 'Audio output');
        audioOutputSelect.appendChild(option);
      }
      audioOutputSelect.value = audioOutputConfigId;
      if (audioOutputSelect.value !== audioOutputConfigId) audioOutputSelect.value = '';
      if (!result?.supported) audioOutputStatus && (audioOutputStatus.textContent = result?.reason || 'Audio output selection is unavailable.');
      else if (!outputs.length) audioOutputStatus && (audioOutputStatus.textContent = 'No selectable outputs were reported. Hive will use the system default.');
      else {
        const active = outputs.find(x => x.id === audioOutputConfigId);
        audioOutputStatus && (audioOutputStatus.textContent = active ? `Selected: ${active.name}` : (result.defaultId ? `System default: ${outputs.find(x => x.id === result.defaultId)?.name || result.defaultId}` : 'System default output'));
      }
    } catch (error) {
      audioOutputStatus && (audioOutputStatus.textContent = error?.message || 'Could not enumerate audio outputs.');
    } finally { audioOutputRefreshBtn && (audioOutputRefreshBtn.disabled = false); }
  }
  audioOutputRefreshBtn?.addEventListener('click', () => { void refreshAudioOutputs(); });
  audioOutputApplyBtn?.addEventListener('click', async () => {
    const id = String(audioOutputSelect?.value || '').trim();
    try {
      const result = await window.beehive.setAudioOutput?.(id);
      audioOutputConfigId = id;
      audioOutputStatus && (audioOutputStatus.textContent = id ? 'Output saved. Restart Hive to route playback to this device.' : 'System default saved. Restart Hive to apply it.');
      if (result?.restartRequired) audioOutputApplyBtn.textContent = 'Saved — restart Hive';
      setTimeout(() => { if (audioOutputApplyBtn) audioOutputApplyBtn.textContent = 'Apply output'; }, 3000);
    } catch (error) { audioOutputStatus && (audioOutputStatus.textContent = error?.message || 'Could not save the output device.'); }
  });
  void refreshAudioOutputs();

  const replayGainModeSelect = document.getElementById('setting-replaygain-mode');
  const replayGainClippingCheck = document.getElementById('setting-replaygain-clipping');
  if (replayGainModeSelect) {
    replayGainModeSelect.value = replayGainMode();
    replayGainModeSelect.addEventListener('change', async () => {
      try { localStorage.setItem(REPLAYGAIN_MODE_KEY, replayGainModeSelect.value); } catch {}
      engineTrackGain = 1;
      const current = currentQueue[currentIndex];
      if (current && !isSpotifyTrack(current)) await resolveReplayGainForTrack(current);
      applyOutputGain();
    });
  }
  const deviceRefreshBtn = document.getElementById('device-refresh-btn');
  deviceRefreshBtn?.addEventListener('click', async () => {
    deviceRefreshBtn.disabled = true;
    deviceRefreshBtn.textContent = 'Refreshing…';
    await refreshAndroidDevices();
    deviceRefreshBtn.disabled = false;
    deviceRefreshBtn.textContent = '↻ Refresh devices';
  });
  // Do not make device discovery a startup dependency. Refresh when the Devices
  // tab is opened so ordinary library startup stays unaffected.
  document.getElementById('settings-tab-devices')?.addEventListener('click', () => { void refreshAndroidDevices(); });

  if (replayGainClippingCheck) {
    replayGainClippingCheck.checked = replayGainClippingGuard();
    replayGainClippingCheck.addEventListener('change', async () => {
      try { localStorage.setItem(REPLAYGAIN_CLIPPING_KEY, String(!!replayGainClippingCheck.checked)); } catch {}
      engineTrackGain = 1;
      const current = currentQueue[currentIndex];
      if (current && !isSpotifyTrack(current)) await resolveReplayGainForTrack(current);
      applyOutputGain();
    });
  }

  const highlightedLyricsToggle = document.getElementById('setting-highlighted-lyrics');
  if (highlightedLyricsToggle) {
    highlightedLyricsToggle.checked = highlightedLyricsEnabled();
    highlightedLyricsToggle.addEventListener('change', () => {
      try { localStorage.setItem(HIGHLIGHTED_LYRICS_KEY, highlightedLyricsToggle.checked ? 'true' : 'false'); } catch {}
      // A changed lyric mode should take effect immediately for the current
      // track -- including switching from an already-shown embedded plain
      // lyric to a synced online result now that the setting is on, which is
      // exactly what refreshTrackLyricsForDisplay decides.
      const current = currentQueue[currentIndex];
      if (current && !current.podcast && current.artist && current.title) {
        clearLyricsLookupCacheForTrack(current);
        renderLyrics(String(current.lyrics || '').trim(), current);
        refreshTrackLyricsForDisplay(current);
      }
    });
  }

  const embedLyricsAutomaticallyToggle = document.getElementById('setting-embed-lyrics-automatically');
  if (embedLyricsAutomaticallyToggle) {
    embedLyricsAutomaticallyToggle.checked = embedLyricsAutomaticallyEnabled();
    embedLyricsAutomaticallyToggle.addEventListener('change', () => {
      try { localStorage.setItem(EMBED_LYRICS_AUTOMATICALLY_KEY, embedLyricsAutomaticallyToggle.checked ? 'true' : 'false'); } catch {}
    });
  }

  // ---------------- built-in theme presets ----------------
  const BUILTIN_THEMES = {
    midnight:{name:'Midnight',description:'Deep neutral surfaces with a restrained silver accent.',vars:{'--bg':'#090a0d','--panel':'rgba(19,20,25,.72)','--panel-strong':'rgba(15,16,21,.88)','--border':'rgba(255,255,255,.09)','--text':'#f0eff3','--text-dim':'#a3a1ad','--text-dimmer':'#6e6c77','--accent':'#b9bac2','--accent-soft':'rgba(205,207,220,.35)','--accent-glow':'rgba(190,195,215,.24)','--ambient-a':'rgba(110,115,145,.18)','--ambient-b':'rgba(55,65,95,.15)','--radius':'14px','--blur':'24px'}},
    light:{name:'Light',description:'A bright neutral theme with high readability for daytime listening.',vars:{'--bg':'#f7f8fa','--panel':'rgba(255,255,255,.94)','--panel-strong':'rgba(255,255,255,.985)','--border':'rgba(24,30,40,.16)','--text':'#171b22','--text-dim':'#3f4651','--text-dimmer':'#5f6875','--accent':'#5366d8','--accent-soft':'rgba(83,102,216,.24)','--accent-glow':'rgba(83,102,216,.12)','--ambient-a':'rgba(83,102,216,.035)','--ambient-b':'rgba(110,120,150,.025)','--radius':'12px','--blur':'18px'}},
    ember:{name:'Ember',description:'Warm copper and charcoal, designed for low-light listening.',vars:{'--bg':'#100b0a','--panel':'rgba(28,20,18,.76)','--panel-strong':'rgba(23,16,14,.9)','--border':'rgba(255,210,185,.10)','--text':'#f4ebe6','--text-dim':'#b8a39a','--text-dimmer':'#806d65','--accent':'#e28b63','--accent-soft':'rgba(240,145,105,.34)','--accent-glow':'rgba(226,139,99,.22)','--ambient-a':'rgba(180,75,35,.19)','--ambient-b':'rgba(95,42,25,.14)','--radius':'14px','--blur':'22px'}},
    forest:{name:'Forest',description:'Dark evergreen surfaces with a quiet mineral green.',vars:{'--bg':'#08100d','--panel':'rgba(14,25,21,.75)','--panel-strong':'rgba(10,20,16,.9)','--border':'rgba(190,230,210,.09)','--text':'#e8f0eb','--text-dim':'#9dafaa','--text-dimmer':'#657a71','--accent':'#79b79a','--accent-soft':'rgba(121,183,154,.34)','--accent-glow':'rgba(121,183,154,.21)','--ambient-a':'rgba(45,130,90,.17)','--ambient-b':'rgba(25,75,58,.14)','--radius':'15px','--blur':'26px'}},
    ocean:{name:'Ocean',description:'Cool blue-black glass with a clean modern edge.',vars:{'--bg':'#070c12','--panel':'rgba(13,22,32,.75)','--panel-strong':'rgba(10,18,27,.9)','--border':'rgba(190,220,245,.10)','--text':'#e7eef5','--text-dim':'#9aaabd','--text-dimmer':'#66788c','--accent':'#70a8d6','--accent-soft':'rgba(112,168,214,.34)','--accent-glow':'rgba(112,168,214,.22)','--ambient-a':'rgba(35,105,155,.18)','--ambient-b':'rgba(25,65,105,.15)','--radius':'13px','--blur':'28px'}},
    violet:{name:'Violet',description:'Muted plum and graphite with a cinematic finish.',vars:{'--bg':'#0d0911','--panel':'rgba(25,18,30,.76)','--panel-strong':'rgba(20,14,25,.91)','--border':'rgba(230,210,245,.10)','--text':'#f0eaf4','--text-dim':'#afa2b8','--text-dimmer':'#776b80','--accent':'#a88bd0','--accent-soft':'rgba(168,139,208,.34)','--accent-glow':'rgba(168,139,208,.22)','--ambient-a':'rgba(120,65,155,.18)','--ambient-b':'rgba(65,35,95,.14)','--radius':'16px','--blur':'26px'}}
  };
  const BUILTIN_THEME_KEY='beehive:builtin-theme';
  const THEME_OPTIONS_KEY='beehive:theme-options';
  const themeOptionDefaults={ambient:true,rounded:true};
  function loadThemeOptions(){ try{return {...themeOptionDefaults,...JSON.parse(localStorage.getItem(THEME_OPTIONS_KEY)||'{}')}}catch{return {...themeOptionDefaults}} }
  function applyThemeOptions(){
    const opts=loadThemeOptions();
    document.documentElement.dataset.hiveAmbient=opts.ambient?'on':'off';
    document.documentElement.dataset.hiveRounded=opts.rounded?'on':'off';
  }
  function applyBuiltinTheme(id,persist=true){
    const theme=BUILTIN_THEMES[id]||BUILTIN_THEMES.midnight;
    const root=document.documentElement.style;
    Object.entries(theme.vars).forEach(([k,v])=>root.setProperty(k,v));
    document.documentElement.dataset.hiveTheme=id;
    const select=document.getElementById('builtin-theme-select');
    const desc=document.getElementById('builtin-theme-description');
    if(select) select.value=id;
    if(desc) desc.textContent=theme.description;
    if(persist)try{localStorage.setItem(BUILTIN_THEME_KEY,id)}catch{}
    applyThemeOptions();
  }
  function renderBuiltinThemes(){
    const select=document.getElementById('builtin-theme-select');
    if(!select)return;
    select.innerHTML=Object.entries(BUILTIN_THEMES).map(([id,t])=>`<option value="${id}">${escapeHtml(t.name)}</option>`).join('');
    select.addEventListener('change',()=>applyBuiltinTheme(select.value,true));
    const saved=(()=>{try{return localStorage.getItem(BUILTIN_THEME_KEY)||'midnight'}catch{return'midnight'}})();
    const opts=loadThemeOptions();
    // Ambient glow and rounded controls remain part of Hive's theme state, but
    // their old Settings switches are intentionally no longer exposed. Preserve
    // the stored values and apply them as before.
    applyBuiltinTheme(BUILTIN_THEMES[saved]?saved:'midnight',false);
  }
  renderBuiltinThemes();

  // Electron window bar theme is a real BrowserWindow mode switch. Electron
  // cannot change BrowserWindow.frame after creation, so the main process
  // recreates the shell while preserving its bounds/maximized state. Playback
  // remains in the main process and is not restarted.
  const applyThemeWindowBarPreference = async () => {
    const toggle = el.themeWindowBarToggle;
    if (!toggle || !window.beehive.window?.getThemeBar) return;
    try {
      const enabled = await window.beehive.window.getThemeBar();
      toggle.checked = !!enabled;
      document.documentElement.classList.toggle('theme-window-bar-enabled', !!enabled);
      document.documentElement.classList.toggle('native-window-bar', !enabled);
    } catch (err) { console.warn('Window bar preference load failed:', err); }
  };
  el.themeWindowBarToggle?.addEventListener('change', async () => {
    const toggle = el.themeWindowBarToggle;
    if (!toggle || !window.beehive.window?.setThemeBar) return;
    toggle.disabled = true;
    try {
      await window.beehive.window.setThemeBar(!!toggle.checked);
    } catch (err) {
      console.warn('Window bar theme switch failed:', err);
      toggle.checked = !toggle.checked;
    } finally {
      toggle.disabled = false;
    }
  });
  void applyThemeWindowBarPreference();

  // ---------------- custom theme CSS ----------------
  let customThemeStyle = null;
  const customCssStatus = document.getElementById('custom-css-status');
  const customCssInput = document.getElementById('custom-css-input');
  const customCssApplyBtn = document.getElementById('custom-css-apply-btn');
  const customCssLoadBtn = document.getElementById('custom-css-load-btn');
  const customCssClearBtn = document.getElementById('custom-css-clear-btn');

  const customCssRemoteImports = new Map();
  let customCssRawSource = '';

  function splitCustomCssImports(css) {
    const imports = [];
    const source = String(css || '');
    const withoutImports = source.replace(/@import\s+(?:url\(\s*)?["']?(https?:\/\/[^"'\)\s]+)["']?\s*\)?\s*;?/gi, (_full, url) => {
      imports.push(url);
      return '';
    });
    return { imports: [...new Set(imports)], css: withoutImports };
  }

  function clearCustomCssRemoteImports() {
    customCssRemoteImports.forEach(link => link.remove());
    customCssRemoteImports.clear();
  }

  function applyCustomCss(css = '', enabled = true, sourceLabel = '') {
    if (!customThemeStyle) {
      customThemeStyle = document.createElement('style');
      customThemeStyle.id = 'beehive-custom-theme-css';
      document.head.appendChild(customThemeStyle);
    }
    clearCustomCssRemoteImports();
    const rawCss = String(css || '');
    customCssRawSource = rawCss;
    if (customCssInput && document.activeElement !== customCssInput) customCssInput.value = rawCss;
    const parsed = enabled ? splitCustomCssImports(rawCss) : { imports: [], css: '' };
    customThemeStyle.textContent = enabled ? parsed.css : '';

    // Remote stylesheets are deliberately loaded as <link> elements rather than
    // leaving @import inside the inline style. This keeps local CSS in Hive's
    // normal style element while making remote theme imports reliable under
    // Chromium's CSP. Only http(s) URLs are accepted by splitCustomCssImports.
    parsed.imports.forEach(url => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.dataset.hiveCustomImport = 'true';
      customCssRemoteImports.set(url, link);
      document.head.appendChild(link);
    });

    if (customCssStatus) {
      const hasCss = enabled && rawCss.trim();
      const remoteCount = parsed.imports.length;
      customCssStatus.textContent = hasCss
        ? (sourceLabel ? `Custom CSS active · ${sourceLabel}${remoteCount ? ` · ${remoteCount} remote import${remoteCount === 1 ? '' : 's'}` : ''}` : 'Custom CSS active.')
        : "Using Hive's built-in theme.";
    }
  }

  async function loadCustomCssSettings() {
    if (!window.beehive.getCustomCss) return;
    try {
      const result = await window.beehive.getCustomCss();
      applyCustomCss(result?.css || '', !!result?.enabled, 'stored stylesheet');
    } catch (err) {
      if (customCssStatus) customCssStatus.textContent = err?.message || 'Could not load custom CSS.';
    }
  }

  customCssApplyBtn?.addEventListener('click', async () => {
    customCssApplyBtn.disabled = true;
    try {
      const css = String(customCssInput?.value || '');
      const result = await window.beehive.setCustomCss(css);
      applyCustomCss(result?.css || '', !!result?.enabled, css.trim() ? 'pasted CSS' : '');
    } catch (err) {
      if (customCssStatus) customCssStatus.textContent = err?.message || 'Could not apply custom CSS.';
    } finally { customCssApplyBtn.disabled = false; }
  });

  customCssLoadBtn?.addEventListener('click', async () => {
    customCssLoadBtn.disabled = true;
    try {
      const result = await window.beehive.chooseCustomCss();
      if (result?.canceled) return;
      applyCustomCss(result?.css || '', true, result?.sourcePath ? result.sourcePath.split(/[\\/]/).pop() : 'stylesheet');
    } catch (err) {
      if (customCssStatus) customCssStatus.textContent = err?.message || 'Could not load custom CSS.';
    } finally { customCssLoadBtn.disabled = false; }
  });

  customCssClearBtn?.addEventListener('click', async () => {
    customCssClearBtn.disabled = true;
    try {
      const result = await window.beehive.clearCustomCss();
      applyCustomCss(result?.css || '', false);
    } catch (err) {
      if (customCssStatus) customCssStatus.textContent = err?.message || 'Could not remove custom CSS.';
    } finally { customCssClearBtn.disabled = false; }
  });
  loadCustomCssSettings();


  // ---------------- settings log viewer ----------------
  let diagnosticLogsCache = null;
  function selectedDiagnosticText(source) {
    if (!diagnosticLogsCache) return 'No log entries were found.';
    if (source === 'current') return String(diagnosticLogsCache?.sessions?.find(x => x.name === diagnosticLogsCache.currentSession)?.text || diagnosticLogsCache?.crash || 'No current session log was found.');
    if (source === 'scan') return String(diagnosticLogsCache?.scan || 'No scan log entries were found.');
    return String(diagnosticLogsCache?.combined || 'No log entries were found.');
  }
  async function loadDiagnosticLogs() {
    if (!window.beehive.getDiagnosticLogs || !el.logOutput) return;
    if (el.logStatus) el.logStatus.textContent = 'Loading logs…';
    try {
      diagnosticLogsCache = await window.beehive.getDiagnosticLogs();
      const select = el.logSource;
      if (select) {
        const previous = select.value;
        select.querySelectorAll('option.session-option').forEach(o => o.remove());
        const sessions = Array.isArray(diagnosticLogsCache?.sessions) ? diagnosticLogsCache.sessions : [];
        for (const session of sessions) {
          const option = document.createElement('option');
          option.className = 'session-option';
          option.value = `session:${session.name}`;
          const date = session.name.match(/^session-(\d{8})-(\d{6})-(\d+)\.txt$/);
          option.textContent = date ? `${date[1].slice(0,4)}-${date[1].slice(4,6)}-${date[1].slice(6,8)} ${date[2].slice(0,2)}:${date[2].slice(2,4)}:${date[2].slice(4,6)}${session.name === diagnosticLogsCache.currentSession ? ' · current' : ''}` : session.name;
          select.appendChild(option);
        }
        if (previous.startsWith('session:') && sessions.some(x => `session:${x.name}` === previous)) select.value = previous;
        else select.value = 'current';
      }
      el.logOutput.value = selectedDiagnosticText(el.logSource?.value || 'current');
      const bytes = new TextEncoder().encode(el.logOutput.value).byteLength;
      const source = el.logSource?.value || 'current';
      if (el.logStatus) el.logStatus.textContent = `${source.startsWith('session:') || source === 'current' ? 'Session log' : source} loaded · ${Math.round(bytes / 1024).toLocaleString()} KB · ${diagnosticLogsCache?.sessions?.length || 0} sessions retained`;
    } catch (err) {
      el.logOutput.value = '';
      if (el.logStatus) el.logStatus.textContent = err?.message || 'Could not load Hive logs.';
    }
  }
  el.logRefresh?.addEventListener('click', loadDiagnosticLogs);
  el.logSource?.addEventListener('change', () => {
    if (!diagnosticLogsCache) return;
    const source = el.logSource.value;
    if (source.startsWith('session:')) {
      const name = source.slice('session:'.length);
      el.logOutput.value = String(diagnosticLogsCache.sessions?.find(x => x.name === name)?.text || 'Session log not found.');
    } else el.logOutput.value = selectedDiagnosticText(source);
    if (el.logStatus) el.logStatus.textContent = `${source.startsWith('session:') || source === 'current' ? 'Session log' : source} loaded · ${Math.round(new TextEncoder().encode(el.logOutput.value).byteLength / 1024).toLocaleString()} KB`;
  });
  el.logCopy?.addEventListener('click', async () => {
    const value = String(el.logOutput?.value || '');
    if (!value) return;
    try { await navigator.clipboard.writeText(value); if (el.logStatus) el.logStatus.textContent = 'Log copied to clipboard.'; }
    catch (err) { if (el.logStatus) el.logStatus.textContent = err?.message || 'Could not copy the log.'; }
  });

  // In-app diagnostics are deliberately button-driven so non-technical users can
  // reproduce a problem without opening a terminal. The main process owns the
  // evidence collection and report path; the renderer only controls the session.
  async function refreshDiagnosticsStatus() {
    if (!window.beehive.getDiagnosticsStatus || !el.diagnosticsStatus) return;
    try {
      const status = await window.beehive.getDiagnosticsStatus();
      const active = status?.active === true;
      if (el.diagnosticsStart) el.diagnosticsStart.disabled = active;
      if (el.diagnosticsFinish) el.diagnosticsFinish.disabled = !active;
      el.diagnosticsStatus.textContent = active
        ? `Diagnostic session running since ${new Date(status.startedAt).toLocaleTimeString()}. Reproduce the problem, then finish the session.`
        : 'No diagnostic session running.';
    } catch (err) {
      el.diagnosticsStatus.textContent = err?.message || 'Diagnostic status unavailable.';
    }
  }
  el.diagnosticsStart?.addEventListener('click', async () => {
    el.diagnosticsStart.disabled = true;
    try {
      const status = await window.beehive.startDiagnostics();
      if (status?.active) {
        if (el.diagnosticsFinish) el.diagnosticsFinish.disabled = false;
        if (el.diagnosticsStatus) el.diagnosticsStatus.textContent = `Diagnostic session started at ${new Date(status.startedAt).toLocaleTimeString()}. Reproduce the problem, then finish the session.`;
      }
    } catch (err) {
      if (el.diagnosticsStatus) el.diagnosticsStatus.textContent = err?.message || 'Could not start diagnostic session.';
      el.diagnosticsStart.disabled = false;
    }
  });
  el.diagnosticsFinish?.addEventListener('click', async () => {
    el.diagnosticsFinish.disabled = true;
    if (el.diagnosticsStatus) el.diagnosticsStatus.textContent = 'Collecting diagnostic evidence…';
    try {
      const result = await window.beehive.finishDiagnostics();
      const name = result?.reportPath ? String(result.reportPath).split(/[\\/]/).pop() : 'diagnostic report';
      if (el.diagnosticsStatus) el.diagnosticsStatus.textContent = result?.reportPath
        ? `Report saved: ${name}. You can open the report folder below.`
        : 'Diagnostic report finished.';
    } catch (err) {
      if (el.diagnosticsStatus) el.diagnosticsStatus.textContent = err?.message || 'Could not finish diagnostic session.';
    }
    await refreshDiagnosticsStatus();
  });
  el.diagnosticsOpen?.addEventListener('click', async () => {
    try {
      const result = await window.beehive.openDiagnosticsFolder();
      if (el.diagnosticsStatus) el.diagnosticsStatus.textContent = result?.error ? `Could not open folder: ${result.error}` : `Report folder: ${result.dir}`;
    } catch (err) {
      if (el.diagnosticsStatus) el.diagnosticsStatus.textContent = err?.message || 'Could not open diagnostic report folder.';
    }
  });
  void refreshDiagnosticsStatus();

  async function refreshCrashReportsStatus() {
    if (!el.crashReportsStatus) return;
    try {
      const result = await window.beehive.crashReportCount?.();
      const count = Number(result?.count) || 0;
      el.crashReportsStatus.textContent = count
        ? `${count.toLocaleString()} crash report${count === 1 ? '' : 's'} on disk.`
        : 'No native crash reports on disk.';
    } catch {
      el.crashReportsStatus.textContent = 'Could not check for crash reports.';
    }
  }
  el.crashReportsOpen?.addEventListener('click', async () => {
    try {
      const result = await window.beehive.openCrashReports?.();
      if (el.crashReportsStatus) el.crashReportsStatus.textContent = result?.dir ? `Crash reports folder: ${result.dir}` : 'Could not open crash reports folder.';
    } catch (err) {
      if (el.crashReportsStatus) el.crashReportsStatus.textContent = err?.message || 'Could not open crash reports folder.';
    }
  });
  void refreshCrashReportsStatus();

  // ---------------- community services / themes / extensions ----------------
  const scrobbleEnabled = document.getElementById('setting-scrobble-enabled');
  const scrobblePercent = document.getElementById('setting-scrobble-percent');
  const scrobbleSeconds = document.getElementById('setting-scrobble-seconds');
  const scrobblePodcasts = document.getElementById('setting-scrobble-podcasts');
  const lbEnabled = document.getElementById('setting-listenbrainz-enabled');
  const lbToken = document.getElementById('setting-listenbrainz-token');
  const lfEnabled = document.getElementById('setting-lastfm-enabled');
  const lfKey = document.getElementById('setting-lastfm-key');
  const lfSecret = document.getElementById('setting-lastfm-secret');
  const lfSession = document.getElementById('setting-lastfm-session');
  const lfBegin = document.getElementById('lastfm-authorize-btn');
  const lfFinish = document.getElementById('lastfm-finish-btn');
  const scrobbleStatusEl = document.getElementById('scrobble-status');
  async function refreshScrobbleSettings() {
    if (!window.beehive.scrobbleStatus) return;
    try {
      const s=await window.beehive.scrobbleStatus(); scrobbleConfig=s||scrobbleConfig;
      if(scrobbleEnabled) scrobbleEnabled.checked=!!s.enabled;
      if(scrobblePercent) scrobblePercent.value=String(s.thresholdPercent||50);
      if(scrobbleSeconds) scrobbleSeconds.value=String(s.thresholdSeconds||240);
      if(scrobblePodcasts) scrobblePodcasts.checked=!!s.includePodcasts;
      if(lbEnabled) lbEnabled.checked=!!s.listenbrainz?.enabled;
      if(lfEnabled) lfEnabled.checked=!!s.lastfm?.enabled;
      if(scrobbleStatusEl) scrobbleStatusEl.textContent=`ListenBrainz: ${s.listenbrainz?.configured?'configured':'not configured'} · Last.fm: ${s.lastfm?.configured?'authorized':'not authorized'}`;
      // status() only exposes booleans (safe to poll). Without also loading
      // the actual saved credentials here, these fields always looked blank
      // on every Settings reopen even after a successful save -- there was
      // no way to see or confirm anything was actually configured.
      if (window.beehive.scrobbleConfig) {
        const full = await window.beehive.scrobbleConfig();
        if(lbToken) lbToken.value=String(full?.listenbrainz?.token||'');
        if(lfKey) lfKey.value=String(full?.lastfm?.apiKey||'');
        if(lfSecret) lfSecret.value=String(full?.lastfm?.sharedSecret||'');
        if(lfSession) lfSession.value=String(full?.lastfm?.sessionKey||'');
      }
    } catch(err) { if(scrobbleStatusEl) scrobbleStatusEl.textContent=err?.message||'Could not load scrobbling settings.'; }
  }
  async function saveScrobbleUi() {
    try {
      const result=await window.beehive.saveScrobbleSettings({ enabled:!!scrobbleEnabled?.checked, thresholdPercent:Number(scrobblePercent?.value)||50, thresholdSeconds:Number(scrobbleSeconds?.value)||240, includePodcasts:!!scrobblePodcasts?.checked, listenbrainz:{enabled:!!lbEnabled?.checked,token:String(lbToken?.value||'')}, lastfm:{enabled:!!lfEnabled?.checked,apiKey:String(lfKey?.value||''),sharedSecret:String(lfSecret?.value||''),sessionKey:String(lfSession?.value||'')} });
      scrobbleConfig=result||scrobbleConfig; if(scrobbleStatusEl) scrobbleStatusEl.textContent='Scrobbling settings saved.';
    } catch(err) { if(scrobbleStatusEl) scrobbleStatusEl.textContent=err?.message||'Could not save scrobbling settings.'; }
  }
  [scrobbleEnabled,scrobblePercent,scrobbleSeconds,scrobblePodcasts,lbEnabled,lbToken,lfEnabled,lfKey,lfSecret,lfSession].forEach(x=>x?.addEventListener('change',saveScrobbleUi));
  lfBegin?.addEventListener('click',async()=>{ try { const r=await window.beehive.lastfmBeginAuth(); if(r?.url) { window.open(r.url,'_blank'); if(scrobbleStatusEl) scrobbleStatusEl.textContent='Last.fm authorization opened. Authorize it, then click Finish authorization.'; } } catch(err){ if(scrobbleStatusEl) scrobbleStatusEl.textContent=err?.message||'Could not start Last.fm authorization.'; } });
  lfFinish?.addEventListener('click',async()=>{ try { const r=await window.beehive.lastfmFinishAuth(); if(lfSession) lfSession.value=''; if(lfEnabled) lfEnabled.checked=true; if(scrobbleStatusEl) scrobbleStatusEl.textContent='Last.fm authorization completed.'; await refreshScrobbleSettings(); } catch(err){ if(scrobbleStatusEl) scrobbleStatusEl.textContent=err?.message||'Could not finish Last.fm authorization.'; } });
  refreshScrobbleSettings();

  document.getElementById('theme-import-btn')?.addEventListener('click',async()=>{ try { const r=await window.beehive.importTheme(); if(r?.canceled)return; applyCustomCss(r.css,true,r.name||'theme'); } catch(err){ themedAlert?.(err?.message||'Could not import theme.','Theme import'); } });
  document.getElementById('theme-export-btn')?.addEventListener('click',async()=>{ try { const css=customCssRawSource||customThemeStyle?.textContent||''; const r=await window.beehive.exportTheme({css,name:'Hive Theme'}); if(!r?.canceled) themedAlert?.('Theme exported.','Theme'); } catch(err){ themedAlert?.(err?.message||'Could not export theme.','Theme export'); } });

  // ---------------- Hive community plugin host API v2 ----------------
  const hivePluginState = { plugins:new Map(), panels:new Map(), listeners:new Map() };
  function pluginEmit(name, payload) {
    const list = hivePluginState.listeners.get(name) || [];
    for (const fn of [...list]) { try { fn(payload); } catch (err) { console.warn('[Hive Plugin]', name, err); } }
  }
  function pluginPermission(plugin, permission) {
    return !permission || plugin.permissions?.includes(permission);
  }
  function pluginApiFor(plugin) {
    const id = plugin.id;
    const requirePermission = permission => { if (!pluginPermission(plugin, permission)) throw new Error(`Plugin ${id} lacks permission: ${permission}`); };
    const settingsListeners = [];
    const api = {
      version:2, id, name:plugin.name,
      library:{ getTracks:()=>{ requirePermission('library.read'); return library.tracks.slice(); } },
      player:{
        getCurrent:()=>{ requirePermission('player.read'); return currentQueue[currentIndex]||null; },
        getState:()=>{ requirePermission('player.read'); const t=currentQueue[currentIndex]||null; return {track:t,position:Number(audioEngine.currentTime)||0,duration:Number(audioEngine.duration)||Number(t?.duration)||0,paused:!!audioEngine.paused}; },
        play:track=>{ requirePermission('player.control'); return playQueue([track],0,false); },
        next:()=>{ requirePermission('player.control'); return goNext(); }, previous:()=>{ requirePermission('player.control'); return goPrev(); }
      },
      events:{
        on:(name,fn)=>{ if(typeof fn!=='function') return ()=>{}; const allowed=['track-change','playback','spectrum']; if(!allowed.includes(name)) throw new Error(`Unsupported Hive event: ${name}`); if(name==='spectrum') requirePermission('spectrum.read'); if(name!=='spectrum') requirePermission('player.read'); const list=hivePluginState.listeners.get(name)||[]; list.push(fn); hivePluginState.listeners.set(name,list); return ()=>{const i=list.indexOf(fn);if(i>=0)list.splice(i,1);}; }
      },
      audio:{
        getSpectrum:()=>{ requirePermission('spectrum.read'); return nowPlayingSpectrum.slice(); },
        onSpectrum:fn=>{ requirePermission('spectrum.read'); if(typeof fn!=='function') return ()=>{}; const list=hivePluginState.listeners.get('spectrum')||[]; list.push(fn); hivePluginState.listeners.set('spectrum',list); return ()=>{const i=list.indexOf(fn);if(i>=0)list.splice(i,1);}; }
      },
      settings:{
        load:async()=>{ requirePermission('settings'); return await window.beehive.getPluginSettings(id); },
        save:async(next)=>{ requirePermission('settings'); const value=await window.beehive.setPluginSettings(id,next||{}); pluginEmit(`settings:${id}`,value); return value; },
        onChange:fn=>{ requirePermission('settings'); if(typeof fn!=='function') return ()=>{}; settingsListeners.push(fn); const list=hivePluginState.listeners.get(`settings:${id}`)||[]; list.push(fn); hivePluginState.listeners.set(`settings:${id}`,list); return ()=>{const i=list.indexOf(fn);if(i>=0)list.splice(i,1);}; }
      },
      ui:{
        toast:(message,title='Hive')=>themedAlert?.(String(message),String(title)),
        addStyle:css=>{const st=document.createElement('style');st.dataset.hivePlugin=id;st.textContent=String(css||'');document.head.appendChild(st);return()=>st.remove();},
        registerSandboxPanel:definition=>{ requirePermission('ui.sandbox'); if(!definition?.id || typeof definition.mount!=='function') throw new Error('registerSandboxPanel requires id and mount(host).'); const panel={...definition,pluginId:id}; hivePluginState.panels.set(`${id}:${definition.id}`,panel); renderHivePluginPanels(); return ()=>{hivePluginState.panels.delete(`${id}:${definition.id}`);renderHivePluginPanels();}; }
      },
      lifecycle:{ onUnload:fn=>{ if(typeof fn==='function') plugin._unload.push(fn); return ()=>{const i=plugin._unload.indexOf(fn);if(i>=0)plugin._unload.splice(i,1);}; } }
    };
    return api;
  }
  function renderHivePluginPanels() {
    const host=document.getElementById('hive-plugin-sandbox-panels'); if(!host) return;
    host.innerHTML='';
    const selected = activeSandboxPluginId ? [...hivePluginState.panels.values()].filter(panel => panel.pluginId === activeSandboxPluginId) : [];
    selected.sort((a,b)=>(Number(a.order)||0)-(Number(b.order)||0)).forEach(panel=>{ const section=document.createElement('section'); section.className='hive-plugin-panel'; section.dataset.pluginId=panel.pluginId; section.dataset.panelId=panel.id; host.appendChild(section); try{panel.mount(section);}catch(err){section.textContent=err?.message||'Plugin panel failed to load.';} });
  }
  function closePluginSettingsModal() {
    const modal=document.getElementById('hive-plugin-settings-modal');
    if(modal) closeModal(modal);
  }
  async function openPluginSettings(plugin) {
    if(!plugin) return;
    let modal=document.getElementById('hive-plugin-settings-modal');
    if(!modal){
      modal=document.createElement('div'); modal.id='hive-plugin-settings-modal'; modal.className='modal-overlay hidden';
      modal.innerHTML='<div class="modal plugin-settings-modal"><div class="modal-header"><h3 id="hive-plugin-settings-title">Plugin settings</h3><button class="modal-close" type="button" aria-label="Close">×</button></div><div class="modal-body" id="hive-plugin-settings-body"></div></div>';
      document.body.appendChild(modal);
      modal.querySelector('.modal-close').addEventListener('click',()=>closePluginSettingsModal());
    }
    modal.querySelector('#hive-plugin-settings-title').textContent=`${plugin.name} settings`;
    const body=modal.querySelector('#hive-plugin-settings-body'); body.innerHTML='';
    const defs=Array.isArray(plugin.settings)?plugin.settings:[];
    const values=await window.beehive.getPluginSettings(plugin.id);
    if(!defs.length){ body.innerHTML='<div class="plugin-settings-empty">This plugin does not expose any settings.</div>'; openModal(modal); return; }
    const draft={};
    for(const def of defs){
      draft[def.id]=values?.[def.id] ?? def.default;
      const row=document.createElement('label'); row.className='settings-row';
      const span=document.createElement('span'); span.innerHTML=`${escapeHtml(def.label||def.id)}${def.description?`<span class="settings-hint">${escapeHtml(def.description)}</span>`:''}`;
      let input;
      if(def.type==='boolean'){ input=document.createElement('input'); input.type='checkbox'; input.checked=!!draft[def.id]; }
      else { input=document.createElement('input'); input.type='number'; input.step=String(def.step??1); if(def.min!=null) input.min=String(def.min); if(def.max!=null) input.max=String(def.max); input.value=String(draft[def.id]); }
      input.dataset.settingId=def.id; input.addEventListener('change',()=>{draft[def.id]=def.type==='boolean'?input.checked:Number(input.value);});
      row.append(span,input); body.appendChild(row);
    }
    const actions=document.createElement('div'); actions.className='settings-actions';
    const save=document.createElement('button'); save.className='sidebar-add settings-primary-action'; save.type='button'; save.textContent='Save settings';
    const cancel=document.createElement('button'); cancel.className='sidebar-add'; cancel.type='button'; cancel.textContent='Close'; cancel.addEventListener('click',closePluginSettingsModal);
    save.addEventListener('click',async()=>{ save.disabled=true; try { await window.beehive.setPluginSettings(plugin.id,draft); pluginEmit(`settings:${plugin.id}`,draft); closePluginSettingsModal(); await loadHiveExtensions(); themedAlert?.(`${plugin.name} settings saved.`,'Plugin settings'); } catch(err){ themedAlert?.(err?.message||'Could not save plugin settings.','Plugin settings'); } finally { save.disabled=false; } });
    actions.append(save,cancel); body.appendChild(actions);
    openModal(modal);
  }
  function renderInstalledPlugins(plugins) {
    const host=document.getElementById('plugin-list'); if(!host) return;
    host.innerHTML='';
    if(!plugins.length){ host.innerHTML='<div class="settings-hint settings-section-copy">No extensions loaded.</div>'; return; }
    for(const plugin of plugins){
      const card=document.createElement('div'); card.className=`plugin-list-card ${plugin.enabled?'enabled':'disabled'}`;
      const head=document.createElement('div'); head.className='plugin-card-head';
      const info=document.createElement('div');
      info.innerHTML=`<div class="settings-section-title">${escapeHtml(plugin.name)}</div><div class="settings-hint settings-section-copy">${escapeHtml(plugin.description||'')}</div><div class="plugin-list-meta">${plugin.enabled?'Enabled':'Disabled'} · API v${escapeHtml(plugin.apiVersion||1)} · ${escapeHtml((plugin.permissions||[]).join(', ')||'no special permissions')}</div>`;
      const actions=document.createElement('div'); actions.className='plugin-card-actions';
      const settings=document.createElement('button'); settings.type='button'; settings.className='sidebar-add'; settings.textContent='Settings'; settings.title=`Open ${plugin.name} settings`; settings.setAttribute('aria-label',`Open plugin settings for ${plugin.name}`); settings.dataset.pluginSettingsId=plugin.id; settings.addEventListener('click',()=>openPluginSettings(plugin));
      const enable=document.createElement('button'); enable.type='button'; enable.className='sidebar-add'; enable.textContent=plugin.enabled?'Disable':'Enable'; enable.addEventListener('click',async()=>{ try { await window.beehive.setPluginEnabled(plugin.id,!plugin.enabled); await loadHiveExtensions(); } catch(err){ themedAlert?.(err?.message||'Could not change plugin state.','Plugin'); } });
      actions.append(settings,enable); head.append(info,actions); card.appendChild(head); host.appendChild(card);
    }
  }

  window.HivePlugin = window.HivePlugin || {
    version:2, id:'', name:'',
    library:{ getTracks:()=>library.tracks.slice() },
    player:{ getCurrent:()=>currentQueue[currentIndex]||null, play:(track)=>playQueue([track],0,false), next:()=>goNext(), previous:()=>goPrev() },
    ui:{ toast:(message,title='Hive')=>themedAlert?.(String(message),String(title)), addStyle:(css)=>{const st=document.createElement('style');st.dataset.hivePlugin=window.HivePlugin._activePlugin?.id||'plugin';st.textContent=String(css||'');document.head.appendChild(st);} }
  };

  async function loadHiveExtensions() {
    const host=document.getElementById('plugin-list'); if(!window.beehive.listPlugins) return;
    try {
      for(const plugin of hivePluginState.plugins.values()) { for(const fn of plugin._unload||[]) { try { await fn(); } catch {} } }
      hivePluginState.plugins.clear(); hivePluginState.panels.clear(); hivePluginState.listeners.clear();
      document.querySelectorAll('style[data-hive-plugin]').forEach(el=>el.remove());
      const result=await window.beehive.listPlugins(); const plugins=Array.isArray(result?.plugins)?result.plugins:[];
      renderInstalledPlugins(plugins);
      for(const plugin of plugins){
        if(!plugin.enabled) continue;
        if(plugin.css){ const style=document.createElement('style'); style.dataset.hivePlugin=plugin.id; style.textContent=plugin.css; document.head.appendChild(style); }
        if(plugin.js){
          try {
            const pluginRuntime={...plugin,_unload:[]}; hivePluginState.plugins.set(plugin.id,pluginRuntime);
            window.HivePlugin=pluginApiFor(pluginRuntime);
            await window.beehive.runPlugin?.(plugin.js, plugin.id);
          } catch(err){ console.warn('[Hive Plugin]',plugin.id,err); }
        }
      }
      renderHivePluginPanels();
    } catch(err){ if(host) host.textContent=err?.message||'Could not load extensions.'; }
  }
  document.getElementById('plugin-import-btn')?.addEventListener('click',async()=>{ try { await window.beehive.installPluginFolder(); await loadHiveExtensions(); } catch(err){ themedAlert?.(err?.message||'Could not install extension.','Extension'); } });
  document.getElementById('plugin-open-btn')?.addEventListener('click',()=>window.beehive.openPluginsFolder?.());
  document.getElementById('plugin-reload-btn')?.addEventListener('click',()=>loadHiveExtensions());
  loadHiveExtensions();
  loadScrobbleConfig();

  function navigationPlainLabel(value) {
    return String(value || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  }
  function renderNavigationEditors() {
    const sideHost=document.getElementById('navigation-sidebar-editor');
    if(!sideHost) return;
    const actionButton=(label,title,onClick,disabled=false)=>{
      const button=document.createElement('button'); button.type='button'; button.className='navigation-editor-action'; button.textContent=label; button.title=title; button.setAttribute('aria-label',title); button.disabled=disabled; button.addEventListener('click',onClick); return button;
    };
    const move=(listKey,id,direction)=>{
      const order=Array.isArray(sidebarNavigation[listKey]) ? sidebarNavigation[listKey].slice() : [];
      const index=order.indexOf(id); const target=index+direction;
      if(index<0 || target<0 || target>=order.length) return;
      [order[index],order[target]]=[order[target],order[index]];
      sidebarNavigation[listKey]=order;
      if(listKey==='pinnedOrder') enforceLockedTopbarPins();
      saveNavigationPrefs(); renderSidebarNavigation(); syncPinnedTabs(); renderTabs(); renderNavigationEditors();
    };
    const makeRow=(host,id,label,description,opts={})=>{
      const row=document.createElement('div'); row.className='navigation-editor-row'; row.dataset.navId=id;
      const copy=document.createElement('div'); copy.className='navigation-editor-name';
      const strong=document.createElement('strong'); strong.textContent=navigationPlainLabel(label) || 'Untitled';
      const desc=document.createElement('span'); desc.textContent=description || '';
      copy.append(strong,desc);
      const actions=document.createElement('div'); actions.className='navigation-editor-actions';
      const orderKey=opts.orderKey;
      const order=orderKey==='sidebar' ? sidebarNavigation.order : sidebarNavigation.pinnedOrder;
      const index=order.indexOf(id);
      actions.append(actionButton('↑','Move up',()=>move(orderKey==='sidebar'?'order':'pinnedOrder',id,-1),index<=0));
      actions.append(actionButton('↓','Move down',()=>move(orderKey==='sidebar'?'order':'pinnedOrder',id,1),index<0||index>=order.length-1));
      if(opts.rename) actions.append(actionButton('Rename','Rename this destination',()=>renameSidebarEntry(id)));
      if(opts.remove) actions.append(actionButton('Remove','Remove this destination',()=>opts.remove()));
      if(opts.pin !== undefined) {
        const lockedPin = opts.locked === true;
        actions.append(actionButton(lockedPin ? 'Pinned' : (opts.pin?'Unpin':'Pin'), lockedPin ? 'Core destination' : (opts.pin?'Remove from top bar':'Pin to top bar'), ()=>{
          if (lockedPin) return;
          if(opts.pin){ sidebarNavigation.pinned.delete(id); sidebarNavigation.pinnedOrder=sidebarNavigation.pinnedOrder.filter(x=>x!==id); }
          else { sidebarNavigation.pinned.add(id); if(!sidebarNavigation.pinnedOrder.includes(id)) sidebarNavigation.pinnedOrder.push(id); }
          enforceLockedTopbarPins(); saveNavigationPrefs(); syncPinnedTabs(); renderTabs(); renderNavigationEditors();
        }));
      }
      if(opts.show !== undefined){
        const labelWrap=document.createElement('label'); labelWrap.className='navigation-editor-switch';
        const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.checked=opts.show; checkbox.addEventListener('change',e=>{
          if(e.target.checked) sidebarNavigation.hidden.delete(id);
          else {
            sidebarNavigation.hidden.add(id);
            if(document.querySelector(`.sidebar-item[data-nav="${CSS.escape(id)}"]`)?.classList.contains('active')){ sidebarNavigation.hidden.delete(id); e.target.checked=true; themedAlert?.('Switch to another destination before hiding the current one.','Navigation'); return; }
          }
          saveNavigationPrefs(); renderSidebarNavigation(); renderNavigationEditors();
        });
        labelWrap.append(checkbox,document.createTextNode('Show')); actions.append(labelWrap);
      }
      row.append(copy,actions); host.appendChild(row);
    };

    sideHost.innerHTML='';
    sidebarNavigation.order.forEach(id=>{
      const d=sidebarEntry(id); if(!d || d.id==='pl-explorer') return;
      if(d.type==='divider') return makeRow(sideHost,id,d.label||'Divider','Separator',{
        orderKey:'sidebar',rename:true,remove:()=>removeSidebarDivider(id)
      });
      if(d.type==='playlist'){
        const pl=playlists.find(p=>String(p.id)===String(d.playlistId)); if(!pl) return;
        return makeRow(sideHost,id,playlistLabel(pl),pl.smart?'Auto Playlist':'Playlist',{orderKey:'sidebar',remove:()=>removePlaylistFromSidebar(id),pin:sidebarNavigation.pinned.has(id)});
      }
      makeRow(sideHost,id,sidebarLabel(id),d.description,{orderKey:'sidebar',rename:true,show:!sidebarNavigation.hidden.has(id),pin:sidebarNavigation.pinned.has(id),locked:id==='music'});
    });
    const addDivider=document.createElement('button'); addDivider.type='button'; addDivider.className='sidebar-add navigation-add-divider'; addDivider.textContent='+ Add divider'; addDivider.addEventListener('click',addSidebarDivider); sideHost.appendChild(addDivider);

    // Pinning/unpinning the top bar and adding a playlist to the sidebar both
    // stay available -- via each sidebar row's own Pin button (opts.pin
    // above) and via a playlist's right-click "Add to sidebar" (see
    // showPlaylistContextMenu) -- without a dedicated settings section for
    // either.
    enforceLockedTopbarPins();
  }
  document.getElementById('navigation-reset-btn')?.addEventListener('click',()=>{
    try { localStorage.removeItem(SIDEBAR_NAV_KEY); localStorage.removeItem(PINNED_NAV_KEY); localStorage.removeItem(TOP_TAB_PREFS_KEY); } catch {}
    sidebarNavigation=loadNavigationPrefs(); enforceLockedTopbarPins(); saveNavigationPrefs(); renderSidebarNavigation(); syncPinnedTabs(); renderTabs(); renderNavigationEditors();
  });

  // ---------------- Android / MTP device sync ----------------
  let androidDevices = [];
  let androidDeviceRefreshPromise = null;

  function setDeviceTransferStatus(text) {
    const node = document.getElementById('device-transfer-status');
    if (node) node.textContent = String(text || '');
  }

  async function refreshAndroidDevices() {
    if (!window.beehive.listDevices) return [];
    if (androidDeviceRefreshPromise) return androidDeviceRefreshPromise;
    const status = document.getElementById('device-status');
    const list = document.getElementById('device-list');
    androidDeviceRefreshPromise = (async () => {
      if (status) status.textContent = 'Checking for Android devices…';
      try {
        const result = await window.beehive.listDevices();
        androidDevices = Array.isArray(result?.devices) ? result.devices : [];
        if (!result?.supported) {
          if (status) status.textContent = result?.reason || 'Android device sync is not supported here.';
        } else if (!androidDevices.length) {
          if (status) status.textContent = 'No Android device found. Unlock the phone and choose File Transfer (MTP), then refresh.';
        } else {
          const mounted = androidDevices.filter(device => device.mounted).length;
          if (status) status.textContent = `${androidDevices.length} Android storage connection${androidDevices.length === 1 ? '' : 's'} found · ${mounted} mounted`;
        }
        if (list) {
          list.innerHTML = '';
          for (const device of androidDevices) {
            const card = document.createElement('div');
            card.className = 'device-card';
            const main = document.createElement('div');
            main.className = 'device-card-main';
            const name = document.createElement('strong');
            name.textContent = device.name || 'Android device';
            const meta = document.createElement('span');
            meta.className = 'device-card-meta';
            const storages = Array.isArray(device.storages) ? device.storages : [];
            meta.textContent = `${storages.length ? `${storages.length} storage${storages.length === 1 ? '' : 's'}` : 'Android storage'} · ${device.mounted ? 'Ready for music transfer' : 'Not mounted'}`;
            main.append(name, meta);

            const destinationRow = document.createElement('div');
            destinationRow.className = 'device-destination-row';
            const storageSelect = document.createElement('select');
            storageSelect.className = 'settings-select device-storage-select';
            storageSelect.setAttribute('aria-label', `Storage on ${device.name || 'Android device'}`);
            for (const storage of storages) {
              const option = document.createElement('option');
              option.value = String(storage.path || '');
              option.textContent = String(storage.name || storage.path || 'Storage');
              storageSelect.appendChild(option);
            }
            const destination = document.createElement('input');
            destination.type = 'text';
            destination.className = 'settings-input device-destination-input';
            destination.placeholder = 'Music';
            destination.value = String(device.destinationPath || 'Music');
            const matchingStorage = storages.find(storage => {
              const prefix = String(storage.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
              return prefix && (destination.value === prefix || destination.value.startsWith(`${prefix}/`));
            });
            if (matchingStorage) storageSelect.value = String(matchingStorage.path || '');
            storageSelect.addEventListener('change', () => {
              const prefix = String(storageSelect.value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
              destination.value = prefix ? `${prefix}/Music` : 'Music';
            });
            const saveDestination = document.createElement('button');
            saveDestination.type = 'button';
            saveDestination.className = 'sidebar-add';
            saveDestination.textContent = 'Save destination';
            saveDestination.addEventListener('click', async () => {
              try {
                const value = String(destination.value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                const result = await window.beehive.setDeviceDestination?.(device.id, value);
                device.destinationPath = String(result?.destinationPath || value || 'Music');
                destination.value = device.destinationPath;
                setDeviceTransferStatus(`Destination saved for ${device.name || 'Android device'}: ${device.destinationPath}`);
              } catch (error) {
                setDeviceTransferStatus(`Could not save destination · ${error?.message || String(error)}`);
              }
            });
            destinationRow.append(storageSelect, destination, saveDestination);

            const actions = document.createElement('div');
            actions.className = 'device-card-actions';
            const send = document.createElement('button');
            send.type = 'button';
            send.className = 'sidebar-add settings-primary-action';
            send.textContent = 'Send selected music';
            send.disabled = !device.mounted || !selectedSongPaths.size;
            send.addEventListener('click', async () => {
              const tracks = orderedSelectedTracks(library.tracks);
              if (!tracks.length) { showAppNotice('Select one or more songs in your library first.'); return; }
              device.destinationPath = String(destination.value || device.destinationPath || 'Music').trim();
              await sendTracksToAndroidDevice(device, tracks);
            });
            actions.append(send);
            card.append(main, destinationRow, actions);
            list.appendChild(card);
          }
        }
        return androidDevices;
      } catch (error) {
        androidDevices = [];
        if (status) status.textContent = error?.message || 'Could not inspect Android devices.';
        if (list) list.innerHTML = '';
        return [];
      } finally {
        androidDeviceRefreshPromise = null;
      }
    })();
    return androidDeviceRefreshPromise;
  }

  async function sendTracksToAndroidDevice(device, tracks) {
    const items = Array.isArray(tracks) ? tracks.filter(track => track?.path && !isSpotifyTrack(track) && !isPodcastTrack(track)) : [];
    if (!items.length) { showAppNotice('Select local library music to send to the phone.'); return null; }
    const label = items.length === 1 ? (items[0].title || '1 track') : `${items.length} tracks`;
    setDeviceTransferStatus(`Preparing ${label} for ${device.name || 'Android device'}…`);
    try {
      const result = await window.beehive.sendTracksToDevice(device, items);
      const copied = Array.isArray(result?.copied) ? result.copied.length : 0;
      const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
      const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
      setDeviceTransferStatus(`Transfer complete · ${copied} copied${skipped ? ` · ${skipped} already present` : ''}${failed ? ` · ${failed} failed` : ''}`);
      if (failed) await themedAlert(`Hive copied ${copied} track${copied === 1 ? '' : 's'} and skipped ${skipped}. ${failed} transfer${failed === 1 ? '' : 's'} failed.\n\n${result.failed.slice(0, 3).map(item => `${item.path}: ${item.error}`).join('\n')}`, 'Android transfer');
      else showAppNotice(`Sent ${copied} track${copied === 1 ? '' : 's'} to ${device.name || 'Android device'}${skipped ? ` · ${skipped} already present` : ''}.`);
      return result;
    } catch (error) {
      setDeviceTransferStatus(`Transfer failed · ${error?.message || String(error)}`);
      await themedAlert(error?.message || String(error), 'Android transfer');
      return null;
    }
  }

  window.beehive.onDeviceTransferProgress?.(progress => {
    const total = Number(progress?.totalFiles || 0);
    const done = Number(progress?.completedFiles || 0);
    const bytes = Number(progress?.completedBytes || 0);
    const totalBytes = Number(progress?.totalBytes || 0);
    const pct = totalBytes > 0 ? Math.min(100, Math.round(bytes / totalBytes * 100)) : (total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0);
    const current = progress?.track?.title || 'track';
    setDeviceTransferStatus(`Transferring ${current} · ${pct}% · ${Math.min(done, total)} / ${total}`);
  });

  // ---------------- settings modal tabs ----------------
  const settingsTabs = Array.from(document.querySelectorAll('.settings-tab-btn'));
  function activateSettingsTab(btn, focus=false) {
    if (!btn) return;
    settingsTabs.forEach(b => { const active=b===btn; b.classList.toggle('active',active); b.setAttribute('aria-selected',String(active)); b.tabIndex=active?0:-1; });
    document.querySelectorAll('.settings-tab-panel').forEach(panel => {
      const active=panel.dataset.settingsPanel===btn.dataset.settingsTab; panel.classList.toggle('active',active); panel.hidden=!active;
    });
    if (focus) btn.focus({preventScroll:true});
  }
  settingsTabs.forEach((btn, index) => {
    btn.addEventListener('click', () => activateSettingsTab(btn));
    btn.addEventListener('keydown', e => {
      if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault();
      let next=index;
      if(e.key==='Home') next=0; else if(e.key==='End') next=settingsTabs.length-1;
      else if(e.key==='ArrowUp'||e.key==='ArrowLeft') next=(index-1+settingsTabs.length)%settingsTabs.length;
      else next=(index+1)%settingsTabs.length;
      activateSettingsTab(settingsTabs[next], true);
    });
  });
  const settingsDescriptions = {
    general:'Playback, audio output, and normalization.',
    devices:'Android/MTP device connections and music transfer.',
    performance:'GPU acceleration and playback responsiveness.',
    appearance:"Theme, surfaces, window chrome, and layout.",
    navigation:'Choose destinations, order, visibility, and top-bar pins.',
    library:'Music folders, scans, lyrics, cache, and Favorites.',
    statistics:'Play counts and long-term listening history.',
    discord:'Configure Music Presence without connecting Hive to Discord IPC.',
    plugins:'Install and configure Hive extensions.',
    community:'Scrobbling services and listening integrations.',
    logs:'Inspect the current Hive session and scan diagnostics when troubleshooting.'
  };
  document.querySelectorAll('.settings-tab-panel').forEach(panel => {
    panel.hidden=!panel.classList.contains('active');
    const key=panel.dataset.settingsPanel;
    if(settingsDescriptions[key] && !panel.querySelector(':scope > .settings-panel-intro')) {
      const intro=document.createElement('div'); intro.className='settings-panel-intro';
      intro.innerHTML=`<span class="settings-panel-kicker">SETTINGS</span><p>${escapeHtml(settingsDescriptions[key])}</p>`;
      panel.prepend(intro);
    }
  });
  renderNavigationEditors();

  // Music Presence remains the sole Discord publisher. Hive only edits the local
  // Music Presence settings file; no Discord IPC or SET_ACTIVITY calls belong here.
  const musicPresenceActivity = document.getElementById('setting-music-presence-activity-type');
  const musicPresenceApplicationId = document.getElementById('setting-music-presence-application-id');
  const musicPresenceApplyBtn = document.getElementById('music-presence-apply-btn');
  const musicPresenceRestartBtn = document.getElementById('music-presence-restart-btn');
  const musicPresenceStatus = document.getElementById('music-presence-status');
  const musicPresenceSavePrompt = document.getElementById('music-presence-save-prompt');

  function setMusicPresenceStatus(text, prompt = '') {
    if (musicPresenceStatus) musicPresenceStatus.textContent = text;
    if (musicPresenceSavePrompt) {
      musicPresenceSavePrompt.textContent = prompt;
      musicPresenceSavePrompt.classList.toggle('hidden', !prompt);
    }
  }

  async function loadMusicPresenceSettings() {
    if (!musicPresenceActivity || !musicPresenceApplicationId || !window.beehive.getMusicPresenceSettings) return;
    setMusicPresenceStatus('Loading Music Presence settings…');
    try {
      const result = await window.beehive.getMusicPresenceSettings();
      if (!result?.supported) {
        setMusicPresenceStatus(result?.reason || 'Music Presence controls are unavailable.');
        return;
      }
      if (!result?.available) {
        setMusicPresenceStatus(result?.reason || 'Music Presence settings.json was not found.');
        return;
      }
      const presence = result.settings?.presence || {};
      const activity = String(presence.activity_type || 'playing').toLowerCase();
      musicPresenceActivity.value = ['listening', 'playing', 'watching'].includes(activity) ? activity : 'listening';
      const customId = presence.custom_discord_application_id;
      musicPresenceApplicationId.value = String(customId?.valid ? customId?.value || '' : '');
      setMusicPresenceStatus('Music Presence settings loaded.');
    } catch (err) {
      setMusicPresenceStatus(err?.message || 'Could not load Music Presence settings.');
    }
  }

  async function applyMusicPresenceSettings() {
    if (!musicPresenceActivity || !musicPresenceApplicationId || !window.beehive.saveMusicPresenceSettings) return;
    const activityType = String(musicPresenceActivity.value || 'listening').toLowerCase();
    const applicationId = String(musicPresenceApplicationId.value || '').trim();
    musicPresenceApplyBtn && (musicPresenceApplyBtn.disabled = true);
    setMusicPresenceStatus('Saving Music Presence settings…');
    try {
      await window.beehive.saveMusicPresenceSettings({ activityType, applicationId });
      setMusicPresenceStatus('Saved. Check Discord to see if Music Presence picked it up live.', 'If it does not change, restart Music Presence.');
    } catch (err) {
      setMusicPresenceStatus(err?.message || 'Could not save Music Presence settings.');
    } finally {
      if (musicPresenceApplyBtn) musicPresenceApplyBtn.disabled = false;
    }
  }

  async function restartMusicPresence() {
    if (!window.beehive.restartMusicPresence) return;
    musicPresenceRestartBtn && (musicPresenceRestartBtn.disabled = true);
    setMusicPresenceStatus('Restarting Music Presence…');
    try {
      const result = await window.beehive.restartMusicPresence();
      if (!result?.ok) throw new Error(result?.reason || 'Could not restart Music Presence.');
      setMusicPresenceStatus('Music Presence restarted.');
    } catch (err) {
      setMusicPresenceStatus(err?.message || 'Could not restart Music Presence.');
    } finally {
      if (musicPresenceRestartBtn) musicPresenceRestartBtn.disabled = false;
    }
  }

  musicPresenceApplyBtn?.addEventListener('click', applyMusicPresenceSettings);
  musicPresenceRestartBtn?.addEventListener('click', restartMusicPresence);
  loadMusicPresenceSettings();

  // Convert Chromium's native `title` popups into themed Hive tooltips. A Mutation
  // Observer also catches dynamically created rows, cards, and context-menu items.
  let globalTooltip = null, globalTooltipTimer = null, globalTooltipTarget = null;
  function tooltipTextFor(node) { return node?.getAttribute?.('data-tooltip') || node?.getAttribute?.('title') || ''; }
  function prepareTooltipNode(node) {
    if (!(node instanceof Element) || node === globalTooltip) return;
    const title = node.getAttribute('title');
    if (title && !node.getAttribute('data-tooltip')) node.setAttribute('data-tooltip', title);
    if (title) node.removeAttribute('title');
  }
  function positionGlobalTooltip(e) {
    if (!globalTooltip || !globalTooltip.classList.contains('visible')) return;
    const r=globalTooltip.getBoundingClientRect(), pad=10;
    let left=e.clientX+12, top=e.clientY+16;
    if (left+r.width > window.innerWidth-pad) left=Math.max(pad,e.clientX-r.width-12);
    if (top+r.height > window.innerHeight-pad) top=Math.max(pad,e.clientY-r.height-12);
    globalTooltip.style.left=`${left}px`; globalTooltip.style.top=`${top}px`;
  }
  document.addEventListener('pointerover', e => {
    const node=e.target?.closest?.('[data-tooltip]'); if(!node) return;
    const text=tooltipTextFor(node); if(!text) return;
    prepareTooltipNode(node); globalTooltipTarget=node;
    if(!globalTooltip){ globalTooltip=document.createElement('div'); globalTooltip.className='beehive-global-tooltip'; document.body.appendChild(globalTooltip); }
    if(globalTooltipTimer)clearTimeout(globalTooltipTimer); globalTooltip.classList.remove('visible');
    globalTooltipTimer=setTimeout(()=>{ if(globalTooltipTarget!==node)return; globalTooltip.textContent=text; globalTooltip.classList.add('visible'); positionGlobalTooltip(e); }, 420);
  });
  document.addEventListener('pointermove', e => positionGlobalTooltip(e));
  document.addEventListener('pointerout', e => { const node=e.target?.closest?.('[data-tooltip]'); if(node && !node.contains(e.relatedTarget)){ if(globalTooltipTimer)clearTimeout(globalTooltipTimer); globalTooltipTarget=null; globalTooltip?.classList.remove('visible'); } });
  const tooltipObserver=new MutationObserver(mutations=>{ for(const m of mutations){ if(m.type==='attributes' && m.attributeName==='title') prepareTooltipNode(m.target); for(const node of m.addedNodes){ if(node.nodeType===1){ prepareTooltipNode(node); node.querySelectorAll?.('[title]').forEach(prepareTooltipNode); } } } });
  tooltipObserver.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['title']});
  document.querySelectorAll('[title]').forEach(prepareTooltipNode);

  window.beehive.getVersion().then((info) => {
    if (info) el.aboutVersion.textContent = `Version ${info.version}`;
  }).catch(() => {});

  // Check-then-ask only: this never downloads or installs anything without
  // the user explicitly clicking the button in whatever state it's in --
  // Check -> (if available) Download -> (once downloaded) Restart & install.
  function renderUpdateStatus(status) {
    if (!el.aboutUpdateStatus || !el.aboutCheckUpdatesBtn) return;
    const btn = el.aboutCheckUpdatesBtn;
    btn.disabled = false;
    switch (status?.state) {
      case 'checking':
        btn.disabled = true;
        btn.textContent = 'Checking…';
        el.aboutUpdateStatus.textContent = 'Checking for updates…';
        break;
      case 'available':
        btn.textContent = 'Download update';
        btn.dataset.updateAction = 'download';
        el.aboutUpdateStatus.textContent = `Update available: version ${status.info?.version || '?'}`;
        break;
      case 'downloading': {
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        const pct = Math.round(Number(status.progress?.percent) || 0);
        el.aboutUpdateStatus.textContent = `Downloading update… ${pct}%`;
        break;
      }
      case 'downloaded':
        btn.textContent = 'Restart && install';
        btn.dataset.updateAction = 'install';
        el.aboutUpdateStatus.textContent = `Update ready: version ${status.info?.version || '?'}. Restart Hive to install.`;
        break;
      case 'up-to-date':
        btn.textContent = 'Check for updates';
        delete btn.dataset.updateAction;
        el.aboutUpdateStatus.textContent = "You're up to date.";
        break;
      case 'error':
        btn.textContent = 'Check for updates';
        delete btn.dataset.updateAction;
        el.aboutUpdateStatus.textContent = `Could not check for updates: ${status.error || 'unknown error'}`;
        break;
      default:
        btn.textContent = 'Check for updates';
        delete btn.dataset.updateAction;
        el.aboutUpdateStatus.textContent = '';
    }
  }
  el.aboutCheckUpdatesBtn?.addEventListener('click', async () => {
    const action = el.aboutCheckUpdatesBtn.dataset.updateAction;
    try {
      if (action === 'install') await window.beehive.installUpdate?.();
      else if (action === 'download') renderUpdateStatus(await window.beehive.downloadUpdate?.());
      else renderUpdateStatus(await window.beehive.checkForUpdates?.());
    } catch (err) {
      if (el.aboutUpdateStatus) el.aboutUpdateStatus.textContent = err?.message || 'Could not check for updates.';
    }
  });
  window.beehive.onUpdateStatusChanged?.(renderUpdateStatus);
  window.beehive.getUpdateStatus?.().then(renderUpdateStatus).catch(() => {});

  // ---------------- draggable floating windows ----------------
  function makeDraggable(node, options = {}) {
    if (!node || node.dataset.draggableReady) return;
    node.dataset.draggableReady = '1';
    let dragging = false, offsetX = 0, offsetY = 0;
    node.addEventListener('pointerdown', (e) => {
      if (options.enabled && !options.enabled()) return;
      if (e.button !== 0 || e.target.closest('button, input, textarea, select, a')) return;
      const r = node.getBoundingClientRect();
      const parent = options.parent ? options.parent() : null;
      const pr = parent ? parent.getBoundingClientRect() : {left:0, top:0};
      if (getComputedStyle(node).position === 'absolute' && parent) {
        offsetX = e.clientX - r.left; offsetY = e.clientY - r.top;
        node.style.right = 'auto';
      } else {
        offsetX = e.clientX - r.left; offsetY = e.clientY - r.top;
      }
      dragging = true;
      node.setPointerCapture?.(e.pointerId);
      node.classList.add('dragging');
      if (getComputedStyle(node).position === 'fixed') {
        node.style.left = `${r.left}px`; node.style.top = `${r.top}px`;
      } else if (parent) {
        node.style.left = `${r.left - pr.left}px`; node.style.top = `${r.top - pr.top}px`;
      }
      e.preventDefault();
    });
    node.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const parent = options.parent ? options.parent() : null;
      const pr = parent ? parent.getBoundingClientRect() : {left:0, top:0};
      let x = e.clientX - offsetX - pr.left;
      let y = e.clientY - offsetY - pr.top;
      if (parent) {
        x = Math.max(0, Math.min(x, parent.clientWidth - node.offsetWidth));
        y = Math.max(0, Math.min(y, parent.clientHeight - node.offsetHeight));
      } else {
        x = Math.max(0, Math.min(x, window.innerWidth - node.offsetWidth));
        y = Math.max(0, Math.min(y, window.innerHeight - node.offsetHeight));
      }
      node.style.left = `${x}px`; node.style.top = `${y}px`;
    });
    const stop = () => { dragging = false; node.classList.remove('dragging'); };
    node.addEventListener('pointerup', stop);
    node.addEventListener('pointercancel', stop);
  }

  // ---------------- cover art lightbox ----------------
  // Shows a track/album/artist's full-size cover(s). When there's more than
  // one embedded image (e.g. front + back cover), it auto-rotates through
  // them on a timer, plus dots and prev/next arrows for manual control.
  function openCoverLightbox(model, startIndex = 0) {
    if (!model) return;
    let items = distinctCovers(model);
    if (!items.length) items = [{ file: null, type: null }];

    let idx = Math.max(0, Math.min(Number(startIndex) || 0, items.length - 1));
    let rotateTimer = null;

    function labelFor(item) {
      const parts = [model.title];
      if (item.type) parts.push(item.type);
      else if (items.length > 1) parts.push(`Image ${idx + 1} of ${items.length}`);
      return parts.filter(Boolean).join('  \u00b7  ');
    }

    function fitLightboxToImage(src) {
      const box = el.coverLightbox.querySelector('.lightbox');
      const stage = el.coverLightbox.querySelector('.lightbox-stage');
      if (!box || !stage) return;
      const img = new Image();
      img.onload = () => {
        const iw = Math.max(1, img.naturalWidth || 1);
        const ih = Math.max(1, img.naturalHeight || 1);
        // Keep the viewer at the artwork's native pixel dimensions when it fits.
        // Very large artwork is uniformly scaled to the usable monitor area.
        const maxW = Math.max(240, Math.floor(window.innerWidth * 0.88));
        const maxH = Math.max(220, Math.floor(window.innerHeight * 0.78));
        const scale = Math.min(1, maxW / iw, maxH / ih);
        const w = Math.max(1, Math.round(iw * scale));
        const h = Math.max(1, Math.round(ih * scale));
        stage.style.width = `${w}px`;
        stage.style.height = `${h}px`;
        stage.style.aspectRatio = 'auto';
        box.style.width = `${w}px`;
        box.style.maxWidth = 'none';
        box.style.maxHeight = 'none';
        box.style.height = 'auto';
        const left = Math.max(10, Math.min(window.innerWidth - w - 10, (window.innerWidth - w) / 2));
        const top = Math.max(10, Math.min(window.innerHeight - h - 70, (window.innerHeight - h) / 2));
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.dataset.positioned = '1';
      };
      img.src = src;
    }

    function render() {
      const item = items[idx];
      const lightboxStage = el.coverLightbox.querySelector('.lightbox-stage');
      const src = item.file ? coverSrc(item.file) : placeholderCover();
      if (lightboxStage) {
        lightboxStage.style.setProperty('--cover-backdrop', `url(\"${src.replace(/\"/g, '\\"')}\")`);
      }
      el.lightboxImg.style.opacity = '0';
      el.lightboxImg.src = src;
      el.lightboxImg.onload = () => {
        el.lightboxImg.style.opacity = '1';
        fitLightboxToImage(src);
      };
      el.lightboxCaption.textContent = labelFor(item);

      el.lightboxDots.innerHTML = '';
      if (items.length > 1) {
        items.forEach((_, i) => {
          const dot = document.createElement('span');
          dot.className = 'lightbox-dot' + (i === idx ? ' active' : '');
          dot.addEventListener('click', () => { idx = i; render(); restartTimer(); });
          el.lightboxDots.appendChild(dot);
        });
      }
      el.lightboxPrev.classList.toggle('hidden', items.length < 2);
      el.lightboxNext.classList.toggle('hidden', items.length < 2);
    }

    function goNextImage() { idx = (idx + 1) % items.length; render(); }
    function goPrevImage() { idx = (idx - 1 + items.length) % items.length; render(); }
    // The lightbox is an inspection surface, not part of the rotating artwork
    // presentation. Once the user opens a particular cover, keep that exact
    // frame in place until they choose another cover with the dots/arrows.
    function restartTimer() { clearInterval(rotateTimer); rotateTimer = null; }

    el.lightboxImg.oncontextmenu = e => { e.preventDefault(); showCoverContextMenu(e, items[idx]?.file); };
    el.lightboxPrev.innerHTML = window.BeehiveIcons.chevronLeft || '';
    el.lightboxNext.innerHTML = window.BeehiveIcons.chevronRight || '';
    el.lightboxPrev.onclick = () => { goPrevImage(); restartTimer(); };
    el.lightboxNext.onclick = () => { goNextImage(); restartTimer(); };

    render();
    restartTimer();
    el.coverLightbox._onClose = () => clearInterval(rotateTimer);
    openModal(el.coverLightbox);
    // While the full-size cover is open, the left/right arrow keys navigate the
    // same cover set as the on-screen previous/next buttons. Keep this listener
    // scoped to the lightbox and remove it on close so normal keyboard shortcuts
    // continue to work everywhere else in Beehive.
    const onKeyDown = e => {
      if (el.coverLightbox.classList.contains('hidden')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        if (items.length > 1) { goPrevImage(); restartTimer(); }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        if (items.length > 1) { goNextImage(); restartTimer(); }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    // Re-fit on resize so a huge image remains inside the current monitor.
    const onResize = () => fitLightboxToImage(el.lightboxImg.src || placeholderCover());
    window.addEventListener('resize', onResize);
    const previousClose = el.coverLightbox._onClose;
    el.coverLightbox._onClose = () => {
      clearInterval(rotateTimer);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
      if (typeof previousClose === 'function') previousClose();
    };
    requestAnimationFrame(() => fitLightboxToImage(el.lightboxImg.src || placeholderCover()));
  }
  makeDraggable(el.coverLightbox.querySelector('.lightbox'));

  // ---------------- queue / cover-art splitter ----------------
  // The thin line between the queue and the large cover is a real splitter.
  // Drag it anywhere within the available panel height; the chosen split is
  // persisted so the layout comes back exactly as the user left it.
  const QUEUE_SPLIT_KEY = 'beehive:queue-art-split';
  const queueSplit = document.getElementById('queue-art-resize');
  const queuePanel = document.getElementById('queue-panel');
  const queueList = document.getElementById('queue-list');
  const npCard = document.getElementById('now-playing-card');

  function loadQueueSplit() {
    const n = parseFloat(localStorage.getItem(QUEUE_SPLIT_KEY));
    return Number.isFinite(n) ? n : null;
  }
  function applyQueueSplit() {
    const saved = loadQueueSplit();
    if (saved == null) return;
    queueList.style.flexBasis = saved + 'px';
  }
  applyQueueSplit();

  if (queueSplit && queuePanel && queueList && npCard) {
    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    const onMove = (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientY - startY) > 3) moved = true;
      const panelRect = queuePanel.getBoundingClientRect();
      const headerH = queuePanel.querySelector('.queue-header')?.getBoundingClientRect().height || 0;
      const splitterH = queueSplit.getBoundingClientRect().height + 6;
      const available = Math.max(80, panelRect.height - headerH - splitterH - 20);
      // Keep both areas usable, but otherwise allow the splitter to travel
      // essentially the full height of the panel.
      const minQueue = 30;
      const minArt = 60;
      const maxQueue = Math.max(minQueue, available - minArt);
      const next = Math.max(minQueue, Math.min(maxQueue, startHeight + (e.clientY - startY)));
      queueList.style.flexBasis = next + 'px';
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      queueSplit.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const h = queueList.getBoundingClientRect().height;
      try { localStorage.setItem(QUEUE_SPLIT_KEY, String(Math.round(h))); } catch {}
    };

    let moved = false;
    queueSplit.addEventListener('mousedown', (e) => {
      if (isLocked) return;
      moved = false;
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startHeight = queueList.getBoundingClientRect().height;
      moved = false;
      queueSplit.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  // ---------------- player glass controls ----------------
  const PLAYBAR_GLASS_KEY = 'beehive:player-glass';
  const PLAYBAR_GLASS_AREAS_KEY = 'beehive:player-glass-areas';
  const glassAreaDefaults = Object.freeze({ topbar:true, sidebar:true, lyrics:true, main:true, toolbar:true, queue:true, playbar:true });
  function loadPlayerGlass() {
    try { const raw=localStorage.getItem(PLAYBAR_GLASS_KEY); return raw==null ? true : raw==='true'; } catch { return true; }
  }
  function loadPlayerGlassAreas() {
    try { const saved=JSON.parse(localStorage.getItem(PLAYBAR_GLASS_AREAS_KEY)||'{}'); return {...glassAreaDefaults,...(saved&&typeof saved==='object'?saved:{})}; } catch { return {...glassAreaDefaults}; }
  }
  let playerGlassEnabled=loadPlayerGlass();
  let glassAreaPrefs=loadPlayerGlassAreas();
  function applyPlayerGlass() {
    const surfaces={
      topbar:document.getElementById('topbar'),
      sidebar:document.getElementById('sidebar'),
      lyrics:document.getElementById('lyrics-section'),
      main:document.getElementById('main'),
      queue:document.getElementById('queue-panel'),
      playbar:document.getElementById('playbar')
    };
    for (const [area,node] of Object.entries(surfaces)) {
      if(!node) continue;
      const frosted=playerGlassEnabled && glassAreaPrefs[area]!==false;
      node.classList.toggle('player-glass-surface',frosted);
      node.classList.toggle('player-glass-transparent',!frosted);
    }
    document.documentElement.classList.toggle('player-glass-enabled', playerGlassEnabled);
    document.querySelectorAll('[data-glass-area]').forEach(input=>{
      input.checked=glassAreaPrefs[input.dataset.glassArea]!==false;
      input.disabled=!playerGlassEnabled;
    });
    if(el.playerGlassToggle) {
      el.playerGlassToggle.checked=playerGlassEnabled;
      el.playerGlassToggle.setAttribute('aria-pressed',String(playerGlassEnabled));
    }
  }
  function savePlayerGlassPrefs(){
    try { localStorage.setItem(PLAYBAR_GLASS_KEY,String(!!playerGlassEnabled)); localStorage.setItem(PLAYBAR_GLASS_AREAS_KEY,JSON.stringify(glassAreaPrefs)); } catch {}
    applyPlayerGlass();
  }
  el.playerGlassToggle?.addEventListener('change',()=>{playerGlassEnabled=!!el.playerGlassToggle.checked;savePlayerGlassPrefs();});
  document.querySelectorAll('[data-glass-area]').forEach(input=>input.addEventListener('change',()=>{
    const area=String(input.dataset.glassArea||'');
    if(!Object.prototype.hasOwnProperty.call(glassAreaDefaults,area)) return;
    glassAreaPrefs[area]=!!input.checked; savePlayerGlassPrefs();
  }));
  applyPlayerGlass();

  // Custom Electron title bar controls. The title bar is draggable except for
  // its interactive controls, which are handled through isolated IPC methods.
  document.querySelectorAll('[data-window-control]').forEach(button => {
    button.addEventListener('click', async () => {
      const action=button.dataset.windowControl;
      try {
        if(action==='minimize') await window.beehive.window?.minimize();
        else if(action==='maximize') await window.beehive.window?.maximize();
        else if(action==='close') await window.beehive.window?.close();
      } catch(err) { console.warn('Window control failed:', err); }
    });
  });
  const titlebarRow=document.querySelector('.window-titlebar-row');
  const themedTopbar=document.getElementById('topbar');
  themedTopbar?.addEventListener('dblclick', async event => {
    if(!document.documentElement.classList.contains('theme-window-bar-enabled')) return;
    if(event.target.closest('button,input,select,a,.window-controls,.search-box')) return;
    try { await window.beehive.window?.maximize(); } catch {}
  });
  const updateWindowMaximizeButton = (maximized) => {
    const btn=document.querySelector('[data-window-control="maximize"]');
    if(btn) { btn.textContent=maximized?'❐':'□'; btn.title=maximized?'Restore':'Maximize'; btn.setAttribute('aria-label',btn.title); }
  };
  window.beehive.window?.onMaximizedChanged?.(updateWindowMaximizeButton);
  void window.beehive.window?.isMaximized?.().then?.(updateWindowMaximizeButton).catch?.(() => {});

  // ---------------- resizable bars + lock setting ----------------
  const PLAYBAR_NOW_PLAYING_BG_KEY = 'beehive:playbar-now-playing-bg';
  function loadPlaybarNowPlayingBg() {
    try { return localStorage.getItem(PLAYBAR_NOW_PLAYING_BG_KEY) === 'true'; } catch { return false; }
  }
  function setPlaybarNowPlayingBg(enabled) {
    document.querySelector('.playbar-left')?.classList.toggle('colored-bg', enabled);
    if (el.playbarNowPlayingBgToggle) el.playbarNowPlayingBgToggle.checked = enabled;
    try { localStorage.setItem(PLAYBAR_NOW_PLAYING_BG_KEY, String(enabled)); } catch {}
  }
  const initialPlaybarNowPlayingBg = loadPlaybarNowPlayingBg();
  setPlaybarNowPlayingBg(initialPlaybarNowPlayingBg);

  async function loadGpuAccelerationSetting() {
    try {
      const enabled = !!(await window.beehive.getGpuAcceleration());
      if (el.gpuAccelerationToggle) el.gpuAccelerationToggle.checked = enabled;
    } catch (err) {
      console.warn('Could not load GPU acceleration setting:', err);
      if (el.gpuAccelerationToggle) el.gpuAccelerationToggle.checked = true;
    }
  }
  loadGpuAccelerationSetting();
  el.gpuAccelerationToggle?.addEventListener('change', async () => {
    const enabled = !!el.gpuAccelerationToggle.checked;
    try {
      const saved = !!(await window.beehive.setGpuAcceleration(enabled));
      el.gpuAccelerationToggle.checked = saved;
      await themedAlert(`GPU acceleration ${saved ? 'enabled' : 'disabled'}. Please restart Beehive for this change to take effect.`, 'Graphics setting');
    } catch (err) {
      el.gpuAccelerationToggle.checked = !enabled;
      console.error('Could not change GPU acceleration setting:', err);
    }
  });

  let embedPlayCounts = false;
  async function loadEmbedPlayCountsSetting() {
    try {
      embedPlayCounts = !!(await window.beehive.getEmbedPlayCounts());
    } catch { embedPlayCounts = false; }
    if (el.embedPlayCountsToggle) el.embedPlayCountsToggle.checked = embedPlayCounts;
  }
  loadEmbedPlayCountsSetting();
  async function loadMusicBeeWrappedState() {
    try {
      const state = await window.beehive.getMusicBeeWrappedState();
      // Hive's own plays are always tracked into the same Wrapped store, so
      // exporting only needs *some* stored history -- not an explicit prior
      // MusicBee import.
      if (el.exportHiveWrappedBtn) el.exportHiveWrappedBtn.disabled = !state?.hasWrappedData;
      if (el.musicBeeWrappedImportStatus && state?.hasWrappedData) el.musicBeeWrappedImportStatus.textContent = `Local Wrapped history · ${Number(state.storedPlayCount || 0).toLocaleString()} sessions · ${state.years.join(', ')}`;
    } catch {}
  }
  loadMusicBeeWrappedState();
  el.embedPlayCountsToggle?.addEventListener('change', async () => {
    const next = !!el.embedPlayCountsToggle.checked;
    try {
      embedPlayCounts = !!(await window.beehive.setEmbedPlayCounts(next));
      el.embedPlayCountsToggle.checked = embedPlayCounts;
    } catch (err) {
      el.embedPlayCountsToggle.checked = embedPlayCounts;
      console.error('Could not change embedded play-count setting:', err);
    }
  });

  // Importing Wrapped data (either a genuine MusicBee export, or a Hive
  // export from another install -- both use the identical zip/XML format)
  // is one guided flow: explain what's expected, import it, then offer to
  // apply it as Hive's authoritative play counts. Applying overwrites BOTH
  // Hive's local counts and each file's embedded P_count with the imported
  // number exactly -- even lowering it -- and resets the embed baseline, so
  // a play right afterward adds +1 on top of that new number in both places
  // and in the Yearly Wrap history.
  el.importMusicBeeWrappedBtn?.addEventListener('click', async () => {
    const button = el.importMusicBeeWrappedBtn;
    const original = button.textContent;
    await themedAlert(
      'Hive supports MusicBee Wrapped data.\n\nLocate your data and zip the folder to import.',
      'Import Wrapped data'
    );
    button.disabled = true; button.textContent = 'Reading Wrapped archive…';
    if (el.musicBeeWrappedImportStatus) el.musicBeeWrappedImportStatus.textContent = 'Choose a Wrapped ZIP containing matching yearly XML files.';
    try {
      const archivePath = await window.beehive.chooseMusicBeeWrappedImport();
      if (!archivePath) {
        button.textContent = 'Import canceled';
        if (el.musicBeeWrappedImportStatus) el.musicBeeWrappedImportStatus.textContent = 'Import canceled.';
        setTimeout(() => { button.disabled = false; button.textContent = original; }, 2000);
        return;
      }
      const result = await window.beehive.importMusicBeeWrapped(archivePath);
      const years = Array.isArray(result?.years) ? result.years : [];
      const summary = years.map(y => `${y.year}: ${Number(y.added || 0).toLocaleString()} imported`).join(' · ');
      button.textContent = `Imported ${Number(result?.added || 0).toLocaleString()} plays`;
      if (el.exportHiveWrappedBtn) el.exportHiveWrappedBtn.disabled = false;
      if (el.musicBeeWrappedImportStatus) el.musicBeeWrappedImportStatus.textContent = summary || 'Wrapped archive imported.';

      const overwrite = await themedConfirm(
        "Would you like to overwrite all play counts with the imported data?\n\nThis replaces every play count in your library, not just the songs in this import: matched songs get the imported count, and every other song's play count -- and embedded P_count -- drops to zero. Listening afterward keeps adding to the new numbers.",
        'Overwrite ALL play counts?'
      );
      if (overwrite) {
        button.textContent = 'Applying play counts…';
        const replaceResult = await window.beehive.replaceMusicBeePlayCounts();
        // The replace call above already wrote the new counts to disk, but
        // library.tracks here is a separate in-memory copy nothing else
        // refreshes -- without this it keeps showing its old numbers.
        const updatedPlayCounts = replaceResult?.updatedPlayCounts;
        if (updatedPlayCounts && typeof updatedPlayCounts === 'object') {
          for (const track of library.tracks || []) {
            if (track?.path && Object.prototype.hasOwnProperty.call(updatedPlayCounts, track.path)) {
              track.playCount = Number(updatedPlayCounts[track.path] || 0);
            }
          }
        }
        // Scope the force-embed to only the songs actually in this import --
        // never the whole library -- by passing exactly the paths Replace
        // just matched and updated.
        const embedResult = await window.beehive.forceEmbedPlayCounts(Object.keys(updatedPlayCounts || {}));
        renderCurrentView();
        button.textContent = `Applied to ${Number(replaceResult?.matchedTracks || 0).toLocaleString()} tracks`;
        if (el.musicBeeWrappedImportStatus) el.musicBeeWrappedImportStatus.textContent = `Play counts overwritten · ${Number(replaceResult?.matchedTracks || 0).toLocaleString()} tracks matched · ${Number(embedResult?.embedded || 0).toLocaleString()} files embedded`;
        if (embedResult?.failed) console.warn('Some force-embed writes failed:', JSON.stringify(embedResult.errors));
        // Show a concrete sample failure inline instead of only a count, so
        // the cause is visible without digging through logs (the raw errors
        // array otherwise only reaches the log as flattened "[object Object]"
        // text once it crosses Electron's console-message boundary).
        const firstError = Array.isArray(embedResult?.errors) ? embedResult.errors[0] : null;
        showAppNotice(`Wrapped data imported and play counts overwritten.

Matched tracks: ${Number(replaceResult?.matchedTracks || 0).toLocaleString()}
Imported plays: ${Number(replaceResult?.importedPlays || 0).toLocaleString()}
Files embedded: ${Number(embedResult?.embedded || 0).toLocaleString()}${embedResult?.failed ? `
Failed: ${Number(embedResult.failed).toLocaleString()}${firstError ? `
  e.g. ${firstError.path}: ${firstError.error}` : ''}` : ''}`, 'Play counts updated');
      } else if (Number(result?.added || 0)) {
        showAppNotice(`Wrapped archive imported successfully.

${summary}

Open Yearly Wrap to browse the imported years.`, 'Yearly Wrap');
      }
    } catch (err) {
      button.textContent = 'Import failed';
      if (el.musicBeeWrappedImportStatus) el.musicBeeWrappedImportStatus.textContent = err?.message || 'Could not import Wrapped archive.';
      console.error('Could not import Wrapped archive:', err);
    }
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 3500);
  });
  el.exportHiveWrappedBtn?.addEventListener('click', async () => {
    const button = el.exportHiveWrappedBtn;
    const original = button.textContent;
    button.disabled = true; button.textContent = 'Exporting Wrapped archive…';
    try {
      const destination = await window.beehive.chooseHiveWrappedExport();
      if (!destination) { button.textContent = 'Export canceled'; return; }
      const result = await window.beehive.exportHiveWrapped(destination);
      button.textContent = 'Wrapped archive exported';
      if (el.musicBeeWrappedImportStatus) el.musicBeeWrappedImportStatus.textContent = `Hive Wrapped archive exported · ${(result?.years || []).join(', ')}`;
      showAppNotice('Your Hive Wrapped listening history was exported. It uses the same format as a MusicBee Wrapped import, so it can be brought back in through "Import Wrapped data" on any Hive install.', 'Yearly Wrap');
    } catch (err) {
      button.textContent = 'Export failed';
      if (el.musicBeeWrappedImportStatus) el.musicBeeWrappedImportStatus.textContent = err?.message || 'Could not export Hive Wrapped archive.';
      console.error('Could not export Hive Wrapped archive:', err);
    }
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 3000);
  });
  el.playbarNowPlayingBgToggle?.addEventListener('change', () => {
    setPlaybarNowPlayingBg(!!el.playbarNowPlayingBgToggle.checked);
  });

  applyLegacyArtScaling(loadLegacyArtScaling(), false);
  el.legacyArtScalingToggle?.addEventListener('change', () => {
    applyLegacyArtScaling(el.legacyArtScalingToggle.checked, true);
  });

  const LAYOUT_KEY = 'beehive:layout';
  const DEFAULT_LAYOUT = { topbar: 46, playbar: 68, sidebar: 220, 'queue-panel': 260, lockResize: false };

  function loadLayout() {
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
      return Object.assign({}, DEFAULT_LAYOUT, saved);
    } catch {
      return Object.assign({}, DEFAULT_LAYOUT);
    }
  }
  function saveLayout(layout) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {}
    try {
      const state = serializeUiState?.();
      if (state) { state.layout = { ...(state.layout || {}), ...layout }; window.beehive.saveUiState?.(state).catch?.(()=>{}); }
    } catch {}
  }

  let layout = loadLayout();
  let isLocked = !!layout.lockResize;

  // The library search is resized from the divider on its left edge, not from
  // a native bottom-right textarea-style handle. Keep this independent from
  // the main panel layout, but persist the user's preferred width.
  const SEARCH_WIDTH_KEY = 'beehive:library-search-width';
  const searchBox = document.querySelector('.search-box');
  const searchResizeDivider = document.getElementById('topbar-search-divider');
  const SEARCH_WIDTH_MIN = 220;
  const SEARCH_WIDTH_MAX = () => Math.min(620, Math.max(320, window.innerWidth * 0.48));
  let searchWidth = SEARCH_WIDTH_MIN;
  try {
    const savedSearchWidth = Number(localStorage.getItem(SEARCH_WIDTH_KEY));
    if (Number.isFinite(savedSearchWidth)) searchWidth = clamp(savedSearchWidth, SEARCH_WIDTH_MIN, SEARCH_WIDTH_MAX());
  } catch {}
  if (searchBox) {
    searchBox.style.width = searchWidth + 'px';
    searchBox.style.flex = '0 0 ' + searchWidth + 'px';
  }

  const panelEls = {
    topbar: document.getElementById('topbar'),
    playbar: document.getElementById('playbar'),
    sidebar: document.getElementById('sidebar'),
    'queue-panel': document.getElementById('queue-panel')
  };
  const sizeProp = { topbar: 'height', playbar: 'height', sidebar: 'width', 'queue-panel': 'width' };
  const limits = {
    topbar: [32, () => Math.max(120, window.innerHeight - 140)],
    // Keep the playbar 15px taller than the previous 56px minimum so the 44px
    // cover art, play/pause controls, and other playback controls remain safely
    // inside the bar instead of touching/overlapping its border when resized.
    playbar: [71, () => Math.max(100, window.innerHeight - 120)],
    sidebar: [120, () => Math.max(260, window.innerWidth - 320)],
    'queue-panel': [120, () => Math.max(280, window.innerWidth - 260)]
  };

  function applySavedSizes() {
    for (const key of Object.keys(panelEls)) {
      const target = panelEls[key];
      if (target && layout[key]) {
        const min = limits[key]?.[0] || 0;
        const savedSize = Math.max(min, Number(layout[key]) || min);
        layout[key] = savedSize;
        target.style[sizeProp[key]] = savedSize + 'px';
      }
    }
  }

  function updateLockUI() {
    document.querySelectorAll('.resize-handle').forEach((h) => h.classList.toggle('locked', isLocked));
    searchResizeDivider?.classList.toggle('locked', isLocked);
    el.lockResizeToggle.checked = isLocked;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function makeResizable(handle) {
    const key = handle.dataset.target;
    const targetEl = panelEls[key];
    const axis = handle.classList.contains('resize-v') ? 'x' : 'y';
    const invert = handle.dataset.invert === 'true';
    const [min, maxValue] = limits[key];
    const max = () => typeof maxValue === 'function' ? maxValue() : maxValue;
    let startPos = 0, startSize = 0, dragging = false;

    function onMove(e) {
      const pos = axis === 'x' ? e.clientX : e.clientY;
      let delta = pos - startPos;
      if (invert) delta = -delta;
      const newSize = clamp(startSize + delta, min, max());
      targetEl.style[sizeProp[key]] = newSize + 'px';
    }
    function onUp() {
      dragging = false;
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      layout[key] = parseFloat(targetEl.style[sizeProp[key]]) || startSize;
      saveLayout(layout);
    }
    handle.addEventListener('mousedown', (e) => {
      if (isLocked) return;
      e.preventDefault();
      dragging = true;
      handle.classList.add('dragging');
      startPos = axis === 'x' ? e.clientX : e.clientY;
      startSize = targetEl.getBoundingClientRect()[axis === 'x' ? 'width' : 'height'];
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  Array.from(document.querySelectorAll('.resize-handle[data-target]')).forEach(makeResizable);

  // Dragging the divider immediately to the left of Search library changes
  // the search width. The right edge stays anchored, so dragging left makes
  // the field longer and dragging right makes it shorter.
  if (searchResizeDivider && searchBox) {
    let draggingSearch = false;
    let searchStartX = 0;
    let searchStartWidth = searchWidth;

    const onSearchResizeMove = (e) => {
      if (!draggingSearch) return;
      const next = clamp(searchStartWidth + (searchStartX - e.clientX), SEARCH_WIDTH_MIN, SEARCH_WIDTH_MAX());
      searchWidth = next;
      searchBox.style.width = next + 'px';
      searchBox.style.flexBasis = next + 'px';
    };
    const onSearchResizeUp = () => {
      if (!draggingSearch) return;
      draggingSearch = false;
      searchResizeDivider.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onSearchResizeMove);
      document.removeEventListener('mouseup', onSearchResizeUp);
      try { localStorage.setItem(SEARCH_WIDTH_KEY, String(Math.round(searchWidth))); } catch {}
    };

    searchResizeDivider.addEventListener('mousedown', (e) => {
      if (isLocked || e.button !== 0) return;
      e.preventDefault();
      draggingSearch = true;
      searchStartX = e.clientX;
      searchStartWidth = searchBox.getBoundingClientRect().width;
      searchResizeDivider.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onSearchResizeMove);
      document.addEventListener('mouseup', onSearchResizeUp);
    });
  }

  // The lyrics rail is independently draggable. The navigation/folder area
  // above it stays scrollable so a long playlist/folder list never pushes
  // the lyrics off-screen. Persist the lyrics height between launches.
  const sidebarUpper = document.getElementById('sidebar-upper');
  const lyricsResize = document.getElementById('lyrics-resize');
  const lyricsSection = el.lyricsSection;
  const LYRICS_HEIGHT_KEY = 'beehive:lyrics-height';
  const savedLyricsHeight = Number(localStorage.getItem(LYRICS_HEIGHT_KEY));
  if (Number.isFinite(savedLyricsHeight) && savedLyricsHeight > 80) {
    lyricsSection.style.flex = '0 0 ' + savedLyricsHeight + 'px';
  }
  if (lyricsResize && sidebarUpper && lyricsSection) {
    let draggingLyrics = false;
    let startY = 0;
    let startHeight = 0;
    const onLyricsMove = (e) => {
      if (!draggingLyrics) return;
      const delta = startY - e.clientY;
      const sidebarHeight = document.getElementById('sidebar')?.getBoundingClientRect().height || window.innerHeight;
      const min = 105;
      const max = Math.max(min + 20, sidebarHeight - 120);
      const next = Math.max(min, Math.min(max, startHeight + delta));
      lyricsSection.style.flex = '0 0 ' + next + 'px';
    };
    const onLyricsUp = () => {
      if (!draggingLyrics) return;
      draggingLyrics = false;
      lyricsResize.classList.remove('dragging');
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onLyricsMove);
      document.removeEventListener('mouseup', onLyricsUp);
      const h = lyricsSection.getBoundingClientRect().height;
      localStorage.setItem(LYRICS_HEIGHT_KEY, String(Math.round(h)));
    };
    lyricsResize.addEventListener('mousedown', (e) => {
      if (isLocked) return;
      e.preventDefault();
      draggingLyrics = true;
      startY = e.clientY;
      startHeight = lyricsSection.getBoundingClientRect().height;
      lyricsResize.classList.add('dragging');
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', onLyricsMove);
      document.addEventListener('mouseup', onLyricsUp);
    });
  }

  el.lockResizeToggle.addEventListener('change', () => {
    isLocked = el.lockResizeToggle.checked;
    layout.lockResize = isLocked;
    saveLayout(layout);
    updateLockUI();
  });

  el.resetLayoutBtn.addEventListener('click', () => {
    const keepLock = layout.lockResize;
    layout = Object.assign({}, DEFAULT_LAYOUT, { lockResize: keepLock });
    saveLayout(layout);
    applySavedSizes();
 
  });

  // Clearing play counts is deliberately separate from file/tag metadata.
  // The confirmation makes the destructive scope explicit, and the IPC call
  // only resets Beehive's local play-stats values.
  el.clearPlayCountsBtn?.addEventListener('click', () => {
    openModal(el.clearPlayCountsModal);
  });
  el.clearPlayCountsCancel?.addEventListener('click', () => closeModal(el.clearPlayCountsModal));
  el.clearPlayCountsConfirm?.addEventListener('click', async () => {
    const button = el.clearPlayCountsConfirm;
    if (button.disabled) return;
    button.disabled = true;
    try {
      await window.beehive.clearPlayCounts();
      for (const track of library.tracks || []) track.playCount = 0;
      renderCurrentView();
      closeModal(el.clearPlayCountsModal);
    } catch (err) {
      console.error('Could not clear Beehive play counts:', err);
      await themedAlert(`Could not clear Beehive play counts: ${err?.message || err}`, 'Clear play counts');
    } finally {
      button.disabled = false;
    }
  });

  applySavedSizes();
  updateLockUI();

  let autoScanQueued = false;
  let autoScanPendingPaths = new Set();
  window.beehive.onLibraryFilesChanged?.((payload = {}) => {
    for (const p of (Array.isArray(payload.paths) ? payload.paths : [])) if (p) autoScanPendingPaths.add(String(p));
    const paths = [...autoScanPendingPaths];
    autoScanPendingPaths.clear();
    if (scanRunning) { for (const p of paths) autoScanPendingPaths.add(p); autoScanQueued = true; return; }
    runScan(false, paths).finally(() => {
      if (autoScanQueued) {
        autoScanQueued = false;
        const queued = [...autoScanPendingPaths];
        autoScanPendingPaths.clear();
        runScan(false, queued);
      }
    });
  });

  // The Hive logo is a shared brand asset, not an emoji or renderer-generated shape.
  // Reuse the existing privileged artwork bridge so the same transparent logo is
  // used by the top-left brand button and About dialog.
  void window.beehive.getYearlyWrapBrandIcon?.().then((dataUrl) => {
    if (!dataUrl) return;
    hiveLogoSourceDataUrl = dataUrl;
    hiveLogoImage = new Image();
    hiveLogoImage.onload = () => {
      document.querySelectorAll('.brand-logo, .about-brand-logo').forEach(elm => { elm.src = hiveLogoSourceDataUrl; });
    };
    hiveLogoImage.src = dataUrl;
  }).catch(() => {});

  startupMark('RENDERER BOOTSTRAP COMPLETE');
  initialLoad();
  document.addEventListener('keydown', handleSelectionKeyboard, true);
  window.addEventListener('keydown', handleTrackTypeaheadKeydown);


})();
