'use strict';

// Hive's plugin store: two catalogs in the public Hive repository, mirroring
// themes/store.json (app/main/theme-store.js).
//   1. Verified (plugins/store.json) — reviewed by Hive's maintainers before
//      appearing in the Verified tab.
//   2. Community / Untested (plugins/community.json) — user-submitted plugins
//      that have not been audited yet. They still run inside Hive's zero-network
//      sandbox, and Hive warns the user and lists their permissions before install.

const { isOffensive } = require('./theme-store');

const VERIFIED_URL = 'https://raw.githubusercontent.com/chasesfloorboard/Hive/main/plugins/store.json';
const COMMUNITY_URL = 'https://raw.githubusercontent.com/chasesfloorboard/Hive/main/plugins/community.json';
const SHARE_URL = 'https://github.com/chasesfloorboard/Hive/issues/new';

const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_JS_BYTES = 256 * 1024;
const MAX_CSS_BYTES = 128 * 1024;
const MAX_URL_CHARS = 7200;

const ALLOWED_PERMISSIONS = [
  'player.read',
  'player.control',
  'queue.read',
  'library.read',
  'spectrum.read',
  'media.artwork',
  'ui.view',
  'settings',
];
const ALLOWED_PLATFORMS = ['desktop', 'mobile'];
const ALLOWED_SETTING_TYPES = ['boolean', 'number', 'string', 'select'];

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function cleanId(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^\.+|\.+$/g, '');
  if (!s || s.length < 2 || s.length > 64 || s.includes('..') || !/^[a-z0-9][a-z0-9._-]*$/.test(s)) return '';
  return s;
}

function cleanVersion(raw) {
  const s = String(raw ?? '').trim();
  return /^\d+\.\d+\.\d+(?:-[a-z0-9.]{1,24})?$/i.test(s) ? s : '1.0.0';
}

function cleanIcon(raw) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  if (!s || /svg/i.test(s)) return '◈';
  return [...s].slice(0, 2).join('');
}

function cleanSetting(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) return null;
  const type = ALLOWED_SETTING_TYPES.includes(raw.type) ? raw.type : null;
  if (!type) return null;
  const out = {
    id,
    type,
    label: cleanText(raw.label || id, 60),
    description: cleanText(raw.description || '', 160),
  };
  if (type === 'boolean') {
    out.default = !!raw.default;
  } else if (type === 'number') {
    if (Number.isFinite(Number(raw.min))) out.min = Number(raw.min);
    if (Number.isFinite(Number(raw.max))) out.max = Number(raw.max);
    if (Number.isFinite(Number(raw.step)) && Number(raw.step) > 0) out.step = Number(raw.step);
    out.default = Number.isFinite(Number(raw.default)) ? Number(raw.default) : (out.min ?? 0);
  } else if (type === 'string') {
    out.default = cleanText(raw.default ?? '', 120);
  } else if (type === 'select') {
    const options = Array.isArray(raw.options)
      ? raw.options.slice(0, 20).map(o => typeof o === 'string'
        ? { value: cleanText(o, 40), label: cleanText(o, 60) }
        : { value: cleanText(o?.value, 40), label: cleanText(o?.label || o?.value, 60) }).filter(o => o.value)
      : [];
    if (!options.length) return null;
    out.options = options;
    out.default = options.some(o => o.value === raw.default) ? raw.default : options[0].value;
  }
  return out;
}

/**
 * Validates and normalizes one store plugin entry.
 * `verified` is strictly enforced by the catalog tier (never trusted from raw JSON).
 */
function cleanPlugin(raw, { verified = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanId(raw.id);
  const name = cleanText(raw.name, 50);
  if (!id || !name) return null;
  const author = cleanText(raw.author || '', 64);
  const description = cleanText(raw.description || '', 220);
  if ([id, name, author, description].some(isOffensive)) return null;

  const apiVersion = Number(raw.apiVersion);
  if (apiVersion !== 2) return null;

  const permissions = [...new Set(
    (Array.isArray(raw.permissions) ? raw.permissions : [])
      .map(p => String(p || '').trim())
      .filter(p => ALLOWED_PERMISSIONS.includes(p))
  )];

  const platformsRaw = Array.isArray(raw.platforms) ? raw.platforms : ['desktop'];
  const platforms = [...new Set(platformsRaw.map(p => String(p || '').trim().toLowerCase()).filter(p => ALLOWED_PLATFORMS.includes(p)))];
  if (!platforms.length) platforms.push('desktop');

  const js = typeof raw.js === 'string' ? raw.js : '';
  const css = typeof raw.css === 'string' ? raw.css : '';
  const builtin = !!raw.builtin && !!verified;
  if (!builtin && !js.trim()) return null;
  if (Buffer.byteLength(js, 'utf8') > MAX_JS_BYTES) return null;
  if (Buffer.byteLength(css, 'utf8') > MAX_CSS_BYTES) return null;

  const settings = (Array.isArray(raw.settings) ? raw.settings : [])
    .slice(0, 24)
    .map(cleanSetting)
    .filter(Boolean);

  return {
    id,
    name,
    version: cleanVersion(raw.version),
    author,
    description,
    icon: cleanIcon(raw.icon),
    apiVersion: 2,
    verified: !!verified,
    builtin,
    platforms,
    permissions,
    settings,
    js,
    css,
  };
}

function cleanCatalog(json, { verified = false } = {}) {
  const list = Array.isArray(json?.plugins) ? json.plugins : [];
  const seen = new Set();
  const out = [];
  for (const raw of list.slice(0, 200)) {
    const p = cleanPlugin(raw, { verified });
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * Builds the submission JSON & pre-filled GitHub issue URL for sharing a plugin
 * either for maintainer verification (`target: 'verified'`) or the Community /
 * Untested section (`target: 'community'`).
 */
function buildSubmission(rawPlugin, { target = 'verified' } = {}) {
  if ([rawPlugin?.id, rawPlugin?.name, rawPlugin?.author, rawPlugin?.description].some(isOffensive)) {
    throw Object.assign(
      new Error("That plugin name or description can't go in the plugin store. Pick another one."),
      { code: 'NAME_BLOCKED' }
    );
  }
  const clean = cleanPlugin({ ...rawPlugin, apiVersion: 2 }, { verified: false });
  if (!clean) throw new Error('The plugin needs a valid id, name, apiVersion 2, and plugin.js code (under 256 KB).');
  const submission = {
    id: clean.id,
    name: clean.name,
    version: clean.version,
    author: clean.author,
    description: clean.description,
    icon: clean.icon,
    apiVersion: 2,
    platforms: clean.platforms,
    permissions: clean.permissions,
    settings: clean.settings,
    js: clean.js,
    css: clean.css,
  };
  const jsonText = JSON.stringify(submission, null, 2);
  const isCommunity = target === 'community';
  const labels = isCommunity ? 'plugin-community' : 'plugin';
  const title = `${isCommunity ? 'Plugin (Community/Untested)' : 'Plugin (Review)'}: ${clean.name}`;
  const intro = isCommunity
    ? 'Submitting a plugin to the **Community / Untested (Unsafe)** section of the Hive Plugin Store.\n\n- I understand this plugin will be clearly marked as unverified and will run inside Hive\'s zero-network sandbox.'
    : 'Submitting a plugin for **Verification** in the Hive Plugin Store.\n\n- Maintainers will review the code and permissions, then apply the `approved` label to publish it to the live Verified store.';
  let body = `${intro}\n\n\`\`\`json\n${jsonText}\n\`\`\``;
  let url = `${SHARE_URL}?labels=${encodeURIComponent(labels)}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  let truncated = false;
  if (url.length > MAX_URL_CHARS) {
    truncated = true;
    const stub = `${intro}\n\n<!-- Paste the copied plugin JSON bundle below (too large for a URL) -->\n\n\`\`\`json\n\n\`\`\``;
    url = `${SHARE_URL}?labels=${encodeURIComponent(labels)}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(stub)}`;
  }
  return { submission, jsonText, url, truncated, target: isCommunity ? 'community' : 'verified' };
}

/** Loads both Verified and Community catalogs through [fetchText]. */
async function loadStores(fetchText) {
  const [verifiedRes, communityRes] = await Promise.allSettled([
    fetchText(VERIFIED_URL, MAX_STORE_BYTES).then(t => cleanCatalog(JSON.parse(t), { verified: true })),
    fetchText(COMMUNITY_URL, MAX_STORE_BYTES).then(t => cleanCatalog(JSON.parse(t), { verified: false })),
  ]);
  return {
    verified: verifiedRes.status === 'fulfilled' ? verifiedRes.value : null,
    community: communityRes.status === 'fulfilled' ? communityRes.value : null,
    online: verifiedRes.status === 'fulfilled' || communityRes.status === 'fulfilled',
    error: verifiedRes.status === 'rejected' ? (verifiedRes.reason?.message || String(verifiedRes.reason)) : null,
  };
}

module.exports = {
  VERIFIED_URL,
  COMMUNITY_URL,
  SHARE_URL,
  ALLOWED_PERMISSIONS,
  ALLOWED_PLATFORMS,
  MAX_JS_BYTES,
  MAX_CSS_BYTES,
  cleanPlugin,
  cleanCatalog,
  buildSubmission,
  loadStores,
};
