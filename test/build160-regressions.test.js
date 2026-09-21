'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root,'app','main','main.js'),'utf8');
const preload = fs.readFileSync(path.join(root,'app','main','preload.js'),'utf8');
const renderer = fs.readFileSync(path.join(root,'app','renderer','renderer.js'),'utf8');
const html = fs.readFileSync(path.join(root,'app','renderer','index.html'),'utf8');

test('Build 161 keeps glass controls out of the bottom player and exposes real surface settings', () => {
  assert.doesNotMatch(html, /id="playbar-glass-toggle"/);
  assert.doesNotMatch(html, /id="playbar-glass-settings"/);
  assert.match(html, /data-glass-area="lyrics"/);
  assert.match(html, /data-glass-area="main"/);
  assert.doesNotMatch(html, /data-glass-area="toolbar"/);
  assert.match(renderer, /glassAreaDefaults/);
  assert.match(html, /Frosted Glass/);
});

test('Build 161 makes the themed Electron title bar an explicit optional window mode', () => {
  assert.match(main, /DEFAULT_THEME_WINDOW_BAR\s*=\s*true/);
  assert.match(main, /frame:\s*themeWindowBarEnabled\s*\?\s*false\s*:\s*true/);
  assert.match(preload, /window:minimize/);
  assert.match(preload, /window:maximize/);
  assert.match(preload, /window:close/);
  assert.match(html, /data-window-control="minimize"/);
  assert.match(html, /data-window-control="maximize"/);
  assert.match(html, /data-window-control="close"/);
  assert.match(html, /id="setting-theme-window-bar"/);
  assert.match(renderer, /theme-window-bar-enabled/);
});

test('Build 161 persists and offers resume recovery for interrupted audio integrity scans', () => {
  assert.match(main, /audioIntegrityScanCheckpoint/i);
  assert.match(main, /resumeAudioIntegrityScan/i);
  assert.match(main, /audio:integrity-scan-resume/i);
  assert.match(renderer, /resumeAudioIntegrityScan/i);
  assert.match(renderer, /interrupted/i);
});

test('Build 161 treats scan checkpoints as durable state and does not silently discard them', () => {
  assert.match(main, /AUDIO_INTEGRITY_SCAN_CHECKPOINT/i);
  assert.match(main, /writeJsonSafe|atomic/i);
  assert.match(main, /completedPaths/i);
});

test('Build 161 prevents secondary mouse buttons from activating a library folder', () => {
  const start = renderer.indexOf("div.addEventListener('click',e=>{if(e.button!==undefined&&e.button!==0)return;rememberMusicBrowserState();activeFolderPath=folder;");
  assert.ok(start >= 0);
  const context = renderer.indexOf("div.addEventListener('contextmenu',e=>", start);
  assert.ok(context > start);
  assert.match(renderer.slice(start, context), /e\.button/);
  assert.match(renderer.slice(context, context + 500), /Rescan library/);
});
