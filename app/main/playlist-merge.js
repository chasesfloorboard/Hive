'use strict';

// A phone's playlist saved over Hive's: the phone only ever sees library songs and streamed
// (Apple Music/Spotify) songs. Everything else in Hive's list (radio, podcast episodes, songs
// not in the library) is kept, each after the entry it followed before, so a phone edit never
// erases what the phone couldn't see.

const path = require('path');

/** A link such as "radio:..." or "podcast:..." (two letters or more: "C:\..." is a Windows path). */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;
const STREAMED = /^ytm:(apple|spotify):/i;

/** Whether the phone gets this entry of Hive's playlist ([libraryPaths]: resolved paths of library songs). */
function phoneSees(ref, libraryPaths) {
  const r = String(ref || '');
  if (STREAMED.test(r)) return true;
  if (SCHEME.test(r)) return false;
  return libraryPaths.has(path.resolve(r));
}

/** [incoming] (the phone's list) with [old]'s entries the phone couldn't see put back where they were. */
function keepUnseen(old, incoming, libraryPaths) {
  const out = [...incoming];
  const present = new Set(out);
  let anchor = null; // the last entry the phone saw before this one
  const pending = [];
  for (const ref of Array.isArray(old) ? old : []) {
    if (phoneSees(ref, libraryPaths)) { anchor = ref; continue; }
    if (present.has(ref)) continue;
    pending.push({ ref, anchor });
  }
  // Insert from the back so earlier positions stay right; entries with no anchor (first in the list) go first.
  const placed = [];
  for (const { ref, anchor: a } of pending) {
    const at = a === null ? -1 : out.indexOf(a);
    if (a !== null && at < 0) { placed.push(ref); continue; } // what it followed is gone: kept at the end
    // After its anchor and after any unseen entries already put after that anchor.
    let i = at + 1;
    while (i < out.length && !phoneSees(out[i], libraryPaths) && !present.has(out[i])) i++;
    out.splice(i, 0, ref);
  }
  out.push(...placed);
  return out;
}

module.exports = { phoneSees, keepUnseen, SCHEME };
