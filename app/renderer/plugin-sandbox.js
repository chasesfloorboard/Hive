'use strict';
// Plugins run sandboxed: each one in its own frame (plugin-frame.html) with the sandbox attribute
// and no origin, so it can't touch Hive's window, its preload API or the network. This is Hive's
// side: it loads each plugin into its frame, sends it what its permissions allow it to see, carries
// out the requests it's allowed to make, and lays the frame over the place in the window where the
// plugin's page goes. Loaded as a plain script (window.HivePluginSandbox) and by the tests via require().
(function (root) {
  // What each request and event needs (the permissions a plugin declares in its manifest).
  const CALLS = {
    'player.play': 'player.control',
    'player.next': 'player.control',
    'player.previous': 'player.control',
    'media.artistImage': 'media.artwork',
    'settings.load': 'settings',
    'settings.save': 'settings',
    'ui.toast': ''
  };
  const EVENTS = { 'track-change': 'player.read', playback: 'player.read', spectrum: 'spectrum.read', library: 'library.read', settings: 'settings' };
  const permissionForCall = method => (Object.prototype.hasOwnProperty.call(CALLS, method) ? CALLS[method] : null);
  const permissionForEvent = name => (Object.prototype.hasOwnProperty.call(EVENTS, name) ? EVENTS[name] : null);
  const allowed = (plugin, permission) => permission === '' || (!!permission && (plugin.permissions || []).includes(permission));

  // Hive's theme as the frame needs it: every custom property on :root, the font and text colour,
  // and the window size (for plugin CSS written in vh/vw).
  // Chromium leaves custom properties out when a computed style is listed, so their names come from
  // the stylesheets and the root's inline style (where Hive puts the colours it takes from covers).
  let varNames = null;
  function customPropertyNames(doc) {
    if (varNames) return varNames;
    const names = new Set();
    const walk = rules => {
      for (const rule of rules || []) {
        if (rule.style) for (let i = 0; i < rule.style.length; i++) if (rule.style[i].startsWith('--')) names.add(rule.style[i]);
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of doc.styleSheets) { try { walk(sheet.cssRules); } catch {} }
    varNames = names;
    return names;
  }
  function themeSnapshot(doc = document) {
    const style = getComputedStyle(doc.documentElement);
    const inline = doc.documentElement.style;
    const names = new Set(customPropertyNames(doc));
    for (let i = 0; i < inline.length; i++) if (inline[i].startsWith('--')) names.add(inline[i]);
    const vars = {};
    for (const name of names) { const value = style.getPropertyValue(name).trim(); if (value) vars[name] = value; }
    const body = getComputedStyle(doc.body);
    // No color-scheme: a frame whose scheme differs from its <iframe>'s gets an opaque background,
    // and the page is meant to show Hive's panel through it.
    return { vars, font: body.fontFamily, color: body.color, viewport: { width: root.innerWidth, height: root.innerHeight } };
  }

  function createPluginSandbox({ frameUrl = 'plugin-frame.html', hooks, doc = document, loadTimeoutMs = 10000 }) {
    const frames = new Map();          // plugin id -> { plugin, iframe, ready, mounted }
    let layer = null;
    let themeQueued = false;

    function ensureLayer() {
      if (layer?.isConnected) return layer;
      layer = doc.createElement('div');
      layer.id = 'hive-plugin-frames';
      doc.body.appendChild(layer);
      return layer;
    }
    const post = (entry, message) => { try { entry.iframe.contentWindow?.postMessage({ hive: true, ...message }, '*'); } catch {} };

    function load(plugin) {
      return new Promise(resolve => {
        const iframe = doc.createElement('iframe');
        iframe.className = 'hive-plugin-frame';
        iframe.setAttribute('sandbox', 'allow-scripts');
        // Named with aria-label: Hive's tooltip system would turn a title into a hover tooltip.
        iframe.setAttribute('aria-label', String(plugin.name || plugin.id));
        iframe.tabIndex = -1;
        iframe.hidden = true;
        const entry = { plugin, iframe, mounted: null, done: resolve, timer: 0 };
        frames.set(plugin.id, entry);
        // A plugin whose top-level code hangs (an infinite loop or runaway allocation in new Function(...))
        // never posts 'loaded'. Don't just log and move on — stop() removes the iframe, which terminates the
        // runaway script, clears the timer, and resolves the load promise false. Otherwise the hung frame
        // keeps burning CPU/memory in the renderer for the whole session.
        entry.timer = setTimeout(() => { hooks.log?.(plugin.id, 'did not finish loading — stopped'); stop(plugin.id); }, loadTimeoutMs);
        // The frame holds plugin-frame.html and nothing else. A plugin that navigates it away (to a
        // page without the frame's CSP) is stopped: its frame is removed as soon as the page loads,
        // and Hive's main process gives frames no network meanwhile.
        let loads = 0;
        iframe.addEventListener('load', () => {
          if (++loads === 1) return;
          hooks.log?.(plugin.id, 'left its sandbox page and was stopped');
          stop(plugin.id);
        });
        iframe.src = frameUrl;
        ensureLayer().appendChild(iframe);
      });
    }

    async function onMessage(event) {
      let entry = null;
      for (const e of frames.values()) if (e.iframe.contentWindow && event.source === e.iframe.contentWindow) { entry = e; break; }
      const m = event.data;
      if (!entry || !m || m.hive !== true) return;
      const { plugin } = entry;
      switch (m.type) {
        case 'boot': {
          const runtime = root.HivePluginFrameRuntime;
          return post(entry, { type: 'runtime', source: typeof runtime === 'function' ? runtime.toString() : '' });
        }
        case 'ready':
          return post(entry, { type: 'init', plugin: { id: plugin.id, name: plugin.name, permissions: plugin.permissions || [], js: plugin.js || '', css: plugin.css || '' }, theme: themeSnapshot(doc), cache: hooks.snapshot(plugin) });
        case 'loaded':
          clearTimeout(entry.timer);
          if (!m.ok) hooks.log?.(plugin.id, m.error);
          entry.done?.(!!m.ok); entry.done = null;
          return;
        case 'registerView':
          if (!allowed(plugin, 'ui.view')) return;
          return hooks.registerView(plugin, m.view);
        case 'unregisterView': return hooks.unregisterView(plugin, String(m.id));
        case 'registerPanel':
          if (!allowed(plugin, 'ui.sandbox')) return;
          return hooks.registerPanel(plugin, m.panel);
        case 'unregisterPanel': return hooks.unregisterPanel(plugin, String(m.id));
        case 'unloaded': entry.unloaded?.(); return;
        case 'call': {
          const permission = permissionForCall(m.method);
          if (permission === null || !allowed(plugin, permission)) return post(entry, { type: 'reply', call: m.call, ok: false, error: `Plugin ${plugin.id} lacks permission: ${permission || m.method}` });
          try {
            const value = await hooks.call(plugin, m.method, Array.isArray(m.args) ? m.args : []);
            post(entry, { type: 'reply', call: m.call, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
          } catch (err) {
            post(entry, { type: 'reply', call: m.call, ok: false, error: String(err?.message || err) });
          }
        }
      }
    }
    root.addEventListener('message', onMessage);

    // Events go only to plugins allowed to see them. `forPlugin` limits one to a single plugin.
    function emit(name, payload, extra = {}, forPlugin = null) {
      const permission = permissionForEvent(name);
      if (permission === null) return;
      for (const entry of frames.values()) {
        if (forPlugin && entry.plugin.id !== forPlugin) continue;
        if (allowed(entry.plugin, permission)) post(entry, { type: 'event', name, payload, ...extra });
      }
    }

    // ---- Placing a frame over its page ----
    function place(entry) {
      const m = entry.mounted;
      if (!m) { entry.iframe.hidden = true; return; }
      // Hive redrew the spot the page was in (left the Sandbox page, reloaded plugins): close the page.
      if (!m.host.isConnected) { post(entry, { type: 'unmount', kind: m.kind, id: m.id }); untrack(entry); entry.mounted = null; entry.iframe.hidden = true; return; }
      const rect = m.host.getBoundingClientRect();
      const shown = m.visible && m.host.isConnected && m.host.offsetParent !== null && rect.width > 0 && rect.height > 0;
      entry.iframe.hidden = !shown;
      if (!shown) return;
      const s = entry.iframe.style;
      s.left = `${rect.left}px`; s.top = `${rect.top}px`; s.width = `${rect.width}px`; s.height = `${rect.height}px`;
    }
    function track(entry) {
      const m = entry.mounted;
      m.observer = new ResizeObserver(() => place(entry));
      m.observer.observe(m.host);
      // Moves without a size change (the sidebar opening, a panel sliding) have no event; check often.
      m.poll = setInterval(() => place(entry), 250);
      place(entry);
    }
    function untrack(entry) {
      const m = entry.mounted;
      if (!m) return;
      m.observer?.disconnect();
      clearInterval(m.poll);
    }

    // Shows one of a plugin's pages in `host`. Returns { setVisible(bool), unmount() }.
    function mount(pluginId, kind, id, host) {
      const entry = frames.get(pluginId);
      if (!entry) return null;
      if (entry.mounted && entry.mounted.host !== host) { untrack(entry); post(entry, { type: 'visibility', kind: entry.mounted.kind, id: entry.mounted.id, visible: false }); }
      entry.mounted = { kind, id, host, visible: true };
      post(entry, { type: 'theme', theme: themeSnapshot(doc) });
      post(entry, { type: 'refresh', cache: hooks.snapshot(entry.plugin, { tracks: false }) });
      post(entry, { type: 'mount', kind, id });
      track(entry);
      const mine = entry.mounted;
      return {
        setVisible(visible) {
          if (entry.mounted !== mine || mine.visible === visible) return;
          mine.visible = visible;
          post(entry, { type: 'visibility', kind, id, visible });
          if (visible) { post(entry, { type: 'theme', theme: themeSnapshot(doc) }); post(entry, { type: 'refresh', cache: hooks.snapshot(entry.plugin, { tracks: false }) }); }
          place(entry);
        },
        unmount() {
          post(entry, { type: 'unmount', kind, id });
          if (entry.mounted !== mine) return;
          untrack(entry);
          entry.mounted = null;
          place(entry);
        }
      };
    }

    // Theme changes (a new theme, the accent following the cover) reach the frames on the next frame.
    function themeChanged(records) {
      // A stylesheet added or changed (a theme): the property names are looked up again.
      if (Array.isArray(records) && records.some(r => r.target !== doc.documentElement)) varNames = null;
      if (themeQueued || !frames.size) return;
      themeQueued = true;
      requestAnimationFrame(() => {
        themeQueued = false;
        const theme = themeSnapshot(doc);
        for (const entry of frames.values()) post(entry, { type: 'theme', theme });
      });
    }
    new MutationObserver(themeChanged).observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    new MutationObserver(themeChanged).observe(doc.head, { childList: true, subtree: true, characterData: true });
    root.addEventListener('resize', themeChanged);

    function stop(pluginId) {
      const entry = frames.get(pluginId);
      if (!entry) return;
      frames.delete(pluginId);
      untrack(entry);
      clearTimeout(entry.timer);
      entry.done?.(false); entry.done = null;
      entry.iframe.remove();
      hooks.stopped?.(entry.plugin);
    }

    // Lets every plugin run its onUnload handlers (briefly), then removes the frames.
    async function unloadAll() {
      const list = [...frames.values()];
      frames.clear();
      await Promise.all(list.map(entry => new Promise(resolve => {
        untrack(entry);
        clearTimeout(entry.timer);
        entry.done?.(false);
        const finish = () => { clearTimeout(t); entry.iframe.remove(); resolve(); };
        const t = setTimeout(finish, 1000);
        entry.unloaded = finish;
        frames.set(`unloading:${entry.plugin.id}`, entry);
        post(entry, { type: 'unload' });
      }).finally(() => frames.delete(`unloading:${entry.plugin.id}`))));
    }

    return { load, emit, mount, stop, unloadAll, themeChanged, has: id => frames.has(id) };
  }

  const api = { createPluginSandbox, permissionForCall, permissionForEvent, allowed };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HivePluginSandbox = api;
})(typeof window !== 'undefined' ? window : globalThis);
