// Monstercat Visualizer for Hive.
//
// Recreates the look of marcopixel/monstercat-visualizer (a Rainmeter skin,
// MIT licensed) as a Hive sidebar page: a row of spectrum bars over the
// artist's photo, artist name and track title. The audio analysis comes from
// Hive's own GStreamer pipeline (Hive.audio.onSpectrum: 64 log-spaced bands,
// 20 Hz - 16 kHz, already lined up with what you hear); this file only shapes
// and draws it.

return (async function (Hive) {
  const DEFAULTS = {
    barCount: 63,
    sensitivity: 35,
    decayMs: 90,
    monstercatSmoothing: true,
    accentColor: true
  };
  // Original skin proportions: 18px bars with 7px gaps, 350px tall over a
  // 1255px wide stage.
  const GAP_RATIO = 7 / 18;
  const MIN_BAR = 0.01;
  const FLOOR_DB = -80;
  const MAX_FPS = 60;
  const QUIET_AFTER_MS = 150;

  // ---- signal shaping (pure; exported to the tests via `internals`) ----

  function levelToDb(level) {
    return FLOOR_DB + Math.max(0, Math.min(1, Number(level) || 0)) * -FLOOR_DB;
  }

  // Map the analyzer's bands onto the bars. Each bar takes the loudest band
  // it covers, so a sharp peak isn't averaged away; with more bars than
  // bands, bars in between are interpolated.
  function resample(values, count) {
    const out = new Array(count).fill(0);
    const n = values.length;
    if (!n) return out;
    for (let i = 0; i < count; i++) {
      const start = (i * n) / count;
      const end = ((i + 1) * n) / count;
      if (end - start >= 1) {
        let max = 0;
        for (let b = Math.floor(start); b < Math.min(n, Math.ceil(end)); b++) max = Math.max(max, values[b]);
        out[i] = max;
      } else {
        const pos = Math.max(0, Math.min(n - 1, (start + end) / 2 - 0.5));
        const lo = Math.floor(pos);
        const hi = Math.min(n - 1, lo + 1);
        out[i] = values[lo] + (values[hi] - values[lo]) * (pos - lo);
      }
    }
    return out;
  }

  // Each bar is at least its neighbours' height divided by 1.5 per bar of
  // distance, which gives Monstercat's smooth "mountain" outline.
  function monstercatSpread(values, factor = 1.5) {
    const out = values.slice();
    for (let i = 0; i < values.length; i++) {
      for (let j = 0; j < values.length; j++) {
        if (i === j) continue;
        const spread = values[i] / Math.pow(factor, Math.abs(i - j));
        if (spread > out[j]) out[j] = spread;
      }
    }
    return out;
  }

  // Auto gain: the loudest recent band sits at the top of a `sensitivity` dB
  // window and falls back slowly, so quiet and loud masters both fill the
  // view. The gain can't rise past MIN_REF_DB, and frames whose loudest band
  // is under SILENCE_DB count as silence: otherwise, in a quiet passage, the
  // gain kept climbing until background noise filled the bars.
  const MIN_REF_DB = -36;
  const SILENCE_DB = -62;
  function createGain() {
    return { refDb: -30 };
  }
  function shapeFrame(levels, gain, settings, dtSeconds) {
    const dbs = levels.map(levelToDb);
    const peak = dbs.reduce((max, v) => Math.max(max, v), FLOOR_DB);
    const count = Math.max(1, Math.round(Number(settings.barCount) || DEFAULTS.barCount));
    if (peak < SILENCE_DB) return new Array(count).fill(0);
    gain.refDb = Math.max(peak, gain.refDb - 6 * Math.max(0, dtSeconds), MIN_REF_DB);
    const sensitivity = Math.max(1, Number(settings.sensitivity) || DEFAULTS.sensitivity);
    const bottom = gain.refDb - sensitivity;
    const normalized = dbs.map(db => Math.max(0, Math.min(1, (db - bottom) / sensitivity)));
    const bars = resample(normalized, count);
    return settings.monstercatSmoothing ? monstercatSpread(bars) : bars;
  }

  // Bars rise almost at once (the skin uses FFTAttack=0) and fall over decayMs.
  function stepBars(current, target, dtSeconds, decayMs) {
    const attack = 1 - Math.exp(-dtSeconds / 0.012);
    const decay = 1 - Math.exp(-dtSeconds / Math.max(0.005, decayMs / 1000));
    let moving = false;
    for (let i = 0; i < target.length; i++) {
      const from = current[i] || 0;
      const to = target[i] || 0;
      const next = from + (to - from) * (to > from ? attack : decay);
      current[i] = Math.abs(next - to) < 0.001 ? to : next;
      if (current[i] !== to) moving = true;
    }
    current.length = target.length;
    return moving;
  }

  // ---- settings ----

  // Saved values are clamped to the manifest's ranges, so a bad value (say
  // 9999 bars) can't make every frame far too expensive to draw.
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  function sanitizeSettings(raw) {
    const next = { ...DEFAULTS, ...(raw || {}) };
    next.barCount = Math.round(clamp(next.barCount, 16, 128, DEFAULTS.barCount));
    next.sensitivity = clamp(next.sensitivity, 15, 70, DEFAULTS.sensitivity);
    next.decayMs = clamp(next.decayMs, 20, 400, DEFAULTS.decayMs);
    return next;
  }
  let settings = { ...DEFAULTS };
  try { settings = sanitizeSettings(await Hive.settings.load()); } catch {}
  const settingsListeners = new Set();
  Hive.settings.onChange(next => {
    settings = sanitizeSettings(next);
    settingsListeners.forEach(fn => fn());
  });

  // ---- the page ----

  function mount(host, context) {
    host.classList.add('mcv');
    host.innerHTML = `
      <div class="mcv-stage">
        <canvas class="mcv-bars"></canvas>
        <div class="mcv-info">
          <div class="mcv-art"><img alt="" draggable="false"></div>
          <div class="mcv-text">
            <div class="mcv-artist"></div>
            <div class="mcv-title"></div>
          </div>
        </div>
      </div>`;
    const canvas = host.querySelector('.mcv-bars');
    const art = host.querySelector('.mcv-art img');
    const artistEl = host.querySelector('.mcv-artist');
    const titleEl = host.querySelector('.mcv-title');
    const ctx2d = canvas.getContext('2d');

    const gain = createGain();
    let target = new Array(settings.barCount).fill(0);
    const bars = [];
    let lastFrameAt = 0;
    let lastFrameStamp = 0;
    let raf = 0;
    let lastDraw = 0;
    let visible = context?.isVisible ? context.isVisible() : true;
    let color = '#ffffff';
    const disposers = [];

    // Bars follow Hive's theme: its accent color, or its text color when the
    // accent is turned off (so they stay visible on light and dark themes).
    let colorReadAt = 0;
    function readColor() {
      colorReadAt = performance.now();
      const style = getComputedStyle(document.documentElement);
      const accent = style.getPropertyValue('--accent').trim();
      const text = style.getPropertyValue('--text').trim() || getComputedStyle(host).color;
      color = (settings.accentColor && accent) || text || '#ffffff';
    }

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }

    function draw() {
      const w = canvas.width, h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);
      const n = bars.length;
      if (!n) return;
      const barW = w / (n + (n - 1) * GAP_RATIO);
      const gap = barW * GAP_RATIO;
      const shadow = Math.max(1, Math.round(barW * 0.12));
      // Drop shadow first (the skin's DropShadowColor 0,0,0,75), then bars,
      // both growing up from the bottom edge.
      ctx2d.fillStyle = 'rgba(0,0,0,0.12)';
      for (let i = 0; i < n; i++) {
        const bh = Math.max(MIN_BAR, bars[i]) * (h - shadow);
        ctx2d.fillRect(i * (barW + gap) + shadow, h - bh, barW, bh);
      }
      ctx2d.fillStyle = color;
      for (let i = 0; i < n; i++) {
        const bh = Math.max(MIN_BAR, bars[i]) * (h - shadow);
        ctx2d.fillRect(i * (barW + gap), h - shadow - bh, barW, bh);
      }
    }

    function tick(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      // Hold at MAX_FPS: high-refresh monitors would otherwise redraw this
      // canvas 144-240 times a second for no visible gain.
      if (now - lastDraw < 1000 / MAX_FPS - 1) { raf = requestAnimationFrame(tick); return; }
      const dt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 1 / MAX_FPS;
      lastDraw = now;
      if (performance.now() - lastFrameAt > QUIET_AFTER_MS) target = target.map(() => 0);
      // Hive retints its accent from each track's cover; pick that up.
      if (now - colorReadAt > 500) readColor();
      const moving = stepBars(bars, target, dt, Number(settings.decayMs) || DEFAULTS.decayMs);
      draw();
      // Once everything has settled (paused, silence) stop drawing until the
      // next spectrum frame arrives.
      if (moving || performance.now() - lastFrameAt <= QUIET_AFTER_MS) raf = requestAnimationFrame(tick);
      else lastDraw = 0;
    }
    function wake() {
      if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick);
    }

    disposers.push(Hive.audio.onSpectrum(levels => {
      const now = performance.now();
      const dt = lastFrameStamp ? Math.min(0.25, (now - lastFrameStamp) / 1000) : 0.033;
      lastFrameStamp = now;
      lastFrameAt = now;
      target = shapeFrame(Array.isArray(levels) ? levels : [], gain, settings, dt);
      wake();
    }));

    // The same cover art Hive shows for the playing file.
    function showTrack(track) {
      const artist = String(track?.artist || track?.albumArtist || '').trim();
      artistEl.textContent = artist || (track ? 'Unknown artist' : '');
      titleEl.textContent = String(track?.title || (track ? '' : 'Nothing playing'));
      const cover = track ? Hive.player.getCoverUrl(track) : null;
      host.classList.toggle('mcv-no-art', !cover);
      if (cover) art.src = cover;
      else art.removeAttribute('src');
    }
    disposers.push(Hive.events.on('track-change', track => { showTrack(track); readColor(); }));
    showTrack(Hive.player.getCurrent());

    const resizeObserver = new ResizeObserver(() => { resizeCanvas(); draw(); });
    resizeObserver.observe(canvas);
    resizeCanvas();
    readColor();

    const onSettings = () => { readColor(); target = new Array(Math.round(settings.barCount) || DEFAULTS.barCount).fill(0); showTrack(Hive.player.getCurrent()); wake(); };
    settingsListeners.add(onSettings);
    const onDocVisibility = () => wake();
    document.addEventListener('visibilitychange', onDocVisibility);
    if (context?.onVisibilityChange) disposers.push(context.onVisibilityChange(v => { visible = v; if (v) { resizeCanvas(); readColor(); wake(); } }));
    wake();

    host._mcvCleanup = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver.disconnect();
      settingsListeners.delete(onSettings);
      document.removeEventListener('visibilitychange', onDocVisibility);
      disposers.forEach(off => { try { off?.(); } catch {} });
    };
  }

  function unmount(host) {
    host._mcvCleanup?.();
    delete host._mcvCleanup;
    host.innerHTML = '';
  }

  Hive.ui.registerView({
    id: 'visualizer',
    title: 'Visualizer',
    description: 'Monstercat-style spectrum with the artist and track',
    mount,
    unmount,
    // Not used by Hive; lets the test suite check the signal shaping.
    internals: { levelToDb, resample, monstercatSpread, createGain, shapeFrame, stepBars, sanitizeSettings, DEFAULTS }
  });
})(Hive);
