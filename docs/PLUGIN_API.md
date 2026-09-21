# Hive Plugin API v2

Hive's community extension standard is **Hive Plugin API v2**.

## What a plugin is

A plugin is a trusted local extension folder containing:

```text
manifest.json
plugin.js       # optional
style.css      # optional
README.md      # optional
```

Hive installs these folders under the user's Hive plugins directory. The host reads the manifest, loads optional CSS, then executes `plugin.js` against the documented `window.HivePlugin` host API.

This is intentionally a **trusted-local renderer extension model**, not a security sandbox. A user should only install code they trust. Plugins do not receive Node.js or Electron APIs through the Hive API.

## Manifest contract

```json
{
  "format": "hive-plugin",
  "apiVersion": 2,
  "id": "example.plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "author": "Example Author",
  "description": "Example Hive extension",
  "permissions": ["player.read", "spectrum.read", "ui.sandbox", "settings"],
  "settings": [
    {"id":"enabled","type":"boolean","label":"Enabled","default":true}
  ]
}
```

Supported permission identifiers are deliberately small:

- `library.read`
- `player.read`
- `player.control`
- `spectrum.read`
- `ui.sandbox`
- `settings`

The host API checks these permissions before exposing the corresponding operation.

## Runtime API

A plugin receives `Hive` as its only documented host object:

```js
return (async function(Hive) {
  const current = Hive.player.getCurrent();

  const stop = Hive.events.on('spectrum', values => {
    // Native GStreamer spectrum values, normalized for Hive's UI.
  });

  Hive.ui.registerSandboxPanel({
    id: 'example-panel',
    title: 'Example',
    order: 20,
    mount(host) {
      host.textContent = current?.title || 'Nothing playing';
    }
  });

  Hive.lifecycle.onUnload(() => stop());
})(Hive);
```

Available event streams:

- `track-change`
- `playback`
- `spectrum`

The spectrum event is a projection of Hive's existing native GStreamer spectrum path. A plugin does not create another audio engine.

## Plugin settings

The host persists settings per plugin. A plugin declares its settings in `manifest.json` and accesses them through:

```js
const settings = await Hive.settings.load();
await Hive.settings.save({ ...settings, enabled: false });
Hive.settings.onChange(next => { /* update UI */ });
```

Hive renders declared settings in Settings → Community automatically. This keeps plugin preferences out of the core Settings implementation.

## Example plugin

Hive ships an installable **Monstercat Visualizer** example under:

```text
resources/hive-plugins/monstercat-visualizer/
```

It demonstrates the complete standard: manifest permissions, persistent plugin settings, native spectrum events, a Sandbox panel, CSS, and lifecycle cleanup.
