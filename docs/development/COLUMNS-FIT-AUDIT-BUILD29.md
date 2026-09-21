# Tracks Column Fit Audit — Build 29

## Finding

Build 28 correctly measured the usable viewer width, but `applySongColumnGrid()` immediately clamped every fitted width back to the normal per-column `minWidth`. On narrow Music viewers this recreated the overflow that the fitter had just removed.

There was also an intrinsic-width risk from grid children containing long metadata.

## Fix

- Fit mode now treats the calculated widths as authoritative and does not re-clamp them to editor minimums.
- Manual/non-fit mode retains the normal column minimums.
- Horizontal scrolling is only marked active for the explicit non-fit/manual mode.
- Grid children are explicitly shrinkable and long metadata ellipsizes instead of expanding a grid track.
- Existing proportional resizing and fit-to-viewer behavior remain intact.

## Regression target

The selected Music track columns must consume the actual Music viewer width without crossing the right edge or being clipped by the Playing Tracks panel.
