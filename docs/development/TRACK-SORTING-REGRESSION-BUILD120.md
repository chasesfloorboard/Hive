# Build 120 — Track header sorting regression audit

## Reported symptom

After sorting the track-list columns once, subsequent header clicks could stop changing the ordering. This was especially visible after switching/re-rendering a Music/Favorites-style track collection.

## Root cause

The sortable header is rebuilt as part of every virtualized table render. Its click handler was attached to that transient `.song-header` element. At the same time, each header cell is a native draggable element for column reordering. Chromium can resolve later pointer interactions against the rebuilt draggable hierarchy as a drag gesture, leaving the expected sort click from reaching the transient handler.

## Build 120 change

Sorting is now delegated from the persistent `songsTable` element and bound once per table DOM instance. The handler discovers the current `.song-header-btn` at event time, so sorting survives header replacement and does not accumulate transient header listeners.

Column dragstart also explicitly rejects `.song-header-btn` targets. A button interaction is sorting, never a column reorder.

## Preserved behavior

- Existing ascending/descending direction rules are unchanged.
- Numeric columns keep their existing default direction.
- Column reordering remains available from draggable header cells.
- Column resizing remains unchanged.
- Virtualized rows and the large-library rendering path remain unchanged.
- Playback/GStreamer state is untouched.

## Verification

- Dedicated sorting regression tests cover stable-table delegation and the draggable-button guard.
- Full test suite and static checks are run during Build 120 packaging.
