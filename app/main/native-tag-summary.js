'use strict';

const MAX_TEXT_LENGTH = 65536;
const MAX_ARRAY_ITEMS = 256;

function binaryLength(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.length;
  if (Array.isArray(value) && value.length > 1024 && value.slice(0, 32).every(item => Number.isInteger(item) && item >= 0 && item <= 255)) return value.length;
  return null;
}

function summarize(value, depth = 0) {
  const bytes = binaryLength(value);
  if (bytes !== null) return `<Binary ${bytes} bytes>`;
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}… [truncated]` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[nested metadata]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => summarize(item, depth + 1)).filter(item => item !== null);
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more values]`);
    return items;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const itemBytes = key.toLowerCase() === 'data' ? binaryLength(item) : null;
      out[key] = itemBytes !== null ? `<Binary ${itemBytes} bytes>` : summarize(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function nativeTagKey(item) {
  const id = String(item?.id ?? item?.key ?? item?.name ?? '').trim();
  if (!id) return '';
  const desc = String(item?.value?.description ?? '').trim();
  return id.toUpperCase() === 'TXXX' && desc ? `TXXX:${desc}` : id;
}

function collectNativeTags(native) {
  const out = {};
  for (const nativeItems of Object.values(native || {})) {
    for (const item of (Array.isArray(nativeItems) ? nativeItems : [])) {
      const key = nativeTagKey(item);
      if (!key) continue;
      const raw = item?.value;
      const values = Array.isArray(raw) ? raw : [raw];
      const clean = values.map(value => summarize(value)).filter(value => value !== null && value !== '');
      if (!clean.length) continue;
      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = clean.length === 1 ? clean[0] : clean;
      else {
        const prior = Array.isArray(out[key]) ? out[key] : [out[key]];
        out[key] = [...prior, ...clean];
      }
    }
  }
  return out;
}

module.exports = { collectNativeTags, summarize, nativeTagKey };
