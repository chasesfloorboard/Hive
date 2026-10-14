'use strict';

// Hive: turn a MusicBee XML skin into a Hive theme (.hive-theme). MusicBee
// skins name colours in a <variables> block and reference them from
// <element id=... bg=... fg=...> entries; the handful of elements below map
// onto Hive's CSS variables. Compiled .xmlc skins are binary and skipped.

const VAR_LINE = /([A-Za-z][\w-]*)\s*=\s*"([^"]*)"/g;

function parseRgb(value) {
  const parts = String(value || '').split(',').map(v => Number(v.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some(n => !Number.isFinite(n))) return null;
  const [r, g, b] = parts.map(n => Math.max(0, Math.min(255, Math.round(n))));
  const a = parts.length > 3 ? Math.max(0, Math.min(255, parts[3])) / 255 : 1;
  return { r, g, b, a };
}

function parseMusicBeeSkin(xmlText) {
  const xml = String(xmlText || '').replace(/^﻿/, '');
  if (!/<root[\s>]|<colours\b/i.test(xml)) throw new Error('Not a MusicBee XML skin (compiled .xmlc skins can\'t be read).');
  // Overlay skins (e.g. "Dark-Fine Tuned") only recolour a base skin.
  const dependsOn = (xml.match(/<root\s+dependsOn="([^"]+)"/i) || [])[1] || '';
  const name = (xml.match(/<!--\s*Skin Name:\s*(.*?)\s*-->/i) || [])[1] || '';
  const variables = {};
  const block = (xml.match(/<variables>([\s\S]*?)<\/variables>/i) || [])[1] || '';
  for (const m of block.matchAll(VAR_LINE)) variables[m[1].toLowerCase()] = m[2];
  const resolve = ref => {
    let v = String(ref || '').trim();
    for (let i = 0; i < 5 && v && !/^\d/.test(v); i++) v = variables[v.toLowerCase()] || '';
    return parseRgb(v);
  };
  const elements = {};
  // Only the default colour set; later <colours> blocks are per-panel overrides.
  const defaults = (xml.match(/<colours id="Default">([\s\S]*?)<\/colours>/i) || [])[1] || xml;
  for (const m of defaults.matchAll(/<element\s+id="([^"]+)"([^>]*)\/?>/gi)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
    elements[m[1]] = attrs;
  }
  // accept(c) lets a candidate be rejected (e.g. text too close to the
  // background) so the next one is tried.
  const pick = (candidates, accept = () => true) => {
    for (const [id, attr] of candidates) {
      const raw = id.startsWith('$') ? id.slice(1) : elements[id]?.[attr];
      const c = resolve(raw);
      if (c && accept(c)) return c;
    }
    return null;
  };
  let bg = pick([['ApplicationBackColour', 'bg'], ['WindowBackColour', 'bg'], ['$Background'], ['$Background-Colour']]);
  if (!bg && dependsOn) bg = { r: 18, g: 18, b: 21, a: 1 }; // the dark base these overlays sit on
  if (!bg) throw new Error('Could not find this skin\'s background colour.');
  const readable = c => contrast(c, bg) >= 3;
  const text = pick([['$Primary-Text'], ['$PrimaryText'], ['Menu.DropDown.Default', 'fg'], ['MenuBar.Default', 'fg'], ['$font_1'], ['Panel.Body.Highlight', 'fg'], ['Menu.ParentItem.Highlight', 'fg']], readable)
    || (luminance(bg) > 0.55 ? { r: 20, g: 20, b: 20, a: 1 } : { r: 236, g: 236, b: 240, a: 1 });
  const colours = {
    bg, text,
    textDim: pick([['$Secondary-Text'], ['$SecondaryText'], ['MenuButton.Default', 'fg'], ['$font_2']], c => contrast(c, bg) >= 2),
    textDimmer: pick([['$Tertiary-Text'], ['$TertiaryText'], ['InlineMenuBar.Default', 'fg'], ['Menu.DropDown.Disabled', 'fg']], c => contrast(c, bg) >= 1.5),
    accent: pick([['Menu.DropDown.Highlight', 'bg'], ['Menu.ParentItem.Highlight', 'bg'], ['$Highlight'], ['$Accent'], ['$theme']], c => contrast(c, bg) >= 1.2)
  };
  return { name: name.trim(), dependsOn, colours };
}

function relLum(c) {
  const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function contrast(a, b) { const x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const hex = c => `#${[c.r, c.g, c.b].map(n => n.toString(16).padStart(2, '0')).join('')}`;
const rgba = (c, a) => `rgba(${c.r},${c.g},${c.b},${a})`;
const mix = (a, b, t) => ({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });
const luminance = c => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

function skinToHiveTheme(parsed, fallbackName = 'MusicBee skin') {
  const { bg, text } = parsed.colours;
  const light = luminance(bg) > 0.55;
  const textDim = parsed.colours.textDim || mix(text, bg, 0.35);
  const textDimmer = parsed.colours.textDimmer || mix(text, bg, 0.6);
  let accent = parsed.colours.accent || mix(text, bg, 0.2);
  // Hive uses the accent for highlights and some text, so keep it visible.
  for (let i = 0; i < 6 && contrast(accent, bg) < 2.2; i++) accent = mix(accent, text, 0.25);
  const panel = mix(bg, light ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }, 0.04);
  const css = `:root {
  --bg: ${hex(bg)};
  --panel: ${rgba(panel, 0.72)};
  --panel-strong: ${rgba(panel, 0.9)};
  --border: ${light ? 'rgba(0,0,0,.1)' : 'rgba(255,255,255,.09)'};
  --text: ${hex(text)};
  --text-dim: ${hex(textDim)};
  --text-dimmer: ${hex(textDimmer)};
  --accent: ${hex(accent)};
  --accent-soft: ${rgba(accent, 0.35)};
  --accent-glow: ${rgba(accent, 0.26)};
  --ambient-a: ${rgba(accent, 0.16)};
  --ambient-b: ${rgba(mix(accent, bg, 0.5), 0.14)};
  --radius: 14px;
  --blur: 24px;
}
`;
  return { format: 'hive-theme', version: 1, name: parsed.name || fallbackName, css, source: 'MusicBee skin' };
}

module.exports = { parseMusicBeeSkin, skinToHiveTheme, parseRgb, contrast };
