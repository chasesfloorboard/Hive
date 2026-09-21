'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectPreferredLyrics } = require('../app/main/lyrics-provider');

test('Build 190 prefers synchronized lyrics whenever an online provider returns them', () => {
  const result = selectPreferredLyrics({
    syncedLyrics: '[00:01.00]Timed line',
    plainLyrics: 'Plain line',
    source: 'lrclib'
  });
  assert.deepEqual(result, {
    lyrics: '[00:01.00]Timed line',
    synced: true,
    source: 'lrclib'
  });
});

test('Build 190 falls back to plain lyrics when no synchronized lyrics exist', () => {
  const result = selectPreferredLyrics({
    syncedLyrics: '',
    plainLyrics: 'Plain line',
    source: 'genius'
  });
  assert.deepEqual(result, {
    lyrics: 'Plain line',
    synced: false,
    source: 'genius'
  });
});

test('Build 190 does not select empty online lyric payloads', () => {
  assert.equal(selectPreferredLyrics({ syncedLyrics: '', plainLyrics: '', source: 'lrclib' }), null);
});

const rendererSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
const stylesSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'renderer', 'styles.css'), 'utf8');

test('Build 190 uses the requested new-user sidebar order with two solid blank dividers', () => {
  const defsStart = rendererSource.indexOf('const SIDEBAR_NAV_DEFS = [');
  const defsEnd = rendererSource.indexOf('];', defsStart) + 2;
  const defs = rendererSource.slice(defsStart, defsEnd);
  assert.ok(defsStart >= 0 && defsEnd > defsStart);
  assert.match(defs, /id:'music'/);
  assert.match(defs, /id:'pl-explorer'/);
  assert.doesNotMatch(defs, /id:'pl-favorites'/);
  assert.match(rendererSource, /function loadNavigationPrefs\(\) \{[\s\S]*?const defaults = SIDEBAR_NAV_DEFS\.map\(d => d\.id\);/);
  assert.match(rendererSource, /id:'divider-top'.*type:'divider'/);
  assert.match(rendererSource, /id:'divider-bottom'.*type:'divider'/);
  assert.match(rendererSource, /label:\s*''/);
  assert.match(rendererSource, /divider\.title = def\.label \? `\$\{def\.label\} divider` : 'Divider'/);
  assert.match(rendererSource, /textContent='\+ Add divider'/);
  assert.match(stylesSource, /\.sidebar-visual-divider::before,[\s\S]*?\.sidebar-visual-divider::after[\s\S]*?background:\s*var\(--border\)/);
  assert.match(stylesSource, /\.sidebar-visual-divider\.is-blank \{ gap: 0; \}/);
});

test('Build 190 queries LRCLIB before plain Genius fallback and preserves sync-first semantics', () => {
  const mainSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'main', 'main.js'), 'utf8');
  const start = mainSource.indexOf("ipcMain.handle('lyrics:search'");
  const end = mainSource.indexOf("ipcMain.handle('track:hasEmbeddedArtwork'", start);
  assert.ok(start >= 0 && end > start);
  const block = mainSource.slice(start, end);
  assert.ok(block.indexOf('searchLrcLibLyrics(') < block.indexOf('searchGeniusLyrics('));
  assert.match(block, /if \(lrclib\?\.synced\) return lrclib/);
  assert.match(block, /return lrclib;/);
});

test('Build 190 lyric rendering prefers syncedLyrics over plainLyrics in provider payloads', () => {
  const start = rendererSource.indexOf('function normalizeLyricsPayload(raw)');
  const end = rendererSource.indexOf('function parseSyncedLyrics(raw)', start);
  assert.ok(start >= 0 && end > start);
  const block = rendererSource.slice(start, end);
  assert.match(block, /const synced = normalizeLyricsText\(raw\.syncedLyrics\);[\s\S]*?if \(synced\) return synced/);
  assert.match(block, /raw\.plainLyrics \?\? raw\.lyrics \?\? raw\.text/);
});

test('Build 190 keeps blank dividers valid while normal navigation labels remain required', () => {
  const start = rendererSource.indexOf('async function renameSidebarEntry(id)');
  const end = rendererSource.indexOf('async function addSidebarDivider()', start);
  assert.ok(start >= 0 && end > start);
  const block = rendererSource.slice(start, end);
  assert.match(block, /entry\.type !== 'divider' && !label/);
  assert.match(block, /if\(entry\.type==='divider' \|\| entry\.type==='playlist'\) entry\.label=label/);
});
