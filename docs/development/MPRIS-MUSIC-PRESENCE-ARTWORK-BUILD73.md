# MPRIS / Music Presence Artwork Repair — Build 73

## Problem

Hive already contained `app/main/artwork-proxy.js`, but the proxy was not instantiated or started. MPRIS therefore exposed local cached covers as `file://` URLs while remote/provider artwork used HTTP(S) URLs.

## Fix

Build 73 makes the existing proxy part of the normal MPRIS lifecycle:

1. Start the localhost-only artwork proxy during Hive startup.
2. Start MPRIS after the proxy is ready.
3. For local cached artwork, publish `http://127.0.0.1:<ephemeral-port>/cover/<basename>` through `mpris:artUrl`.
4. Preserve provider artwork URLs for Spotify/remote tracks.
5. Stop the proxy during application shutdown.

The proxy remains restricted to Hive's cached cover directory and performs basename, path, and realpath containment checks.

## Architecture invariant

Hive does not publish Discord Rich Presence and does not connect to Discord IPC. Music Presence remains the sole Discord publisher. Hive's responsibility is accurate MPRIS metadata, playback state, and artwork.
