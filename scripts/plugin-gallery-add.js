#!/usr/bin/env node
'use strict';
// Adds a plugin submitted via GitHub issue (ISSUE_BODY) to either:
//   --tier verified   -> plugins/store.json     (maintainer applied `approved`)
//   --tier community  -> plugins/community.json (untested community section)
// Validated with the exact same rules Desktop & Mobile use (app/main/plugin-store.js).
const fs = require('fs');
const path = require('path');
const { cleanPlugin } = require('../app/main/plugin-store');

const tierIdx = process.argv.indexOf('--tier');
const tier = tierIdx >= 0 ? String(process.argv[tierIdx + 1] || '').toLowerCase() : 'verified';
if (tier !== 'verified' && tier !== 'community') {
  console.error('Usage: node scripts/plugin-gallery-add.js --tier verified|community');
  process.exit(1);
}
const verified = tier === 'verified';
const file = path.join(__dirname, '..', 'plugins', verified ? 'store.json' : 'community.json');
const body = String(process.env.ISSUE_BODY || '');
const m = /```json\s*([\s\S]*?)```/.exec(body);
if (!m) { console.error('No plugin JSON block found in the issue body.'); process.exit(1); }

let raw;
try { raw = JSON.parse(m[1]); }
catch (err) { console.error('Invalid plugin JSON:', err.message); process.exit(1); }

const plugin = cleanPlugin(raw, { verified });
if (!plugin) {
  console.error('The plugin did not pass validation (id, name, apiVersion 2, permissions, size, or blocked words).');
  process.exit(1);
}
if (!plugin.author && process.env.ISSUE_AUTHOR) {
  plugin.author = String(process.env.ISSUE_AUTHOR).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 64);
}

const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(catalog.plugins)) catalog.plugins = [];

// Community submissions may never squat on the official `hive.*` namespace or an existing Verified plugin ID.
if (!verified) {
  const verifiedFile = path.join(__dirname, '..', 'plugins', 'store.json');
  let verifiedIds = new Set();
  try {
    const vCat = JSON.parse(fs.readFileSync(verifiedFile, 'utf8'));
    verifiedIds = new Set((vCat.plugins || []).map(p => p.id));
  } catch {}
  if (plugin.id.startsWith('hive.') || verifiedIds.has(plugin.id)) {
    const suffix = plugin.id.replace(/^hive\./, '');
    plugin.id = `community.${suffix}`.slice(0, 64);
  }
}

// Update in place if same id + author (or maintainer updating a verified plugin), else disambiguate id.
const existingIdx = catalog.plugins.findIndex(p => p.id === plugin.id);
if (existingIdx >= 0) {
  const prev = catalog.plugins[existingIdx];
  if (verified || prev.author === plugin.author) {
    catalog.plugins[existingIdx] = plugin;
  } else {
    let id = plugin.id, n = 2;
    while (catalog.plugins.some(p => p.id === id)) id = `${plugin.id}-${n++}`;
    catalog.plugins.push({ ...plugin, id });
  }
} else {
  catalog.plugins.push(plugin);
}

fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
console.log(`Published ${plugin.name} (${plugin.id} v${plugin.version}) to ${tier} store.`);
