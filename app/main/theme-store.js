'use strict';

// Hive's theme gallery ("Browse themes"): themes people shared, listed in themes/store.json in the
// public Hive repository. No server: the list is read from GitHub, and sharing opens a pre-filled
// GitHub issue that the maintainer adds to the list.
//
// A theme from the gallery is only colours and sizes. Every value is checked against a short list
// of variables and plain value shapes (hex, rgb/rgba, px), so a shared theme can't load anything
// from the internet (no url()), import other CSS, or touch anything but Hive's colours.

const STORE_URL = 'https://raw.githubusercontent.com/chasesfloorboard/Hive/main/themes/store.json';
const SHARE_URL = 'https://github.com/chasesfloorboard/Hive/issues/new';
const MAX_STORE_BYTES = 1024 * 1024;

const THEME_VARS = ['--bg', '--panel', '--panel-strong', '--border', '--text', '--text-dim', '--text-dimmer',
  '--accent', '--accent-soft', '--accent-glow', '--ambient-a', '--ambient-b', '--radius', '--blur'];
const REQUIRED_VARS = ['--bg', '--text', '--accent'];

const BYTE = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|\\d?\\d)';
const ALPHA = '(?:0|1|0?\\.\\d{1,3}|1\\.0{1,3})';
const COLOUR = new RegExp(`^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\\(\\s*${BYTE}\\s*,\\s*${BYTE}\\s*,\\s*${BYTE}\\s*(?:,\\s*${ALPHA}\\s*)?\\))$`, 'i');
const LENGTH = /^(?:\d|[1-4]\d)px$/;

// ---- names in the gallery: a basic profanity and slur filter (themes/blocked-words.json) ----
// Only for what's shared: a theme's name on someone's own device is theirs.
let blockedWords = null;
function blocked() {
  if (!blockedWords) {
    try { blockedWords = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'themes', 'blocked-words.json'), 'utf8')); }
    catch { blockedWords = { anywhere: [], words: [] }; }
  }
  return blockedWords;
}
const LOOKALIKE = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g', '6': 'g' };
/** Whether a shared name, author or description has a slur or profanity in it. */
function isOffensive(value) {
  const raw = String(value || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const undone = [...raw].map(c => LOOKALIKE[c] ?? c).join('');
  const { anywhere = [], words = [] } = blocked();
  // Every letter run joined ("f u c k", "f.u.c.k" -> "fuck"), with letters said twice once ("fuuuck" -> "fuck").
  const joined = undone.replace(/[^a-z]/g, '');
  const squeezed = joined.replace(/(.)\1+/g, '$1');
  // The squeezed text is matched only against squeezed words still four letters or more ("kkk" would be "k").
  if (anywhere.some(w => { const sq = w.replace(/(.)\1+/g, '$1'); return joined.includes(w) || (sq.length >= 4 && squeezed.includes(sq)); })) return true;
  const tokens = new Set([...raw.split(/[^a-z0-9]+/), ...undone.split(/[^a-z0-9]+/)].filter(Boolean));
  return words.some(w => tokens.has(w));
}

/** One variable's value, if it's safe for that variable; otherwise null. */
function safeValue(name, value) {
  const v = String(value ?? '').trim();
  if (name === '--radius' || name === '--blur') return LENGTH.test(v) ? v : null;
  return COLOUR.test(v) ? v : null;
}

function text(value, max) { return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max); }

/** A gallery theme made safe: { id, name, author, description, vars }, or null if it isn't usable. */
function cleanTheme(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const vars = {};
  for (const name of THEME_VARS) {
    if (!raw.vars || !Object.prototype.hasOwnProperty.call(raw.vars, name)) continue;
    const v = safeValue(name, raw.vars[name]);
    if (v) vars[name] = v;
  }
  if (!REQUIRED_VARS.every(n => vars[n])) return null;
  const name = text(raw.name, 40);
  const id = text(raw.id, 48).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name || !id) return null;
  const author = text(raw.author, 40), description = text(raw.description, 140);
  // The gallery is for everyone: a bad name, author or description keeps a theme out of it.
  if ([name, id, author, description].some(isOffensive)) return null;
  return { id, name, author, description, vars };
}

/** The gallery's list, checked theme by theme (bad entries are left out, not fatal). */
function cleanStore(json) {
  const list = Array.isArray(json?.themes) ? json.themes : [];
  const seen = new Set();
  const out = [];
  for (const raw of list.slice(0, 500)) {
    const t = cleanTheme(raw);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/** CSS for a clean theme, the same shape as Hive's own theme packs. */
function themeCss(theme) {
  const lines = THEME_VARS.filter(n => theme.vars[n]).map(n => `  ${n}: ${theme.vars[n]};`);
  return `:root {\n${lines.join('\n')}\n}\n`;
}

/** The variables of a theme's CSS (the user's own theme, to share), or null if it has none Hive knows. */
function varsFromCss(css) {
  const vars = {};
  for (const m of String(css || '').matchAll(/(--[a-z-]+)\s*:\s*([^;}{]+)/gi)) {
    const name = m[1].toLowerCase();
    if (!THEME_VARS.includes(name) || vars[name]) continue;
    const v = safeValue(name, m[2]);
    if (v) vars[name] = v;
  }
  return REQUIRED_VARS.every(n => vars[n]) ? vars : null;
}

/** The link that opens a pre-filled GitHub issue sharing [theme] ({ name, author, vars }). */
function shareUrl(theme) {
  if ([theme?.name, theme?.author, theme?.description].some(isOffensive)) throw Object.assign(new Error('That name can\'t go in the theme gallery. Pick another one (you can still call it anything on your own device).'), { code: 'NAME_BLOCKED' });
  const clean = cleanTheme({ ...theme, id: theme?.id || theme?.name });
  if (!clean) return null;
  const body = [
    'A theme for the Hive theme gallery.',
    '',
    '```json',
    JSON.stringify(clean, null, 2),
    '```',
  ].join('\n');
  return `${SHARE_URL}?labels=theme&title=${encodeURIComponent(`Theme: ${clean.name}`)}&body=${encodeURIComponent(body)}`;
}

/** Reads the gallery. [fetchText]: (url, maxBytes) => text, so tests need no network. */
async function loadStore(fetchText) {
  const body = await fetchText(STORE_URL, MAX_STORE_BYTES);
  return cleanStore(JSON.parse(body));
}

module.exports = { isOffensive, STORE_URL, SHARE_URL, THEME_VARS, cleanTheme, cleanStore, themeCss, varsFromCss, shareUrl, loadStore, safeValue };
