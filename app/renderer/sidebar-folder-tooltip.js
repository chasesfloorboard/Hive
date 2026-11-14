'use strict';
// The hover tooltip for a sidebar library-folder row: it shows the folder's full path
// (the row only shows the last path segment) and follows the pointer. Separate from the
// global data-tooltip system (tooltip-system.js) because it is pointer-tracking and
// folder-specific. Extracted from renderer.js (docs/ai/ARCHITECTURE.md). Dual-mode:
// `window.HiveSidebarFolderTooltip` for the app, `module.exports` for node tests. The
// factory owns its own tooltip element + last-pointer state; document/window/rAF are
// injectable, and the clamp math is a pure, unit-testable helper.
(function () {
  // Position the tooltip near the pointer, clamped 8px inside the viewport on every edge.
  // Pure: no DOM.
  function clampFolderTooltip(pointer, size, viewport, pad = 8) {
    return {
      left: Math.max(pad, Math.min(viewport.width - size.width - pad, pointer.x + 14)),
      top: Math.max(pad, Math.min(viewport.height - size.height - pad, pointer.y + 16)),
    };
  }

  function createSidebarFolderTooltip(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    const win = deps.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) throw new Error('createSidebarFolderTooltip needs a document and window');
    const raf = deps.requestAnimationFrame || (win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (cb) => cb());

    let tip = null;
    let lastPointer = { x: 0, y: 0 };

    function ensureSidebarFolderTooltip() {
      if (tip) return tip;
      tip = doc.createElement('div');
      tip.className = 'beehive-tooltip sidebar-folder-tooltip';
      doc.body.appendChild(tip);
      return tip;
    }

    // Signature kept as (_item, folder, e): the first arg (the row element) is unused but
    // the single call site passes it, so the seam stays a drop-in.
    function showSidebarFolderTooltip(_item, folder, e) {
      const node = ensureSidebarFolderTooltip();
      node.textContent = String(folder || '');
      if (e) lastPointer = { clientX: e.clientX, clientY: e.clientY };
      node.classList.add('visible');
      // lastPointer is stored in event shape so the first (rAF) placement is correct.
      // (Before extraction it was stored as {x,y} but move() reads .clientX/.clientY, so
      // the very first frame positioned at NaN until the next mousemove corrected it.)
      raf(() => moveSidebarFolderTooltip(lastPointer));
    }

    function moveSidebarFolderTooltip(e) {
      if (!e) return;
      lastPointer = { clientX: e.clientX, clientY: e.clientY };
      if (!tip?.classList.contains('visible')) return;
      const r = tip.getBoundingClientRect();
      const { left, top } = clampFolderTooltip(
        { x: e.clientX, y: e.clientY },
        { width: r.width, height: r.height },
        { width: win.innerWidth, height: win.innerHeight },
      );
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    }

    function hideSidebarFolderTooltip() { tip?.classList.remove('visible'); }

    return { showSidebarFolderTooltip, moveSidebarFolderTooltip, hideSidebarFolderTooltip, ensureSidebarFolderTooltip, clampFolderTooltip };
  }

  const exported = { createSidebarFolderTooltip, clampFolderTooltip };
  if (typeof window !== 'undefined') window.HiveSidebarFolderTooltip = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
