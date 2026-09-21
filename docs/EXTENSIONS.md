# Hive Community Extensions and Themes

Hive 1.0 exposes a small renderer extension surface for community experimentation without changing the playback core.

## Extension layout

Install a folder containing:

```text
manifest.json
plugin.js       # optional
style.css       # optional
```

Example manifest:

```json
{
  "id": "example.my-plugin",
  "name": "My Hive Extension",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "A small Hive extension",
  "permissions": ["library.read", "player.control", "ui"]
}
```

The extension loader makes `window.HivePlugin` available to `plugin.js` with:

- `Hive.version`
- `Hive.id` / `Hive.name`
- `Hive.library.getTracks()` — a snapshot of renderer-safe library tracks
- `Hive.player.getCurrent()`
- `Hive.player.play(track)`
- `Hive.player.next()` / `Hive.player.previous()`
- `Hive.ui.toast(message, title)`
- `Hive.ui.addStyle(css)`

Extensions run as trusted local renderer code. Only install extensions you trust.
The extension API does not grant Node.js or filesystem access. Do not use an extension to replace or bypass GStreamer, the Spotify bridge, or podcast transport ownership.

## Themes

A `.hive-theme` file is JSON:

```json
{
  "format": "hive-theme",
  "version": 1,
  "name": "Example Hive Theme",
  "css": ":root { --accent: #7dd3fc; }"
}
```

Theme authors should prefer Hive's stable variables:

`--accent`, `--accent-soft`, `--accent-glow`, `--ambient-a`, `--ambient-b`, `--bg`, `--panel`, `--panel-strong`, `--border`, `--text`, `--text-dim`, `--text-dimmer`, `--radius`, `--blur`, `--control-bg`, `--control-bg-hover`, `--control-bg-active`, `--control-border`, `--control-track`, `--control-muted`, `--control-strong`.

Custom CSS is presentation-only and must not depend on JavaScript execution.

## Provider direction

Artwork and lyrics providers are deliberately isolated behind provider modules. Future community providers should add a provider implementation rather than modify the scanner or playback transport. MusicBrainz API access remains rate-limited to one request per second and uses an identifiable User-Agent.
