// Text on an accent-coloured surface (the play button, primary buttons, the
// active Settings tab) must stay readable whatever the theme's accent is: a
// muted grey, a pale lemon, a deep grape. This keeps --accent-contrast set to
// whichever of near-black or white reads better on the current --accent, and
// updates it whenever the theme changes.
(function (root) {
  const DARK = [6, 6, 8];
  const LIGHT = [255, 255, 255];

  function luminance([r, g, b]) {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function ratio(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  // Pure: the text colour (as 'rgb(...)') for an accent given as [r, g, b].
  function textOnAccent(rgb) {
    return ratio(rgb, DARK) >= ratio(rgb, LIGHT) ? `rgb(${DARK.join(', ')})` : `rgb(${LIGHT.join(', ')})`;
  }

  const api = { textOnAccent, contrastRatio: ratio };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.HiveAccentContrast = api;

  const doc = root.document;
  let probe = null;
  let last = '';
  function update() {
    const html = doc.documentElement;
    const accent = root.getComputedStyle(html).getPropertyValue('--accent').trim();
    if (!accent || !doc.body) return;
    if (!probe) {
      probe = doc.createElement('span');
      probe.hidden = true;
      probe.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(probe);
    }
    probe.style.color = '';
    probe.style.color = accent;
    const parts = (root.getComputedStyle(probe).color.match(/[\d.]+/g) || []).map(Number);
    if (parts.length < 3) return;
    const value = textOnAccent(parts.slice(0, 3));
    if (value === last && html.style.getPropertyValue('--accent-contrast') === value) return;
    last = value;
    html.style.setProperty('--accent-contrast', value);
  }
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    root.requestAnimationFrame(() => { queued = false; update(); });
  }
  function start() {
    update();
    new root.MutationObserver(schedule).observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-hive-theme'] });
    new root.MutationObserver(schedule).observe(doc.body, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(typeof window !== 'undefined' ? window : null);
