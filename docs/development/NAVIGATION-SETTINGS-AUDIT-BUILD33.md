# Hive — Navigation Settings Audit — Build 33

## User-facing goal

The previous Navigation settings editor exposed drag-and-drop ordering and per-row vertical resizing. That made a simple navigation task feel like a layout editor and was difficult to scan.

## Changes

1. Sidebar ordering is now controlled by explicit **Up** and **Down** buttons.
2. Sidebar rows have a fixed standard height; Navigation settings no longer expose resize handles or size controls.
3. Built-in sidebar destinations still support Show/Hide and Rename.
4. Custom visual dividers still support ordering, Rename, and Remove.
5. Top built-in tabs use the same explicit Up/Down ordering controls.
6. The Beta Lab Settings tab and panel were removed from the user-facing Settings UI.
7. The obsolete Beta Lab Settings host initialization and navigation resize CSS were removed.
8. Existing saved `sizes` preferences are ignored and are no longer written, returning the sidebar to the standard item height.

## Regression checks

- Renderer JavaScript syntax check required.
- Settings HTML checked for removal of `data-settings-tab="beta"` and `data-settings-panel="beta"`.
- Navigation renderer checked for absence of resize-handle code.
- Navigation settings copy checked to ensure it no longer instructs users to drag or resize.
- Existing navigation features (hide, rename, visual divider, top-tab order) remain wired.

Runtime UI testing is not claimed unless executed separately.
