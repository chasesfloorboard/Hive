# Build 30 — Spotify artwork audit

## Root cause

Build 29 already carried Spotify cover URLs through imported playlist records and the Spotify bridge, but the bridge also has access to Spotify’s internal Player metadata fields such as `image_xlarge_url`. Those fields can be `spotify:image:<id>` URIs rather than browser-loadable HTTP URLs. Hive’s generic `mbcover://` resolver cannot serve those provider URIs, so artwork could arrive correctly and still render as missing.

Spicetify documents the Player metadata image fields as internal URL paths, and current Spotify/Spicetify player metadata uses `spotify:image:` identifiers. The Build 30 bridge converts those identifiers to Spotify CDN URLs (`https://i.scdn.co/image/<id>`) before sending artwork to Hive.

## Changes

- Added `spotifyImageUrl()` to the Spicetify bridge.
- Bridge artwork resolution now checks Spotify album image URLs first, then `image_xlarge_url`, `image_large_url`, `image_url`, and `image_small_url`.
- Added explicit `artworkUrl` alongside the legacy `cover` field so Spotify artwork is a first-class external visual source.
- Added renderer-side `normalizeSpotifyArtworkSource()` so old/imported records containing `spotify:image:` remain displayable.
- Spotify playback state now updates both `cover` and `artworkUrl` when the bridge supplies artwork.
- Queue-session serialization persists `artworkUrl`.
- Public playlist fallback also carries `artworkUrl`.
- Now Playing/queue artwork explicitly recognize Spotify external artwork before falling back to automatic artwork.
- No Spotify artwork is downloaded into Hive’s local music library or written into local audio tags.

## Validation

- `node --check app/renderer/renderer.js` — PASS
- `node --check resources/spicetify/hive-spotify-bridge.js` — PASS
- `node --check app/main/main.js` — PASS
- `bash -n install.sh` — PASS
- `bash -n run.sh` — PASS
- `node scripts/check.js` — PASS
- `npm test` — expected 19/20 environment result; the remaining failure is the known missing `node_modules/music-metadata/lib/index.js` in the build environment.
- ZIP integrity — PASS
- Runtime Spotify/Spicetify playback was not available in the build environment, so no runtime success is claimed.
