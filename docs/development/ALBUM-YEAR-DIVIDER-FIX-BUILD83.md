# Build 83 — album year divider layout fix

## Problem

The Albums Years view could render release-year divider lines with a visibly
short or unstable width. The year sections were participating as 100%-basis
items inside the same flex layout used for album cards. That made the divider
container's sizing unnecessarily dependent on the card-flow flex formatting
context.

## Fix

- `#albums-grid.album-years-grouped` now uses a full-width block-flow section
  stack.
- Each `.album-year-section` is an explicit full-width block with
  `box-sizing: border-box`.
- `.album-year-heading` now uses a two-column grid (`year` + `1fr`) so the rule
  has a definite track to fill.
- `.album-year-rule` explicitly fills its available heading track.
- Removed `content-visibility:auto` from the year-section wrapper; individual
  album cards retain their existing content-visibility optimization.
- The nested `.album-year-grid` card layout is otherwise unchanged.

This is a layout-only regression fix. It does not change album grouping,
year sorting, card sizing, artwork loading, playback, or tab persistence.
