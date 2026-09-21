# Hive Build 169 — Frosted Glass Settings Fix

## Scope

Fix the Appearance → Frosted Glass controls so the Left sidebar and Lyrics surface toggles control the actual frosted surfaces they describe, and remove the redundant `Glass surfaces` theme checkbox.

## Root cause

The per-area glass state was already persisted and applied through `player-glass-surface` / `player-glass-transparent`, but the Left sidebar had a separate `#sidebar::before` pseudo-surface that independently painted the glass background and backdrop blur. The transparent class did not disable that pseudo-element, so the sidebar toggle could remove the outer background while leaving the real frosted layer active.

Lyrics had a second, smaller issue: `.sidebar-lyrics` retained its own translucent background and border when the Lyrics parent was marked transparent, leaving a visible surface after the Lyrics glass toggle was turned off.

The Appearance theme section also exposed a `Glass surfaces` checkbox that only wrote an unused `data-hive-glass` state. The actual frosted-surface controls are the dedicated Frosted Glass master/per-area settings, so the redundant checkbox was removed.

## Changes

- Removed the unused `Glass surfaces` theme option from Appearance.
- Removed its dead `glass` theme-option state/data handling from the renderer.
- Added a transparent-state override for the sidebar's `::before` glass layer.
- Added a transparent-state override for the Lyrics inner `.sidebar-lyrics` surface.
- Preserved the existing master switch, per-area persistence key, and all other glass-area controls.

## Validation

- Added `test/build169-frosted-glass-regressions.test.js` covering the redundant control removal and both transparent-surface regressions.
- Targeted Build 169 regression test passes.
- Full project test suite and static checks are run as part of packaging.
- No Electron GUI runtime test was performed in the build environment.
