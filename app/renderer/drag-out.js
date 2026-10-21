'use strict';
// Drag songs out of Hive into other apps (Bitwig, Discord, a file manager…)
// as the real files.
//
// Hive's song rows and album covers start an HTML drag (which Hive's own
// queue and playlists read) and ask the main process for a native file drag
// at the same moment. Only one drag can run at a time, so the HTML one used
// to win and other apps were offered only a link. Here, in the capture
// phase before Hive's own handlers, the HTML drag is cancelled for anything
// that is a file on disk, which lets the native drag run. Hive's drop
// targets keep working with it: they read what's being dragged from Hive's
// own state, not from the drag. When the native drag ends, the element it
// started from hears a dragend, as it would have from the HTML drag.
(() => {
  const SOURCES = '.song-row, .inline-track-row, .album-card';
  let source = null;

  // A streamed song ("ytm:…", "am:…") has no file; its drag stays an HTML one.
  const isFilePath = p => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(String(p || ''));

  document.addEventListener('dragstart', e => {
    const el = e.target?.closest?.(SOURCES);
    if (!el || el.getAttribute('draggable') !== 'true' && el.draggable !== true) return;
    const path = el.dataset?.path;
    if (path !== undefined && !isFilePath(path)) return;
    if (typeof window.beehive?.startNativeFileDrag !== 'function') return;
    source = el;
    e.preventDefault();
  }, true);

  window.beehive?.onNativeFileDragEnd?.(() => {
    const el = source;
    source = null;
    if (!el) return;
    // A row scrolled out of a virtual list is gone; any row of its kind clears the same state.
    const target = el.isConnected ? el : document.querySelector(SOURCES);
    target?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  });
})();
