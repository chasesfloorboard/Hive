'use strict';
// Hive Tag Tools (MusicBee's Tag Tools): batch find & replace, case
// conversion and copy/swap between fields. Pure planning only; the renderer
// previews the changes and saves them through the normal metadata queue.
// Loaded as a plain script (window.HiveTagTools) and via require() by tests.
(function (root) {
  // Editable text fields: in-memory track key === metadata write key.
  const FIELDS = [
    ['title', 'Title'], ['artist', 'Artist'], ['albumArtist', 'Album Artist'], ['album', 'Album'],
    ['genre', 'Genre'], ['composer', 'Composer'], ['grouping', 'Grouping'], ['publisher', 'Publisher'],
    ['comment', 'Comment'], ['year', 'Year']
  ];
  const FIELD_KEYS = new Set(FIELDS.map(f => f[0]));

  const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function findReplace(value, { find = '', replace = '', caseSensitive = false, regex = false, wholeWord = false } = {}) {
    const text = String(value ?? '');
    if (!find) return text;
    let source = regex ? find : escapeRegExp(find);
    if (wholeWord) source = `\\b(?:${source})\\b`;
    const pattern = new RegExp(source, caseSensitive ? 'g' : 'gi'); // throws on a bad regex: the caller reports it
    return text.replace(pattern, regex ? replace : () => replace);
  }

  // Title Case keeps short joining words lower-case except at the start/end
  // and after a colon, and leaves words that are already all-caps (AC/DC,
  // MF DOOM) or contain digits alone.
  const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with', 'feat', 'ft']);
  function changeCase(value, mode) {
    const text = String(value ?? '');
    if (mode === 'upper') return text.toUpperCase();
    if (mode === 'lower') return text.toLowerCase();
    if (mode === 'sentence') {
      const lower = text.toLowerCase();
      return lower.replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, pre, ch) => pre + ch.toUpperCase());
    }
    if (mode === 'title') {
      const words = text.split(/(\s+)/);
      const realIndexes = words.map((w, i) => (/\S/.test(w) ? i : -1)).filter(i => i >= 0);
      const first = realIndexes[0], last = realIndexes[realIndexes.length - 1];
      let afterColon = false;
      return words.map((w, i) => {
        if (!/\S/.test(w)) return w;
        const bare = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        let out;
        if (bare.length > 1 && bare === bare.toUpperCase() && /\p{L}/u.test(bare)) out = w; // acronym
        else if (/\d/.test(bare)) out = w.toLowerCase();
        else if (i !== first && i !== last && !afterColon && SMALL_WORDS.has(bare.toLowerCase())) out = w.toLowerCase();
        else out = w.toLowerCase().replace(/(^|[(\[{"'\-/])(\p{L})/gu, (_, pre, ch) => pre + ch.toUpperCase());
        afterColon = /[:\-–]$/.test(w);
        return out;
      }).join('');
    }
    return text;
  }

  // op: { kind: 'replace', field|'*', find, replace, caseSensitive, regex, wholeWord }
  //   | { kind: 'case', field|'*', mode }
  //   | { kind: 'copy', from, to, swap, onlyEmpty }
  // Returns [{ track, path, tags: { field: newValue }, changes: [[field, old, new]] }].
  function planTagTool(tracks, op) {
    const fields = op.field === '*' ? FIELDS.map(f => f[0]).filter(f => f !== 'year') : [op.field];
    const plans = [];
    for (const track of tracks || []) {
      if (!track?.path) continue;
      const tags = {}, changes = [];
      const set = (field, next) => {
        if (!FIELD_KEYS.has(field)) return;
        const before = String(track[field] ?? '');
        if (next !== before) { tags[field] = next; changes.push([field, before, next]); }
      };
      if (op.kind === 'replace') for (const f of fields) set(f, findReplace(track[f], op));
      else if (op.kind === 'case') for (const f of fields) set(f, changeCase(track[f], op.mode));
      else if (op.kind === 'copy') {
        const fromValue = String(track[op.from] ?? '');
        const toValue = String(track[op.to] ?? '');
        if (op.swap) { set(op.to, fromValue); set(op.from, toValue); }
        else if (!op.onlyEmpty || !toValue.trim()) set(op.to, fromValue);
      }
      if (changes.length) plans.push({ track, path: track.path, tags, changes });
    }
    return plans;
  }

  const api = { FIELDS, findReplace, changeCase, planTagTool };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveTagTools = api;
})(typeof window !== 'undefined' ? window : globalThis);
