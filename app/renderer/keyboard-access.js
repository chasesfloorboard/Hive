'use strict';
// Keyboard use of the library (CLAUDE.md accessibility findings #5/#6): album cards, song rows and
// queue rows can be reached and used without a mouse, and the right-click menu works with the
// arrow keys. Everything is delegated from the document, so it keeps working for the virtual
// lists that reuse their row elements. renderer.js gives the elements their roles, names and
// tabindex when it draws them. Loaded as a plain script (window.HiveKeyboardAccess) and by the
// tests via require().
(function (root) {
  const ROW = '.song-row, .queue-row';
  const CARD = '.album-card';

  // The index the arrow keys move to in a list of `count` items, or -1 when the key doesn't move.
  function stepIndex(current, key, count, page = 10) {
    if (count <= 0) return -1;
    const at = current < 0 ? -1 : current;
    switch (key) {
      case 'ArrowDown': return Math.min(count - 1, at + 1);
      case 'ArrowUp': return at < 0 ? 0 : Math.max(0, at - 1);
      case 'Home': return 0;
      case 'End': return count - 1;
      case 'PageDown': return Math.min(count - 1, Math.max(0, at) + page);
      case 'PageUp': return Math.max(0, at - page);
      default: return -1;
    }
  }

  // Menu items wrap around, as they do in native menus.
  function stepMenu(current, key, count) {
    if (count <= 0) return -1;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
    if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count;
    return -1;
  }

  // Spoken names. The visible text is in the element too, but a card or row reads better as one phrase.
  function albumLabel(album) {
    const title = String(album?.title || '').trim() || 'Unknown album';
    const artist = String(album?.artist || '').trim();
    return artist ? `${title} by ${artist}` : title;
  }
  function starLabel(value) { return `Rate ${value} star${value === 1 ? '' : 's'}`; }

  // Opens an element's own right-click menu from the keyboard (the Menu key or Shift+F10).
  function openContextMenuFor(node) {
    const r = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + Math.min(40, r.width / 2)), clientY: Math.round(r.top + r.height / 2) }));
  }
  const isMenuKey = e => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
  const typing = target => !!target?.closest?.('input, textarea, select, [contenteditable="true"]');

  // Rows in a virtual list: the neighbour may not be drawn yet, so scroll by a row and look again.
  function moveRowFocus(row, key) {
    const list = Array.from(row.parentElement?.querySelectorAll(':scope > ' + (row.classList.contains('queue-row') ? '.queue-row' : '.song-row')) || [])
      .filter(r => r.offsetParent !== null)
      .sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx));
    const at = list.indexOf(row);
    const next = list[stepIndex(at, key, list.length, Math.max(1, list.length - 2))];
    const scroller = scrollParent(row);
    if (next && next !== row) { next.focus({ preventScroll: false }); next.scrollIntoView({ block: 'nearest' }); return; }
    if (!scroller) return;
    // At the edge of what's drawn: move the list and focus whichever row now holds the next index.
    const want = Number(row.dataset.idx) + (key === 'ArrowUp' || key === 'PageUp' ? -1 : 1);
    if (key === 'Home') scroller.scrollTop = 0;
    else if (key === 'End') scroller.scrollTop = scroller.scrollHeight;
    else scroller.scrollTop += (want < Number(row.dataset.idx) ? -1 : 1) * row.offsetHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const rows = Array.from(row.parentElement?.querySelectorAll(':scope > .song-row, :scope > .queue-row') || []).filter(r => r.offsetParent !== null);
      const target = key === 'Home' ? rows.sort((a, b) => a.dataset.idx - b.dataset.idx)[0]
        : key === 'End' ? rows.sort((a, b) => b.dataset.idx - a.dataset.idx)[0]
        : rows.find(r => Number(r.dataset.idx) === want);
      target?.focus();
    }));
  }
  function scrollParent(node) {
    for (let n = node.parentElement; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight) return n;
    }
    return null;
  }
  // Cards sit in a grid: left/right go one card, up/down go one row of cards.
  function moveCardFocus(card, key) {
    const cards = Array.from(card.parentElement?.querySelectorAll(':scope > ' + CARD) || []).filter(c => c.offsetParent !== null);
    const at = cards.indexOf(card);
    if (at < 0) return;
    const top = card.offsetTop;
    const perRow = Math.max(1, cards.filter(c => c.offsetTop === top).length);
    const by = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow }[key];
    const next = key === 'Home' ? cards[0] : key === 'End' ? cards[cards.length - 1] : cards[Math.max(0, Math.min(cards.length - 1, at + by))];
    if (next && next !== card) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
  }

  function onKeydown(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(e.target)) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.matches(ROW) ? target : null;
    const card = !row && target.matches(CARD) ? target : null;
    if (!row && !card) return;
    const node = row || card;
    if (isMenuKey(e)) { e.preventDefault(); openContextMenuFor(node); return; }
    if (e.key === 'Enter') {
      // Enter does what a double-click does: play the song, jump to the queue entry, play the album.
      e.preventDefault();
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return;
    }
    if (e.key === ' ') {
      // Space selects (a row) or opens the album's tracks (a card), as a single click does.
      e.preventDefault();
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: e.shiftKey }));
      return;
    }
    if (row && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) { e.preventDefault(); moveRowFocus(row, e.key); return; }
    if (card && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); moveCardFocus(card, e.key); }
  }

  // ---- The right-click menu ----
  let menuReturnFocus = null;
  const menuItems = menu => Array.from(menu.querySelectorAll(':scope > .context-item, :scope > .context-submenu-wrap > .context-submenu-trigger')).filter(b => b.offsetParent !== null && !b.disabled);
  const subItems = sub => Array.from(sub.querySelectorAll(':scope > .context-item')).filter(b => !b.disabled);

  // Called by showContextMenu() once the menu is built and placed.
  function prepareMenu(menu, { focusFirst = true } = {}) {
    menu.setAttribute('role', 'menu');
    menu.querySelectorAll('.context-item, .context-submenu-trigger').forEach(b => { b.setAttribute('role', 'menuitem'); b.tabIndex = -1; });
    menu.querySelectorAll('.context-submenu').forEach(sub => sub.setAttribute('role', 'menu'));
    menu.querySelectorAll('.context-submenu-trigger').forEach(b => { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); });
    menu.querySelectorAll('.context-rating-help').forEach(h => h.setAttribute('role', 'presentation'));
    const active = document.activeElement;
    if (active && active !== document.body && !menu.contains(active)) menuReturnFocus = active;
    if (!menu._hiveKeys) { menu.addEventListener('keydown', onMenuKeydown); menu._hiveKeys = true; }
    if (focusFirst) menuItems(menu)[0]?.focus({ preventScroll: true });
  }
  function openSub(trigger, focus = true) {
    const wrap = trigger.parentElement;
    const sub = wrap?.querySelector(':scope > .context-submenu');
    if (!sub) return null;
    wrap.dispatchEvent(new MouseEvent('mouseenter'));  // places it on screen (see showContextMenu)
    wrap.classList.add('keyboard-open');
    trigger.setAttribute('aria-expanded', 'true');
    if (focus) subItems(sub)[0]?.focus();
    return sub;
  }
  function closeSub(wrap) {
    wrap?.classList.remove('keyboard-open');
    wrap?.querySelector(':scope > .context-submenu-trigger')?.setAttribute('aria-expanded', 'false');
  }
  function onMenuKeydown(e) {
    const menu = e.currentTarget;
    const item = e.target.closest?.('.context-item, .context-submenu-trigger');
    const sub = item?.closest('.context-submenu');
    const items = sub ? subItems(sub) : menuItems(menu);
    const next = stepMenu(items.indexOf(item), e.key, items.length);
    if (next >= 0) { e.preventDefault(); e.stopPropagation(); items[next].focus(); return; }
    if (e.key === 'ArrowRight' && item?.classList.contains('context-submenu-trigger')) { e.preventDefault(); openSub(item); return; }
    if ((e.key === 'Enter' || e.key === ' ') && item?.classList.contains('context-submenu-trigger')) { e.preventDefault(); openSub(item); return; }
    if ((e.key === 'ArrowLeft' || e.key === 'Escape') && sub) {
      e.preventDefault(); e.stopPropagation();
      const wrap = sub.parentElement; closeSub(wrap);
      wrap.querySelector(':scope > .context-submenu-trigger')?.focus();
      return;
    }
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); root.hiveHideContextMenu?.(); }
  }
  // When the menu goes away, focus goes back to where it was (the row or card the menu was for).
  function menuClosed(menu) {
    menu?.querySelectorAll('.context-submenu-wrap.keyboard-open').forEach(closeSub);
    const back = menuReturnFocus; menuReturnFocus = null;
    if (back?.isConnected && menu?.contains(document.activeElement)) back.focus({ preventScroll: true });
  }

  // A song list or the queue is one Tab stop; arriving on it by keyboard moves on to its selected
  // row (or the first one drawn), and the arrow keys take it from there.
  function onFocusin(e) {
    const list = e.target;
    if (!(list instanceof Element) || !list.matches('[data-row-list]') || !list.matches(':focus-visible')) return;
    const rows = Array.from(list.querySelectorAll(ROW)).filter(r => r.offsetParent !== null);
    (rows.find(r => r.classList.contains('selected')) || rows.find(r => r.classList.contains('playing')) || rows[0])?.focus({ preventScroll: false });
  }

  function install(doc = document) { doc.addEventListener('keydown', onKeydown); doc.addEventListener('focusin', onFocusin); }

  const api = { stepIndex, stepMenu, albumLabel, starLabel, install, prepareMenu, menuClosed };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveKeyboardAccess = api;
})(typeof window !== 'undefined' ? window : globalThis);
