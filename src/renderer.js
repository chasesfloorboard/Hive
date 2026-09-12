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

  const startupDebugEnabled = !!window.beehive.startupDebugEnabled;
  const startupStatus = document.getElementById('startup-status');
  const startupStatusText = document.getElementById('startup-status-text');
  const startupPerfStart = performance.now();
  function startupMark(label, details = null) {
    if (!startupDebugEnabled) return;
    try { window.beehive.startupDebugLog(label, details); } catch {}
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
    setTimeout(() => clearInterval(loopTimer), 20000);
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
  let engineVolume = 1;
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
  let gstPosition = 0;
  let gstPositionUpdatedAt = 0;
  let gstDuration = 0;
  let gstTrackIndex = -1;
  let gstWaitingNextStream = false;
  let gstExpectInitialStream = false;
  let gstResumeAfterSeek = false;
  let gstLoadGeneration = 0;
  function gstCompatibleTrack(t) {
    if (!t?.path) return false;
    return Math.max(0, parseTimeValue(t.startTime)) === 0 && Math.max(0, parseTimeValue(t.endTime)) === 0;
  }
  function gstCompatibleQueue() {
    if (!gstCompatibleTrack(currentQueue[currentIndex])) return false;
    const ni = getNextPlaybackIndex();
    return ni < 0 || gstCompatibleTrack(currentQueue[ni]);
  }
  function gstB64(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function gstSend(command) { try { window.beehive.gstreamerCommand(command); return true; } catch { return false; } }
  function gstSendNext() {
    const ni = getNextPlaybackIndex();
    if (ni < 0 || ni === currentIndex) return;
    const next = currentQueue[ni];
    if (gstCompatibleTrack(next)) gstSend(`NEXT\t${gstB64(next.path)}`);
  }
  function gstStop() {
    if (!gstActive) return;
    gstLoadGeneration++;
    gstSend('STOP');
    gstActive = false;
    gstTrackIndex = -1;
    gstWaitingNextStream = false;
    gstExpectInitialStream = false;
  }
  async function gstLoadCurrent(offset = 0) {
    const t = currentQueue[currentIndex];
    if (!t?.path || !gstAvailable || !gstCompatibleQueue()) return false;
    const generation = ++gstLoadGeneration;
    gstActive = true;
    gstTrackIndex = currentIndex;
    gstDuration = Math.max(0, Number(t.duration) || 0);
    gstPosition = Math.max(0, Math.min(gstDuration || Number.MAX_SAFE_INTEGER, Number(offset) || 0));
    gstPositionUpdatedAt = performance.now();
    gstWaitingNextStream = false;
    gstExpectInitialStream = true;
    enginePaused = false;
    engineEnded = false;
    engineSrc = window.beehive.fileUrl(t.path);
    // The native GStreamer helper is a separate process and keeps its own
    // volume state.  Re-apply Beehive's persisted user volume before every
    // native load so a fresh helper (whose default is 100%) can never blast
    // audio when the user presses Play.
    gstSend('VOLUME\t' + String(Math.max(0, Math.min(1, Number(engineVolume) || 0))));
    gstSend(`LOAD\t${gstB64(t.path)}\t${gstPosition}`);
    gstSendNext();
    // LOAD is queued in the helper's command loop. Give it one turn to enter
    // PAUSED/preroll before PLAY, rather than racing two state changes.
    await new Promise(resolve => setTimeout(resolve, 25));
    if (generation !== gstLoadGeneration || !gstActive) return false;
    // Begin every fresh native track at silence; GStreamer PLAY performs the
    // protected 10 ms transport ramp up to the user's actual volume.
    gstSend('RAMPSTART');
    gstSend('MUTE\t' + (engineMuted ? '1' : '0'));
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
    recordTrackPlayed(t);
    renderQueue();
    return true;
  }

  Object.defineProperties(audioEngine, {
    currentTime: {
      get() {
        // Startup restoration intentionally keeps activeBuffer null. The logical
        // offset is still the real transport position and must be exposed to the
        // UI while paused; otherwise the restored scrubber falls back to 0:00.
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
    duration: { get() { return gstActive ? (gstDuration || 0) : (activeDuration || 0); }},
    paused: { get() { return enginePaused; }},
    ended: { get() { return engineEnded; }},
    muted: { get() { return engineMuted; }, set(v) { engineMuted = !!v; if (gstActive) gstSend('MUTE\t' + (engineMuted ? '1' : '0')); if (masterGain) masterGain.gain.value = engineMuted ? 0 : engineVolume; }},
    volume: { get() { return engineVolume; }, set(v) { engineVolume = Math.max(0, Math.min(1, Number(v) || 0)); if (gstActive) gstSend('VOLUME\t' + String(engineVolume)); if (masterGain && !engineMuted) masterGain.gain.value = engineVolume; }},
    src: { get() { return engineSrc; }, set(v) { engineSrc = String(v || ''); }},
    readyState: { get() { return gstActive || activeBuffer ? 4 : 0; }}
  });
  audioEngine.load = () => {};
  audioEngine.removeAttribute = (name) => { if (name === 'src') engineSrc = ''; };
  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = engineMuted ? 0 : engineVolume;
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
  function dispatchAudio(name) { try { audioEngine.dispatchEvent(new Event(name)); } catch {} }
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
    if (!next?.path) return;
    try { await decodeTrack(next); } catch {}
  }
  function getNextPlaybackIndex() {
    if (!currentQueue.length) return -1;
    if (repeat === 2) return currentIndex;
    const n = currentIndex + 1;
    if (n < currentQueue.length) return n;
    return repeat === 1 ? 0 : -1;
  }
  async function armGaplessNext(generation) {
    if (generation !== engineGeneration || !activeBuffer || !audioCtx || enginePaused) return;
    const nextIndex = getNextPlaybackIndex();
    if (nextIndex < 0 || nextIndex === currentIndex) return;
    const next = currentQueue[nextIndex];
    if (!next?.path) return;
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
          updateNowPlayingUI(next);
          renderQueue();
          saveQueueSession();
          recordTrackPlayed(next);
          // Immediately arm the successor.
          armGaplessNext(generation);
        }
      }, delay);
    } catch {}
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

    // Persist the durable stat in the main process. The returned value is
    // authoritative if another serialized stats mutation completed first.
    const keepInlineAlbumOpen = !!document.querySelector('.inline-album-dropdown');
    window.beehive.recordPlay(t.path, {title:t.title, artist:t.artist, album:t.album, cover:t.cover}).then(entry=>{
      const count = Number(entry.playCount || t.playCount || 0);
      const when = Number(entry.lastPlayedAt || t.lastPlayedAt || Date.now());
      t.playCount = count;
      t.lastPlayedAt = when;
      if (canonical && canonical !== t) {
        canonical.playCount = count;
        canonical.lastPlayedAt = when;
      }
      // Do not tear down and rebuild the shared Albums viewer merely because a
      // play count finished persisting. An open inline album is interactive UI
      // state and must remain physically open while its track starts playing.
      if (!keepInlineAlbumOpen && typeof renderCurrentView === 'function') renderCurrentView();
    }).catch(()=>{});

    // Refresh the visible view immediately as well. This is especially
    // important for the Songs table, where the Plays column is otherwise only
    // refreshed when another library render happens. If an inline album is open,
    // update its playing marker in place instead of rebuilding the album viewer.
    if (!keepInlineAlbumOpen && typeof renderCurrentView === 'function') renderCurrentView();
  }
  audioEngine.play = async (userInitiated = false) => {
    if (startupPlaybackLocked && !userInitiated) return;
    if (userInitiated) startupPlaybackLocked = false;
    if (gstActive) {
      engineEnded = false;
      gstSend('PLAY');
      // GStreamer state notifications are authoritative for the transport UI.
      // Do not synthesize a PLAY event here; the native PAUSED/PLAYING messages
      // will update enginePaused and the button in the correct order.
      return;
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
    await loadAndPlayCurrent();
  };
  audioEngine.pause = () => {
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
    if (gstActive) {
      const target = Math.max(0, Math.min(gstDuration || Number.MAX_SAFE_INTEGER, Number(seconds) || 0));
      gstPosition = target;
      gstPositionUpdatedAt = performance.now();
      gstSend((resumeAfterSeek ? 'SEEKPLAY\t' : 'SEEK\t') + String(target));
      if (resumeAfterSeek) gstResumeAfterSeek = true;
      dispatchAudio('timeupdate');
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
    if (name === 'POSITION') {
      const p = Number(ev.value);
      if (gstActive && Number.isFinite(p)) { gstPosition = Math.max(0, Math.min(gstDuration || p, p)); gstPositionUpdatedAt = performance.now(); dispatchAudio('timeupdate'); }
      return;
    }
    if (name === 'ABOUT_TO_FINISH') { gstWaitingNextStream = true; return; }
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
          gstDuration = Math.max(0, Number(next.duration) || 0);
          gstPosition = 0;
          gstPositionUpdatedAt = performance.now();
          gstWaitingNextStream = false;
          enginePaused = false; engineEnded = false;
          engineSrc = window.beehive.fileUrl(next.path);
          updateNowPlayingUI(next);
          renderQueue();
          saveQueueSession();
          recordTrackPlayed(next);
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
      // A flush seek can briefly report PAUSED even when the user was playing.
      // When SEEKPLAY was requested, keep the transport logically playing until
      // the authoritative PLAYING event arrives. This prevents releasing the
      // scrubber from leaving the UI/audio engine stuck in pause.
      if (gstResumeAfterSeek) return;
      enginePaused = true; syncDiscordPresence(currentQueue[currentIndex], true, true); syncMpris(currentQueue[currentIndex], true); dispatchAudio('pause'); return;
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
      syncDiscordPresence(currentQueue[currentIndex], false, true);
      syncMpris(currentQueue[currentIndex], false);
      const playingTrack = currentQueue[currentIndex];
      if (playingTrack && !embeddedCoverExists(playingTrack)) {
        // Background-only enrichment: never block playback and never embed the
        // result. It exists solely as temporary visual artwork for this session.
        ensureAutomaticCoverVisual(playingTrack);
      }
      return;
    }
    if (name === 'EOS' && gstActive) {
      enginePaused = true; engineEnded = true; gstPosition = gstDuration; syncDiscordPresence(currentQueue[currentIndex], true, true); syncMpris(currentQueue[currentIndex], true); dispatchAudio('timeupdate'); dispatchAudio('ended');
      if (!gstWaitingNextStream) { gstActive = false; goNext(); }
      return;
    }
    if (name === 'ERROR' && gstActive) {
      console.warn('Beehive GStreamer backend:', ev.value || 'error');
      gstActive = false; gstAvailable = false; gstAvailabilityKnown = true;
      loadAndPlayCurrent();
    }
  });

  const audio = audioEngine;

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
    artistSortTools: document.getElementById('artist-sort-tools'),
    artistSortBtn: document.getElementById('artist-sort-btn'),
    albumSortBtn: document.getElementById('album-sort-btn'),
    tagModal: document.getElementById('tag-modal'),
    playlistModal: document.getElementById('playlist-modal'),
    playlistName: document.getElementById('playlist-name'),
    playlistDisplayView: document.getElementById('playlist-display-view'),
    playlistModalTitle: document.getElementById('playlist-modal-title'),
    playlistSave: document.getElementById('playlist-save'),
    playlistCancel: document.getElementById('playlist-cancel'),
    playlistInfoModal: document.getElementById('playlist-info-modal'),
    playlistInfoTitle: document.getElementById('playlist-info-title'),
    playlistInfoBody: document.getElementById('playlist-info-body'),
    playlistInfoName: document.getElementById('playlist-info-name'),
    playlistInfoDisplayView: document.getElementById('playlist-info-display-view'),
    playlistInfoSave: document.getElementById('playlist-info-save'),
    playlistInfoSaveStatus: document.getElementById('playlist-info-save-status'),
    noticeModal: document.getElementById('notice-modal'),
    noticeTitle: document.getElementById('notice-title'),
    noticeBody: document.getElementById('notice-body'),
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
    clearLibraryCacheNextLaunchToggle: document.getElementById('setting-clear-library-cache-next-launch'),
    gpuAccelerationToggle: document.getElementById('setting-gpu-acceleration'),
    embedPlayCountsToggle: document.getElementById('setting-embed-play-counts'),
    embedPlayCountsNowBtn: document.getElementById('embed-play-counts-now-btn'),
    importEmbeddedPlayCountsBtn: document.getElementById('import-embedded-play-counts-btn'),
    settingsDiscordClientId: document.getElementById('settings-discord-client-id'),
    settingsDiscordImageKey: document.getElementById('settings-discord-image-key'),
    settingsDiscordImageText: document.getElementById('settings-discord-image-text'),
    settingsDiscordEnabled: document.getElementById('settings-discord-enabled'),
    settingsDiscordArtist: document.getElementById('settings-discord-artist'),
    settingsDiscordProgress: document.getElementById('settings-discord-progress'),
    settingsDiscordSave: document.getElementById('settings-discord-save'),
    settingsDiscordTest: document.getElementById('settings-discord-test'),
    settingsDiscordClear: document.getElementById('settings-discord-clear'),
    settingsDiscordStatus: document.getElementById('settings-discord-status'),

    // about modal
    aboutModal: document.getElementById('about-modal'),
    aboutVersion: document.getElementById('about-version'),

    pbVolIcon: document.getElementById('pb-vol-icon'),

    // cover art lightbox
    coverLightbox: document.getElementById('cover-lightbox'),
    lightboxImg: document.getElementById('lightbox-img'),
    lightboxCaption: document.getElementById('lightbox-caption'),
    lightboxDots: document.getElementById('lightbox-dots'),
    lightboxPrev: document.getElementById('lightbox-prev'),
    lightboxNext: document.getElementById('lightbox-next')
  };

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
  const SONG_COLUMN_DEFS = [
    { key:'title', label:'Title', defaultWidth:240, minWidth:140, get:t=>String(t?.title || '') },
    { key:'artist', label:'Artist', defaultWidth:170, minWidth:110, get:t=>String(t?.artist || '') },
    { key:'album', label:'Album', defaultWidth:190, minWidth:120, get:t=>String(t?.album || '') },
    { key:'albumArtist', label:'Album Artist', defaultWidth:170, minWidth:110, get:t=>String(t?.albumArtist || '') },
    { key:'genre', label:'Genre', defaultWidth:140, minWidth:90, get:t=>String(t?.genre || '') },
    { key:'year', label:'Year', defaultWidth:70, minWidth:55, get:t=>String(t?.year || '') },
    { key:'track', label:'Track #', defaultWidth:75, minWidth:55, get:t=>formatTrackNumber(t) },
    { key:'disc', label:'Disc #', defaultWidth:70, minWidth:55, get:t=>formatDiscNumber(t) },
    { key:'composer', label:'Composer', defaultWidth:150, minWidth:100, get:t=>String(t?.composer || '') },
    { key:'publisher', label:'Publisher', defaultWidth:150, minWidth:100, get:t=>String(t?.publisher || '') },
    { key:'comment', label:'Comment', defaultWidth:180, minWidth:100, get:t=>String(t?.comment || '') },
    { key:'plays', label:'Plays', defaultWidth:70, minWidth:55, get:t=>String(Number(t?.playCount || 0)) },
    { key:'rating', label:'Rating', defaultWidth:112, minWidth:80, get:t=>Number(t?.ratingRaw) === 255 ? '5' : String(Number(t?.rating || 0)) },
    { key:'length', label:'Length', defaultWidth:75, minWidth:60, get:t=>fmtTime(t?.duration) },
    { key:'bitrate', label:'Bitrate', defaultWidth:85, minWidth:65, get:t=>formatBitrate(t) },
    { key:'sampleRate', label:'Sample Rate', defaultWidth:100, minWidth:75, get:t=>formatSampleRate(t) },
    { key:'dateAdded', label:'Date Added', defaultWidth:115, minWidth:90, get:t=>formatDateAdded(t) },
    { key:'filename', label:'Filename', defaultWidth:180, minWidth:110, get:t=>String(t?.path || '').split(/[\\/]/).pop() || '' },
    { key:'folder', label:'Folder', defaultWidth:220, minWidth:120, get:t=>formatFolder(t) },
  ];
  let songColumns = loadSongColumns();
  let songVirtualState = { tracks: [], rowHeight: 46, headerHeight: 32, lastStart: -1, lastEnd: -1, raf: 0 };
  // The playback queue can contain the entire library. Keep only the visible
  // rows in the DOM so starting a song from Tracks never blocks the audio player.
  let queueVirtualState = { rowHeight: 42, lastStart: -1, lastEnd: -1, raf: 0 };
  let playlistVirtualState = { rowHeight: 66, lastStart: -1, lastEnd: -1, raf: 0, viewport: null, window: null, spacer: null };

  let repeat = 0; // 0 = play through and stop, 1 = repeat queue, 2 = repeat single
  let viewMode = 'albums';
  let searchTerm = '';
  let artistSearchSort = 'release';
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
  const lyricsLookupCache = new Map();
  let renderedLyricsTrackPath = '';
  let syncedLyricsEntries = [];
  let activeSyncedLyricIndex = -1;
  let followHighlightedLyric = true;
  let lyricsProgrammaticScroll = false;
  let lyricsProgrammaticScrollTimer = 0;

  function parseSyncedLyrics(raw) {
    const source = String(raw || '').replace(/\r\n?/g, '\n').trim();
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
    const text = String(raw || '').trim();
    syncedLyricsEntries = parseSyncedLyrics(text);
    activeSyncedLyricIndex = -1;
    followHighlightedLyric = true;
    renderedLyricsTrackPath = String(track?.path || '');
    const container = el.lyricsText;
    if (!container) return;
    if (!syncedLyricsEntries.length) {
      container.classList.remove('lyrics-synced');
      container.textContent = text;
      return;
    }
    container.classList.add('lyrics-synced');
    container.innerHTML = syncedLyricsEntries.map((entry, i) =>
      `<div class=\"lyrics-line\" data-lyric-index=\"${i}\">${escapeHtml(entry.text).replace(/\n/g, '<br>')}</div>`
    ).join('');
    updateSyncedLyrics(Number(audio.currentTime) || 0, true);
  }

  function scrollHighlightedLyricIntoView(behavior = 'smooth') {
    if (!syncedLyricsEntries.length || !el.lyricsRail || !el.lyricsText || activeSyncedLyricIndex < 0) return;
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

  function updateSyncedLyrics(position, force = false) {
    if (!syncedLyricsEntries.length || !el.lyricsText) return;
    const time = Math.max(0, Number(position) || 0);
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
    return `${(t.albumArtist || t.artist || '').toLowerCase()}||${(t.album || '').toLowerCase()}`;
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
      if (!map.has(key)) {
        map.set(key, { key, title: t.album, artist: t.albumArtist || t.artist, year: t.year, cover: t.cover, covers: t.covers, tracks: [] });
      }
      const a = map.get(key);
      a.tracks.push(t);
      if (!a.cover && t.cover) { a.cover = t.cover; a.covers = t.covers; }
      if (!a.year && t.year) a.year = t.year;
    }
    const list = Array.from(map.values());
    for (const a of list) {
      a.tracks.sort((x, y) => (x.disk || 0) - (y.disk || 0) || (x.track || 0) - (y.track || 0) || x.title.localeCompare(y.title));
    }
    list.sort((a, b) => (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title));
    return list;
  }

  function coverSrc(coverFile) {
    // Optimistic artwork edits use the freshly downloaded/selected image as a
    // data URL while the background metadata worker embeds it into every file.
    // Keep that preview visible immediately instead of routing the data URL
    // through mbcover:// (which only serves scanner-generated cached covers).
    if (typeof coverFile === 'string' && /^(?:https?:\/\/|data:image\/|blob:)/i.test(coverFile)) return coverFile;
    return window.beehive.coverUrl(coverFile) || placeholderCover();
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
  async function reconcileArtworkAfterBackgroundWrite(paths, options = {}) {
    const wanted = [...new Set((Array.isArray(paths) ? paths : [paths]).map(p => String(p || '')).filter(Boolean))];
    if (!wanted.length) return;
    const lib = await window.beehive.scanChangedLibrary(wanted);
    const byPath = new Map((lib?.tracks || []).map(t => [String(t?.path || ''), t]));

    // Keep the queue's long-lived playback objects synchronized with the fresh
    // library snapshot. The queue intentionally survives library replacement,
    // so merely calling applyLibrary() is not enough for artwork/tag edits.
    for (const queueTrack of currentQueue) {
      const path = String(queueTrack?.path || '');
      if (!wanted.includes(path)) continue;
      const fresh = byPath.get(path);
      if (!fresh) continue;
      Object.assign(queueTrack, fresh);
      const embedded = distinctCovers(queueTrack);
      if (embedded.length) clearAutomaticCoverVisual(queueTrack);
      else if (options.searchMissing !== false) {
        // This is deliberately fire-and-forget. A missing embedded cover should
        // trigger the normal automatic visual search, but it must never block the
        // metadata operation or make the player wait for the network.
        void ensureAutomaticCoverVisual(queueTrack);
      }
    }

    applyLibrary(lib, { deferView: true });
    // Artwork saves already update the visible library optimistically. Do not
    // synchronously rebuild a potentially very large song/album view here; doing
    // that at the end of a multi-file metadata batch can starve the playback/UI
    // process right when the disk work has just completed. Coalesce one paint for
    // the next animation frame instead.
    if (!window.__beehiveArtworkRenderQueued) {
      window.__beehiveArtworkRenderQueued = true;
      requestAnimationFrame(() => {
        window.__beehiveArtworkRenderQueued = false;
        try { renderCurrentView(); } catch (err) { console.error('[Beehive Artwork] deferred reconcile render failed:', err); }
      });
    }
    refreshCoverRotationTargets();

    const current = currentQueue[currentIndex];
    if (current && wanted.includes(String(current.path || ''))) {
      await syncCurrentTrackArtwork(current.path);
      if (!embeddedCoverExists(current) && options.searchMissing !== false) {
        void ensureAutomaticCoverVisual(current);
      }
    }

    // If another queued track from the same album was changed, refresh the
    // visible album/queue artwork without spawning one metadata process per row.
    if (options.warmAlbum !== false) void warmQueueAutomaticArtwork();
    return lib;
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
    if (!album) return;
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
    if (coverFile && out.length > 1) {
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

  async function refreshFolders() {
    const config = await window.beehive.getConfig();
    el.folderList.innerHTML = '';
    for (const folder of config.folders || []) {
      const div = document.createElement('div'); div.className='sidebar-item'; div.dataset.folder=folder;
      div.textContent='📁 '+(folder.split(/[\\/]/).filter(Boolean).pop()||folder);
      div.addEventListener('mouseenter', e => showSidebarFolderTooltip(div, folder, e));
      div.addEventListener('mouseleave', hideSidebarFolderTooltip);
      div.addEventListener('mousemove', e => moveSidebarFolderTooltip(e));
      div.addEventListener('click', () => {
        rememberMusicBrowserState();
        activeFolderPath = folder;
        specialView = 'folder';
        artistSearchTerm = '';
        searchTerm = '';
        el.search.value = '';
        el.main.classList.remove('searching');
        openAlbumKey = null;
        el.sidebarItems.forEach(i => i.classList.remove('active'));
        el.folderList.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        div.classList.add('active');
        viewMode = 'songs';
        el.viewBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === 'songs'));
        showLibraryView(folder.split(/[\\/]/).filter(Boolean).pop() || folder, tracksForFolder(folder), 'folder');
        saveActiveTabState();
        updateActiveTabLabel();
      });
      div.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e.clientX,e.clientY,[
        {label:'Rescan this library',action:()=>runScan()},
        {label:'Remove library folder',danger:true,action:async()=>{await window.beehive.removeFolder(folder);if(activeFolderPath===folder){activeFolderPath='';specialView=null;}await refreshFolders();await runScan();}}
      ]); });
      el.folderList.appendChild(div);
    }
  }

  function hideContentViews(){ [el.emptyState,el.tabPlaceholder,el.albumsToolbar,el.albumsGrid,el.songsTable,el.artistsGrid,el.contentTools].forEach(x=>x.classList.add('hidden')); }
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

  async function setTrackRating(t, rating, shouldRender = true) {
    if (!t?.path) return;
    const value = await window.beehive.setRating(t.path, rating);
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
  }

  function syncLoveStateForPath(trackPath, loved) {
    const normalizedPath = String(trackPath || '');
    if (!normalizedPath) return;
    const value = !!loved;
    const update = track => {
      if (track && String(track.path || '') === normalizedPath) track.loved = value;
    };
    for (const track of (library.tracks || [])) update(track);
    for (const track of (currentQueue || [])) update(track);
    for (const track of (activeSelectionTracks || [])) update(track);
    // Keep derived in-memory album/artist models synchronized with the verified
    // file write so an already-rendered Favorites or expanded album model cannot
    // retain the old Love state.
    for (const album of (albums || [])) {
      for (const track of (album?.tracks || [])) update(track);
    }
    for (const entry of (artistPickerEntries || [])) {
      for (const track of (entry?.tracks || [])) update(track);
    }
    update(window.__beehiveNowPlayingTrack);
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
    if (value && !library.tracks.some(track => String(track?.path || '') === String(t.path))) {
      library.tracks.push(t);
      libraryTrackByPath.set(String(t.path), t);
    }
    if (specialView === 'favorites' || (shouldRender && specialView === 'favorites')) renderCurrentView();

    // The metadata worker is serialized per file and runs outside the current
    // render interaction. Favorites does not wait for this promise. If the
    // write fails, roll the optimistic state back and refresh the visible view.
    queueLoveFileWrite(t.path, value).catch(err => {
      syncLoveStateForPath(t.path, oldValue);
      if (specialView === 'favorites' && shouldRender) renderCurrentView();
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
    const result = await window.beehive.setRatings(list, rating);
    const value = Math.max(0, Math.min(5, Number(rating) || 0));
    const successful = new Set(list);
    for (const err of (result?.errors || [])) successful.delete(String(err?.path || ''));
    for (const track of library.tracks) {
      if (!successful.has(String(track?.path || ''))) continue;
      track.rating = value;
      track.ratingRaw = value >= 5 ? 255 : 0;
      track.ratingHydrated = true;
    }
    renderCurrentView();
    if (result?.failed) console.warn('Some bulk rating writes failed:', result.errors);
    return result;
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
    if (specialView === 'favorites') { const t=library.tracks.filter(t=>t.loved); return viewMode==='albums'?renderSpecialAlbums(t):renderSpecialSongs(t); }
    if (specialView === 'folder' && activeFolderPath) {
      const t = tracksForFolder(activeFolderPath);
      return viewMode === 'albums' ? renderSpecialAlbums(t) : renderSpecialSongs(t);
    }
    if (specialView === 'playlist' && activePlaylistId) {
      const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
      if (pl) {
        const tracks = tracksForPlaylist(pl);
        if (viewMode === 'albums') return renderSpecialAlbums(tracks);
        if (viewMode === 'artists') return renderArtists(tracks);
        return renderSpecialSongs(tracks);
      }
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
        return { path:x.path, title:x.title || x.path?.split(/[\\/]/).pop() || 'Unknown track', artist:x.artist || 'Unknown Artist', album:x.album || 'Unknown Album', cover:x.cover || null, rating:0, playCount:0, duration:0, historyPlayedAt:Number(x.playedAt || 0) };
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
      const widths = {};
      for (const def of SONG_COLUMN_DEFS) {
        const n = Number(saved?.widths?.[def.key]);
        widths[def.key] = Number.isFinite(n) ? Math.max(def.minWidth, Math.round(n)) : def.defaultWidth;
      }
      return { keys: unique.length ? unique : defaults, widths };
    } catch {
      return { keys: defaults, widths: Object.fromEntries(SONG_COLUMN_DEFS.map(d => [d.key, d.defaultWidth])) };
    }
  }

  function saveSongColumns() {
    try { localStorage.setItem(SONG_COLUMNS_KEY, JSON.stringify(songColumns)); } catch {}
  }

  function songColumnDef(key) { return SONG_COLUMN_DEFS.find(d => d.key === key) || null; }

  function applySongColumnGrid() {
    if (!el.songsTable) return;
    const widths = songColumns.keys.map(key => `${Math.max(songColumnDef(key)?.minWidth || 40, Number(songColumns.widths[key]) || 80)}px`);
    el.songsTable.style.setProperty('--song-grid', widths.join(' '));
    el.songsTable.classList.toggle('song-table-scrollable', songColumns.keys.length > 6 || widths.reduce((sum,w)=>sum + parseFloat(w),0) > el.songsTable.clientWidth);
  }

  function resetSongColumnWidths() {
    for (const def of SONG_COLUMN_DEFS) songColumns.widths[def.key] = def.defaultWidth;
    saveSongColumns();
    applySongColumnGrid();
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
      const startWidth = Number(songColumns.widths[key]) || def.defaultWidth;
      const nextStartWidth = nextKey ? (Number(songColumns.widths[nextKey]) || nextDef.defaultWidth) : 0;
      const maxFirst = nextKey ? startWidth + Math.max(0, nextStartWidth - nextDef.minWidth) : Infinity;
      const onMove = ev => {
        const delta = ev.clientX - startX;
        const width = Math.max(def.minWidth, Math.min(maxFirst, Math.round(startWidth + delta)));
        songColumns.widths[key] = width;
        if (nextKey) songColumns.widths[nextKey] = Math.max(nextDef.minWidth, Math.round(nextStartWidth - (width - startWidth)));
        applySongColumnGrid();
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.classList.remove('song-column-resizing');
        saveSongColumns();
      };
      document.body.classList.add('song-column-resizing');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once:true });
      handle.setPointerCapture?.(e.pointerId);
    });
  }

  function sortTracks(tracks) {
    const out = [...tracks];
    const key = songSort.key;
    if (!key) return out;
    const value = t => {
      if (key === 'plays') return Number(t.playCount || 0);
      if (key === 'rating') return Number(t.ratingRaw) === 255 ? 5 : Number(t.rating || 0);
      if (key === 'length') return Number(t.duration || 0);
      const def = songColumnDef(key);
      const raw = def?.get?.(t) ?? '';
      if (['year','track','disc','bitrate','sampleRate','dateAdded'].includes(key)) return Number(raw) || 0;
      return String(raw).toLowerCase();
    };
    if (['plays','rating','length','year','track','disc','bitrate','sampleRate','dateAdded'].includes(key)) {
      out.sort((a,b) => (value(a)-value(b))*songSort.dir);
    } else {
      const cache = new WeakMap();
      const v = t => { if (!cache.has(t)) cache.set(t, value(t)); return cache.get(t); };
      out.sort((a,b) => songCollator.compare(v(a), v(b))*songSort.dir);
    }
    return out;
  }

  function songHeader() {
    const cells = songColumns.keys.map((key, index) => {
      const def = songColumnDef(key);
      if (!def) return '';
      const isLast = index === songColumns.keys.length - 1;
      return `<div class="song-header-cell" data-column="${def.key}"><button class="song-header-btn ${songSort.key===key?'active':''}" data-sort="${def.key}">${escapeHtml(def.label)}${songSort.key===key?(songSort.dir===1?' ↑':' ↓'):''}</button>${isLast?'':`<span class="song-column-resizer" data-column-resize="${def.key}" title="Drag to resize column"></span>`}</div>`;
    }).join('');
    return `<div class="song-header">${cells}</div>`;
  }

  function bindSongHeader() {
    applySongColumnGrid();
    el.songsTable.querySelectorAll('.song-header-btn').forEach(btn=>btn.addEventListener('click',()=>{
      const key=btn.dataset.sort;
      if(songSort.key===key) songSort.dir*=-1; else { songSort.key=key; songSort.dir=1; }
      renderCurrentView();
    }));
    const header = el.songsTable.querySelector('.song-header');
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
        <img src="${coverSrc(t.cover)}" alt="" />
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

  function saveQueueSession() {
    if (!playbackPersistenceReady || playbackRestorePending) return;
    const paths = currentQueue.map(t => String(t?.path || '')).filter(Boolean);
    const savedAt = Date.now();
    const currentPath = currentQueue[currentIndex]?.path || '';
    const currentState = {
      paths,
      currentIndex: Number.isInteger(currentIndex) ? currentIndex : -1,
      currentPath,
      selectedQueueIndex: Number.isInteger(selectedQueueIndex) ? selectedQueueIndex : -1,
      selectedIndices: [...selectedQueueIndices].filter(Number.isInteger),
      position: getPlaybackPositionForSave(),
      shuffle: !!shuffle,
      shuffleBasePaths: shuffleRestoreQueue ? shuffleRestoreQueue.map(t => String(t?.path || '')).filter(Boolean) : [],
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
    try {
      const playbackState = buildPlaybackState();
      playbackState.savedAt = savedAt;
      window.beehive.savePlaybackStateSync(playbackState);
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

  function buildPlaybackState() {
    const t = currentQueue[currentIndex];
    return {
      paths: currentQueue.map(x => String(x?.path || '')).filter(Boolean),
      currentIndex: Number.isInteger(currentIndex) ? currentIndex : -1,
      currentPath: t?.path || '',
      position: getPlaybackPositionForSave(),
      shuffle: !!shuffle,
      shuffleBasePaths: shuffleRestoreQueue ? shuffleRestoreQueue.map(x => String(x?.path || '')).filter(Boolean) : [],
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
    const state = buildPlaybackState();
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
        if (forceSync) window.beehive.savePlaybackStateSync(state);
        else window.beehive.updatePlaybackTransportSync(state);
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
      el.pbVolume.value = String(Math.round(normalizedVolume * 100));
      el.pbVolume.style.setProperty('--volume-progress', `${Math.round(normalizedVolume * 100)}%`);
      renderVolumeIcon();
    }

    // Prefer the newest non-empty queue snapshot. The backend file is the
    // primary persistence store, while localStorage remains useful for older
    // sessions and for recovering from an interrupted backend write.
    const candidates = [backendPlaybackState, localQueueState].filter(s => Array.isArray(s?.paths) && s.paths.length);
    if (!candidates.length) return false;
    const queueState = candidates.reduce((best, item) =>
      !best || Number(item.savedAt || 0) >= Number(best.savedAt || 0) ? item : best, null);

    // Restore transport mode from the same atomic session snapshot as the queue.
    // This happens before rendering so the controls reflect exactly what the user
    // left behind.
    shuffle = !!queueState.shuffle;
    const restoredRepeat = Number(queueState.repeat);
    repeat = Number.isInteger(restoredRepeat) && restoredRepeat >= 0 && restoredRepeat <= 2 ? restoredRepeat : 0;

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

    const byPath = new Map((library.tracks || []).map(t => [String(t?.path || ''), t]));
    const restoredQueue = queueState.paths.map(p => byPath.get(String(p))).filter(Boolean);
    if (!restoredQueue.length) return false;

    shuffleRestoreQueue = null;
    if (shuffle && Array.isArray(queueState.shuffleBasePaths) && queueState.shuffleBasePaths.length) {
      const restoredBase = queueState.shuffleBasePaths.map(p => byPath.get(String(p))).filter(Boolean);
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
    updateNowPlayingUI(restored);
    // Startup restoration is asynchronous because the selected track must be
    // decoded before Web Audio can expose its duration/position. Prevent the
    // periodic session saver from replacing the real saved position with 0:00
    // while that decode is in progress.
    playbackRestorePending = true;
    // Startup always restores the queue, current song, and saved position, but
    // never restores the previous playing state. Beehive must remain paused
    // until the user explicitly presses Play.
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

  function bindSongDrag(row, track) {
    row.draggable = true;
    row.addEventListener('dragstart', e => beginSongDrag(e, track));
    row.addEventListener('dragend', () => { if (songDragState?.preview?.isConnected) songDragState.preview.remove(); songDragState = null; clearQueueDropTarget(); });
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

  function bindSongSelection(row, tracks, index) {
    const track = tracks[index];
    const path = String(track?.path || '');
    row.dataset.path = path;
    row.classList.toggle('selected', selectedSongPaths.has(path));
    row.addEventListener('click', (e) => {
      activeSelectionScope = 'songs';
      activeSelectionTracks = tracks;
      // Clicking a song selects it only. Playback remains a double-click action.
      if (e.target.closest('.rating-star')) return;
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
      applySongSelectionClasses();
    });
  }

  function renderSpecialSongs(tracks){
    const filtered0=searchTerm ? tracks.filter(trackMatchesSearch) : tracks;
    const filtered = specialView === 'recent'
      ? filtered0.slice().sort((a,b) => Number(b?.addedAt || 0) - Number(a?.addedAt || 0))
      : specialView === 'history' ? filtered0 : sortTracks(filtered0);
    el.contentTools.classList.add('hidden');
    el.contentTools.innerHTML = '';
    el.albumsGrid.classList.add('hidden');
    el.songsTable.classList.remove('hidden');
    el.songsTable.innerHTML=songHeader()+filtered.map((t,i)=>songRowHtml(t,i)).join('');
    bindSongHeader();
    bindSongContextMenu(el.songsTable);
    el.songsTable.querySelectorAll('.song-row').forEach((row,i)=>{
      bindSongSelection(row, filtered, i);
      bindSongDrag(row, filtered[i]);
      row.addEventListener('dblclick',()=>playQueue(filtered,i));
      row.addEventListener('contextmenu',e=>{e.preventDefault();prepareTrackContextSelection(filtered[i], filtered);showTrackContextMenu(e.clientX,e.clientY,filtered[i]);});
      row.querySelectorAll('.rating-star').forEach(star=>star.addEventListener('click',e=>{e.stopPropagation();setTrackRating(filtered[i],Number(star.dataset.star));}));
    });
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
    tab.baseLabel = String(label || (tab.kind === 'music' ? 'MUSIC' : 'PLAYLISTS')).trim() || (tab.kind === 'music' ? 'MUSIC' : 'PLAYLISTS');
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

  function showLibraryView(title,tracks,kind){
    specialView=kind;
    hideContentViews();
    el.albumsToolbar.classList.remove('hidden');
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
    const activeTab = getActiveTab();
    if (activeTab?.kind === 'music') {
      // A sidebar collection is the tab's base context. The tab is opened in
      // the Music browser, but it must be allowed to replace the generic
      // MUSIC label until an album is actually opened in that tab.
      activeTab.baseLabel = title || 'MUSIC';
      activeTab.label = activeTab.baseLabel;
      renderTabs();
    }
    saveActiveTabState();
    updateActiveTabLabel();
  }
  function tracksForPlaylist(pl){
    if(pl?.smart) return evaluateSmartPlaylist(pl);
    const source = Array.isArray(pl?.tracks) ? pl.tracks : [];
    const out = [];
    for (const x of source) {
      const t = libraryTrackByPath.get(String(x));
      if (t) out.push(t);
    }
    return out;
  }

  function shuffleForPlayback(tracks){
    const out=tracks.slice();
    for(let i=out.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[out[i],out[j]]=[out[j],out[i]];}
    return out;
  }

  function playPlaylist(pl){
    const tracks=tracksForPlaylist(pl);
    if(!tracks.length)return false;
    // When the user explicitly starts a playlist while Shuffle is already on,
    // the first song must itself be random. Passing a random starting index to
    // playQueue() lets the shared shuffle path make that chosen track first
    // while still randomizing the remainder of the playlist.
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

  let playlistInfoEditingId = null;
  let playlistInfoEditingDynamicNav = null;
  function showPlaylistInfo(pl){
    if(!pl || !el.playlistInfoModal) return;
    const tracks=tracksForPlaylist(pl);
    const runtime=tracks.reduce((sum,t)=>sum+(Number(t.duration)||0),0);
    const added=(pl.trackAddedAt && typeof pl.trackAddedAt==='object')
      ? Object.values(pl.trackAddedAt).map(Number).filter(Number.isFinite) : [];
    const lastAdded=added.length ? Math.max(...added) : 0;
    const missing=Math.max(0,(pl.tracks||[]).length-tracks.length);
    playlistInfoEditingId = pl.id;
    playlistInfoEditingDynamicNav = null;
    el.playlistInfoTitle.textContent = pl.name || 'Untitled Playlist';
    el.playlistInfoBody.innerHTML = `
      <div class="playlist-info-grid">
        <div><span>Tracks</span><strong>${tracks.length.toLocaleString()}${missing?` (${missing.toLocaleString()} missing locally)`:''}</strong></div>
        <div><span>Length</span><strong>${escapeHtml(formatPlaylistRuntime(runtime))}</strong></div>
        <div><span>Last track added</span><strong>${escapeHtml(pl.smart ? 'Dynamic playlist — membership is generated from its rules.' : formatPlaylistDate(lastAdded))}</strong></div>
      </div>`;
    if(el.playlistInfoName) { el.playlistInfoName.value = pl.name || 'Untitled Playlist'; el.playlistInfoName.disabled = !!pl.smart; }
    if(el.playlistInfoDisplayView) el.playlistInfoDisplayView.value = ['albums','songs','artists'].includes(pl.displayView) ? pl.displayView : 'albums';
    if(el.playlistInfoSaveStatus) el.playlistInfoSaveStatus.textContent = '';
    openModal(el.playlistInfoModal);
  }

  async function savePlaylistInfoChanges(){
    if (playlistInfoEditingDynamicNav) {
      const nav = playlistInfoEditingDynamicNav;
      const displayView = ['albums','songs','artists'].includes(el.playlistInfoDisplayView?.value) ? el.playlistInfoDisplayView.value : 'albums';
      try { localStorage.setItem(`beehive:dynamic-playlist-display-view:${nav}`, displayView); } catch {}
      viewMode = displayView;
      syncTabControls();
      if (nav === 'pl-favorites') {
        await showSpecialNavigation(nav);
      }
      if (el.playlistInfoSaveStatus) el.playlistInfoSaveStatus.textContent = 'Saved';
      return;
    }
    const pl = playlists.find(p=>String(p.id)===String(playlistInfoEditingId));
    if(!pl) return;
    const name = el.playlistInfoName?.value.trim();
    if(!name) return;
    const displayView = ['albums','songs','artists'].includes(el.playlistInfoDisplayView?.value) ? el.playlistInfoDisplayView.value : 'albums';
    const updated = await window.beehive.savePlaylist({ ...pl, name, displayView });
    playlists = playlists.map(p=>String(p.id)===String(updated.id)?updated:p);
    if(activePlaylistId===updated.id){
      const mode = ['albums','songs','artists'].includes(updated.displayView) ? updated.displayView : 'albums';
      // The Playlist Info setting is authoritative while this playlist is open.
      // Use setView() so the top toolbar, visible content surface, and persisted
      // tab state all change together instead of only changing the active button.
      setView(mode);
      if(el.sectionTitleText) el.sectionTitleText.textContent = updated.name;
      syncTabControls();
      renderTabs();
      saveActiveTabState();
    }
    el.playlistInfoTitle.textContent = updated.name || 'Untitled Playlist';
    renderPlaylistManager();
    if(el.playlistInfoSaveStatus) el.playlistInfoSaveStatus.textContent = 'Saved';
  }

  function showPlaylistContextMenu(e, pl){
    if(!pl) return;
    e.preventDefault();
    showContextMenu(e.clientX,e.clientY,[
      {label:'Add playlist to queue',action:()=>{const tracks=tracksForPlaylist(pl);if(!tracks.length){showAppNotice('This playlist has no matching local tracks.');return;}addTracksToQueue(tracks);}},
      {label:'Playlist info',action:()=>showPlaylistInfo(pl)},
      {label:'Rename playlist',action:()=>showPlaylistInfo(pl)},
      {label:'Play playlist',action:()=>playPlaylist(pl)},
      {label:'Export as M3U',action:()=>exportNamedPlaylist(pl)},
      {label:'Delete playlist',danger:true,action:async()=>{await window.beehive.deletePlaylist(pl.id);playlists=playlists.filter(x=>x.id!==pl.id);if(activePlaylistId===pl.id){activePlaylistId=null;specialView=null;}renderPlaylistManager();}}
    ]);
  }

  function smartFieldValue(t,field){
    const n = v => Number(v || 0);
    const text = v => String(v ?? '');
    const map = {
      title:t.title, artist:t.artist, album:t.album, albumArtist:t.albumArtist,
      genre:t.genre, composer:t.composer, publisher:t.publisher, conductor:t.conductor,
      comment:t.comment, grouping:t.grouping, copyright:t.copyright,
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
      lyrics:text(t.lyrics), albumRating:n(t.albumRating), quality:text(t.quality),
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
    const limit=Math.max(1,Math.min(5000,Number(pl.limit)||25));
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
    if(pl.smartShuffle==='random') out=shuffleForPlayback(out);
    return out;
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
  async function exportNamedPlaylist(pl){ return exportPlaylist(pl.name, tracksForPlaylist(pl)); }
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
  async function importSpotifyPlaylist(){
    const input=prompt('Spotify playlist URL:', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    if(!input)return;
    try{
      const data=await window.beehive.importSpotifyPlaylist(input);
      const matched=[], unmatched=[];
      for(const entry of data.tracks||[]){ const t=matchSpotifyTrack(entry); if(t)matched.push(t.path); else unmatched.push(`${entry.artist} - ${entry.title}`); }
      const unique=[...new Set(matched)];
      if(!unique.length){ showAppNotice(`Spotify playlist “${data.name}” was read, but none of its tracks matched your local Beehive library.`); return; }
      const pl=await window.beehive.savePlaylist({name:data.name,tracks:unique,smart:false,source:'spotify',sourceUrl:data.sourceUrl,spotifyPlaylistId:data.id,unmatched,description:'Imported from Spotify; playback uses local Beehive files.'});
      playlists=await window.beehive.getPlaylists(); closeModal(el.playlistImportModal); renderPlaylistManager();
      const trunc=data.likelyTruncated?' Spotify exposed the first 100 entries in its public embed.':'';
      showAppNotice(`Imported “${pl.name}” with ${unique.length} local tracks${unmatched.length?` (${unmatched.length} not found locally)`:''}.${trunc}`);
    }catch(err){ showAppNotice(err.message||'Could not import Spotify playlist.'); }
  }

  function rowImportButtons(list){
    list.querySelectorAll('.playlist-row').forEach((row,i)=>{
      const pl=playlists[i];
      row.addEventListener('contextmenu',e=>showPlaylistContextMenu(e,pl));
    });
  }

  async function renderPlaylistManager(){
    hideContentViews(); el.tabPlaceholder.classList.remove('hidden');
    el.tabPlaceholder.innerHTML='<div class="playlist-manager"><div class="playlist-manager-head"><div><h2>Playlists</h2><p class="dim">Create normal playlists or dynamic smart playlists.</p></div><div class="playlist-manager-create"><button id="playlist-import-btn" class="sidebar-add">Import Playlist</button><button id="new-playlist-btn" class="sidebar-add">+ New playlist</button><button id="new-smart-playlist-btn" class="sidebar-add">✦ Smart playlist</button></div></div><div id="playlist-manager-list"></div></div>';
    const list=document.getElementById('playlist-manager-list');

    // Bind the explorer controls before the empty-state early return. With zero
    // playlists there is no virtualized list to build, but Import/New playlist
    // must still be fully functional.
    document.getElementById('playlist-import-btn').onclick=()=>openModal(el.playlistImportModal);
    document.getElementById('new-playlist-btn').onclick=()=>openNewPlaylistModal();
    document.getElementById('new-smart-playlist-btn').onclick=()=>openSmartPlaylistModal();

    if(!playlists.length){ list.innerHTML='<div class="empty-state small-empty"><p>No playlists yet. Create one to get started.</p></div>'; return; }

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
      row.innerHTML=`<div><strong>${escapeHtml(pl.name)}</strong>${pl.smart?'<span class="smart-badge">SMART</span>':''}<div class="dim small">${pl.smart?'Dynamic · updates automatically':`${count} track${count===1?'':'s'}`}</div></div><div class="playlist-actions"><button class="sidebar-add play-pl">▶ Play</button><button class="sidebar-add del-pl">Delete</button></div>`;
      row.querySelector('.play-pl').onclick=e=>{e.stopPropagation();playPlaylist(pl);};
      row.querySelector('.del-pl').onclick=async e=>{e.stopPropagation();await window.beehive.deletePlaylist(pl.id);playlists=playlists.filter(x=>x.id!==pl.id);if(activePlaylistId===pl.id){activePlaylistId=null;specialView=null;}renderPlaylistManager();};
      row.addEventListener('click',()=>{
        // The playlist context must be established AFTER switchTab().
        // switchTab() restores the target Music tab's saved state, which can
        // otherwise overwrite specialView/activePlaylistId with the Music tab's
        // previous library context. That made Tracks / Albums / Artists fall
        // back to the entire library after selecting a playlist.
        const musicTab=tabs.find(t=>t.kind==='music');
        if(musicTab){
          if (activeTabId !== musicTab.id) switchTab(musicTab.id);
          musicTab.state = null;
          activateTabDom(musicTab);
          bindActiveTabDom(musicTab);
          bindTabToolbar(musicTab);
          musicTab.dom.initialized = true;
        }

        activePlaylistId=pl.id;
        specialView='playlist';
        viewMode=['albums','songs','artists'].includes(pl.displayView) ? pl.displayView : 'albums';
        searchTerm='';
        artistSearchTerm='';
        el.search.value='';
        updateSearchClearButton();
        el.main.classList.remove('searching');
        el.sidebarItems.forEach(i=>i.classList.remove('active'));

        renderTabs();
        // Open the playlist in its saved display mode. setView() owns the
        // content-view switching, so Tracks actually replaces the album grid
        // instead of leaving the Albums view visible underneath it.
        setView(viewMode);
        syncTabControls();
        saveActiveTabState();
        updateActiveTabLabel();
      });
      row.addEventListener('dblclick',()=>playPlaylist(pl));
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

  }

  let editingPlaylistId = null;
  function openNewPlaylistModal(){
    editingPlaylistId = null;
    if (el.playlistModalTitle) el.playlistModalTitle.textContent = 'New playlist';
    el.playlistName.value='New Playlist';
    if (el.playlistDisplayView) el.playlistDisplayView.value='albums';
    if (el.playlistSave) el.playlistSave.textContent='Create playlist';
    openModal(el.playlistModal); setTimeout(()=>{el.playlistName.focus();el.playlistName.select();},0);
  }
  function openEditPlaylistModal(pl){
    if(!pl) return;
    editingPlaylistId = pl.id;
    if (el.playlistModalTitle) el.playlistModalTitle.textContent = 'Rename playlist';
    el.playlistName.value = pl.name || 'Untitled Playlist';
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
    ['library','playlist','folder'].forEach(type=>document.getElementById(`smart-source-${type}`)?.addEventListener('change',()=>{
      const active=document.querySelector('input[name="smart-source"]:checked')?.value||'library';
      document.getElementById('smart-source-playlist').disabled=active!=='playlist';
      document.getElementById('smart-source-folder').disabled=active!=='folder';
    }));
    const refresh=document.getElementById('smart-refresh-now');
    const auto=document.getElementById('smart-auto-refresh');
    if(refresh) refresh.disabled=!(auto?.checked);
    auto?.addEventListener('change',()=>{if(refresh)refresh.disabled=!auto.checked;});
  }
  function openSmartPlaylistModal(){
    el.smartPlaylistName.value='Smart Playlist';el.smartPlaylistMatch.value='all';el.smartPlaylistLimit.value='25';
    if(el.smartPlaylistSort)el.smartPlaylistSort.value='addedDesc';
    ['smart-playlist-description','smart-source-playlist','smart-source-folder'].forEach(id=>{const n=document.getElementById(id);if(n)n.value='';});
    document.getElementById('smart-source-library').checked=true;
    document.getElementById('smart-filter-duplicates').checked=false;
    document.getElementById('smart-playlist-select-by').value='track';
    document.getElementById('smart-playlist-shuffle').value='none';
    document.getElementById('smart-playlist-display').value='songs';
    document.getElementById('smart-auto-refresh').checked=true;
    document.getElementById('smart-export-static').checked=false;
    document.getElementById('smart-refresh-now').disabled=false;
    document.getElementById('smart-source-playlist').disabled=true;document.getElementById('smart-source-folder').disabled=true;
    populateSmartSources();
    el.smartPlaylistRules.innerHTML='';addSmartRuleRow();bindSmartSourceControls();openModal(el.smartPlaylistModal);setTimeout(()=>{el.smartPlaylistName.focus();el.smartPlaylistName.select();},0);
  }

  function dynamicSidebarPlaylist(nav){
    if(nav==='pl-favorites') return {id:'sidebar-favorites', name:'Favorites', smart:true, tracks:library.tracks.filter(t=>t.loved).map(t=>t.path), dynamicTracks:library.tracks.filter(t=>t.loved)};
    if(nav==='pl-recent') { const tracks=getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100); return {id:'sidebar-recent',name:'Recently Added',smart:true,tracks:tracks.map(t=>t.path),dynamicTracks:tracks}; }
    if(nav==='pl-top') { const tracks=[...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25); return {id:'sidebar-top',name:'Top 25 Most Played',smart:true,tracks:tracks.map(t=>t.path),dynamicTracks:tracks}; }
    return null;
  }

  function openPlaylistInfo(name, count, runtime, lastAdded = 0, dynamicNav = null) {
    if (!el.playlistInfoModal) return;
    playlistInfoEditingId = null;
    playlistInfoEditingDynamicNav = dynamicNav || null;
    el.playlistInfoTitle.textContent = String(name || 'Playlist');
    el.playlistInfoBody.innerHTML = `
      <div class="playlist-info-grid">
        <div><span>Tracks</span><strong>${Number(count || 0).toLocaleString()}</strong></div>
        <div><span>Length</span><strong>${escapeHtml(formatPlaylistRuntime(runtime))}</strong></div>
        <div><span>Last track added</span><strong>${lastAdded ? escapeHtml(formatPlaylistDate(lastAdded)) : 'Not tracked for this dynamic playlist.'}</strong></div>
      </div>`;
    if (el.playlistInfoName) {
      el.playlistInfoName.value = String(name || 'Playlist');
      el.playlistInfoName.disabled = true;
    }
    const savedView = dynamicNav ? localStorage.getItem(`beehive:dynamic-playlist-display-view:${dynamicNav}`) : null;
    if (el.playlistInfoDisplayView) el.playlistInfoDisplayView.value = ['albums','songs','artists'].includes(savedView) ? savedView : 'albums';
    if (el.playlistInfoSaveStatus) el.playlistInfoSaveStatus.textContent = '';
    openModal(el.playlistInfoModal);
  }

  function showAppNotice(message, title = 'Hive') {
    if (!el.noticeModal) return;
    el.noticeTitle.textContent = String(title || 'Hive');
    el.noticeBody.textContent = String(message || '');
    openModal(el.noticeModal);
  }

  function showDynamicPlaylistContextMenu(e, pl){
    if(!pl) return;
    e.preventDefault();
    const tracks=pl.dynamicTracks||[];
    const runtime=tracks.reduce((sum,t)=>sum+(Number(t.duration)||0),0);
    const lastAdded=pl.id==='sidebar-recent' && tracks.length ? Number(tracks[0].addedAt||0) : 0;
    showContextMenu(e.clientX,e.clientY,[
      {label:'Add playlist to queue',action:()=>{if(!tracks.length){showAppNotice('This playlist has no tracks.');return;}addTracksToQueue(tracks);}},
      {label:'Playlist info',action:()=>openPlaylistInfo(pl.name, tracks.length, runtime, lastAdded, pl.id.replace('sidebar-','pl-'))}
    ]);
  }

  async function showSpecialNavigation(nav){
    el.sidebarItems.forEach(i=>i.classList.toggle('active',i.dataset.nav===nav));

    // Sidebar destinations are contexts inside the appropriate top tab.
    // Selecting one must also update that tab's label AND emoji, even though
    // the destination itself is rendered by the existing Music/Playlists view.
    const musicContexts = {
      history: ['History', '🕘'],
      'pl-recent': ['Recently Added', '🕗'],
      'pl-top': ['Top 25 Most Played', '🔥'],
      'pl-favorites': ['Favorites', '★']
    };

    if (musicContexts[nav]) {
      const musicTab = rememberMusicBrowserState() || tabs.find(t => t.kind === 'music');
      if (musicTab && activeTabId !== musicTab.id) switchTab(musicTab.id);
      if (musicTab) {
        // Change only the visible tab label while this temporary sidebar
        // context is active. Do not save this context back into the Music
        // browser state and do not tear down an expanded album.
        musicTab.baseLabel = musicContexts[nav][0];
        musicTab.baseIcon = musicContexts[nav][1];
        musicTab.label = musicContexts[nav][0];
        musicTab.icon = musicContexts[nav][1];
        renderTabs();
      }
    }

    if(nav==='history'){
      const saved=localStorage.getItem('beehive:sidebar-display-view:history');
      viewMode=['albums','songs','artists'].includes(saved) ? saved : 'songs';
      const h=await window.beehive.getHistory();
      return showLibraryView('History',historyTracks(h||[]),'history');
    }
    if(nav==='pl-recent'){
      const saved=localStorage.getItem('beehive:dynamic-playlist-display-view:pl-recent');
      viewMode=['albums','songs','artists'].includes(saved) ? saved : 'albums';
      return showLibraryView('Recently Added',getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100),'recent');
    }
    if(nav==='pl-top'){
      const saved=localStorage.getItem('beehive:dynamic-playlist-display-view:pl-top');
      viewMode=['albums','songs','artists'].includes(saved) ? saved : 'albums';
      return showLibraryView('Top 25 Most Played',[...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25),'top');
    }
    if(nav==='pl-favorites'){
      const saved=localStorage.getItem('beehive:dynamic-playlist-display-view:pl-favorites');
      viewMode=['albums','songs','artists'].includes(saved) ? saved : 'albums';
      return showLibraryView('Favorites',library.tracks.filter(t=>t.loved),'favorites');
    }
    if(nav==='pl-explorer'){
      const playlistsTab = getActiveTab()?.kind === 'playlists' ? getActiveTab() : tabs.find(t => t.kind === 'playlists');
      if (playlistsTab && activeTabId !== playlistsTab.id) switchTab(playlistsTab.id);
      const activePlaylistTab = getActiveTab();
      if (activePlaylistTab?.kind === 'playlists') {
        activePlaylistTab.baseLabel = 'Playlist Explorer';
        activePlaylistTab.baseIcon = '🗂';
        activePlaylistTab.label = 'Playlist Explorer';
        activePlaylistTab.icon = '🗂';
        renderTabs();
        saveActiveTabState();
      }
      playlists=await window.beehive.getPlaylists();
      return renderPlaylistManager();
    }
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
        const wrap=document.createElement('div'); wrap.className='context-submenu-wrap';
        const b=document.createElement('button'); b.className='context-item context-submenu-trigger'; b.innerHTML=`<span>${it.label}</span><span class="context-arrow">›</span>`;
        const sub=document.createElement('div'); sub.className='context-submenu';
        it.submenu.forEach(si=>{
          const sb=document.createElement('button');
          sb.className='context-item context-rating-item' + (si.active ? ' active' : '') + (si.loved ? ' loved' : '');
          const icon=document.createElement('span'); icon.className='context-rating-icon'; icon.textContent=si.icon || '';
          const label=document.createElement('span'); label.className='context-rating-label'; label.textContent=si.label;
          const check=document.createElement('span'); check.className='context-rating-check'; check.textContent=si.active ? '✓' : '';
          if(si.icon){ sb.append(icon); }
          sb.append(label,check);
          sb.title=si.title || '';
          sb.onclick=async()=>{hideContextMenu();await si.action();};
          sub.appendChild(sb);
        });
        wrap.appendChild(b); wrap.appendChild(sub); m.appendChild(wrap);
      } else {
        const b=document.createElement('button'); b.className='context-item'+(it.danger?' danger':'')+(it.playlistRemove?' playlist-remove':''); b.textContent=it.label; b.onclick=async()=>{hideContextMenu();await it.action();}; m.appendChild(b);
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
    const items=distinctCovers(model||{cover:file});
    const menu=[{label:'Open full-size cover',action:()=>openCoverLightbox(model||{cover:file})}];
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

  async function removeTracksFromFavorites(tracks) {
    const candidates = Array.isArray(tracks) ? tracks.filter(t => t?.path && t?.loved) : [];
    if (!candidates.length || specialView !== 'favorites') return false;
    const count = candidates.length;
    const label = count === 1
      ? `Remove “${String(candidates[0].title || candidates[0].path.split(/[\\/]/).pop() || 'this track')}” from “Favorites”?`
      : `Remove ${count} selected tracks from “Favorites”?`;
    const confirmed = window.confirm(`${label}\n\nThis will remove the selected tracks from Favorites.\n\nThis cannot be undone.`);
    if (!confirmed) return false;
    const paths = [...new Set(candidates.map(t => String(t.path || '')).filter(Boolean))];
    const result = await window.beehive.setLove(paths, false);
    if (result?.failed) {
      console.warn('Some Favorites removals failed:', result.errors);
      showAppNotice('Some tracks could not be removed from Favorites.');
      return false;
    }
    const removedSet = new Set(paths);
    for (const track of library.tracks) {
      if (removedSet.has(String(track?.path || ''))) track.loved = false;
    }
    clearSongSelection();
    activeSelectionTracks = [];
    renderCurrentView();
    saveActiveTabState();
    return true;
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
    const confirmed = window.confirm(`${label}\n\nThis cannot be undone.`);
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

  function showTrackContextMenu(x,y,t){
    if(!t)return;
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
    showContextMenu(x,y,[
      {label:'Play',action:()=>playQueue([t],0)},
      {label:queueLabel,action:()=>addTracksToQueue(queueTracks)},
      {label:'Rating',submenu:[
        {label:bulk && allLoved ? 'Unlove' : 'Love', icon:allLoved ? '♥' : '♡', loved:true, active:bulk ? allLoved : !!t.loved, title:bulk ? (allLoved ? `Remove Love from ${selected.length} selected tracks` : `Love ${selected.length} selected tracks`) : (t.loved ? 'Loved — click to remove' : 'Not loved — click to love'), action:()=>applyLove(bulk ? !allLoved : !t.loved)},
        {label:'5 stars', icon:'★★★★★', active:ratingIs(5), title:bulk ? `Rate ${selected.length} selected tracks at 5 stars` : 'Set rating to 5 stars', action:()=>applyRating(5)},
        {label:'4 stars', icon:'★★★★☆', active:ratingIs(4), title:bulk ? `Rate ${selected.length} selected tracks at 4 stars` : 'Set rating to 4 stars', action:()=>applyRating(4)},
        {label:'3 stars', icon:'★★★☆☆', active:ratingIs(3), title:bulk ? `Rate ${selected.length} selected tracks at 3 stars` : 'Set rating to 3 stars', action:()=>applyRating(3)},
        {label:'2 stars', icon:'★★☆☆☆', active:ratingIs(2), title:bulk ? `Rate ${selected.length} selected tracks at 2 stars` : 'Set rating to 2 stars', action:()=>applyRating(2)},
        {label:'1 star', icon:'★☆☆☆☆', active:ratingIs(1), title:bulk ? `Rate ${selected.length} selected tracks at 1 star` : 'Set rating to 1 star', action:()=>applyRating(1)},
        {label:'Clear', icon:'×', active:ratingIs(0), title:bulk ? `Clear ratings from ${selected.length} selected tracks` : 'Remove the star rating', action:()=>applyRating(0)}
      ]},
      {label:`Search artist: ${t.artist || 'Unknown Artist'}`,action:()=>searchForArtist(t.artist, t)},
      {label:`Search album: ${t.album || 'Unknown Album'}`,action:()=>showAlbumFromTrack(t)},
      {label:'Show file in browser',action:()=>showTrackFileInBrowser(t)},
      ...(specialView === 'playlist' && activePlaylistId ? [{label:bulk ? `Remove tracks from playlist (${selected.length} selected)` : 'Remove tracks from playlist', playlistRemove:true, action:()=>removeTracksFromActivePlaylist(selected)}] : []),
      {label:bulk ? `Delete files from disk… (${selected.length} selected)` : 'Delete file from disk…',danger:true,action:()=>deleteTracksFromDisk(selected)},
      {label:editLabel,action:()=>openTagEditor(t, selected)},
      {label:'Add to playlist…',action:async()=>{
        playlists=await window.beehive.getPlaylists();
        const selected=(activeSelectionScope==='songs' && selectedSongPaths.has(String(t.path||'')))
          ? orderedSelectedTracks(library.tracks)
          : [t];
        const paths=[...new Set(selected.map(x=>String(x?.path||'')).filter(Boolean))];
        if(!paths.length)return;
        if(!playlists.length){
          const n=prompt(`New playlist name for ${paths.length} selected song${paths.length===1?'':'s'}:`,'My Playlist');
          if(!n?.trim())return;
          const created=await window.beehive.savePlaylist({name:n.trim(),tracks:paths,smart:false});
          playlists=[...playlists,created];
          showAppNotice(`Created “${created.name}” with ${paths.length} track${paths.length===1?'':'s'}.`);
          return;
        }
        const ans=prompt(playlists.map((p,i)=>`${i+1}. ${p.name}${p.smart?' [SMART]':''}`).join('\n')+`\n\nEnter playlist number for ${paths.length} selected song${paths.length===1?'':'s'}:`);
        const i=Number(ans)-1;
        if(i<0||i>=playlists.length||playlists[i].smart)return;
        const existing=Array.isArray(playlists[i].tracks)?playlists[i].tracks:[];
        const merged=[...existing];
        for(const path of paths)if(!merged.includes(path))merged.push(path);
        const saved=await window.beehive.savePlaylist({...playlists[i],tracks:merged});
        playlists[i]=saved;
        showAppNotice(`Added ${merged.length-existing.length} new track${merged.length-existing.length===1?'':'s'} to “${saved.name}”.`);
      }}
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
  function formatEditorTime(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return '';
    const mins = Math.floor(n / 60);
    const secs = n - mins * 60;
    return `${mins}:${secs.toFixed(3).padStart(6, '0')}`;
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
  }
  document.querySelectorAll('.tag-editor-tab').forEach(btn => btn.addEventListener('click', () => setTagEditorTab(btn.dataset.tagTab)));

  const TAG_EDITOR_FIELDS = [
    ['title', 'tag-title'], ['artist', 'tag-artist'], ['album', 'tag-album'], ['albumartist', 'tag-albumArtist'],
    ['genre', 'tag-genre'], ['year', 'tag-year'], ['track', 'tag-track'], ['disk', 'tag-disk'],
    ['composer', 'tag-composer'], ['publisher', 'tag-publisher'], ['conductor', 'tag-conductor'], ['bpm', 'tag-bpm'],
    ['grouping', 'tag-grouping'], ['copyright', 'tag-copyright'], ['comment', 'tag-comment'], ['compilation', 'tag-compilation'],
    ['pcount', 'tag-pcount'], ...Array.from({length:19}, (_, i) => [`custom${i+2}`, `tag-custom${i+2}`]),
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
    if (key === 'comment') return text(common?.comment);
    if (key === 'lyrics') return common?.lyrics?.[0]?.text ?? common?.lyrics?.[0] ?? common?.lyrics ?? '';
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
    return (pictures || []).find(p => String(p?.type || '').toLowerCase() === 'cover (front)') || pictures?.[0] || null;
  }
  function artworkEditorPictureSrc(picture, fallback = null) {
    if (picture?.dataUrl) return String(picture.dataUrl);
    if (picture?.dataBase64) return `data:${String(picture.mime || 'image/jpeg')};base64,${picture.dataBase64}`;
    if (picture?.file) return coverSrc(picture.file);
    return fallback ? coverSrc(fallback) : placeholderCover();
  }
  function ensureArtworkEditorBlankSlot() {
    if (!Array.isArray(artworkEditorBlankSlots)) artworkEditorBlankSlots = [];
    if (!artworkEditorBlankSlots.length) {
      artworkEditorBlankSlots.push({ id: artworkEditorNextBlankId++, type: 'Cover (Back)', description: '' });
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
          <div class="artwork-library-actions"><button type="button" data-artwork-blank-search>Search Internet for Cover…</button><button type="button" data-artwork-blank-upload>Upload…</button>${artworkEditorBlankSlots.length > 1 ? '<button type="button" data-artwork-blank-remove>Remove Slot</button>' : ''}</div>
        </div>
      </article>`;
    }).join('');

    list.innerHTML = pictureCards + blankCards;

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
      const thumb = card.querySelector('.artwork-library-thumb-wrap');
      thumb?.addEventListener('contextmenu', e => {
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
      });
      card.querySelector('[data-artwork-save]')?.addEventListener('click', async e => {
        e.stopPropagation();
        const picture = artworkEditorPictures[index];
        if (!picture?.dataUrl) return;
        try {
          const temp = await window.beehive.saveDataUrlImage(picture.dataUrl, `beehive-artwork-${index + 1}.${String(picture.mime || 'image/jpeg').split('/')[1] || 'jpg'}`);
          if (temp) await window.beehive.saveImageFile(temp);
        } catch (err) { el.tagStatus.textContent = err.message || 'Could not save artwork.'; }
      });
      const persistArtworkMeta = async () => {
        artworkEditorSelected = index;
        const type = card.querySelector('[data-artwork-type]')?.value || artworkEditorPictures[index]?.type || 'Cover (Front)';
        const comment = card.querySelector('[data-artwork-comment]')?.value || '';
        try {
          el.tagStatus.textContent = `Saving artwork metadata ${index + 1}…`;
          for (const track of editingTracks) {
            const data = await window.beehive.readTags(track.path);
            const targetIndex = artworkEditorIndexForSlot(data?.pictures || [], slot);
            if (targetIndex < 0) throw new Error(`The ${artworkEditorSlotLabel(slot)} is not present in one of the selected files.`);
            await window.beehive.modifyArtwork(track.path, { action:'update', index:targetIndex, pictureType:type, comment }, { background: true });
          }
          await reloadArtworkEditor();
          await reconcileArtworkAfterBackgroundWrite(editingTracks.map(track => track.path));
          el.tagStatus.textContent = 'Artwork metadata saved.';
        } catch (err) { el.tagStatus.textContent = err.message || 'Could not save artwork metadata.'; }
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
        const type = card.querySelector('[data-artwork-blank-type]')?.value || slot.type || 'Cover (Back)';
        const comment = card.querySelector('[data-artwork-blank-comment]')?.value || slot.description || '';
        await fillArtworkBlankSlot(slot.id, chosen, type, comment);
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
      artworkEditorBlankSlots = [{ id: artworkEditorNextBlankId++, type: 'Cover (Back)', description: '' }];
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
    return { type, occurrence };
  }
  function artworkEditorIndexForSlot(pictures, slot) {
    if (!slot) return -1;
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
        track.cover = pictures[0]?.file || track.cover || chosen.path;
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
        current.cover = currentPictures[0]?.file || chosen.path || current.cover;
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
        await reloadArtworkEditor();
        await reconcileArtworkAfterBackgroundWrite(editingTracks.map(track => track.path), { searchMissing: false, warmAlbum: false });
        el.tagStatus.textContent = `${artworkEditorSlotLabel(slot)} saved.`;
      }, null, { protectPlayback: true, bulkWrite: true, paths: editingTracks.map(track => track.path) });
    } catch (err) { el.tagStatus.textContent = err.message || 'Could not replace artwork.'; }
  }

  async function deleteArtworkItem(index) {
    if (!confirm('Delete this embedded artwork from the selected file(s)?')) return;
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
        await reloadArtworkEditor();
        await reconcileArtworkAfterBackgroundWrite(editingTracks.map(track => track.path), { searchMissing: false, warmAlbum: false });
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
      await reloadArtworkEditor();
      await reconcileArtworkAfterBackgroundWrite(editingTracks.map(track => track.path), { searchMissing: false, warmAlbum: false });
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
    artworkEditorBlankSlots = [{ id: artworkEditorNextBlankId++, type: 'Cover (Back)', description: '' }];
    window.__beehiveRemoveArtwork = false;
    window.__beehiveRemoveFrontArtwork = false;
    openModal(el.tagModal);
    const bulkMode = editingTracks.length > 1;
    const albumMode = bulkMode && editingTracks.every(track => String(track?.albumKey || '') === String(t?.albumKey || ''));
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

    const set=(id,v)=>{ const node=document.getElementById(id); if(node) { node.value=v??''; node.removeAttribute('placeholder'); } };
    const setMerged=(id, values, bulk, multiLabel)=>{
      const node=document.getElementById(id);
      if(!node) return;
      const merged = bulk ? mergeEditorValues(values) : (values[0] ?? '');
      node.value = merged ?? '';
      if (bulk && merged === '' && values.some(v => editorComparable(v) !== editorComparable(values[0] ?? ''))) {
        node.placeholder = multiLabel;
      } else {
        node.removeAttribute('placeholder');
      }
    };
    const multiValueGhost = albumMode ? 'Multiple Variables' : 'Multiple Values';
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

    const starts = loaded.map(item => item.track.startTime || nativeTagValue(item.data?.native,'START_TIME'));
    const ends = loaded.map(item => item.track.endTime || nativeTagValue(item.data?.native,'END_TIME'));
    setMerged('tag-start-time', starts, bulkMode, multiValueGhost);
    setMerged('tag-end-time', ends, bulkMode, multiValueGhost);
    const lyricValues = loaded.map(item => editorTextValue(item.data?.common || {}, item.data?.native || {}, 'lyrics'));
    const lyricText = bulkMode ? mergeEditorValues(lyricValues) : lyricValues[0];
    setMerged('tag-lyrics', lyricValues, bulkMode, multiValueGhost);
    const synced = parseSyncedLyrics(lyricText).length > 0;
    document.querySelectorAll('input[name="tag-lyrics-sync"]').forEach(r => r.checked = r.value === (synced ? 'synced' : 'unsynced'));
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

    const f=firstData.format||{}, stat=firstData.stat||{};
    const prop=(id,v)=>{const n=document.getElementById(id);if(n)n.textContent=v||'—';};
    prop('tag-prop-type', f.codec ? `${String(f.codec).toUpperCase()} audio file` : pathExtLabel(t.path));
    prop('tag-prop-encoder', f.encoder); prop('tag-prop-version', Array.isArray(f.tagTypes) && f.tagTypes.length ? f.tagTypes.join(', ') : (firstCommon.artwork ? 'embedded artwork' : (f.codec||''))); prop('tag-prop-channels', f.numberOfChannels ? `${f.numberOfChannels}` : '—');
    prop('tag-prop-size', stat.size ? formatBytes(stat.size) : '—'); prop('tag-prop-bitrate', f.bitrate ? `${Math.round(f.bitrate/1000)} kbps` : '—');
    prop('tag-prop-duration', f.duration ? fmtTime(f.duration) : fmtTime(t.duration)); prop('tag-prop-samplerate', f.sampleRate ? `${(f.sampleRate/1000).toFixed(1)} kHz` : '—');
    prop('tag-prop-added', stat.birthtimeMs ? new Date(stat.birthtimeMs).toLocaleString() : (t.addedAt ? new Date(t.addedAt).toLocaleString() : '—'));
    prop('tag-prop-lastplayed', bulkMode ? 'Multiple' : (t.lastPlayedAt ? new Date(t.lastPlayedAt).toLocaleString() : 'Unknown')); prop('tag-prop-plays', bulkMode ? 'Multiple' : String(t.playCount||0));
    prop('tag-prop-rating', bulkMode ? 'Multiple' : ratingStars(t).replace(/<[^>]*>/g,''));
    set('tag-prop-location',t.path||'');
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
      'tag-remember-position': nativeTagValue(firstData.native, 'BEEHIVE_REMEMBER_POSITION'),
      'tag-keep-sequence': nativeTagValue(firstData.native, 'BEEHIVE_KEEP_SEQUENCE')
    };
    Object.entries(settingValues).forEach(([id, value]) => { const node=document.getElementById(id); if(node) node.checked=/^(1|true|yes)$/i.test(String(value||'')); });
    const compilationNode = document.getElementById('tag-compilation-setting');
    if (compilationNode) compilationNode.checked = String(editorTextValue(firstCommon, firstData.native, 'compilation') || '') === '1';
    ['tag-exclude-playback','tag-do-not-crossfade','tag-remember-position','tag-keep-sequence'].forEach(id => {
      const node = document.getElementById(id); if (node) node.checked = /^(1|true|yes)$/i.test(String(node.value || ''));
    });
    el.tagStatus.textContent = bulkMode ? `${editingTracks.length} files loaded from disk. Blank fields mean the selected files differ.` : (t.path||'');
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

  function showLyricsContextMenu(e, t) {
    if (!t) return;
    showContextMenu(e.clientX, e.clientY, [
      {label:'Show highlighted lyric', action:()=>{
        followHighlightedLyric = true;
        scrollHighlightedLyricIntoView('smooth');
      }},
      {label:'Edit lyrics…', action:()=>{ openTagEditor(t); setTagEditorTab('lyrics'); }},
      {label:'Alignment', submenu:[
        {label:'Left', action:()=>applyLyricsAlignment('left')},
        {label:'Center', action:()=>applyLyricsAlignment('center')},
        {label:'Right', action:()=>applyLyricsAlignment('right')}
      ]}
    ]);
  }

  function showAlbumFromTrack(t) {
    if (!t || !t.album) return;
    const tab = getActiveTab();
    // Album search is another entry point into the same Albums viewer. Snapshot
    // the current browser so Back restores the exact view, expanded album, and
    // scroll position instead of leaving the user stranded in album-focus.
    if (!albumSearchReturnState && tab) {
      saveActiveTabState();
      const state = tab.state || currentTabState(tab);
      albumSearchReturnState = {
        searchTerm: String(state.searchTerm || ''),
        artistSearchTerm: String(state.artistSearchTerm || ''),
        artistSearchSort: state.artistSearchSort === 'album' ? 'album' : 'release',
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
    artistSearchSort = saved.artistSearchSort === 'album' ? 'album' : 'release';
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
    artistSearchSort = saved.artistSearchSort === 'album' ? 'album' : 'release';
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

    // Do NOT build a second artist-specific viewer. Artist search is simply the
    // main Albums viewer filtered by artist metadata. Snapshot the existing
    // browser first so Back can restore its exact state and any expanded album.
    if (!artistSearchReturnState && tab) {
      saveActiveTabState();
      const state = tab.state || currentTabState(tab);
      artistSearchReturnState = {
        searchTerm: String(state.searchTerm || ''),
        artistSearchTerm: String(state.artistSearchTerm || ''),
        artistSearchSort: state.artistSearchSort === 'album' ? 'album' : 'release',
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
    artistSearchSort = 'release';
    el.search.value = artist;
    updateSearchClearButton();

    const keepPlaylistContext = specialView === 'playlist' && !!activePlaylistId;
    if (!keepPlaylistContext) specialView = null;
    el.main.classList.add('searching');
    setView('albums');
  }

  function showAlbumContextMenu(e, album) {
    if (!album || !album.tracks?.length) return;
    // Right-clicking an album is an album selection operation. It must replace
    // any previous song selection with exactly the files belonging to this album,
    // so Edit Tags / artwork actions cannot accidentally include another album.
    activeSelectionScope = 'songs';
    activeSelectionTracks = album.tracks.slice();
    clearSongSelection();
    for (const track of album.tracks) selectSongPath(track?.path);
    songSelectionAnchor = String(album.tracks[0]?.path || '');
    applySongSelectionClasses();
    const playlistContext = specialView === 'playlist' && !!activePlaylistId;
    const favoritesContext = specialView === 'favorites';
    const albumTracks = album.tracks.slice();
    showContextMenu(e.clientX, e.clientY, [
      {label:'Edit album tags & cover…', action:()=>openTagEditor(album.tracks[0], album.tracks)},
      {label:`Search album: ${album.title || 'Unknown Album'}`, action:()=>showAlbumFromTrack(album.tracks[0])},
      {label:`Search artist: ${album.artist || 'Unknown Artist'}`, action:()=>searchForArtist(album.artist, album.tracks?.[0] || null)},
      {label:'Play album', action:()=>playQueue(album.tracks, 0)},
      ...(playlistContext ? [{label:'Remove tracks from playlist', playlistRemove:true, action:()=>removeTracksFromActivePlaylist(albumTracks)}] : []),
      ...(playlistContext || favoritesContext ? [{label:`Delete files from disk… (${albumTracks.length} selected)`, danger:true, action:()=>deleteTracksFromDisk(albumTracks)}] : [])
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
      if (m?.tracks?.length) playQueue(m.tracks,0);
    });
    card.draggable = viewMode === 'albums';
    card.addEventListener('dragstart', e => beginAlbumDrag(e, resolve()));
    card.addEventListener('dragend', () => { if (songDragState?.preview?.isConnected) songDragState.preview.remove(); songDragState = null; clearQueueDropTarget(); });
    const badge=card.querySelector('.play-badge');
    badge?.addEventListener('click',e=>{e.stopPropagation();clearTimeout(clickTimer);const m=resolve();if(m?.tracks?.length)playQueue(m.tracks,0);});
  }

  // ---------------- cover art session cache ----------------
  // Keep a small set of recently requested cover URLs warm without replacing
  // the actual mbcover:// image source with blob URLs. This avoids breaking
  // Electron custom-protocol image loading while still reducing repeat fetches.
  const COVER_MEMORY_CACHE_LIMIT = 150;
  const coverMemoryCache = new Map(); // source URL -> Image
  function primeCoverCache(src) {
    if (!src || /^https?:\/\//i.test(src) || coverMemoryCache.has(src)) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      coverMemoryCache.delete(src);
      coverMemoryCache.set(src, img);
      while (coverMemoryCache.size > COVER_MEMORY_CACHE_LIMIT) {
        coverMemoryCache.delete(coverMemoryCache.keys().next().value);
      }
    };
    img.src = src;
  }
  function lazyCoverImg(src) {
    // Native Chromium lazy-loading is enough here. Do not proactively create
    // an Image object for every album card: on a large library that turns the
    // startup into a burst of thousands of cover requests despite loading=lazy.
    return `<img src="${src}" alt="" loading="lazy"/>`;
  }

  // The current Beehive image markup uses native HTML lazy-loading directly.
  // Keep this observer hook as a harmless compatibility helper for the album
  // and artist renderers that call it after rebuilding their grids. Older
  // observer-based implementations are no longer needed, and this must never
  // interfere with cover loading or playback state.
  function observeLazyImages(root) {
    if (!root) return;
    const images = root.querySelectorAll?.('img[loading="lazy"]');
    if (!images) return;
    for (const img of images) img.loading = 'lazy';
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
    const tracks = (album.tracks || []).slice().sort((a,b) =>
      (Number(a.disk)||0)-(Number(b.disk)||0) || (Number(a.track)||0)-(Number(b.track)||0) || songCollator.compare(a.title||'', b.title||'')
    );
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

    // The expanded panel is a newly-created target. If it belongs to the
    // currently playing album, attach it to the EXISTING current-track
    // rotator without restarting/resetting the rotation index. This keeps
    // the expanded cover synchronized with Now Playing even when the panel
    // is opened several seconds after playback started.
    const current = currentQueue[currentIndex];
    if (current && albumKey(current) === key) {
      const expandedImg = panel.querySelector('.inline-album-cover img');
      if (expandedImg) nowPlayingRotator.retarget([expandedImg]);
    }

    const cards = Array.from(container.children).filter(node => node.classList?.contains('album-card'));
    const clickedTop = card.offsetTop;
    const rowCards = cards.filter(node => Math.abs(node.offsetTop - clickedTop) <= 2);
    const lastCardInRow = rowCards[rowCards.length - 1] || card;
    lastCardInRow.after(panel);
    card.classList.add('inline-expanded');
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
    el.artistSortTools?.classList.add('hidden');
    if (el.albumSortBtn) {
      el.albumSortBtn.textContent = albumYearDividers ? 'Years: On' : 'Years: Off';
      el.albumSortBtn.title = albumYearDividers
        ? 'Hide the year dividers and keep the albums in one continuous row flow.'
        : 'Show release years as visual section dividers.';
    }

    const groupByYear = albumYearDividers;
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
  }

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

    const sorted = sortTracks(filtered);
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
      const value = songColumnDef(key)?.get?.(t) ?? '';
      if (key === 'title') return `<span class="s-title song-title-cell"><img class="song-thumb" src="${coverSrc(t.cover)}" alt="" loading="lazy" /> <span>${escapeHtml(value)}</span></span>`;
      if (key === 'rating') return `<span class="s-rating">${ratingStars(t)}</span>`;
      return `<span class="s-${escapeHtml(key)} dim">${escapeHtml(value)}</span>`;
    }).join('');
    return `<div class="song-row" data-idx="${i}" data-path="${escapeHtml(t.path || '')}">${cells}</div>`;
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
    win.querySelectorAll('.song-row').forEach(row => {
      const i = Number(row.dataset.idx);
      bindSongSelection(row, tracks, i);
      bindSongDrag(row, tracks[i]);
      row.addEventListener('dblclick', () => playQueue(tracks, i));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); prepareTrackContextSelection(tracks[i], tracks); showTrackContextMenu(e.clientX,e.clientY,tracks[i]); });
      bindRatingClicks(row, tracks);
    });
  }

  function buildArtistPickerEntries(sourceTracks = library.tracks) {
    const map = new Map();
    for (const t of sourceTracks) {
      const key = String(t.albumArtist || t.artist || '').trim();
      if (!key) continue;
      if (!map.has(key)) map.set(key, { name: key, cover: t.cover, covers: t.covers, tracks: [] });
      const entry = map.get(key);
      entry.tracks.push(t);
      if (!entry.cover && t.cover) { entry.cover = t.cover; entry.covers = t.covers; }
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

  let legacyArtScaling = false;
  const LEGACY_ART_SCALING_KEY = 'beehive:legacy-art-scaling';
  function loadLegacyArtScaling() {
    try { return localStorage.getItem(LEGACY_ART_SCALING_KEY) === 'true'; } catch { return false; }
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

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setView(mode) {
    viewMode = mode;
    el.viewBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    if (el.albumSortBtn) el.albumSortBtn.classList.toggle('hidden', mode !== 'albums');
    if (el.artistBackBtn) el.artistBackBtn.classList.toggle('hidden', !(((artistSearchTerm && mode === 'albums') || (albumSearchReturnState && specialView === 'album-focus' && mode === 'albums'))));
    if (el.sectionTitleText) el.sectionTitleText.textContent = artistSearchTerm ? artistSearchTerm : (mode === 'artists' ? 'Artists' : mode === 'songs' ? 'Tracks' : 'Albums');
    if (el.artistSortTools) el.artistSortTools.classList.add('hidden');
    if(specialView){
      if(specialView==='playlist' && activePlaylistId){
        const pl=playlists.find(p=>String(p.id)===String(activePlaylistId));
        if(pl){
          hideContentViews();
          el.albumsToolbar.classList.remove('hidden');
          if (el.sectionTitleText) el.sectionTitleText.textContent=pl.name || 'Playlist';
          const playlistTracks = tracksForPlaylist(pl);
          if(viewMode==='albums'){
            el.albumsGrid.classList.remove('hidden');
            renderAlbums();
          } else if(viewMode==='songs'){
            el.songsTable.classList.remove('hidden');
            renderSongsTable();
          } else if(viewMode==='artists'){
            el.artistsGrid.classList.remove('hidden');
            renderArtists(playlistTracks);
          }
        }
        saveActiveTabState();
        updateActiveTabLabel();
        return;
      }
      if(specialView==='history'){
        window.beehive.getHistory().then(h=>{const t=historyTracks(h||[]);showLibraryView('History',t,'history');});
      } else if(specialView==='recent'){
        showLibraryView('Recently Added',getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100),'recent');
      } else if(specialView==='top'){
        showLibraryView('Top 25 Most Played',[...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25),'top');
      } else if(specialView==='favorites'){
        showLibraryView('Favorites',library.tracks.filter(t=>t.loved),'favorites');
      } else if(specialView==='folder' && activeFolderPath){
        const folderName = activeFolderPath.split(/[\\/]/).filter(Boolean).pop() || activeFolderPath;
        showLibraryView(folderName, tracksForFolder(activeFolderPath), 'folder');
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
  function playQueue(tracks, startIndex=0, respectShuffle=true) {
    // An explicit queue/album/track play action is a user-initiated transport
    // command. It must be allowed to start playback even when startup restored
    // a previous session in the deliberately-paused state.
    startupPlaybackLocked = false;
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
    selectedQueueIndex = currentIndex;
    selectedQueueIndices.clear();
    if (currentIndex >= 0) selectedQueueIndices.add(currentIndex);
    activeSelectionScope = 'queue';
    playbackHistory = [];
    renderQueue();
    saveQueueSession();
    loadAndPlayCurrent();
  }

  function queueRowHtml(t, i) {
    return `<li class="queue-row${i === currentIndex ? ' playing' : ''}${selectedQueueIndices.has(i) ? ' selected' : ''}" data-idx="${i}">
      <img class="q-thumb" src="${coverSrc(visualCoverForTrack(t))}" alt="" loading="lazy" />
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

    // Keep the native GStreamer pipeline's current track and next URI aligned
    // with the newly visible queue order. Rebuild only while actually playing;
    // a paused pipeline can simply receive the new NEXT URI.
    if (gstActive) {
      const position = Number(gstPosition) || 0;
      if (!enginePaused) {
        gstStop();
        if (currentQueue[currentIndex]?.path) gstLoadCurrent(position);
      } else {
        gstSendNext();
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

  function bindQueueRows() {
    el.queueList.querySelectorAll('.queue-row').forEach(row => {
      const i = Number(row.dataset.idx);
      const t = currentQueue[i];
      if (!t) return;
      row.draggable = true;
      row.classList.toggle('selected', selectedQueueIndices.has(i));
      row.addEventListener('dragstart', e => beginQueueRowDrag(e, i));
      row.addEventListener('dragend', () => {
        queueDragState = null;
        if (el.queueList) el.queueList.querySelectorAll('.queue-drop-target').forEach(r => { r.classList.remove('queue-drop-target'); delete r.dataset.dropSide; });
        queueDropIndex = -1;
      });
      row.addEventListener('click', (e) => {
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
      row.addEventListener('dblclick', () => {
        // Queue-row double-click is an explicit user playback command. It always
        // means "play this song from the beginning" — including when this is
        // the track restored from the previous session with a saved position.
        startupPlaybackLocked = false;
        if (currentQueue[currentIndex] && currentQueue[currentIndex] !== currentQueue[i]) playbackHistory.push(currentQueue[currentIndex]);
        currentIndex = i;
        selectedQueueIndex = i;
        activeOffset = 0;
        activeDuration = 0;
        pendingRestoredOffset = null;
        loadAndPlayCurrent();
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); showTrackContextMenu(e.clientX,e.clientY,t); });

      row.addEventListener('dragover', (e) => {
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
      row.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || !row.contains(e.relatedTarget)) { row.classList.remove('queue-drop-target'); delete row.dataset.dropSide; }
      });
      row.addEventListener('drop', (e) => {
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

  function updateQueueVirtualRows(force = false) {
    if (!el.queueList) return;
    const tracks = currentQueue || [];
    const spacer = el.queueList.querySelector('.queue-virtual-spacer');
    const win = el.queueList.querySelector('.queue-virtual-window');
    if (!spacer || !win) return;
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
    win.style.transform = `translateY(${start * rowHeight}px)`;
    win.style.width = '100%';
    win.innerHTML = tracks.slice(start, end).map((t, local) => queueRowHtml(t, start + local)).join('');
    bindQueueRows();
    // Virtualization can replace the currently-playing queue row while the user
    // scrolls. Retarget the existing rotator to the newly-created thumbnail
    // without restarting its four-second timer. This keeps only the current row
    // rotating while allowing every other queue row to remain static.
    const current = currentQueue[currentIndex];
    if (current && Number.isInteger(currentIndex)) {
      const currentRow = el.queueList.querySelector(`.queue-row[data-idx="${currentIndex}"]`);
      const currentThumb = currentRow?.querySelector('.q-thumb');
      if (currentThumb) nowPlayingRotator.retarget([el.pbCover, el.npCover, currentThumb]);
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
      if (!album) continue;
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
    el.queueList.innerHTML = '<li class="queue-virtual-spacer" aria-hidden="true"></li><div class="queue-virtual-window"></div>';
    el.queueList.style.position = 'relative';
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
  }

  if (el.queueList) {
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

  async function loadAndPlayCurrent() {
    const t = currentQueue[currentIndex];
    if (!t?.path) return;
    if (!gstAvailabilityKnown && !gstAvailabilityPromise && window.beehive.gstreamerStatus) {
      gstAvailabilityPromise = window.beehive.gstreamerStatus().then(v => { gstAvailable = !!v; gstAvailabilityKnown = true; return gstAvailable; }).catch(() => { gstAvailable = false; gstAvailabilityKnown = true; return false; });
    }
    if (gstAvailabilityPromise) await gstAvailabilityPromise;
    if (gstAvailable && gstCompatibleQueue()) {
      // GStreamer is the sole playback owner on this path. If the previous
      // track was being rendered by the fallback Web Audio transport, stop its
      // live source before handing the queue to GStreamer. Otherwise an album
      // double-click can briefly leave both transports audible at once, making
      // the perceived volume higher than the volume meter indicates.
      cancelScheduledNext();
      stopActiveSource();
      if (gstActive) gstStop();
      const desired = Number.isFinite(Number(pendingRestoredOffset)) ? Number(pendingRestoredOffset) : 0;
      pendingRestoredOffset = null;
      if (await gstLoadCurrent(desired)) return;
    }

    const generation = ++engineGeneration;
    const ctx = ensureAudioContext();
    await ctx.resume();
    cancelScheduledNext();
    stopActiveSource();
    enginePaused = false;
    engineEnded = false;
    try {
      const buffer = await decodeTrack(t);
      if (generation !== engineGeneration) return;
      const start = Math.max(0, parseTimeValue(t.startTime));
      const end = Math.max(0, parseTimeValue(t.endTime));
      const available = Math.max(0, buffer.duration - start);
      const duration = end > start ? Math.min(end - start, available) : available;
      if (duration <= 0) throw new Error('Track has no playable duration');
      const restoredOffset = Number.isFinite(Number(pendingRestoredOffset))
        ? Math.max(0, Math.min(duration, Number(pendingRestoredOffset)))
        : 0;
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
      recordTrackPlayed(t);
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
    if (!t?.path) return;
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

  async function updateNowPlayingUI(t) {
    window.__beehiveNowPlayingTrack = t;
    syncDiscordPresence(t, audioEngine.paused, true);

    // Clear the previous song's artwork synchronously on a track change. This
    // function performs a few asynchronous metadata reads before the new
    // artwork is resolved; leaving the old <img>.src in place during that
    // window produces a visible one-frame/one-tick flash of the previous song
    // when skipping. The cover rotator will paint the new decoded artwork once
    // it is ready.
    if (el.pbCover) el.pbCover.src = placeholderCover();
    if (el.npCover) el.npCover.src = placeholderCover();
    const transitionBackdrop = document.querySelector('.np-cover-stage');
    if (transitionBackdrop) transitionBackdrop.style.removeProperty('--cover-backdrop');
    // The expanded album viewer is shared UI state. Update its playing marker
    // in place so playback changes never close/rebuild the open album panel.
    refreshInlineTrackPlayingState();
    // The bottom heart is driven by the actual embedded Love state, not a
    // potentially stale queue/library copy. This keeps it synchronized with
    // the right-click Rating > Love action and with tags changed externally.
    if (t?.path) {
      try {
        const actualLoved = !!(await window.beehive.readLove(t.path));
        syncLoveStateForPath(t.path, actualLoved);
      } catch {}
    }
    const visualCover = visualCoverForTrack(t);
    const cover = coverSrc(visualCover);
    // Playback must update the dynamic accent too. Album single-clicks already
    // do this when opening their inline panel, but double-click playback goes
    // straight through playQueue(), so the playing album needs to refresh the
    // palette here as the single source of truth.
    const paletteCover = visualCoverForTrack(t);
    if (paletteCover) applyPaletteFromCover(coverSrc(paletteCover));
    const coverBackdrop = document.querySelector('.np-cover-stage');
    if (coverBackdrop) {
      const firstCover = visualCoverForTrack(t);
      coverBackdrop.style.setProperty('--cover-backdrop', `url(\"${coverSrc(firstCover).replace(/\"/g, '\\"')}\")`);
    }

    el.pbCover.title = 'Double-click for cover art';
    el.pbCover.ondblclick = () => openCoverLightbox(t);
    el.pbCover.oncontextmenu = e => { e.preventDefault(); showCoverContextMenu(e, t.covers?.[0]?.file || t.cover, t); };
    el.pbTitle.textContent = t.title;
    el.pbArtist.textContent = t.artist;

    el.npCover.title = 'Double-click for cover art';
    el.npCover.ondblclick = () => openCoverLightbox(t);
    el.npCover.oncontextmenu = e => { e.preventDefault(); showCoverContextMenu(e, t.covers?.[0]?.file || t.cover, t); };
    // The large Now Playing area carries the full useful track metadata.
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

    // The Now Playing heart is authoritative to MusicBee's exact LOVE RATING field.
    // Do not infer Love from legacy TXXX:Love or from a stale cached value.
    let fileLoved = !!t.loved;
    try {
      fileLoved = !!(await window.beehive.readLove(t.path));
      t.loved = fileLoved;
      const libTrack = library.tracks.find(x => String(x?.path || '') === String(t.path || ''));
      if (libTrack) libTrack.loved = fileLoved;
    } catch {}
    el.btnLove.innerHTML = (fileLoved ? ic.heartFilled : ic.heartOutline) || '';
    el.btnLove.classList.toggle('loved', fileLoved);
    el.btnLove.dataset.path = t.path;

    // Never overwrite embedded lyrics. If a track has no embedded lyrics, try an online lookup
    // for display only; if nothing is found, leave the lyrics panel blank.
    const embeddedLyrics = String(t.lyrics || '').trim();
    const trackAlign = String(t.customTags?.LYRICS_ALIGNMENT || localStorage.getItem('beehive:lyrics-alignment') || 'center').toLowerCase();
    applyLyricsAlignment(trackAlign);
    renderLyrics(embeddedLyrics, t);
    if (el.lyricsRail) {
      el.lyricsRail.onscroll = handleLyricsScroll;
      el.lyricsRail.oncontextmenu = e => { e.preventDefault(); showLyricsContextMenu(e, t); };
    }
    if (!embeddedLyrics && t.artist && t.title && !t.podcast) {
      const lookupId = `${t.path || ''}|${t.artist}|${t.title}|${t.album || ''}|${t.duration || 0}`;
      const previous = lyricsLookupCache.get(lookupId);
      if (previous !== undefined) {
        renderLyrics(previous || '', t);
      } else {
        renderLyrics('', t);
        window.beehive.searchLyrics({artist:t.artist,title:t.title,album:t.album,duration:t.duration}).then(found => {
          lyricsLookupCache.set(lookupId, found || '');
          if (currentQueue[currentIndex] === t && !String(t.lyrics || '').trim()) renderLyrics(found || '', t);
        }).catch(() => lyricsLookupCache.set(lookupId, ''));
      }
    }

    refreshCoverRotationTargets();

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
  // source of the large Now Playing image can otherwise force Chromium to
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
          finish(token === generation ? true : true);
        };
        img.onerror = () => finish(false);
      });
      img.src = src;
      // Keep the promise on the object so duplicate targets do not start
      // another decode for the same cover.
      img.__beehiveDecodePromise = promise;
      return promise;
    }

    function apply(immediate) {
      const item = items[idx];
      const src = sourceFor(item);
      imgs.forEach(img => {
        if (!img) return;
        // No opacity transition here. Instant swapping after decode is much
        // cheaper than animating a large cover and avoids a visible Discord
        // video hitch at the exact moment the artwork changes.
        img.style.transition = 'none';
        img.style.opacity = '1';
        img.src = src;
      });
      // Prepare the next image before the next four-second rotation.
      if (items.length > 1) {
        const nextSrc = sourceFor(items[(idx + 1) % items.length]);
        preload(nextSrc, generation);
      }
    }

    function stop() {
      clearInterval(timer);
      timer = null;
      generation++;
    }

    async function start(coverItems, imgEls) {
      stop();
      items = (coverItems && coverItems.length) ? coverItems : [{ file: null }];
      imgs = (imgEls || []).filter(Boolean);
      idx = 0;
      const token = generation;

      // Decode the first cover before painting the targets when possible.
      const firstSrc = sourceFor(items[0]);
      await preload(firstSrc, token);
      if (token !== generation) return;
      apply(true);

      if (items.length > 1) {
        timer = setInterval(async () => {
          const nextIndex = (idx + 1) % items.length;
          const nextSrc = sourceFor(items[nextIndex]);
          await preload(nextSrc, generation);
          if (token !== generation) return;
          idx = nextIndex;
          apply(false);
        }, 4000);
      }
    }

    return {
      start,
      stop,
      retarget(imgEls) {
        const additions = (imgEls || []).filter(Boolean);
        imgs = Array.from(new Set([...(imgs || []), ...additions]));
        if (!items.length) return;
        apply(true);
      }
    };
  }

  const nowPlayingRotator = createCoverRotator();

  // Re-collects which on-screen <img> elements should be showing/rotating
  // the current track's cover(s): playbar, now-playing card, its grid card
  // (if rendered), and the album panel (if it's open on this same album).
  function refreshCoverRotationTargets() {
    const t = currentQueue[currentIndex];
    if (!t) { nowPlayingRotator.stop(); return; }

    const items = distinctCovers(t);
    artworkDebug('refreshing current-track cover rotation targets', { path: t?.path || '', queueIndex: currentIndex, embeddedCoverCount: items.length, hasTemporaryArtwork: automaticCoverVisuals.has(String(t?.path || '')) });
    if (items.length) clearAutomaticCoverVisual(t);
    if (!items.length) {
      const temporary = automaticCoverVisuals.get(String(t.path || ''));
      if (temporary) items.push({ file: temporary, type: 'Automatic visual artwork' });
    }
    const key = albumKey(t);
    const targets = [el.pbCover, el.npCover];
    const currentRow = el.queueList?.querySelector(`.queue-row[data-idx="${currentIndex}"]`);
    const currentQueueThumb = currentRow?.querySelector('.q-thumb');
    if (currentQueueThumb) targets.push(currentQueueThumb);

    document.querySelectorAll(`.album-card[data-key]`).forEach((card) => {
      if (card.dataset.key === key) {
        const img = card.querySelector('img');
        if (img) targets.push(img);
      }
    });

    // If this exact album is currently expanded, its large inline cover is part
    // of the same visual surface as Now Playing. Keep it on the exact same
    // rotator so front/back/other embedded artwork changes in sync with the
    // playbar and Now Playing cover. Never rotate an unrelated expanded album.
    document.querySelectorAll('.inline-album-dropdown[data-album-key]').forEach(panel => {
      if (String(panel.dataset.albumKey || '') !== key) return;
      const img = panel.querySelector('.inline-album-cover img');
      if (img) targets.push(img);
    });

    nowPlayingRotator.start(items, targets);
  }

  function resetPaletteToNeutral() {
    const root = document.documentElement.style;
    root.setProperty('--accent', 'hsla(220, 6%, 62%, 1)');
    root.setProperty('--accent-soft', 'hsla(220, 6%, 72%, 0.38)');
    root.setProperty('--accent-glow', 'hsla(220, 6%, 55%, 0.28)');
    root.setProperty('--ambient-a', 'hsla(220, 5%, 28%, 0.22)');
    root.setProperty('--ambient-b', 'hsla(220, 5%, 22%, 0.18)');
  }

  const paletteCache = new Map();
  let paletteRequestId = 0;

  function applyPaletteFromCover(src) {
    if (!src) return;
    const cached = paletteCache.get(src);
    const root = document.documentElement.style;
    if (cached) {
      root.setProperty('--accent', cached.accent);
      root.setProperty('--accent-soft', cached.accentSoft);
      root.setProperty('--accent-glow', cached.accentGlow);
      root.setProperty('--ambient-a', cached.ambientA);
      root.setProperty('--ambient-b', cached.ambientB);
      return;
    }
    const requestId = ++paletteRequestId;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      const palette = await window.BeehiveColor.extractPaletteFromImage(img);
      paletteCache.set(src, palette);
      if (requestId !== paletteRequestId) return;
      const root = document.documentElement.style;
      root.setProperty('--accent', palette.accent);
      root.setProperty('--accent-soft', palette.accentSoft);
      root.setProperty('--accent-glow', palette.accentGlow);
      root.setProperty('--ambient-a', palette.ambientA);
      root.setProperty('--ambient-b', palette.ambientB);
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
  function renderShuffleButton() {
    el.btnShuffle.innerHTML = (shuffle ? ic.shuffle : ic.shuffleOff) || ic.shuffle || '';
    el.btnShuffle.title = shuffle ? 'Shuffle on' : 'Shuffle off';
    el.btnShuffle.classList.toggle('active', shuffle);
    el.btnShuffle.dataset.mode = shuffle ? 'on' : 'off';
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
    if (op === 'VOLUME') { audioEngine.volume = Number(rest[0]); saveLastPlayback(); return; }
    if (op === 'SHUFFLE') {
      const wanted = rest[0] === 'true';
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
      loadAndPlayCurrent();
      return;
    }
    if (audio.paused) audio.play(true); else audio.pause();
  });
  audio.addEventListener('play', () => { el.btnPlay.innerHTML = ic.pause || ''; });
  audio.addEventListener('pause', () => { el.btnPlay.innerHTML = ic.play || ''; });

  el.btnNext.addEventListener('click', () => goNext());
  el.btnPrev.addEventListener('click', () => goPrev());

  function goNext() {
    if (!currentQueue.length) return;
    const current = currentQueue[currentIndex];
    if (current) playbackHistory.push(current);

    if (repeat === 2) {
      audio.currentTime = 0;
      loadAndPlayCurrent();
      return;
    }
    clearAutomaticCoverVisual(current);
    if (shuffle) {
      // Shuffle is represented by the queue order itself. Advancing simply
      // walks that already-shuffled queue so what the user sees matches what
      // will actually play next.
      currentIndex += 1;
      if (currentIndex >= currentQueue.length) {
        if (repeat !== 1) {
          currentIndex = currentQueue.length - 1;
          audio.pause();
          renderQueue();
          return;
        }
        currentIndex = 0;
      }
    } else {
      currentIndex += 1;
      if (currentIndex >= currentQueue.length) {
        if (repeat !== 1) {
          currentIndex = currentQueue.length - 1;
          audio.pause();
          return;
        }
        currentIndex = 0;
      }
    }
    loadAndPlayCurrent();
  }
  function goPrev() {
    if (!currentQueue.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }

    // Previous follows actual playback history, never the shuffled queue order.
    // This makes Back behave like a music player's listening history.
    while (playbackHistory.length) {
      const previous = playbackHistory.pop();
      const previousIndex = currentQueue.indexOf(previous);
      if (previousIndex >= 0) {
        currentIndex = previousIndex;
        loadAndPlayCurrent();
        return;
      }
    }

    // Non-shuffle queues retain their normal sequential Previous behavior.
    if (!shuffle) {
      currentIndex = Math.max(0, currentIndex - 1);
      loadAndPlayCurrent();
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
  });

  function saveLastPlayback() { savePlaybackSession(false); }

  function restoreLastPlayback() {
    return restoreSavedQueue();
  }
  window.addEventListener('beforeunload', () => savePlaybackSession(true));
  window.addEventListener('pagehide', () => savePlaybackSession(true));
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
    if (isScrubbing) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const next = Math.max(0, Math.min(audio.duration, Number(el.pbSeek.value) || 0));
    try { audio.currentTime = next; } catch {}
    updateSeekUI();
    saveLastPlayback();
  });

  el.pbVolume.addEventListener('input', () => {
    audio.volume = Number(el.pbVolume.value) / 100;
    if (Number(el.pbVolume.value) > 0) audio.muted = false;
    el.pbVolume.style.setProperty('--volume-progress', `${Math.max(0, Math.min(100, Number(el.pbVolume.value) || 0))}%`);
    renderVolumeIcon();
    saveLastPlayback();
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
  audio.volume = Number(el.pbVolume.value) / 100;

  let volBeforeMute = Number(el.pbVolume.value) || 80;
  el.pbVolIcon.addEventListener('click', () => {
    if (!audio.muted && Number(el.pbVolume.value) > 0) {
      volBeforeMute = Number(el.pbVolume.value);
      audio.muted = true;
      el.pbVolume.value = '0';
    } else {
      audio.muted = false;
      el.pbVolume.value = String(volBeforeMute || 80);
      audio.volume = Number(el.pbVolume.value) / 100;
    }
    el.pbVolume.style.setProperty('--volume-progress', `${Math.max(0, Math.min(100, Number(el.pbVolume.value) || 0))}%`);
    renderVolumeIcon();
    saveLastPlayback();
  });
  el.pbVolume.style.setProperty('--volume-progress', `${Math.max(0, Math.min(100, Number(el.pbVolume.value) || 0))}%`);
  renderVolumeIcon();

  el.btnShuffle.addEventListener('click', async () => {
    const wasShuffle = shuffle;
    const currentPath = String(currentQueue[currentIndex]?.path || '');
    shuffle = !shuffle;

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

    renderShuffleButton();

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
    library = lib || { tracks: [] };
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
      playlists = Array.isArray(playlistList) ? playlistList : [];
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
            const needsLoveRefresh = await window.beehive.needsLovedRefresh?.();
            if (needsLoveRefresh) {
              console.info('[Beehive] FAVORITES LOVE RECONCILIATION STARTED');
              const loveResult = await refreshCachedLovesInBackground();
              console.info('[Beehive] FAVORITES LOVE RECONCILIATION FINISHED', {
                total: loveResult?.total || 0,
                loved: loveResult?.loved || 0,
                failed: loveResult?.failed || 0
              });
            } else {
              console.info('[Beehive] FAVORITES LOVE CACHE ALREADY HYDRATED');
            }
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
    if (tagOperationActive) {
      el.scanProgress.classList.remove('hidden');
      if (el.scanTitle) el.scanTitle.textContent = payload.operationLabel || 'Metadata operation';
      const done = Number(payload.done || 0);
      const total = Number(payload.total || 0);
      const pct = total ? Math.round((done / total) * 100) : 0;
      el.scanFill.style.width = pct + '%';
      const failed = Number(payload.failed || 0);
      const success = Number(payload.updated || 0);
      const current = payload.current ? ` · ${payload.current}` : '';
      const failedText = failed ? ` · ${failed} failed` : '';
      const skipped = Number(payload.skipped || 0);
      const skippedText = skipped ? ` · ${skipped.toLocaleString()} skipped` : '';
      const phase = payload.phase ? `${payload.phase} · ` : '';
      el.scanLabel.textContent = `${phase}${done.toLocaleString()} / ${total.toLocaleString()} files · ${success.toLocaleString()} completed${failedText}${skippedText}${current}`;
    } else if (!scanRunning) {
      el.scanProgress.classList.add('hidden');
      const paths = Array.isArray(payload.paths) ? payload.paths.filter(Boolean) : [];
      if (paths.length) {
        // The worker has finished the physical writes. Now, and only now, make
        // the disk-read metadata authoritative for library, queue and Now Playing.
        // Give the playback/rendering pipeline a short quiet window after the
        // final low-priority rewrite before starting the incremental reread.
        setTimeout(() => {
          void reconcileArtworkAfterBackgroundWrite(paths, { searchMissing: true, warmAlbum: true })
            .catch(err => console.warn('[Beehive] background metadata reconciliation failed:', err?.message || err));
        }, 350);
      }
    }
  }
  tagOperationOff = window.beehive.onTagProgress?.(showTagOperationProgress) || null;

  let scanTrackRenderQueued = false;
  let scanTrackRenderNeeded = false;
  const offScanTrack = window.beehive.onScanTrack?.((incoming) => {
    const track = incoming && typeof incoming === 'object' ? incoming : null;
    const filePath = String(track?.path || '');
    if (!filePath) return;
    // Scan events arrive once per changed file. Use the maintained path index here;
    // a linear .find() over 30k tracks for every event turns a full first scan into
    // quadratic renderer work and can make the UI appear frozen.
    const existing = libraryTrackByPath.get(filePath) || null;
    const wasLoved = !!existing?.loved;
    if (existing) Object.assign(existing, track);
    else library.tracks.push(track);
    libraryTrackByPath.set(filePath, existing || track);
    if (specialView === 'favorites' && wasLoved !== !!track.loved) scanTrackRenderNeeded = true;
    if (specialView === 'favorites' && !!track.loved) scanTrackRenderNeeded = true;
    if (!scanTrackRenderNeeded || scanTrackRenderQueued) return;
    scanTrackRenderQueued = true;
    requestAnimationFrame(() => {
      scanTrackRenderQueued = false;
      if (!scanTrackRenderNeeded) return;
      scanTrackRenderNeeded = false;
      renderCurrentView();
    });
  });

  let scanRunning = false;
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
      startupMark('SCAN RESULT RECEIVED', { tracks:lib?.tracks?.length || 0 });
      await applyLibraryProgressive(lib, { status: false });
      startupMark('SCAN RESULT APPLIED', { tracks:library?.tracks?.length || 0 });
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
      if(specialView==='favorites'){const t=library.tracks.filter(t=>t.loved);return viewMode==='albums'?renderSpecialAlbums(t):renderSpecialSongs(t);}
      if(specialView==='folder' && activeFolderPath){return setView(viewMode);}
      if(specialView==='playlist' && activePlaylistId){const pl=playlists.find(p=>String(p.id)===String(activePlaylistId));if(pl)return setView(viewMode);}
      if(specialView==='history')return window.beehive.getHistory().then(h=>{const t=historyTracks(h||[]);return viewMode==='albums'?renderSpecialAlbums(t):renderSpecialSongs(t);});
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
    if(nav==='pl-recent'){
      return getRecentlyAddedTracks().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,100);
    }
    if(nav==='pl-top'){
      return [...library.tracks].filter(t=>(t.playCount||0)>0).sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,25);
    }
    if(nav==='pl-favorites'){
      return library.tracks.filter(t=>t.loved);
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
    if(nav==='nowplaying'){
      const current=currentQueue?.[currentIndex];
      return current?.path ? [current] : [];
    }
    return [];
  }

  async function playSidebarCollection(nav){
    const tracks=await getSidebarCollectionTracks(nav);
    if(tracks.length) {
      // Use the exact same explicit-play path as Favorites. If Shuffle is
      // enabled, choose a random starting track and let playQueue() shuffle
      // the remainder while keeping that chosen track first.
      const startIndex = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
      playQueue(tracks,startIndex);
    }
    return true;
  }

  async function exportSidebarCollection(nav){
    const names={
      music:'Music',
      explorer:'Music Explorer',
      history:'History',
      'pl-explorer':'Playlist Explorer',
      'pl-favorites':'Favorites',
      'pl-recent':'Recently Added',
      'pl-top':'Top 25 Most Played',
      nowplaying:'Now Playing'
    };
    const tracks=await getSidebarCollectionTracks(nav);
    return exportPlaylist(names[nav] || 'Beehive',tracks);
  }

  el.sidebarItems.forEach(item=>{
    item.addEventListener('click',async()=>{
      const nav=item.dataset.nav;
      if(nav==='nowplaying'){el.sidebarItems.forEach(i=>i.classList.remove('active'));item.classList.add('active');return;}
      if(nav==='explorer')return;
      if(nav==='music'){
        const musicTab = tabs.find(t => t.kind === 'music');
        if (musicTab) {
          // If we are currently inside a temporary sidebar context, restore
          // the Music browser state that was saved before entering it.
          restoreMusicBrowserState();
        }
        specialView=null;
        activePlaylistId=null;
        activeFolderPath='';
        el.main.classList.remove('searching');
        el.sidebarItems.forEach(i=>i.classList.toggle('active',i===item));
        if (getActiveTab()?.kind === 'music') {
          const activeMusicTab = getActiveTab();
          activeMusicTab.baseLabel = 'MUSIC';
          activeMusicTab.baseIcon = '🎵';
          activeMusicTab.label = 'MUSIC';
          activeMusicTab.icon = '🎵';
          renderTabs();
          saveActiveTabState();
          updateActiveTabLabel();
        }
        return;
      }
      await showSpecialNavigation(nav);
    });
    item.addEventListener('dblclick',async e=>{
      e.preventDefault();
      const nav=item.dataset.nav;
      if(['music','explorer','history','pl-recent','pl-top','pl-favorites','pl-explorer','nowplaying'].includes(nav)) {
        await playSidebarCollection(nav);
      }
    });
    item.addEventListener('contextmenu',async e=>{
      const nav=item.dataset.nav;
      const dynamicNames={ 'pl-favorites':'Favorites','pl-recent':'Recently Added','pl-top':'Top 25 Most Played' };
      if(dynamicNames[nav]){
        const pl=dynamicSidebarPlaylist(nav);
        if(!pl) return;
        e.preventDefault();
        const tracks=pl.dynamicTracks||[];
        const runtime=tracks.reduce((sum,t)=>sum+(Number(t.duration)||0),0);
        const lastAdded=pl.id==='sidebar-recent' && tracks.length ? Number(tracks[0].addedAt||0) : 0;
        showContextMenu(e.clientX,e.clientY,[
          {label:'Add playlist to queue',action:()=>{if(!tracks.length){showAppNotice('This playlist has no tracks.');return;}addTracksToQueue(tracks);}},
          {label:'Playlist info',action:()=>openPlaylistInfo(pl.name, tracks.length, runtime, lastAdded, pl.id.replace('sidebar-','pl-'))},
          {label:'Export as M3U',action:()=>exportSidebarCollection(nav)}
        ]);
        return;
      }
      const fixedNames={
        music:'Music',
        explorer:'Music Explorer',
        history:'History',
        'pl-explorer':'Playlist Explorer',
        nowplaying:'Now Playing'
      };
      if(!fixedNames[nav]) return;
      e.preventDefault();
      showContextMenu(e.clientX,e.clientY,[
        {label:'Play',action:()=>playSidebarCollection(nav)},
        {label:'Export as M3U',action:()=>exportSidebarCollection(nav)}
      ]);
    });
  });

  // ---------------- top bar tabs (Playlists / Music / +) ----------------
  // Each tab owns its own actual content DOM. The library data is shared, but
  // album expansion, rendered cards, scroll position, and view state are not.
  // This is intentionally a DOM-level separation rather than a snapshot of one
  // shared Music browser.
  let tabs = [
    { id: 'tab-playlists', label: 'PLAYLISTS', icon: '\u2630', kind: 'playlists', closable: false, state: null, baseLabel: 'PLAYLISTS', baseIcon: '☰' },
    { id: 'tab-music', label: 'MUSIC', icon: '\uD83C\uDFB5', kind: 'music', closable: true, state: null, baseLabel: 'MUSIC', baseIcon: '🎵' },
    { id: 'tab-beta', label: 'BETA LAB', icon: '🧪', kind: 'beta', closable: false, state: null, baseLabel: 'BETA LAB', baseIcon: '🧪' },
  ];
  let activeTabId = 'tab-music';
  let tabSeq = 0;
  let restoringTabState = false;

  // Discord Rich Presence is intentionally isolated from playback. It receives
  // authoritative track/transport state from the renderer and only talks to the
  // local Discord IPC socket in the main process. It never controls GStreamer.
  let discordPresenceLastPaused = true;
  let discordPresenceLastTrackPath = '';
  let discordPresenceRefreshTimer = 0;
  function discordPresenceTrackPayload(t) {
    if (!t?.path) return null;
    const visual = visualCoverForTrack(t);
    const artworkUrl = typeof visual === 'string' && /^https?:\/\//i.test(visual) ? visual : '';
    return {
      path:String(t.path),
      title:String(t.title || ''),
      artist:String(t.artist || ''),
      album:String(t.album || ''),
      albumArtist:String(t.albumArtist || ''),
      duration:Number(t.duration)||0,
      coverFile:String(visualCoverForTrack(t) || t.cover || ''),
      artworkUrl,
      musicBrainzReleaseId:String(t.musicBrainzReleaseId || t.musicbrainz_albumid || t.MUSICBRAINZ_ALBUMID || '')
    };
  }
  function syncMpris(t = currentQueue[currentIndex], paused = audioEngine.paused) {
    const payload = discordPresenceTrackPayload(t);
    if (!payload) { window.beehive.mprisUpdate?.({ track:null, position:0, duration:0, paused:true, volume:Number(audioEngine.volume)||0, shuffle, repeat }).catch?.(()=>{}); return; }
    const visual = visualCoverForTrack(t);
    const artworkUrl = typeof visual === 'string' && /^https?:\/\//i.test(visual) ? visual : '';
    window.beehive.mprisUpdate?.({ track:payload, position:Number(audioEngine.currentTime)||0, duration:Number(audioEngine.duration)||Number(t.duration)||0, paused:!!paused, volume:Number(audioEngine.volume)||0, shuffle, repeat, artworkUrl }).catch?.(()=>{});
  }

  function syncDiscordPresence(t = currentQueue[currentIndex], paused = audioEngine.paused, force = false) {
    const payload = discordPresenceTrackPayload(t);
    if (!payload) { window.beehive.discordClearActivity?.().catch?.(()=>{}); return; }
    const position = Number(audioEngine.currentTime) || 0;
    // Discord's activity timestamps advance the playback clock on their own.
    // Once a track has been successfully sent, do not resend the full activity
    // (including all metadata) just because the playback position changed.
    // Only a track change, pause/resume transition, or an explicit forced sync
    // should issue another Discord IPC update.
    if (!force && payload.path === discordPresenceLastTrackPath && paused === discordPresenceLastPaused) return;
    window.__beehiveDiscordLastPosition = position;
    // Only advance the local dedupe state after Discord actually accepts the
    // activity. If a pause/resume update fails, leave the state unsynced so the
    // next presence tick can retry it instead of silently getting stuck.
    Promise.resolve(window.beehive.discordUpdateActivity?.({ track:payload, position, paused:!!paused }))
      .then(ok => {
        if (ok !== false) {
          discordPresenceLastTrackPath = payload.path;
          discordPresenceLastPaused = !!paused;
        }
      })
      .catch(() => {});
  }
  function startDiscordPresenceClock() {
    if (discordPresenceRefreshTimer) return;
    discordPresenceRefreshTimer = setInterval(() => {
      if (currentQueue[currentIndex]) {
        // Keep the activity visible while paused. Normally this is a no-op; it
        // also provides a quiet retry if a pause/resume IPC update failed.
        syncDiscordPresence(currentQueue[currentIndex], !!audioEngine.paused, false);
        if (!audioEngine.paused) syncMpris(currentQueue[currentIndex], false);
      }
    }, 5000);
  }
  startDiscordPresenceClock();

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
    host.className = 'tab-content-host beta-lab-host';
    host.dataset.tabId = 'tab-beta';
    host.innerHTML = `<div class="beta-lab">
      <div class="beta-hero">
        <div><div class="beta-kicker">HIVE EXPERIMENTAL WORKSHOP</div><h1>🧪 Beta Lab</h1><p>Every unfinished community-grade feature lives here first. Test the UI, expose edge cases, and promote only the pieces that prove themselves.</p></div>
        <div class="beta-hero-actions"><button class="sidebar-add" id="beta-refresh">Refresh diagnostics</button><span class="beta-safe-badge">READ-ONLY BY DEFAULT</span></div>
      </div>
      <div class="beta-summary" id="beta-summary"></div>
      <section class="beta-section beta-readiness-section"><div class="beta-section-head"><div><h2>🛡 1.0 readiness control center</h2><p>Read-only engineering checks for the boundaries that can make or break a production release. Nothing here writes music metadata.</p></div><span id="beta-readiness-score" class="beta-section-status">NOT RUN</span></div><div class="beta-grid" id="beta-readiness-grid"></div><pre id="beta-readiness-detail" class="beta-diagnostic-detail" hidden></pre></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>🔥 Priority queue</h2><p>These are the areas most likely to affect reliability or deserve dedicated testing before production.</p></div><span class="beta-section-status">WORK THROUGH ONE AT A TIME</span></div><div class="beta-grid" id="beta-priority-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>🎵 MusicBrainz & metadata</h2><p>Identification, matching, tagging, artwork, ratings, Love, and recovery experiments.</p></div></div><div class="beta-grid" id="beta-metadata-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>📚 Library intelligence</h2><p>Health checks, duplicates, statistics, external changes, formats, and smart collections.</p></div></div><div class="beta-grid" id="beta-library-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>🔊 Playback & audio</h2><p>Community-player quality experiments that must never destabilize the established GStreamer path.</p></div></div><div class="beta-grid" id="beta-audio-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>🛡 Reliability & recovery</h2><p>Crash recovery, transactions, regression testing, and production-readiness checks.</p></div></div><div class="beta-grid" id="beta-reliability-grid"></div></section>
      <section class="beta-section"><div class="beta-section-head"><div><h2>🖥 Distribution & ecosystem</h2><p>Cross-platform and community-project polish tracked separately from the core Linux player.</p></div></div><div class="beta-grid" id="beta-platform-grid"></div></section>

      <section class="beta-section beta-notes"><div class="beta-section-head"><div><h2>🧭 Promotion rules</h2><p>A Beta feature is not production-ready just because its button works.</p></div></div><div class="beta-rules"><div><b>1. UI test</b><span>Make the interaction feel right and expose confusing states.</span></div><div><b>2. Data test</b><span>Run it against the real library without corrupting files.</span></div><div><b>3. Failure test</b><span>Interrupt it, restart Beehive, and verify recovery.</span></div><div><b>4. Regression test</b><span>Confirm playback, scanning, queues, and existing workflows remain untouched.</span></div><div><b>5. Promote</b><span>Only then move the feature into the normal Beehive experience.</span></div></div></section>
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

  async function renderBetaLab() {
    const tab = tabs.find(t => t.kind === 'beta'); if (!tab?.dom?.host) return;
    const root = tab.dom.host;
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
      betaCard('MusicBrainz match workspace', 'Side-by-side local metadata versus MusicBrainz release results, with explicit field selection before writing.', 'Prototype', 'Test search', async()=>{ const q=window.prompt('Beta MusicBrainz search', ''); if(!q) return 'Search cancelled.'; const found=await window.beehive.musicBrainzSearchReleaseGroups(q); return `${Array.isArray(found)?found.length:0} release-group results returned.`; }),
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
      betaCard('ReplayGain / EBU R128', 'Analyze loudness and preview track-gain versus album-gain behavior before integrating it with GStreamer.', 'Prototype', 'Open audio test', async()=> 'Safe UI-only prototype: no gain tags or playback settings changed.'),
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
    const musicTab = tabs.find(t => t.kind === 'music');
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
      artistSearchSort: source.artistSearchSort === 'album' ? 'album' : 'release',
      albumYearDividers: source.albumYearDividers !== false,
      viewMode: source.viewMode || 'albums',
      specialView: null,
      tabBaseLabel: 'MUSIC',
      tabBaseIcon: source.tabBaseIcon || musicTab.baseIcon || '🎵',
      activeFolderPath: '',
      activePlaylistId: null,
      openAlbumKey: source.openAlbumKey || null,
      highlightedAlbumKey: source.highlightedAlbumKey || null,
      scrollTop: Number(source.scrollTop || 0),
    };
    return musicTab;
  }

  function restoreMusicBrowserState() {
    const musicTab = tabs.find(t => t.kind === 'music');
    if (!musicTab) return;
    const saved = musicTab.returnState || musicTab.state;
    if (!saved) return;
    musicTab.state = { ...saved, specialView: null, activeFolderPath: '', activePlaylistId: null, tabBaseLabel: 'MUSIC' };
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
    if (tab.kind === 'beta') {
      tab.dom = makeBetaDom();
      el.main.appendChild(tab.dom.host);
      tab.dom.host.addEventListener('scroll', () => { if (activeTabId === tab.id) tab.state = { ...(tab.state || {}), scrollTop: tab.dom.host.scrollTop }; }, { passive: true });
      renderBetaLab();
      return tab.dom.host;
    }
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
    host.addEventListener('scroll', () => {
      if (activeTabId !== tab.id || restoringTabState) return;
      saveActiveTabState();
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
    bar.querySelector('.artist-back-btn')?.addEventListener('click', () => {
      if (activeTabId !== tab.id) return;
      if (albumSearchReturnState) restoreAlbumSearchContext();
      else restoreArtistSearchContext();
    });
    bar.querySelector('.artist-sort-btn')?.addEventListener('click', () => {
      if (activeTabId !== tab.id) return;
      artistSearchSort = artistSearchSort === 'release' ? 'album' : 'release'; renderAlbums();
    });
    const yearsButton = bar.querySelector('#album-sort-btn');
    if (yearsButton) {
      yearsButton.onclick = () => {
        if (activeTabId !== tab.id) return;
        albumYearDividers = !albumYearDividers;
        yearsButton.textContent = albumYearDividers ? 'Years: On' : 'Years: Off';
        yearsButton.title = albumYearDividers
          ? 'Hide the year dividers and keep the albums in one continuous row flow.'
          : 'Show release years as visual section dividers.';
        renderCurrentView();
        syncTabControls();
        saveActiveTabState();
      };
    }
  }

  function bindActiveTabDom(tab) {
    if (!tab?.dom) return;
    el.emptyState = tab.dom.emptyState;
    el.tabPlaceholder = tab.dom.tabPlaceholder;
    el.tabPlaceholderTitle = tab.dom.tabPlaceholder.querySelector('#tab-placeholder-title') || tab.dom.tabPlaceholder.querySelector('h2');
    el.tabPlaceholderBody = tab.dom.tabPlaceholder.querySelector('#tab-placeholder-body') || tab.dom.tabPlaceholder.querySelector('p');
    el.albumsToolbar = tab.dom.albumsToolbar;
    el.albumsGrid = tab.dom.albumsGrid;
    el.artistSortTools = tab.dom.albumsToolbar.querySelector('#artist-sort-tools');
    el.artistSortBtn = tab.dom.albumsToolbar.querySelector('#artist-sort-btn');
    el.albumSortBtn = tab.dom.albumsToolbar.querySelector('#album-sort-btn');
    el.sectionTitle = tab.dom.albumsToolbar.querySelector('#section-title');
    el.sectionTitleText = tab.dom.albumsToolbar.querySelector('#section-title-text');
    el.artistBackBtn = tab.dom.albumsToolbar.querySelector('#artist-back-btn');
    el.viewBtns = Array.from(tab.dom.albumsToolbar.querySelectorAll('.view-btn[data-mode]'));
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
    if (tab.kind === 'beta') { renderBetaLab(); return; }
    bindActiveTabDom(tab);
  }

  function currentTabState(tab = getActiveTab()) {
    const ownOpenAlbum = tab?.dom?.albumsGrid
      ? tab.dom.albumsGrid.querySelector('.album-card.inline-expanded')?.dataset.key || null
      : null;
    return {
      searchTerm,
      artistSearchTerm,
      artistSearchSort,
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

  function saveActiveTabState() {
    if (restoringTabState) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    // Sidebar collections are independent browser surfaces layered over the
    // Music tab. Their Albums/Tracks/Artists choice must never overwrite the
    // Music tab's own view state. Persist the collection view separately and
    // leave the Music tab state untouched so returning to Music restores the
    // exact view the user had there.
    const independentSidebar = ['history','recent','top','favorites','folder'].includes(String(specialView || ''));
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
  }

  function syncTabControls() {
    el.viewBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === viewMode));
    if (el.artistBackBtn) el.artistBackBtn.classList.toggle('hidden', !(((artistSearchTerm && viewMode === 'albums') || (albumSearchReturnState && specialView === 'album-focus' && viewMode === 'albums'))));
    if (el.sectionTitleText) el.sectionTitleText.textContent = artistSearchTerm ? artistSearchTerm : (viewMode === 'artists' ? 'Artists' : viewMode === 'songs' ? 'Tracks' : 'Albums');
    if (el.artistSortTools) el.artistSortTools.classList.toggle('hidden', !(artistSearchTerm && viewMode === 'albums'));
    if (el.artistSortBtn) el.artistSortBtn.textContent = artistSearchSort === 'release' ? 'Sort: Release date' : 'Sort: Album';
    if (el.albumSortBtn) {
      el.albumSortBtn.classList.toggle('hidden', viewMode !== 'albums');
      el.albumSortBtn.textContent = albumYearDividers ? 'Years: On' : 'Years: Off';
      el.albumSortBtn.title = albumYearDividers ? 'Hide the year dividers and keep the albums in one continuous row flow.' : 'Show release years as visual section dividers.';
    }
  }

  function tabContextLabel() {
    if (artistSearchTerm) return artistSearchTerm;
    if (searchTerm) return el.search.value.trim() || searchTerm;
    if (specialView === 'folder' && activeFolderPath) return activeFolderPath.split(/[\\/]/).filter(Boolean).pop() || activeFolderPath;
    if (specialView === 'playlist' && activePlaylistId) {
      const pl = playlists.find(p => String(p.id) === String(activePlaylistId));
      if (pl?.name) return pl.name;
    }
    if (specialView === 'favorites') return 'Favorites';
    if (specialView === 'recent') return 'Recently Added';
    if (specialView === 'top') return 'Top 25 Most Played';
    if (specialView === 'history') return 'History';
    if (viewMode === 'songs') return 'Tracks';
    if (viewMode === 'artists') return 'Artists';
    if (viewMode === 'albums') return 'Albums';
    return 'Music';
  }

  function updateActiveTabLabel(preferredAlbumTitle = null) {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.kind !== 'music') return;

    // Base label comes from the current sidebar/browser context. An album name
    // takes over only while an album is actually expanded in this tab.
    let desired = '';
    if (preferredAlbumTitle && String(preferredAlbumTitle).trim()) {
      desired = String(preferredAlbumTitle).trim();
    } else if (tab.dom?.albumsGrid) {
      const openCard = tab.dom.albumsGrid.querySelector('.album-card.inline-expanded');
      if (openCard) {
        const title = openCard.querySelector('.title')?.textContent?.trim();
        if (title) desired = title;
      }
    }
    if (!desired) desired = tab.baseLabel || tabContextLabel();
    if (!desired || desired === 'Albums') desired = tab.baseLabel || 'MUSIC';
    if (tab.baseIcon) tab.icon = tab.baseIcon;
    if (tab.label !== desired) {
      tab.label = desired;
      renderTabs();
    }
  }

  function renderTabs() {
    el.topbarTabs.innerHTML = '';
    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
      btn.dataset.tabId = tab.id;
      btn.innerHTML = `<span class="tab-label">${tab.icon} ${escapeHtml(tab.label)}</span>` +
        (tab.closable ? `<span class="tab-close" title="Close tab" aria-label="Close tab">\u2715</span>` : '');
      el.topbarTabs.appendChild(btn);
    }
    el.topbarTabs.appendChild(el.tabAddBtn);
  }

  function tabPlaceholderCopy(kind) {
    if (kind === 'playlists') return ['Playlists', 'Pick a playlist from the sidebar (Favorites, Recently Added, Top 25) to view it here.'];
    return ['', ''];
  }

  function applyTabView(kind) {
    el.tabPlaceholder.classList.add('hidden');
    el.emptyState.classList.add('hidden');
    el.albumsToolbar.classList.add('hidden');
    el.albumsGrid.classList.add('hidden');
    el.songsTable.classList.add('hidden');
    el.artistsGrid.classList.add('hidden');
    if (kind === 'playlists') {
      playlists = playlists || [];
      renderPlaylistManager();
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
    artistSearchSort = state.artistSearchSort === 'album' ? 'album' : 'release';
    albumYearDividers = state.albumYearDividers !== false;
    viewMode = state.viewMode || 'albums';
    specialView = state.specialView || null;
    const derivedBaseLabel = specialView === 'favorites' ? 'Favorites'
      : specialView === 'recent' ? 'Recently Added'
      : specialView === 'top' ? 'Top 25 Most Played'
      : specialView === 'history' ? 'History'
      : specialView === 'folder' && state.activeFolderPath ? String(state.activeFolderPath).split(/[\\/]/).filter(Boolean).pop() || String(state.activeFolderPath)
      : specialView === 'playlist' ? null
      : (tab?.kind === 'music' ? 'MUSIC' : null);
    if (tab?.kind === 'music') {
      tab.baseLabel = state.tabBaseLabel || derivedBaseLabel || 'MUSIC';
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
    el.sidebarItems.forEach(i => i.classList.remove('active'));
    el.folderList.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    if (specialView === 'folder' && activeFolderPath) {
      Array.from(el.folderList.querySelectorAll('.sidebar-item')).find(i => i.dataset.folder === activeFolderPath)?.classList.add('active');
    } else if (specialView === 'history' || specialView === 'recent' || specialView === 'top' || specialView === 'favorites') {
      document.querySelector(`.sidebar-item[data-nav="${specialView === 'recent' ? 'pl-recent' : specialView === 'top' ? 'pl-top' : specialView === 'favorites' ? 'pl-favorites' : 'history'}"]`)?.classList.add('active');
    } else if (!specialView && tab.kind === 'music') {
      document.querySelector('.sidebar-item[data-nav="music"]')?.classList.add('active');
    }
  }

  function restoreTabState(tab) {
    if (!tab) return;
    ensureTabHost(tab);
    activateTabDom(tab);
    if (tab.kind === 'beta') {
      requestAnimationFrame(() => { if (activeTabId === tab.id) tab.dom.host.scrollTop = Math.max(0, Number(tab.state?.scrollTop) || 0); });
      return;
    }
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
    requestAnimationFrame(() => {
      if (activeTabId !== tab.id) return;
      getActiveViewport().scrollTop = savedScrollTop;
      requestAnimationFrame(() => {
        if (activeTabId !== tab.id) return;
        getActiveViewport().scrollTop = savedScrollTop;
        saveActiveTabState();
      });
    });
  }

  function switchTab(id) {
    const tab = tabs.find(t => t.id === id);
    if (!tab || id === activeTabId) return;
    saveActiveTabState();
    activeTabId = id;
    renderTabs();
    restoreTabState(tab);
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
  }

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
    if (id) switchTab(id);
  });

  el.tabAddBtn.addEventListener('click', () => {
    saveActiveTabState();
    tabSeq += 1;
    const id = 'tab-extra-' + tabSeq;
    const tab = { id, label: 'Music', icon: '\uD83C\uDFB5', kind: 'music', closable: true, baseLabel: 'Music', baseIcon: '🎵', state: {
      searchTerm: '', artistSearchTerm: '', artistSearchSort: 'release', albumYearDividers: true, viewMode: 'albums',
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
  });

  // The original browser surfaces become the permanent DOM owned by the
  // default Music tab. Every other tab receives independent clones. The
  // playlists tab is also isolated so switching between top-level tabs cannot
  // accidentally reuse a Music browser's DOM.
  const defaultMusicTab = tabs.find(t => t.id === 'tab-music');
  const playlistsTab = tabs.find(t => t.id === 'tab-playlists');
  defaultMusicTab.dom = makeTabDom(null, true);
  defaultMusicTab.dom.initialized = false;
  playlistsTab.dom = {
    emptyState: defaultMusicTab.dom.emptyState.cloneNode(true),
    tabPlaceholder: defaultMusicTab.dom.tabPlaceholder.cloneNode(true),
    albumsToolbar: defaultMusicTab.dom.albumsToolbar.cloneNode(true),
    albumsGrid: defaultMusicTab.dom.albumsGrid.cloneNode(true),
    songsTable: defaultMusicTab.dom.songsTable.cloneNode(true),
    artistsGrid: defaultMusicTab.dom.artistsGrid.cloneNode(true),
    contentTools: defaultMusicTab.dom.contentTools.cloneNode(true),
    initialized: false,
    dirty: false,
    host: null,
    viewport: null,
  };
  tabs.forEach(t => ensureTabHost(t));
  activateTabDom(tabs.find(t => t.id === activeTabId));
  tabs.forEach(t => {
    if (t.state) return;
    t.state = {
      searchTerm: '', artistSearchTerm: '', artistSearchSort: 'release', albumYearDividers: true, viewMode: 'albums',
      specialView: null, tabBaseLabel: t.baseLabel || (t.kind === 'music' ? 'MUSIC' : 'PLAYLISTS'),
      tabBaseIcon: t.baseIcon || (t.kind === 'music' ? '🎵' : '☰'), activeFolderPath: '', activePlaylistId: null, openAlbumKey: null, highlightedAlbumKey: null, scrollTop: 0,
    };
  });
  renderTabs();
  updateActiveTabLabel();
  document.getElementById('beta-refresh')?.addEventListener('click', () => renderBetaLab());
  el.playlistInfoSave?.addEventListener('click',savePlaylistInfoChanges);
  el.playlistCancel.addEventListener('click',()=>closeModal(el.playlistModal));
  el.playlistImportCancel.addEventListener('click',()=>closeModal(el.playlistImportModal));
  el.playlistImportFile.addEventListener('click',importPlaylistFile);
  el.playlistImportSpotify.addEventListener('click',importSpotifyPlaylist);
  el.playlistSave.addEventListener('click',async()=>{
    const name=el.playlistName.value.trim(); if(!name)return;
    const displayView=['albums','songs','artists'].includes(el.playlistDisplayView?.value) ? el.playlistDisplayView.value : 'albums';
    const existing=editingPlaylistId ? playlists.find(p=>String(p.id)===String(editingPlaylistId)) : null;
    const pl=await window.beehive.savePlaylist({
      ...(existing || {}),
      id: editingPlaylistId || undefined,
      name,
      tracks: existing ? existing.tracks : [],
      smart: existing ? !!existing.smart : false,
      displayView
    });
    if(existing){ playlists=playlists.map(p=>String(p.id)===String(pl.id)?pl:p); }
    else playlists.push(pl);
    editingPlaylistId=null;
    closeModal(el.playlistModal); renderPlaylistManager();
  });
  el.smartPlaylistCancel.addEventListener('click',()=>closeModal(el.smartPlaylistModal));
  el.smartPlaylistAddRule.addEventListener('click',()=>addSmartRuleRow());
  el.smartPlaylistSave.addEventListener('click',async()=>{
    const name=el.smartPlaylistName.value.trim(); if(!name)return;
    const rules=Array.from(el.smartPlaylistRules.querySelectorAll('.smart-rule-row')).map(row=>({field:row.querySelector('.smart-field').value,op:row.querySelector('.smart-op').value,value:row.querySelector('.smart-value').value.trim()}));
    const sourceType=document.querySelector('input[name="smart-source"]:checked')?.value||'library';
    const sourceValue=sourceType==='playlist'?document.getElementById('smart-source-playlist').value:sourceType==='folder'?document.getElementById('smart-source-folder').value:'library';
    const pl=await window.beehive.savePlaylist({name,tracks:[],smart:true,match:el.smartPlaylistMatch.value,rules,limit:Number(el.smartPlaylistLimit.value)||25,sort:el.smartPlaylistSort?.value||'addedDesc',sourceType,sourceValue,description:document.getElementById('smart-playlist-description').value.trim(),displayView:document.getElementById('smart-playlist-display').value,filterDuplicates:document.getElementById('smart-filter-duplicates').checked,selectBy:document.getElementById('smart-playlist-select-by').value,smartShuffle:document.getElementById('smart-playlist-shuffle').value,autoRefresh:document.getElementById('smart-auto-refresh').checked,exportStatic:document.getElementById('smart-export-static').checked});
    playlists.push(pl);closeModal(el.smartPlaylistModal);renderPlaylistManager();
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
    const albumMode = Array.isArray(editingTracks) && editingTracks.length > 1 && editingTracks.every(track => String(track?.albumKey || '') === String(editingTrack?.albumKey || ''));
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
    const albumSelection = Array.isArray(editingTracks) && editingTracks.length > 1 && editingTracks.every(track => String(track?.albumKey || '') === String(editingTrack?.albumKey || ''));
    const removePicture = () => {
      if (albumSelection) {
        const count = editingTracks.length;
        const confirmed = confirm(`Remove ALL embedded artwork from all ${count} selected album tracks?\n\nThis will remove the front covers and any Album Cover (back) pictures, as well as every other embedded picture. The audio files themselves will not be deleted.`);
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

  el.tagSave.addEventListener('click',async()=>{
    if(!editingTrack)return;
    const v=id=>document.getElementById(id)?.value.trim()||'';
    let custom={};
    try{custom=v('tag-advanced')?JSON.parse(v('tag-advanced')):{};}catch{el.tagStatus.textContent='Advanced tags must be valid JSON.';return;}
    const entered={
      title:v('tag-title'),artist:v('tag-artist'),album:v('tag-album'),albumArtist:v('tag-albumArtist'),genre:v('tag-genre'),year:v('tag-year'),track:v('tag-track'),disk:v('tag-disk'),composer:v('tag-composer'),publisher:v('tag-publisher'),conductor:v('tag-conductor'),bpm:v('tag-bpm'),grouping:v('tag-grouping'),copyright:v('tag-copyright'),comment:v('tag-comment'),compilation:v('tag-compilation'),lyrics:v('tag-lyrics'),lyricist:v('tag-lyricist'),originalartist:v('tag-originalArtist'),originalalbum:v('tag-originalAlbum'),originalyear:v('tag-originalYear'),quality:v('tag-quality'),tempo:v('tag-tempo'),mood:v('tag-mood'),occasion:v('tag-occasion'),keywords:v('tag-keywords'),language:v('tag-language'),START_TIME:v('tag-start-time'),END_TIME:v('tag-end-time'),...custom
    };
    const bulk = editingTracks.length > 1;
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
        const syncMode = document.querySelector('input[name="tag-lyrics-sync"]:checked')?.value || 'unsynced';
        const originalSync = mergeEditorValues(editingTagSnapshots.map(item => parseSyncedLyrics(editorTextValue(item.data?.common || {}, item.data?.native || {}, 'lyrics')).length ? 'synced' : 'unsynced'));
        if (!bulk && syncMode !== originalSync) perTrack.LYRICS_SYNC = syncMode;
        const shownStart=v('tag-start-time'), shownEnd=v('tag-end-time');
        const originalStart=track.startTime || nativeTagValue(native,'START_TIME');
        const originalEnd=track.endTime || nativeTagValue(native,'END_TIME');
        if(!bulk || shownStart!==editorComparable(mergeEditorValues(editingTagSnapshots.map(item=>item.track.startTime||nativeTagValue(item.data?.native,'START_TIME'))))) perTrack.START_TIME=shownStart;
        if(!bulk || shownEnd!==editorComparable(mergeEditorValues(editingTagSnapshots.map(item=>item.track.endTime||nativeTagValue(item.data?.native,'END_TIME'))))) perTrack.END_TIME=shownEnd;
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
          ['BEEHIVE_REMEMBER_POSITION','tag-remember-position'],
          ['BEEHIVE_KEEP_SEQUENCE','tag-keep-sequence']
        ];
        for (const [tagKey, id] of settingFields) {
          const node = document.getElementById(id);
          const shown = node?.checked ? '1' : '';
          const original = mergeEditorValues(editingTagSnapshots.map(item => nativeTagValue(item.data?.native, tagKey)));
          if (!bulk || shown !== editorComparable(original)) perTrack[tagKey] = shown;
        }
        const compilationNode = document.getElementById('tag-compilation-setting');
        const shownCompilation = compilationNode?.checked ? '1' : '0';
        const originalCompilationValues = editingTagSnapshots.map(item => String(editorTextValue(item.data?.common || {}, item.data?.native || {}, 'compilation') || '') === '1' ? '1' : '0');
        const originalCompilation = mergeEditorValues(originalCompilationValues);
        // Compilation is a boolean tag. Checked writes the native value `1`;
        // unchecked removes it rather than writing a professional tag's `0` value.
        if (!bulk || shownCompilation !== editorComparable(originalCompilation || '0')) perTrack.compilation = shownCompilation;

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
            else track[modelKey] = value;
          }
          track._searchText = '';
          backgroundTagJobs.push({ path: track.path, perTrack });
        }
        if (window.__beehiveRemoveFrontArtwork) {
          track.cover = null; track.covers = [];
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
      const metadataJobs = [
        ...backgroundTagJobs.map(job => ({ kind: 'tags', path: job.path, perTrack: job.perTrack })),
        ...backgroundArtworkJobs.map(job => ({
          kind: job.action === 'removeFront' ? 'artwork:removeFront' :
                job.action === 'removeAll' ? 'artwork:removeAll' :
                job.action === 'replaceSlot' ? 'artwork:replaceSlot' : 'artwork:add',
          path: job.path, slot: job.slot || null,
          slotLabel: job.slot ? artworkEditorSlotLabel(job.slot) : '',
          imagePath: job.imagePath || '', pictureType: job.pictureType || 'Cover (Front)', comment: job.comment || ''
        }))
      ];
      if (metadataJobs.length) {
        window.beehive.queueMetadataSave(metadataJobs);
      }
    }catch(err){
      console.error('Tag save failed before verification completed:', err);
      el.tagStatus.textContent=err.message||'Could not save tags.';
    }
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

  // ---------------- settings modal tabs (General / Library) ----------------
  let settingsDiscordBound = false;
  async function bindSettingsDiscord() {
    if (settingsDiscordBound || !el.settingsDiscordClientId) return;
    settingsDiscordBound = true;
    try {
      const settings = await window.beehive.discordGetSettings();
      el.settingsDiscordClientId.value = settings.clientId || '';
      el.settingsDiscordImageKey.value = settings.largeImageKey || '';
      el.settingsDiscordImageText.value = settings.largeImageText || 'Hive';
      el.settingsDiscordEnabled.checked = !!settings.enabled;
      el.settingsDiscordArtist.checked = settings.showArtist !== false;
      el.settingsDiscordProgress.checked = settings.showProgress !== false;
    } catch {}
    const refresh = async () => {
      try { const st = await window.beehive.discordGetStatus(); el.settingsDiscordStatus.textContent = st.connected ? 'Connected to Discord' : (st.configured ? 'Configured — Discord is not running' : 'Not configured'); }
      catch { el.settingsDiscordStatus.textContent = 'Status unavailable'; }
    };
    await refresh();
    el.settingsDiscordSave.onclick = async () => {
      el.settingsDiscordSave.disabled = true; el.settingsDiscordStatus.textContent = 'Saving…';
      try {
        const saved = await window.beehive.discordSaveSettings({ clientId: el.settingsDiscordClientId.value.trim(), largeImageKey: el.settingsDiscordImageKey.value.trim(), largeImageText: el.settingsDiscordImageText.value.trim(), enabled: el.settingsDiscordEnabled.checked, showArtist: el.settingsDiscordArtist.checked, showAlbum: true, showProgress: el.settingsDiscordProgress.checked });
        el.settingsDiscordStatus.textContent = saved.enabled ? 'Saved — Rich Presence enabled' : 'Saved — Rich Presence disabled';
        if (saved.enabled) syncDiscordPresence(currentQueue[currentIndex], audioEngine.paused, true);
      } catch (err) { el.settingsDiscordStatus.textContent = `Save failed: ${err?.message || err}`; }
      finally { el.settingsDiscordSave.disabled = false; await refresh(); }
    };
    el.settingsDiscordTest.onclick = async () => {
      const t = currentQueue[currentIndex] || window.__beehiveNowPlayingTrack;
      if (!t) { el.settingsDiscordStatus.textContent = 'Start a track first.'; return; }
      el.settingsDiscordTest.disabled = true;
      try { const ok = await window.beehive.discordUpdateActivity({ track: discordPresenceTrackPayload(t), position: Number(audioEngine.currentTime) || 0, paused: !!audioEngine.paused }); el.settingsDiscordStatus.textContent = ok ? 'Test presence sent' : 'Discord IPC connection not found'; }
      catch (err) { el.settingsDiscordStatus.textContent = `Test failed: ${err?.message || err}`; }
      finally { el.settingsDiscordTest.disabled = false; await refresh(); }
    };
    el.settingsDiscordClear.onclick = async () => { await window.beehive.discordClearActivity(); el.settingsDiscordStatus.textContent = 'Presence cleared'; await refresh(); };
  }
  document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.settings-tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.settingsPanel === btn.dataset.settingsTab));
      if (btn.dataset.settingsTab === 'discord') bindSettingsDiscord();
    });
  });

  // ---------------- brand dropdown menu ----------------
  el.brandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.brandDropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!el.brandDropdown.classList.contains('hidden') && !el.brandDropdown.contains(e.target) && e.target !== el.brandBtn) {
      el.brandDropdown.classList.add('hidden');
    }
  });
  el.brandDropdown.addEventListener('click', (e) => {
    const btn = e.target.closest('.dropdown-item');
    if (!btn) return;
    el.brandDropdown.classList.add('hidden');
    if (btn.dataset.action === 'settings') { openModal(el.settingsModal); }
    if (btn.dataset.action === 'about') openModal(el.aboutModal);
    // "check-updates" and any future items are placeholders for now.
  });

  function openModal(modal) { modal.classList.remove('hidden'); }
  function closeModal(modal) {
    modal.classList.add('hidden');
    if (typeof modal._onClose === 'function') { modal._onClose(); modal._onClose = null; }
  }

  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay);
    });
    overlay.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(overlay));
    });
  });

  window.beehive.getVersion().then((info) => {
    if (info) el.aboutVersion.textContent = `Version ${info.version}`;
  }).catch(() => {});

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
      alert(`GPU acceleration ${saved ? 'enabled' : 'disabled'}. Please restart Beehive for this change to take effect.`);
    } catch (err) {
      el.gpuAccelerationToggle.checked = !enabled;
      console.error('Could not change GPU acceleration setting:', err);
    }
  });

  async function loadLibraryCacheResetSetting() {
    try {
      if (el.clearLibraryCacheNextLaunchToggle) {
        el.clearLibraryCacheNextLaunchToggle.checked = !!(await window.beehive.getLibraryCacheResetSetting());
      }
    } catch (err) {
      console.warn('Could not load library cache reset setting:', err);
    }
  }
  loadLibraryCacheResetSetting();
  el.clearLibraryCacheNextLaunchToggle?.addEventListener('change', async () => {
    const enabled = !!el.clearLibraryCacheNextLaunchToggle.checked;
    try {
      const saved = !!(await window.beehive.setLibraryCacheResetSetting(enabled));
      el.clearLibraryCacheNextLaunchToggle.checked = saved;
    } catch (err) {
      el.clearLibraryCacheNextLaunchToggle.checked = !enabled;
      console.error('Could not change library cache reset setting:', err);
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
  el.embedPlayCountsNowBtn?.addEventListener('click', async () => {
    const button = el.embedPlayCountsNowBtn;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Embedding play counts…';
    try {
      const result = await window.beehive.embedCurrentPlayCounts();
      if (result.failed) {
        button.textContent = `Embedded ${result.embedded}; ${result.failed} failed`;
        console.warn('Some P_count embeddings failed:', result.errors);
      } else {
        button.textContent = result.embedded ? `Embedded ${result.embedded} files` : 'Play counts already embedded';
      }
    } catch (err) {
      button.textContent = 'Embedding failed';
      console.error('Could not embed current play counts:', err);
    }
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 2500);
  });
  el.importEmbeddedPlayCountsBtn?.addEventListener('click', async () => {
    const button = el.importEmbeddedPlayCountsBtn;
    const original = button.textContent;
    button.disabled = true; button.textContent = 'Importing embedded play counts…';
    try {
      const result = await window.beehive.importEmbeddedPlayCounts();
      button.textContent = `Imported ${Number(result.imported || 0).toLocaleString()} tracks`;
      if (result.failed) console.warn('Some embedded P_count reads failed:', result.errors);
      // Refresh the visible library from the updated local statistics.
      const imported = Number(result.imported || 0);
      if (imported) renderCurrentView();
    } catch (err) {
      button.textContent = 'Import failed';
      console.error('Could not import embedded play counts:', err);
    }
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 3000);
  });
  el.playbarNowPlayingBgToggle?.addEventListener('change', () => {
    setPlaybarNowPlayingBg(el.playbarNowPlayingBgToggle.checked);
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
      alert(`Could not clear Beehive play counts: ${err?.message || err}`);
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

  startupMark('RENDERER BOOTSTRAP COMPLETE');
  initialLoad();
  document.addEventListener('keydown', handleSelectionKeyboard, true);
  window.addEventListener('keydown', handleTrackTypeaheadKeydown);


})();
