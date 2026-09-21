'use strict';

const CANONICAL_LOVE_TAG = 'LOVE RATING';
const LOVE_FIELD_NAMES = new Set([
  'LOVE RATING',
  'LOVE',
  'LOVERATING',
  'MUSICBEE/LOVE RATING',
  'MUSICBEE/LOVERATING',
  'MUSICBEE LOVE RATING'
]);

function normalizeLoveFieldName(value) {
  return String(value ?? '').trim().toUpperCase();
}

function isLoveFieldName(value) {
  return LOVE_FIELD_NAMES.has(normalizeLoveFieldName(value));
}

function isLovedValue(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'L' || v === 'Y' || v === 'YES' || v === 'TRUE' ||
    v === '1' || v === 'LOVE' || v === 'LOVED' ||
    v === 'FAVORITE' || v === 'FAVOURITE';
}

function normalizeLoveValue(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (isLovedValue(v)) return 'L';
  if (v === '0' || v === 'U' || v === 'N' || v === 'NO' || v === 'FALSE' || v === 'UNLOVED') return '0';
  return v;
}

function analyzeLoveValues(values) {
  const normalized = (Array.isArray(values) ? values : [values])
    .flatMap(value => String(value ?? '').split('\0'))
    .map(normalizeLoveValue)
    .filter(Boolean);
  const loved = normalized.includes('L');
  return {
    flagged: normalized.length > 1,
    loved,
    canonicalValue: loved ? 'L' : '0'
  };
}

module.exports = {
  CANONICAL_LOVE_TAG,
  LOVE_FIELD_NAMES,
  normalizeLoveFieldName,
  isLoveFieldName,
  isLovedValue,
  normalizeLoveValue,
  analyzeLoveValues
};
