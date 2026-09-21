# Build 210 — Topbar Resize and Search Focus Regression

## Changes

- Restored a visible accent focus ring around the complete library search control using `:focus-within`.
- Search overflow is visible so the focus ring cannot be clipped by the search wrapper.
- Made the themed topbar app row flexible instead of fixed-height so vertical topbar resizing changes the usable tab area.
- Removed the fixed `translateY(-11px)` tab positioning from the themed chrome.
- Tabs now remain vertically centered within the resizable app row while staying `no-drag` and interactive.

## Preservation

No playback, queue, scanning, navigation, artwork, tagging, or provider architecture was changed.
