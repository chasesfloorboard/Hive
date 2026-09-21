# Build 140 — Executable Installer Packaging Fix

## Purpose

Build 140 fixes a release-packaging regression where `install.sh` was present but had mode `0644`, so it could not be launched directly as `./install.sh`.

## Changes

- `install.sh` is now mode `0755`.
- Shipped shell entrypoints are mode `0755`: `run.sh`, `setup-music-presence.sh`, `enable-music-presence-autostart.sh`, `scripts/hive-launcher.sh`, and `scripts/spotify-background.sh`.
- The package test suite includes a regression check for executable shell entrypoints.

## Validation

- Shell syntax checks run with `bash -n`.
- Executable-bit checks run against the source tree.
- ZIP metadata is inspected after packaging to verify `install.sh` is stored as executable.
- ZIP integrity is tested with `unzip -t`.
