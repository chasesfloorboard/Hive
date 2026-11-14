'use strict';
// The global hover-tooltip system: one themed, delegated Hive tooltip that replaces
// Chromium's native `title` popups and shows `data-tooltip` hints. Extracted from
// renderer.js (docs/ai/ARCHITECTURE.md — renderer DOM/view de-monolith). Dual-mode:
// `window.HiveTooltip` for the app, `module.exports` for node tests. The pure helpers
// (tooltipTextFor, clampTooltipPosition) are unit-tested; install() wires the
// document-level listeners + MutationObserver in the running app.
(function () {
  const DEFAULT_DELAY_MS = 420; // hover dwell before a tooltip appears
  const EDGE_PAD = 10;          // keep the box this far from the viewport edge

  // The text a node's tooltip should show: an explicit data-tooltip wins, else the
  // node's native title. Pure.
  function tooltipTextFor(node) {
    return node?.getAttribute?.('data-tooltip') || node?.getAttribute?.('title') || '';
  }

  // Place the tooltip box near the pointer, flipping to the other side when it would
  // overflow the right/bottom edge, and never letting it cross the top/left pad. Pure:
  // no DOM, fully unit-testable.
  function clampTooltipPosition(pointer, size, viewport, pad = EDGE_PAD) {
    let left = pointer.x + 12;
    let top = pointer.y + 16;
    if (left + size.width > viewport.width - pad) left = Math.max(pad, pointer.x - size.width - 12);
    if (top + size.height > viewport.height - pad) top = Math.max(pad, pointer.y - size.height - 12);
    return { left, top };
  }

  // Build a tooltip controller bound to a given document/window. install() is what the
  // renderer calls once; everything else is internal.
  function createTooltipSystem(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    const win = deps.window || (typeof window !== 'undefined' ? window : null);
    const delayMs = deps.delayMs == null ? DEFAULT_DELAY_MS : deps.delayMs;
    if (!doc || !win) throw new Error('createTooltipSystem needs a document and window');

    let tip = null, timer = null, target = null, observer = null;

    // Promote a native `title` into data-tooltip (so later state changes — Shuffle
    // on/off, Maximize/Restore — refresh the text instead of freezing the first one),
    // mirror it to aria-label (screen readers never read data-tooltip, so stripping
    // title alone would remove the only accessible name icon-only controls had), then
    // drop the title so Chromium's own popup never fires.
    function prepareTooltipNode(node) {
      if (!(node instanceof win.Element) || node === tip) return;
      const title = node.getAttribute('title');
      if (title) node.setAttribute('data-tooltip', title);
      if (title && !node.getAttribute('aria-label')) node.setAttribute('aria-label', title);
      if (title) node.removeAttribute('title');
    }

    function position(e) {
      if (!tip || !tip.classList.contains('visible')) return;
      const r = tip.getBoundingClientRect();
      const { left, top } = clampTooltipPosition(
        { x: e.clientX, y: e.clientY },
        { width: r.width, height: r.height },
        { width: win.innerWidth, height: win.innerHeight },
      );
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    }

    function onPointerOver(e) {
      const node = e.target?.closest?.('[data-tooltip]'); if (!node) return;
      // Moving between parts of the same thing (an album card's cover, title and
      // artist) fires pointerover again: the showing tooltip stays put rather than
      // flickering off and back on.
      if (node === target) return;
      const text = tooltipTextFor(node); if (!text) return;
      prepareTooltipNode(node); target = node;
      if (!tip) { tip = doc.createElement('div'); tip.className = 'beehive-global-tooltip'; doc.body.appendChild(tip); }
      if (timer) clearTimeout(timer);
      tip.classList.remove('visible');
      timer = setTimeout(() => {
        if (target !== node) return;
        // Optional second, dimmer line (e.g. file size after a duration).
        const secondary = String(node.dataset.tooltipSecondary || '');
        if (secondary) {
          tip.textContent = '';
          const main = doc.createElement('span'); main.className = 'tooltip-primary'; main.textContent = text;
          const sub = doc.createElement('span'); sub.className = 'tooltip-secondary'; sub.textContent = secondary;
          tip.append(main, sub);
        } else tip.textContent = text;
        tip.classList.add('visible'); position(e);
      }, delayMs);
    }

    function onPointerOut(e) {
      const node = e.target?.closest?.('[data-tooltip]');
      if (node && !node.contains(e.relatedTarget)) {
        if (timer) clearTimeout(timer);
        target = null;
        tip?.classList.remove('visible');
      }
    }

    // Wire the delegated listeners once, plus a MutationObserver so dynamically created
    // rows, cards and context-menu items get their native titles themed too.
    function install() {
      doc.addEventListener('pointerover', onPointerOver);
      doc.addEventListener('pointermove', position);
      doc.addEventListener('pointerout', onPointerOut);
      observer = new win.MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'title') prepareTooltipNode(m.target);
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) { prepareTooltipNode(node); node.querySelectorAll?.('[title]').forEach(prepareTooltipNode); }
          }
        }
      });
      observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
      doc.querySelectorAll('[title]').forEach(prepareTooltipNode);
      return api;
    }

    const api = { tooltipTextFor, clampTooltipPosition, prepareTooltipNode, install };
    return api;
  }

  const exported = { createTooltipSystem, tooltipTextFor, clampTooltipPosition };
  if (typeof window !== 'undefined') window.HiveTooltip = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
