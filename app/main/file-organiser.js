'use strict';
(function () {

// MusicBee-style "Organise files": build a relative path for a track from a
// naming template, e.g.
//   <Album Artist>\<Album>\<Track#> - <Title>
//   $If(<Album Artist>,<Album Artist>,<Artist>)\(<Year>) <Album>\<Track#> <Title>
// Placeholders are MusicBee field names in angle brackets; "\" or "/" make
// folders; $If(cond,then,else), $IsNull(field,then,else), $Upper, $Lower and
// $Left(text,n) are supported. The original file extension is always kept.
// Pure: path planning only. Moving files and remapping Hive's records is done
// by main.js.

// Also loaded in the renderer as a plain script (window.HiveTemplates) for
// Hive virtual tags; only the file-planning functions need Node's path.
const path = typeof require === 'function' ? require('path') : null;
const fileStem = p => String(p || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');

const FIELDS = {
  'title': t => t.title,
  'artist': t => t.artist,
  'album artist': t => t.albumArtist || t.artist,
  'album artist (raw)': t => t.albumArtist,
  'album': t => t.album,
  'genre': t => t.genre,
  'year': t => (t.year ? String(t.year).slice(0, 4) : ''),
  'composer': t => t.composer,
  'publisher': t => t.publisher,
  'grouping': t => t.grouping,
  'disc#': t => (Number(t.disk) > 0 ? String(Number(t.disk)) : ''),
  'track#': t => (Number(t.track) > 0 ? String(Number(t.track)).padStart(2, '0') : ''),
  'track number': t => (Number(t.track) > 0 ? String(Number(t.track)) : ''),
  'filename': t => fileStem(t.path)
};

const DEFAULT_TEMPLATE = '<Album Artist>\\<Album>\\<Track#> - <Title>';

// Characters that are invalid on Windows/exFAT (external music drives often are) plus
// control characters. Trailing dots/spaces are also invalid there.
function safeSegment(text, fallback = 'Unknown') {
  let s = String(text ?? '').replace(/[<>:"|?*\u0000-\u001f]/g, '').replace(/[\\/]/g, '-').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, '');
  if (s === '.' || s === '..') s = '';
  if (s.length > 120) s = s.slice(0, 120).trim();
  return notReserved(s) || fallback;
}

// Windows refuses these names as files or folders, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function notReserved(s) { return RESERVED.test(s) ? `${s}_` : s; }

// One file or folder name that works on Windows, exFAT and Linux alike, keeping
// as much of the text as it can: ":" becomes " - ", other forbidden characters
// "_"; no leading dot, no trailing dots or spaces, no reserved device name.
// Used for downloads and for songs received from the phone.
function safeName(text, fallback = 'Untitled') {
  let s = String(text ?? '').replace(/\s*:\s*/g, ' - ').replace(/[\\/*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[. ]+/, '').slice(0, 120).replace(/[. ]+$/, '');
  return notReserved(s) || fallback;
}

function fieldValue(track, name) {
  const getter = FIELDS[String(name).trim().toLowerCase()];
  return getter ? String(getter(track) ?? '').trim() : '';
}

// Split function arguments on top-level commas only.
function splitArgs(text) {
  const args = []; let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += ch;
  }
  args.push(cur);
  return args;
}

function evaluate(template, track) {
  let out = '';
  for (let i = 0; i < template.length;) {
    const ch = template[i];
    if (ch === '<') {
      const end = template.indexOf('>', i);
      if (end > i) { out += fieldValue(track, template.slice(i + 1, end)).replace(/[\\/]/g, '-'); i = end + 1; continue; }
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z]+)\(/.exec(template.slice(i));
      if (m) {
        let depth = 0, j = i + m[0].length - 1;
        for (; j < template.length; j++) { if (template[j] === '(') depth++; else if (template[j] === ')' && --depth === 0) break; }
        const args = splitArgs(template.slice(i + m[0].length, j)).map(a => a.trim());
        out += callFunction(m[1].toLowerCase(), args, track);
        i = j + 1;
        continue;
      }
    }
    out += ch; i++;
  }
  return out;
}

function callFunction(name, args, track) {
  const val = a => evaluate(a ?? '', track);
  switch (name) {
    case 'if': return val(args[0]).trim() ? val(args[1]) : val(args[2]);
    case 'isnull': return fieldValue(track, String(args[0] || '').replace(/^<|>$/g, '')) ? val(args[2]) : val(args[1]);
    case 'upper': return val(args[0]).toUpperCase();
    case 'lower': return val(args[0]).toLowerCase();
    case 'left': return val(args[0]).slice(0, Math.max(0, Number(val(args[1])) || 0));
    default: return '';
  }
}

function splitTemplateLevels(template) {
  const levels = []; let cur = '', angle = 0, paren = 0;
  for (const ch of template) {
    if (ch === '<') angle++;
    else if (ch === '>' && angle) angle--;
    else if (ch === '(') paren++;
    else if (ch === ')' && paren) paren--;
    if ((ch === '\\' || ch === '/') && !angle && !paren) { if (cur.trim()) levels.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) levels.push(cur);
  return levels;
}

// Relative target path (with the original extension) for one track.
function targetRelativePath(track, template = DEFAULT_TEMPLATE) {
  const ext = path.extname(String(track.path || ''));
  // Split the template into folder levels first (separators outside <...>
  // and $f(...)), so a level whose fields are empty becomes "Unknown" rather
  // than disappearing.
  const parts = splitTemplateLevels(String(template || DEFAULT_TEMPLATE)).map(level => evaluate(level, track).trim());
  if (!parts.length) parts.push('');
  const segments = parts.map((p, i) => safeSegment(p, i === parts.length - 1 ? fieldValue(track, 'filename') || 'Untitled' : 'Unknown'));
  segments[segments.length - 1] += ext;
  return segments.join(path.sep);
}

// Plan moves for tracks under one library root. Unchanged paths are skipped;
// two tracks wanting the same name (or a name that already exists and isn't
// moving away) get " (2)", " (3)"... `exists(p)` checks the file system.
function planOrganise(tracks, { root, template = DEFAULT_TEMPLATE, exists = () => false } = {}) {
  const base = path.resolve(String(root || ''));
  const moving = new Set(tracks.map(t => path.resolve(String(t.path || ''))));
  const claimed = new Set();
  const moves = [];
  // Files already at their target keep it, whatever order they come in.
  const targets = tracks.map(t => [path.resolve(String(t.path || '')), path.join(base, targetRelativePath(t, template))]);
  for (const [from, to] of targets) if (to === from) claimed.add(to.toLowerCase());
  for (const [from, target] of targets) {
    let to = target;
    if (to === from) continue;
    const ext = path.extname(to), stem = to.slice(0, to.length - ext.length);
    for (let n = 2; claimed.has(to.toLowerCase()) || (exists(to) && !moving.has(to) && to.toLowerCase() !== from.toLowerCase()); n++) to = `${stem} (${n})${ext}`;
    claimed.add(to.toLowerCase());
    if (to !== from) moves.push({ from, to });
  }
  return moves;
}

const api = { DEFAULT_TEMPLATE, targetRelativePath, planOrganise, safeSegment, safeName, evaluate };
if (typeof module === 'object' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.HiveTemplates = api;
})();
