'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const native = fs.readFileSync(path.join(root, 'app', 'native', 'gstreamer-player.c'), 'utf8');

test('explicit track selection forces a fresh scrubber position instead of restoring another track position', () => {
  const start = renderer.indexOf('function playQueue(');
  const end = renderer.indexOf('\n  function queueRowHtml', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /activeOffset = 0;/);
  assert.match(block, /pendingRestoredOffset = null;/);
  assert.match(block, /gstPosition = 0;/);
  assert.match(block, /requestLoadAndPlayCurrent\(true\)/);
});

test('explicit queue changes cannot persist the previous GStreamer position onto the newly selected track', () => {
  const start = renderer.indexOf('function playQueue(');
  const end = renderer.indexOf('\n  function queueRowHtml', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  const reset = block.indexOf('gstPosition = 0;');
  const save = block.indexOf('saveQueueSession();');
  const transportSave = block.indexOf('savePlaybackSession();');
  assert.ok(reset >= 0, 'playQueue must reset the native position before persistence');
  assert.ok(save > reset, 'queue persistence should occur after the stale-position reset');
  assert.ok(transportSave > reset, 'transport persistence should occur after the stale-position reset');
});

test('fresh manual track loads do not read a remembered position for the newly selected song', () => {
  const start = renderer.indexOf('async function loadAndPlayCurrent(');
  const end = renderer.indexOf('\n  // Restore the last queue/current track', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /freshPlayback/);
  assert.match(block, /freshPlayback \? 0 :/);
});

test('manual native track changes use the native LOAD/PLAY sequence without inserting a renderer sleep', () => {
  const start = renderer.indexOf('async function gstLoadCurrent(');
  const end = renderer.indexOf('\n  Object.defineProperties(audioEngine', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.doesNotMatch(block, /setTimeout\(resolve, 12\)/);
  assert.match(block, /gstSend\(`LOAD\\t/);
  assert.match(block, /gstSend\('PLAY'\)/);
  assert.match(native, /gst_element_set_state\(player, GST_STATE_PLAYING\)/);
});

test('explicit queue track double-click invalidates the live native transport before changing the active index', () => {
  const start = renderer.indexOf("el.queueList.addEventListener('dblclick', e => {");
  const end = renderer.indexOf("el.queueList.addEventListener('contextmenu'", start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /gstTrackIndex = -1/);
  assert.match(block, /gstPosition = 0/);
  assert.match(block, /gstPosition = 0/);
  assert.match(block, /el\.pbSeek\.value = '0'/);
  assert.ok(block.indexOf('gstPosition = 0') < block.indexOf('currentIndex = i'),
    'live scrubber state must reset before selecting the new queue track');
});

test('native POSITION events cannot overwrite a fresh track before its LOAD is acknowledged', () => {
  assert.match(renderer, /let gstPositionUpdatesEnabled = false;/);
  const loadStart = renderer.indexOf('async function gstLoadCurrent(');
  const loadEnd = renderer.indexOf('\n  Object.defineProperties(audioEngine', loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  const loadBlock = renderer.slice(loadStart, loadEnd);
  assert.match(loadBlock, /gstPositionUpdatesEnabled = false;/);
  assert.match(loadBlock, /gstSend\(`LOAD\\t\$\{gstB64\(t\.path\)\}/);
  const eventStart = renderer.indexOf("if (name === 'POSITION')");
  const eventEnd = renderer.indexOf("if (name === 'ABOUT_TO_FINISH')", eventStart);
  assert.ok(eventStart >= 0 && eventEnd > eventStart);
  const positionBlock = renderer.slice(eventStart, eventEnd);
  assert.match(positionBlock, /gstPositionUpdatesEnabled/);
  const loadedStart = renderer.indexOf("if (name === 'LOADED')");
  assert.ok(loadedStart >= 0, 'renderer must acknowledge native LOAD completion');
});

test('a new track snaps its lyrics scroll to the highlighted line instead of animating from the previous track', () => {
  const start = renderer.indexOf('function renderLyrics(');
  const end = renderer.indexOf('\n  function scrollHighlightedLyricIntoView', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  // The shared updateSyncedLyrics()->scrollHighlightedLyricIntoView('smooth')
  // path is for the deliberate "Show highlighted lyric" recenter action, which
  // must keep its animation -- a fresh track load has to suppress that shared
  // smooth scroll and jump instantly instead.
  assert.match(block, /followHighlightedLyric = false;/);
  assert.match(block, /updateSyncedLyrics\(Number\(audio\.currentTime\) \|\| 0, true\);/);
  const suppressAt = block.indexOf('followHighlightedLyric = false;');
  const updateAt = block.indexOf('updateSyncedLyrics(Number(audio.currentTime) || 0, true);');
  const restoreAt = block.indexOf('followHighlightedLyric = true;', updateAt);
  const jumpAt = block.indexOf("scrollHighlightedLyricIntoView('auto');");
  assert.ok(suppressAt >= 0 && suppressAt < updateAt, 'follow mode must be suppressed before recomputing the active line');
  assert.ok(restoreAt > updateAt, 'follow mode must be restored after recomputing the active line');
  assert.ok(jumpAt > restoreAt, 'the instant jump must happen after follow mode is restored');
});

test('scrubbing after a track ends with no next queue track resumes the still-alive native pipeline instead of only staging a position', () => {
  const start = renderer.indexOf('async function seekEngine(');
  const end = renderer.indexOf('\n  window.beehive.onGstreamerEvent', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  const gstActiveBranch = block.indexOf('if (gstActive) {');
  const idleEosBranch = block.indexOf('if (!gstActive && engineEnded');
  const fallbackBranch = block.indexOf('if (!activeBuffer) {');
  assert.ok(gstActiveBranch >= 0 && idleEosBranch > gstActiveBranch && fallbackBranch > idleEosBranch,
    'the idle-at-EOS resume branch must sit between the live-gst branch and the generic staged-offset fallback');
  const idleEosBlock = block.slice(idleEosBranch, fallbackBranch);
  assert.match(idleEosBlock, /gstTrackIndex === currentIndex/);
  assert.match(idleEosBlock, /gstCompatibleTrack\(currentQueue\[currentIndex\]\)/);
  assert.match(idleEosBlock, /gstActive = true;/);
  assert.match(idleEosBlock, /engineEnded = false;/);
  assert.match(idleEosBlock, /gstSend\('SEEKPLAY\\t' \+ String\(target\)\);/);
});
