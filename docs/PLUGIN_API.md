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
- `media.artwork` (artist photo lookups)
- `ui.view` (a left-sidebar page)
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

The spectrum event is a projection of Hive's existing native GStreamer spectrum path. A plugin does not create another audio engine. Each event is an array of 64 levels from 0 to 1 (−80 dB to 0 dB), one per log-spaced band from 20 Hz to 16 kHz, about 30 times a second, delivered when that audio is actually heard. Nothing arrives while playback is paused.

## Sidebar pages

With the `ui.view` permission a plugin can add its own page to the left sidebar. It behaves like Hive's built-in entries: users can reorder, rename, hide or pin it, and right-clicking it shows Plugin info and Plugin settings.

```js
Hive.ui.registerView({
  id: 'visualizer',            // letters, numbers, . _ -
  title: 'Visualizer',         // sidebar label
  mount(host, context) {
    // Fill `host` (it fills the content area).
    context.onVisibilityChange(visible => { /* pause/resume drawing */ });
  },
  unmount(host) { /* stop timers, remove listeners */ }
});
```

`mount` runs when the page is first shown in its tab. The tab keeps its page while another tab is shown, so stop animation when `context.onVisibilityChange` reports `false`. `unmount` runs when the page is replaced or the plugin is disabled or reloaded.

## Artwork

- `Hive.player.getCoverUrl(track?)` (`player.read`) returns an image URL for the track's cover (the current track by default), or `null`.
- `Hive.media.getArtistImage(artist)` (`media.artwork`) resolves to a photo of the artist, looked up online once and cached, or `null`.

## Plugin settings

The host persists settings per plugin. A plugin declares its settings in `manifest.json` and accesses them through:

```js
const settings = await Hive.settings.load();
await Hive.settings.save({ ...settings, enabled: false });
Hive.settings.onChange(next => { /* update UI */ });
```

Hive renders declared settings in Settings → Community automatically. This keeps plugin preferences out of the core Settings implementation. Number settings are kept within their declared `min`/`max`.

## Example plugin

Hive ships the **Monstercat Visualizer** under:

```text
resources/hive-plugins/monstercat-visualizer/
```

Hive copies it into the user's plugin folder and updates that copy when the bundled manifest's `version` changes (a copy the user edited without Hive's `.hive-bundled` marker, or deleted, is left alone). It demonstrates the complete standard: manifest permissions, persistent plugin settings, spectrum events, a sidebar page, CSS, and lifecycle cleanup.
