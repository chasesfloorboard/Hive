# Build 143 — Metadata object cleanup

## Purpose

Prevent JavaScript object coercion from leaking into user-visible Comments and Lyrics metadata.

## Changes

- Added object-safe metadata text normalization in the renderer and scanner.
- Common object-shaped metadata values are recursively unwrapped from `text`, `plainLyrics`, `lyrics`, `value`, and `description` fields.
- Arrays of text values are joined without object coercion.
- The literal `[object Object]` sentinel is treated as invalid display metadata rather than shown to the user.
- Comment and lyric values are normalized at library-load, incremental-scan, and track-update boundaries as well as table/editor/smart-playlist display paths.
- Existing lyrics normalization remains the established compatibility wrapper.

## Verification

Targeted metadata regression tests pass. Full test and static checks are run as part of packaging; runtime verification against affected user files remains required.
