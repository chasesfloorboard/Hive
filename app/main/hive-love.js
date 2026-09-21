'use strict';

// Hive-owned Love semantics. This module defines the meaning of Loved and the
// canonical embedded field. Format-specific readers/writers may expose their
// native representation, but the decision itself belongs to Hive.
const CANONICAL_LOVE_TAG = 'LOVE RATING';
const LOVE_FIELD_NAMES = new Set([
  CANONICAL_LOVE_TAG,
  'LOVE',
  'LOVERATING',
  'MUSICBEE/LOVE RATING',
  'MUSICBEE/LOVERATING',
  'MUSICBEE LOVE RATING'
]);

function normalizeField(value) { return String(value ?? '').trim().toUpperCase(); }
function isLoveFieldName(value) { return LOVE_FIELD_NAMES.has(normalizeField(value)); }
function isLovedValue(value) {
  const v = normalizeField(value);
  return v === 'L' || v === 'Y' || v === 'YES' || v === 'TRUE' || v === '1' ||
    v === 'LOVE' || v === 'LOVED' || v === 'FAVORITE' || v === 'FAVOURITE';
}

function collectTextValues(raw, out = []) {
  if (raw === null || raw === undefined) return out;
  if (Array.isArray(raw)) { for (const value of raw) collectTextValues(value, out); return out; }
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    collectTextValues(Buffer.from(raw).toString('utf8'), out); return out;
  }
  if (typeof raw === 'object') {
    if (raw.text !== undefined) { collectTextValues(raw.text, out); return out; }
    if (raw.value !== undefined) { collectTextValues(raw.value, out); return out; }
    return out;
  }
  for (const value of String(raw).split('\0')) {
    const clean = value.replace(/^\uFEFF/, '').trim();
    if (clean) out.push(clean);
  }
  return out;
}

function nativeTagField(tag) {
  const value = tag?.value;
  return value?.description ?? value?.name ?? tag?.description ?? tag?.name ?? tag?.id ?? '';
}

function nativeTagValues(tag) {
  const value = tag?.value;
  return collectTextValues(value?.text ?? value?.value ?? value);
}

function readLovedFromNativeTags(native) {
  for (const tagList of Object.values(native || {})) {
    for (const tag of (Array.isArray(tagList) ? tagList : [])) {
      const field = nativeTagField(tag);
      const id = normalizeField(tag?.id || '');
      const idTail = id.includes(':') ? id.slice(id.lastIndexOf(':') + 1).trim() : id;
      if (!isLoveFieldName(field) && !isLoveFieldName(idTail)) continue;
      if (nativeTagValues(tag).some(isLovedValue)) return true;
    }
  }
  return false;
}

module.exports = {
  CANONICAL_LOVE_TAG,
  LOVE_FIELD_NAMES,
  isLoveFieldName,
  isLovedValue,
  readLovedFromNativeTags
};
