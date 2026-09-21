# Hive Build 102 — Spotify Background Ownership Handoff Recovery

## Root cause

Build 101 still relied on the PID recorded from the initial Spotify launch. The Arch Spotify client can create/hand off Chromium processes, so a later helper could see `spotify` processes while the originally recorded PID no longer represented the active provider. The helper then rejected the remaining provider as a visible desktop Spotify.

## Recovery model

Build 102 keeps a durable `spotify-background-owner.json` record separate from the transient lifecycle status file. Every Hive-launched Spotify process inherits `HIVE_SPOTIFY_OWNER=1` and a random `HIVE_SPOTIFY_INSTANCE_ID`. A subsequent helper scans all `spotify` processes and matches that marker plus the isolated `DISPLAY`, allowing ownership recovery after PID handoff.

If the recorded Xvfb server has disappeared, all matching processes for that Hive instance are treated as orphaned and terminated before a fresh provider is started. Unrelated Spotify processes still cause the visible-client guard to fail safely.

## Preserved behavior

The existing Xvfb `-displayfd` allocation, X11/Ozone launch path, Spicetify bridge, Spotify transport, playlist/artwork handling, and external-provider streaming model are unchanged.
