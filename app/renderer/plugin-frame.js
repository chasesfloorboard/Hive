'use strict';
// The inside of a plugin's sandbox (plugin-frame.html; Hive's side is plugin-sandbox.js). A frame
// with no origin can't load scripts from disk, so Hive loads this file and sends the frame the
// source of hivePluginFrame(), which the frame's one inline script runs.
// Hive sends the plugin's code and keeps this frame up to date: the playing track and its cover,
// playback state, the spectrum and the theme's colours. The Hive object the plugin gets answers
// from those copies, so the API stays synchronous where it always was; everything else (settings,
// playback control, artist photos, toasts) is a message that Hive checks against the plugin's
// permissions before acting.
(function (root) {
function hivePluginFrame() {
  const host = window.parent;
  const send = message => host.postMessage({ hive: true, ...message }, '*');
  const EVENTS = ['track-change', 'playback', 'spectrum'];

  const cache = { current: null, cover: null, covers: new Map(), state: null, stateAt: 0, spectrum: [], tracks: [] };
  const listeners = new Map();
  const views = new Map();
  const panels = new Map();
  const surfaces = new Map();
  const unloads = [];
  const calls = new Map();
  let nextCall = 1;
  let plugin = { id: '', name: '', permissions: [] };

  const can = permission => !permission || plugin.permissions.includes(permission);
  const need = permission => { if (!can(permission)) throw new Error(`Plugin ${plugin.id} lacks permission: ${permission}`); };
  const listen = (name, fn) => {
    const list = listeners.get(name) || [];
    list.push(fn); listeners.set(name, list);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  };
  function emit(name, payload) {
    for (const fn of [...(listeners.get(name) || [])]) { try { fn(payload); } catch (err) { console.warn('[Hive Plugin]', plugin.id, name, err); } }
  }
  function call(method, ...args) {
    const id = nextCall++;
    return new Promise((resolve, reject) => { calls.set(id, { resolve, reject }); send({ type: 'call', call: id, method, args }); });
  }
  const copy = value => (value == null ? value : JSON.parse(JSON.stringify(value)));

  const Hive = {
    version: 2,
    get id() { return plugin.id; },
    get name() { return plugin.name; },
    library: { getTracks: () => { need('library.read'); return cache.tracks.slice(); } },
    player: {
      getCurrent: () => { need('player.read'); return copy(cache.current); },
      getState: () => {
        need('player.read');
        const s = cache.state || { track: cache.current, position: 0, duration: Number(cache.current?.duration) || 0, paused: true };
        // The position moves on between Hive's updates while playing.
        const position = s.paused ? s.position : s.position + (performance.now() - cache.stateAt) / 1000;
        return { ...copy(s), position: s.duration ? Math.min(s.duration, position) : position };
      },
      getCoverUrl: track => {
        need('player.read');
        const t = track || cache.current;
        if (!t) return null;
        if (!track || (cache.current && t.path === cache.current.path)) return cache.cover;
        return cache.covers.get(String(t.path || '')) ?? null;
      },
      play: track => { need('player.control'); return call('player.play', track?.path ? { path: String(track.path) } : null); },
      next: () => { need('player.control'); return call('player.next'); },
      previous: () => { need('player.control'); return call('player.previous'); }
    },
    events: {
      on: (name, fn) => {
        if (typeof fn !== 'function') return () => {};
        if (!EVENTS.includes(name)) throw new Error(`Unsupported Hive event: ${name}`);
        need(name === 'spectrum' ? 'spectrum.read' : 'player.read');
        return listen(name, fn);
      }
    },
    audio: {
      getSpectrum: () => { need('spectrum.read'); return cache.spectrum.slice(); },
      onSpectrum: fn => { need('spectrum.read'); return typeof fn === 'function' ? listen('spectrum', fn) : () => {}; }
    },
    media: { getArtistImage: async artist => { need('media.artwork'); try { return await call('media.artistImage', String(artist || '')); } catch { return null; } } },
    settings: {
      load: async () => { need('settings'); return call('settings.load'); },
      save: async next => { need('settings'); return call('settings.save', copy(next || {})); },
      onChange: fn => { need('settings'); return typeof fn === 'function' ? listen('settings', fn) : () => {}; }
    },
    ui: {
      toast: (message, title = 'Hive') => { call('ui.toast', String(message), String(title)).catch(() => {}); },
      // Styles apply inside this plugin's own frame, which is where its pages are drawn.
      addStyle: css => { const st = document.createElement('style'); st.textContent = String(css || ''); document.head.appendChild(st); return () => st.remove(); },
      registerView: definition => {
        need('ui.view');
        const id = String(definition?.id || '');
        if (!/^[a-zA-Z0-9._-]{1,60}$/.test(id) || typeof definition.mount !== 'function') throw new Error('registerView requires an id (letters, numbers, . _ -) and mount(host).');
        views.set(id, definition);
        send({ type: 'registerView', view: { id, title: String(definition.title || ''), description: String(definition.description || ''), icon: String(definition.icon || '') } });
        return () => { unmount('view', id); views.delete(id); send({ type: 'unregisterView', id }); };
      },
      registerSandboxPanel: definition => {
        need('ui.sandbox');
        const id = String(definition?.id || '');
        if (!id || typeof definition.mount !== 'function') throw new Error('registerSandboxPanel requires id and mount(host).');
        panels.set(id, definition);
        send({ type: 'registerPanel', panel: { id, order: Number(definition.order) || 0 } });
        return () => { unmount('panel', id); panels.delete(id); send({ type: 'unregisterPanel', id }); };
      }
    },
    lifecycle: { onUnload: fn => { if (typeof fn === 'function') unloads.push(fn); return () => { const i = unloads.indexOf(fn); if (i >= 0) unloads.splice(i, 1); }; } }
  };

  // A page of the plugin: Hive lays this frame over the spot in its window where the page goes.
  function mount(kind, id) {
    const definition = (kind === 'view' ? views : panels).get(id);
    if (!definition) return;
    const key = `${kind}:${id}`;
    if (surfaces.has(key)) { show(key); return; }
    const el = document.createElement('section');
    el.className = 'hive-plugin-surface' + (kind === 'view' ? ' hive-plugin-view' : ' hive-plugin-panel');
    document.body.appendChild(el);
    const surface = { el, definition, visible: true, visibilityListeners: [] };
    surfaces.set(key, surface);
    show(key);
    const context = {
      isVisible: () => surface.visible,
      onVisibilityChange: fn => {
        if (typeof fn !== 'function') return () => {};
        surface.visibilityListeners.push(fn);
        return () => { const i = surface.visibilityListeners.indexOf(fn); if (i >= 0) surface.visibilityListeners.splice(i, 1); };
      }
    };
    try { definition.mount(el, context); } catch (err) { el.textContent = err?.message || 'This plugin page failed to load.'; }
  }
  function show(key) { for (const [k, s] of surfaces) s.el.hidden = k !== key; }
  function setVisible(kind, id, visible) {
    const surface = surfaces.get(`${kind}:${id}`);
    if (!surface || surface.visible === visible) return;
    surface.visible = visible;
    if (visible) show(`${kind}:${id}`);
    for (const fn of [...surface.visibilityListeners]) { try { fn(visible); } catch (err) { console.warn('[Hive Plugin] visibility', err); } }
  }
  function unmount(kind, id) {
    const key = `${kind}:${id}`;
    const surface = surfaces.get(key);
    if (!surface) return;
    surfaces.delete(key);
    try { surface.definition.unmount?.(surface.el); } catch (err) { console.warn('[Hive Plugin] unmount', err); }
    surface.el.remove();
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme?.vars || {})) root.style.setProperty(name, value);
    // vh/vw in a plugin's CSS mean Hive's window, as they did before plugins had frames of their own.
    if (theme?.viewport) { root.style.setProperty('--hive-vh', `${theme.viewport.height / 100}px`); root.style.setProperty('--hive-vw', `${theme.viewport.width / 100}px`); }
    if (theme?.font) document.body.style.fontFamily = theme.font;
    if (theme?.color) document.body.style.color = theme.color;
  }

  function onEvent({ name, payload, cover }) {
    if (name === 'track-change') { cache.current = payload || null; cache.cover = cover ?? null; if (payload?.path && cover) cache.covers.set(String(payload.path), cover); }
    else if (name === 'playback') { cache.state = payload?.state || null; cache.stateAt = performance.now(); if (payload?.state?.track) cache.current = payload.state.track; }
    else if (name === 'spectrum') cache.spectrum = Array.isArray(payload) ? payload : [];
    else if (name === 'library') { cache.tracks = Array.isArray(payload) ? payload : []; return; }
    emit(name, payload);
  }

  async function load(message) {
    plugin = { id: String(message.plugin.id), name: String(message.plugin.name || ''), permissions: Array.isArray(message.plugin.permissions) ? message.plugin.permissions.map(String) : [] };
    document.title = plugin.name || plugin.id;
    applyTheme(message.theme);
    const c = message.cache || {};
    cache.current = c.current || null; cache.cover = c.cover ?? null; cache.state = c.state || null; cache.stateAt = performance.now();
    cache.spectrum = Array.isArray(c.spectrum) ? c.spectrum : []; cache.tracks = Array.isArray(c.tracks) ? c.tracks : [];
    if (message.plugin.css) { const st = document.createElement('style'); st.textContent = String(message.plugin.css); document.head.appendChild(st); }
    try {
      await new Function('Hive', String(message.plugin.js || ''))(Hive);
      send({ type: 'loaded', ok: true });
    } catch (err) {
      console.warn('[Hive Plugin]', plugin.id, err);
      send({ type: 'loaded', ok: false, error: String(err?.message || err) });
    }
  }

  window.addEventListener('message', async event => {
    if (event.source !== host) return;
    const m = event.data;
    if (!m || m.hive !== true) return;
    switch (m.type) {
      case 'init': return load(m);
      case 'event': return onEvent(m);
      case 'theme': return applyTheme(m.theme);
      case 'refresh': {
        // Hive's current copies (a cover found after the track started, say), without an event.
        const c = m.cache || {};
        cache.current = c.current || null; cache.cover = c.cover ?? null;
        if (c.current?.path && c.cover) cache.covers.set(String(c.current.path), c.cover);
        if (c.state) { cache.state = c.state; cache.stateAt = performance.now(); }
        return;
      }
      case 'mount': return mount(m.kind, m.id);
      case 'visibility': return setVisible(m.kind, m.id, !!m.visible);
      case 'unmount': return unmount(m.kind, m.id);
      case 'reply': {
        const pending = calls.get(m.call);
        if (!pending) return;
        calls.delete(m.call);
        return m.ok ? pending.resolve(m.value) : pending.reject(new Error(m.error || 'Hive refused the request.'));
      }
      case 'unload':
        for (const key of [...surfaces.keys()]) { const [kind, ...rest] = key.split(':'); unmount(kind, rest.join(':')); }
        for (const fn of unloads.splice(0)) { try { await fn(); } catch {} }
        return send({ type: 'unloaded' });
    }
  });
  send({ type: 'ready' });
}
  // Hive's window keeps the function; plugin-sandbox.js sends its source into each frame to run.
  if (typeof module === 'object' && module.exports) module.exports = { hivePluginFrame };
  else root.HivePluginFrameRuntime = hivePluginFrame;
})(typeof window !== 'undefined' ? window : globalThis);
