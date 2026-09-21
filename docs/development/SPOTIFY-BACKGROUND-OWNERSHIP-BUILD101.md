# Hive Build 101 — Spotify Background Ownership Recovery

## Problem

The Spotify background helper previously treated any process named `spotify` as a user-visible desktop Spotify instance. Hive's launcher can restart the Electron/helper process while a previously launched background Spotify process survives, so the next helper invocation incorrectly failed with `Spotify is already running visibly.`

## Recovery model

The helper now uses the persisted `~/.cache/hive/spotify-background-status.json` lifecycle record to recognize a provider it owns. Before accepting the record, it verifies:

- the recorded Spotify PID is still alive;
- the recorded process command name is `spotify`;
- the process environment still contains the recorded isolated `DISPLAY`; and
- when recorded, the associated Xvfb PID is still alive.

Only after that ownership check does the helper reject an unrelated running Spotify process. A verified Hive-owned provider is reused on its existing isolated display.

## Cleanup

A helper that is reattached to an existing provider does not kill that Spotify process on exit because it did not launch it during that invocation. The helper still manages the associated Xvfb display.

If the provider PID survives but its recorded Xvfb server is gone, Hive treats the provider as an orphan rather than reusing it and terminates that stale provider before starting a fresh isolated client.

## Compatibility

This change preserves the existing Xvfb `-displayfd` allocation, forced X11/Ozone launch path, Spicetify transport, bridge diagnostics, and external Spotify streaming architecture. It does not download or stream-rip Spotify audio.
