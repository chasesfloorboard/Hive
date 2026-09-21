# Post-Spotify 1.0 Development Pause

## Status

Spotify development is intentionally paused for the Hive 1.0 stable line. The existing Spotify/Spicetify implementation is retained in the source tree as historical development work and is not being removed.

## What is paused

- Hive does not start the Spotify loopback bridge.
- Spotify launch/login/command IPC is inert while the pause flag is enabled.
- `install.sh` does not install, configure, or apply the Hive Spotify/Spicetify integration. The existing installer implementation is preserved but its call is commented out.
- The Spotify playlist import button remains visible as a red, disabled deferred control.

## What remains intact

Spotify source, bridge, provider, artwork, queue, and installer code remain available for later development. Do not delete or rewrite this code as part of normal 1.0 stabilization.

## Resuming Spotify development

If Spotify development is requested again, treat the request **"resume Spotify development"** as the explicit resume instruction. Restore the guarded bridge startup/IPC behavior, uncomment the `install_spotify_stack` call, and run the Spotify regression suite before making new Spotify changes.

The pause switch is `SPOTIFY_DEVELOPMENT_PAUSED` in `app/main/main.js`; change it from `true` to `false` only when Spotify development is explicitly resumed.
