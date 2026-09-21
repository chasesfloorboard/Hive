# Tracks Column UX Audit — Build 34

## Scope

This pass addresses the Music → Tracks header behavior shown in the current UI:

1. Column boundary/resizer lines should be visible without first hovering or resizing.
2. The Tracks grid should fit the visible Music viewer by default.
3. Header sections should be draggable into a new order.
4. Moving a header must move the complete column identity, so its row values and sort/filter behavior stay attached to that column.
5. Settings tabs should be a permanently visible, flat button strip rather than a scrollable tab surface.

## Findings

### Column boundaries

The resize hit areas already existed, but their visible divider was effectively a hover affordance. The divider is now rendered at rest with the accent/border blend and becomes stronger during resize.

### Fit-to-viewer

The renderer already had the correct architectural direction from Build 29: Music Tracks is permanently fit-to-viewer, and fitted widths are authoritative. Build 34 preserves that invariant and keeps the fitter tied to the active table through `ResizeObserver`.

The fitter accounts for header/row horizontal padding and grid gaps before distributing widths. It also proportionally scales below normal metadata minimums when necessary rather than introducing horizontal spill.

### Column reordering

The existing implementation stores columns by stable definition key (`position`, `title`, `artist`, etc.), not by visual index. Reordering therefore changes `songColumns.keys` while leaving each column's renderer/sort definition attached to its key.

Build 34 hardens the interaction by making the header cell the draggable surface and explicitly disabling native dragging on the nested sort button. The resize handle remains a separate interaction.

Consequences:

- Dragging `Artist` moves Artist values with the header.
- Sorting `Artist` still sorts by the Artist key after it is moved.
- The row renderer continues to read values by the same column key.
- Saved order persists in the existing `hive:song-columns` preference.
- Column widths remain keyed by column identity rather than position.

### Settings tabs

The Settings tab strip was using a flexible layout that could behave like a scrollable tab surface at constrained sizes. Build 34 changes it to a fixed grid of flat buttons: eight visible buttons at normal Settings width and four per row on narrow windows. The strip itself does not scroll.

## Validation

Static validation performed for Build 34:

- Renderer JavaScript syntax check.
- Main-process JavaScript syntax check.
- Preload JavaScript syntax check.
- Installer shell syntax check.
- Project `npm run check`.
- Unit test suite (`npm test`): expected existing environment-only `music-metadata/lib/index.js` failure remains; other tests pass.
- Targeted source assertions for visible column dividers, fit-to-viewer default, draggable column cells, non-draggable sort buttons, keyed reorder behavior, and non-scrollable Settings tabs.
- ZIP integrity check.

No Electron runtime/UI test was performed in this environment, so runtime success is not claimed.
