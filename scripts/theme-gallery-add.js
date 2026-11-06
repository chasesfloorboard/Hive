#!/usr/bin/env node
'use strict';
// Adds the theme in a "Share theme" issue (ISSUE_BODY) to themes/store.json, checked by the same
// rules as the apps. Run by .github/workflows/theme-gallery.yml once the maintainer approves it.
const fs = require('fs');
const path = require('path');
const { cleanTheme } = require('../app/main/theme-store');

const file = path.join(__dirname, '..', 'themes', 'store.json');
const body = String(process.env.ISSUE_BODY || '');
const m = /```json\s*([\s\S]*?)```/.exec(body);
if (!m) { console.error('No theme JSON in the issue.'); process.exit(1); }
const theme = cleanTheme(JSON.parse(m[1]));
if (!theme) { console.error('The theme did not pass the checks.'); process.exit(1); }
if (!theme.author && process.env.ISSUE_AUTHOR) theme.author = String(process.env.ISSUE_AUTHOR).slice(0, 40);
const store = JSON.parse(fs.readFileSync(file, 'utf8'));
let id = theme.id, n = 2;
while (store.themes.some(t => t.id === id)) id = `${theme.id}-${n++}`;
store.themes.push({ ...theme, id });
fs.writeFileSync(file, JSON.stringify(store, null, 2) + '\n');
console.log(`Added ${theme.name} as ${id}.`);
